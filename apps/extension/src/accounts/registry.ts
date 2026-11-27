// The accounts the extension fills from. Reads go to every unlocked account and are merged; each
// item carries a reference to the account it came from, so filling or reading it goes back there;
// saving a new login goes to one account, chosen in one place (saveTarget). Today there is one
// account, Apple Passwords; nothing here assumes so.

import type {
  Account,
  AccountSettings,
  AccountStatus,
  AccountView,
  Credential,
  OneTimeCodeItem,
  PairingCodeUnlock,
  Tab,
  UnlockMethod,
} from "./types.ts";

/** A login as pages see it: `ref` names it across accounts. */
export interface LoginRef {
  ref: string;
  account: string;
  username: string;
}

/** A verification code as pages see it: `ref` names it across accounts. */
export interface OneTimeCodeRef extends Omit<OneTimeCodeItem, "id"> {
  ref: string;
  account: string;
}

/** What's kept of each account between browser launches. */
export interface StoredAccount {
  id: string;
  provider: string;
  settings: Partial<AccountSettings>;
}

export interface AccountsStore {
  load(): Promise<StoredAccount[] | undefined>;
  save(accounts: StoredAccount[]): Promise<void>;
  /** Account settings kept from before accounts existed (in the extension's settings), if any. */
  legacy?(): Promise<Partial<AccountSettings>>;
}

export interface Entry {
  account: Account;
  /** This account's settings until the user changes them (they may differ per platform). */
  defaults: () => Promise<AccountSettings>;
}

export class AccountError extends Error {
  constructor(
    message: string,
    readonly code: "locked" | "unknown-account" | "no-account" | "not-found",
  ) {
    super(message);
  }
}

export function itemRef(account: string, id: string): string {
  return JSON.stringify([account, id]);
}

export function parseRef(ref: string): { account: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(ref);
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [account, id] = parsed as unknown[];
      if (typeof account === "string" && typeof id === "string") return { account, id };
    }
  } catch {}
  throw new AccountError("that item is no longer saved", "not-found");
}

export class Accounts {
  readonly #entries: Entry[];
  #stored: Promise<StoredAccount[]> | undefined;

  constructor(
    entries: Entry[],
    private readonly store: AccountsStore,
  ) {
    this.#entries = entries;
  }

  get all(): readonly Account[] {
    return this.#entries.map((entry) => entry.account);
  }

  get anyUnlocked(): boolean {
    return this.all.some((account) => account.isUnlocked);
  }

  get unlocked(): Account[] {
    return this.all.filter((account) => account.isUnlocked);
  }

  /** Whether any account is unlocked or unlocking: locking now would interrupt the user. */
  get busy(): boolean {
    return this.all.some(({ status }) => status.state === "unlocked" || status.state === "unlocking");
  }

  get(id: string): Account {
    const account = this.all.find((a) => a.id === id);
    if (!account) throw new AccountError("that account isn't connected", "unknown-account");
    return account;
  }

  /** The account an unlock request is for: the one named, else the first that unlocks this way. */
  pairingCode(id?: string): Account & { unlock: PairingCodeUnlock } {
    const account = id === undefined ? this.all.find((a) => a.unlock.kind === "pairing-code") : this.get(id);
    if (account?.unlock.kind !== "pairing-code") {
      throw new AccountError("no account unlocks with a code", "no-account");
    }
    return account as Account & { unlock: PairingCodeUnlock };
  }

  /** Called with each account's status as it changes. */
  onChange(listener: (account: Account, status: AccountStatus) => void): () => void {
    const stops = this.all.map((account) => account.onChange((status) => listener(account, status)));
    return () => {
      for (const stop of stops) stop();
    };
  }

  onOneTimeCodesChanged(listener: () => void): () => void {
    const stops = this.all.map((account) => account.onOneTimeCodesChanged(listener));
    return () => {
      for (const stop of stops) stop();
    };
  }

  /** Connects the accounts in `states` (by default those that lost their connection). */
  async connect(states: readonly AccountStatus["state"][] = ["offline"]): Promise<void> {
    await Promise.all(
      this.all.filter(({ status }) => states.includes(status.state)).map((a) => a.connect().catch(() => {})),
    );
  }

  lock(id?: string): void {
    for (const account of id === undefined ? this.all : [this.get(id)]) account.lock();
  }

  async logins(hostname: string, tab?: Tab): Promise<LoginRef[]> {
    const lists = await this.#fromUnlocked((account) => account.logins(hostname, tab));
    return lists.flatMap(([account, logins]) =>
      logins.map(({ id, username }) => ({ ref: itemRef(account.id, id), account: account.id, username })),
    );
  }

  /** The usernames saved for a site, in one account or (by default) all unlocked ones. */
  async usernames(hostname: string, account?: Account): Promise<string[]> {
    if (account) return (await account.logins(hostname)).map((login) => login.username);
    return (await this.logins(hostname)).map((login) => login.username);
  }

  /** The login `ref` names (without its password), if it's still saved. */
  async login(hostname: string, ref: string): Promise<LoginRef> {
    const { account, id } = parseRef(ref);
    const login = await this.#unlockedAccount(account).login(hostname, id);
    if (!login) throw new AccountError("that login is no longer saved", "not-found");
    return { ref, account, username: login.username };
  }

  async credential(hostname: string, ref: string, tab: Tab): Promise<Credential> {
    const { account, id } = parseRef(ref);
    const credential = await this.#unlockedAccount(account).credential(hostname, id, tab);
    if (!credential) throw new AccountError("that login is no longer saved", "not-found");
    return credential;
  }

  async oneTimeCodes(url: URL, tab?: Tab): Promise<OneTimeCodeRef[]> {
    const lists = await this.#fromUnlocked(
      (account) => account.oneTimeCodes(url, tab),
      (account) => account.capabilities.oneTimeCodes,
    );
    return lists.flatMap(([account, codes]) =>
      codes.map(({ id, username, domain }) => ({
        ref: itemRef(account.id, id),
        account: account.id,
        username,
        domain,
      })),
    );
  }

  async oneTimeCode(url: URL, ref: string, tab: Tab): Promise<string | undefined> {
    const { account, id } = parseRef(ref);
    return this.#unlockedAccount(account).oneTimeCode(url, id, tab);
  }

  /**
   * The account a new login for `hostname` is saved to. With one account, that one; with more,
   * this is where a default, per-site choices or asking the user come in.
   */
  saveTarget(_hostname: string): Account {
    const target = this.unlocked.find((account) => account.capabilities.savePasswords);
    if (!target) throw new AccountError("unlock to save passwords", "locked");
    return target;
  }

  /** The account whose app opens: the first that has one. */
  appAccount(): Account | undefined {
    return this.all.find((account) => account.capabilities.openApp);
  }

  async settings(id: string): Promise<AccountSettings> {
    const entry = this.#entry(id);
    const stored = (await this.#load()).find((s) => s.id === id);
    return { ...(await entry.defaults()), ...stored?.settings };
  }

  async setSettings(id: string, changes: Partial<AccountSettings>): Promise<AccountSettings> {
    this.#entry(id);
    const stored = await this.#load();
    const next = stored.map((s) => (s.id === id ? { ...s, settings: { ...s.settings, ...changes } } : s));
    this.#stored = Promise.resolve(next);
    await this.store.save(next);
    return this.settings(id);
  }

  /** The accounts as pages see them. */
  async views(): Promise<AccountView[]> {
    return Promise.all(this.all.map((account) => this.#view(account)));
  }

  async #view(account: Account): Promise<AccountView> {
    const settings = await this.settings(account.id);
    let unlock: UnlockMethod;
    if (account.unlock.kind === "pairing-code") {
      // asked only when it can help: an account that's locked, not one before setup or unlocked
      const locked = ["offline", "locked", "unlocking"].includes(account.status.state);
      const touchId = settings.touchId && locked && (await account.unlock.touchIdReady?.());
      unlock = { kind: "pairing-code", digits: account.unlock.digits, ...(touchId ? { touchId: true } : {}) };
    } else {
      unlock = { kind: account.unlock.kind };
    }
    return {
      id: account.id,
      provider: account.provider,
      label: account.label,
      ...account.status,
      unlock,
      capabilities: account.capabilities,
      settings,
    };
  }

  #entry(id: string): Entry {
    const entry = this.#entries.find((e) => e.account.id === id);
    if (!entry) throw new AccountError("that account isn't connected", "unknown-account");
    return entry;
  }

  /** What's stored, with an entry for every account (added, and saved, on first use). */
  #load(): Promise<StoredAccount[]> {
    this.#stored ??= (async () => {
      const stored = (await this.store.load()) ?? [];
      const missing = this.all.filter((account) => !stored.some((s) => s.id === account.id));
      if (missing.length === 0) return stored;
      // accounts from before there were several start with the options the user had set
      const legacy = stored.length === 0 ? ((await this.store.legacy?.()) ?? {}) : {};
      const next = [
        ...stored,
        ...missing.map((account) => ({ id: account.id, provider: account.provider, settings: { ...legacy } })),
      ];
      await this.store.save(next);
      return next;
    })().catch((error) => {
      this.#stored = undefined;
      throw error;
    });
    return this.#stored;
  }

  #unlockedAccount(id: string): Account {
    const account = this.get(id);
    if (!account.isUnlocked) throw new AccountError(`${account.label} is locked`, "locked");
    return account;
  }

  /**
   * Asks every unlocked account (that `can`). One that fails is left out, unless all do: then its
   * error is the answer. None unlocked is an error too: pages ask only once unlocked.
   */
  async #fromUnlocked<T>(
    ask: (account: Account) => Promise<T>,
    can: (account: Account) => boolean = () => true,
  ): Promise<[Account, T][]> {
    const accounts = this.unlocked.filter(can);
    if (accounts.length === 0) {
      if (this.anyUnlocked) return [];
      throw new AccountError("unlock to see saved passwords", "locked");
    }
    const results = await Promise.allSettled(accounts.map(ask));
    const answered: [Account, T][] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") answered.push([accounts[i] as Account, result.value]);
    });
    const failed = results.find((result) => result.status === "rejected");
    if (answered.length === 0 && failed) throw failed.reason;
    return answered;
  }
}
