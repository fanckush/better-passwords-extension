// The accounts the extension fills from. Reads go to every unlocked account and are merged; each
// item carries a reference to the account it came from, so filling or reading it goes back there;
// saving goes to one account, chosen in one place (saveTarget). Accounts are kept in storage and
// can be added and removed; nothing here knows which providers they are.

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

export interface AccountsOptions {
  /** Makes the account a stored one names (undefined for a provider this version doesn't know). */
  create?: (stored: StoredAccount) => Entry | undefined;
  /** The accounts a new install starts with. */
  initial?: Omit<StoredAccount, "settings">[];
  /** The account new logins are saved to (the user's choice), if set. */
  saveTo?: () => Promise<string | undefined>;
}

export class AccountError extends Error {
  constructor(
    message: string,
    readonly code: "locked" | "unknown-account" | "no-account" | "not-found",
  ) {
    super(message);
  }
}

/** A site's address when only its hostname is known (around saves): its home page. */
export function siteUrl(hostname: string): URL {
  return new URL(`https://${hostname}/`);
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
  #entries: Entry[] = [];
  #stored: Promise<StoredAccount[]> | undefined;
  readonly #listeners = new Set<(account: Account, status: AccountStatus) => void>();
  readonly #codeListeners = new Set<() => void>();
  readonly #loginListeners = new Set<() => void>();
  readonly #unwatch = new Map<string, () => void>();
  /** Settles once the stored accounts are made: until then, the list may be incomplete. */
  readonly ready: Promise<void>;

  constructor(
    entries: Entry[],
    private readonly store: AccountsStore,
    private readonly options: AccountsOptions = {},
  ) {
    for (const entry of entries) this.#attach(entry);
    this.ready = this.#restore().catch(() => {});
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

  /** Called with each account's status as it changes, accounts added later included. */
  onChange(listener: (account: Account, status: AccountStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onOneTimeCodesChanged(listener: () => void): () => void {
    this.#codeListeners.add(listener);
    return () => this.#codeListeners.delete(listener);
  }

  /** Called when an account's logins changed by themselves (synced from elsewhere). */
  onLoginsChanged(listener: () => void): () => void {
    this.#loginListeners.add(listener);
    return () => this.#loginListeners.delete(listener);
  }

  /** Adds an account (just signed in, say) and keeps it for next time. */
  async add(entry: Entry): Promise<void> {
    await this.ready;
    if (this.#entries.some((e) => e.account.id === entry.account.id)) {
      throw new AccountError("that account is added already", "unknown-account");
    }
    const stored = await this.#load();
    this.#attach(entry);
    const { account } = entry;
    const next = [
      ...stored.filter((s) => s.id !== account.id),
      { id: account.id, provider: account.provider, settings: {} },
    ];
    this.#stored = Promise.resolve(next);
    await this.store.save(next);
    for (const listener of this.#listeners) listener(entry.account, entry.account.status);
  }

  /** Locks and forgets an account: it signs out, if it signs in. */
  async remove(id: string): Promise<void> {
    await this.ready;
    const entry = this.#entry(id);
    entry.account.lock();
    this.#unwatch.get(id)?.();
    this.#unwatch.delete(id);
    this.#entries = this.#entries.filter((e) => e !== entry);
    const next = (await this.#load()).filter((s) => s.id !== id);
    this.#stored = Promise.resolve(next);
    await this.store.save(next);
    await entry.account.remove?.();
  }

  /** Connects the accounts in `states` (by default those that lost their connection). */
  async connect(states: readonly AccountStatus["state"][] = ["offline"]): Promise<void> {
    await this.ready;
    await Promise.all(
      this.all.filter(({ status }) => states.includes(status.state)).map((a) => a.connect().catch(() => {})),
    );
  }

  lock(id?: string): void {
    for (const account of id === undefined ? this.all : [this.get(id)]) account.lock();
  }

  async logins(page: URL, tab?: Tab): Promise<LoginRef[]> {
    const lists = await this.#fromUnlocked((account) => account.logins(page, tab));
    return lists.flatMap(([account, logins]) =>
      logins.map(({ id, username }) => ({ ref: itemRef(account.id, id), account: account.id, username })),
    );
  }

  /** The usernames saved for a page, in one account or (by default) all unlocked ones. */
  async usernames(page: URL, account?: Account): Promise<string[]> {
    if (account) return (await account.logins(page)).map((login) => login.username);
    return (await this.logins(page)).map((login) => login.username);
  }

  /** The login `ref` names (without its password), if it's still saved. */
  async login(page: URL, ref: string): Promise<LoginRef> {
    const { account, id } = parseRef(ref);
    const login = await this.#unlockedAccount(account).login(page, id);
    if (!login) throw new AccountError("that login is no longer saved", "not-found");
    return { ref, account, username: login.username };
  }

  async credential(page: URL, ref: string, tab: Tab): Promise<Credential> {
    const { account, id } = parseRef(ref);
    const credential = await this.#unlockedAccount(account).credential(page, id, tab);
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
   * The account a login for `page` is saved to: a new password goes to the account that has the
   * login (by `username`); a new login to the account the user chose, else the first that saves.
   * The chosen account locked is an error, not a reason to save somewhere the user didn't pick.
   */
  async saveTarget(page: URL, username?: string): Promise<Account> {
    await this.ready;
    const savers = this.all.filter((account) => account.capabilities.savePasswords);
    const unlocked = savers.filter((account) => account.isUnlocked);
    if (username) {
      const lower = username.toLowerCase();
      for (const account of unlocked) {
        const logins = await account.logins(page).catch(() => []);
        if (logins.some((login) => login.username.toLowerCase() === lower)) return account;
      }
    }
    const chosen = await this.#chosenSaver(savers);
    if (chosen && !chosen.isUnlocked) throw new AccountError(`Unlock ${chosen.label} to save passwords`, "locked");
    const target = chosen ?? unlocked[0];
    if (!target) throw new AccountError("unlock to save passwords", "locked");
    return target;
  }

  async #chosenSaver(savers: Account[]): Promise<Account | undefined> {
    const id = await this.options.saveTo?.();
    return id === undefined ? undefined : savers.find((account) => account.id === id);
  }

  /** The account whose app opens: the first that has one and can be used here. */
  appAccount(): Account | undefined {
    return this.all.find(
      (account) => account.capabilities.openApp && !["needs-setup", "unavailable"].includes(account.status.state),
    );
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
    await this.ready;
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
      ...(account.detail ? { detail: account.detail } : {}),
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

  #attach(entry: Entry) {
    const { account } = entry;
    this.#entries.push(entry);
    const stops = [
      account.onChange((status) => {
        for (const listener of this.#listeners) listener(account, status);
      }),
      account.onOneTimeCodesChanged(() => {
        for (const listener of this.#codeListeners) listener();
      }),
      account.onLoginsChanged?.(() => {
        for (const listener of this.#loginListeners) listener();
      }) ?? (() => {}),
    ];
    this.#unwatch.set(account.id, () => {
      for (const stop of stops) stop();
    });
  }

  /** Makes the stored accounts (or, on a new install, the initial ones). */
  async #restore(): Promise<void> {
    const { create, initial = [] } = this.options;
    if (!create) return;
    const stored = (await this.store.load()) ?? initial.map((account) => ({ ...account, settings: {} }));
    for (const account of stored) {
      if (this.#entries.some((e) => e.account.id === account.id)) continue;
      const entry = create(account);
      if (entry) this.#attach(entry);
    }
  }

  /** What's stored, with an entry for every account (added, and saved, on first use). */
  #load(): Promise<StoredAccount[]> {
    this.#stored ??= (async () => {
      await this.ready;
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
