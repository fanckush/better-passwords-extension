// A Bitwarden account (bitwarden.com or .eu) as an Account. Bitwarden has no app on the computer we
// could ask, so the extension is the client: it signs in, keeps the vault as Bitwarden sends it
// (encrypted) and decrypts it in memory once the master password opens the user key.
//
// Signed in is not unlocked. On disk (storage.local): who, where, the tokens, the wrapped user key
// and the encrypted vault. In memory only (storage.session, which outlives a background worker but
// not the browser, and content scripts can't read): the user key, once unlocked.

import {
  type BitwardenClient,
  BitwardenError,
  type CipherData,
  type CipherRequest,
  decryptVault,
  fromBase64,
  type KdfConfig,
  loginsFor,
  masterKey,
  newLoginRequest,
  newPasswordRequest,
  openUserKey,
  type Region,
  SERVERS,
  type SignInRequest,
  type SymmetricKey,
  type SyncData,
  symmetricKey,
  type Tokens,
  toBase64,
  type Vault,
  type VaultLogin,
} from "@app/bitwarden";
import { otpCode, parseOtp } from "@app/otp";
import { siteUrl } from "../registry.ts";
import type {
  Account,
  AccountStatus,
  Capabilities,
  Credential,
  LoginItem,
  OneTimeCodeItem,
  PasswordUnlock,
} from "../types.ts";

export const BITWARDEN_PROVIDER = "bitwarden";

/** What's kept on disk for a Bitwarden account. Nothing in it opens the vault without the master password. */
export interface BitwardenRecord {
  region: Region;
  email: string;
  kdf: KdfConfig;
  /** The user key, wrapped with the master password's key. */
  protectedUserKey: string;
  /** Null once Bitwarden signed this browser out: the email and region stay, to sign in again. */
  tokens: Tokens | null;
  /** The vault as /sync gave it, encrypted. */
  vault: SyncData | null;
  syncedAt: number;
}

/** What tells two copies of a vault apart: each item and when it last changed. */
function revisions(data: SyncData | null): string {
  return (data?.ciphers ?? []).map((c) => `${c.id}@${c.revisionDate}`).join(",");
}

/** The unlocked user key, kept in memory only, and when the vault was last used. */
export interface UnlockedKey {
  key: string;
  lastUsed: number;
}

export interface BitwardenStore {
  load(): Promise<BitwardenRecord | undefined>;
  save(record: BitwardenRecord): Promise<void>;
  loadKey(): Promise<UnlockedKey | undefined>;
  saveKey(key: UnlockedKey): Promise<void>;
  clearKey(): Promise<void>;
  /** Forgets the account here: signs out (removing it). */
  clear(): Promise<void>;
}

export interface BitwardenDeps {
  store: BitwardenStore;
  client(region: Region): Promise<BitwardenClient>;
  /** The account's "lock after" setting, in minutes (0: never while the browser runs). */
  lockAfterMinutes(): Promise<number>;
  argon2?: Parameters<typeof masterKey>[3];
  now?: () => number;
  /** Opens a page in a new tab (the web vault). */
  openTab?: (url: string) => Promise<void>;
}

/** What a sign-in step asks next, if anything. */
export type SignInStep =
  | { status: "signed-in" }
  | { status: "two-factor"; providers: number[]; email?: string }
  | { status: "new-device" };

/**
 * Vaults this old are synced when next used (a menu opening, say), in the background: what's there
 * is shown at once, and again if the sync brought changes. A login just added in Bitwarden's own
 * apps shows up the next time the user looks, about.
 */
const SYNC_AFTER_MS = 60_000;
/** The last-used time is written at most this often. */
const TOUCH_EVERY_MS = 30_000;

export class BitwardenAccount implements Account {
  readonly provider = BITWARDEN_PROVIDER;
  readonly label = "Bitwarden";
  readonly capabilities: Capabilities = {
    oneTimeCodes: true,
    savePasswords: true,
    // the web vault, which Bitwarden's own apps link to as well
    openApp: true,
    asksBeforeSaving: false,
  };
  readonly unlock: PasswordUnlock = { kind: "password", unlock: (password) => this.#unlock(password) };
  // not read from storage yet: "offline" until connect() has (accounts.connect() covers it)
  #status: AccountStatus = { state: "offline" };
  #connecting: Promise<void> | undefined;
  #record: BitwardenRecord | undefined;
  #open: { vault: Vault; lastUsed: number; touched: number } | undefined;
  #syncing: Promise<void> | undefined;
  #refreshing: Promise<Tokens> | undefined;
  readonly #listeners = new Set<(status: AccountStatus) => void>();
  readonly #codeListeners = new Set<() => void>();
  readonly #loginListeners = new Set<() => void>();

  constructor(
    readonly id: string,
    private readonly deps: BitwardenDeps,
  ) {}

  get detail(): string | undefined {
    return this.#record?.email;
  }

  get status(): AccountStatus {
    return this.#status;
  }

  get isUnlocked(): boolean {
    return this.#status.state === "unlocked";
  }

  onChange(listener: (status: AccountStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onOneTimeCodesChanged(listener: () => void): () => void {
    this.#codeListeners.add(listener);
    return () => this.#codeListeners.delete(listener);
  }

  onLoginsChanged(listener: () => void): () => void {
    this.#loginListeners.add(listener);
    return () => this.#loginListeners.delete(listener);
  }

  /** Reads what's stored; reopens the vault if this browser session unlocked it (a new worker). */
  connect(): Promise<void> {
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connect(): Promise<void> {
    if (this.#open) return;
    this.#record = await this.deps.store.load();
    if (!this.#record?.tokens) {
      this.#set({ state: "needs-setup", ...(this.#record ? { error: "Signed out. Sign in again." } : {}) });
      return;
    }
    const saved = await this.deps.store.loadKey();
    if (saved && !(await this.#idle(saved.lastUsed))) {
      await this.#openVault(symmetricKey(fromBase64(saved.key)), saved.lastUsed);
      return;
    }
    if (saved) await this.deps.store.clearKey();
    this.#set({ state: "locked" });
  }

  /**
   * Signs in (again): Bitwarden may ask for a two-step code or, for a new device, an emailed one;
   * the caller asks the user and calls again with the same request plus the code.
   */
  async signIn(request: SignInRequest & { region: Region }): Promise<SignInStep> {
    const client = await this.deps.client(request.region);
    const result = await client.signIn(request);
    if (result.status !== "signed-in") return result;
    const { account } = result;
    const user = await openUserKey(account.protectedUserKey, account.masterKey);
    const record: BitwardenRecord = {
      region: request.region,
      email: request.email.trim().toLowerCase(),
      kdf: account.kdf,
      protectedUserKey: account.protectedUserKey,
      tokens: account.tokens,
      vault: null,
      syncedAt: 0,
    };
    this.#record = record;
    await this.deps.store.save(record);
    await this.#openVault(user, this.#now());
    await this.sync();
    return { status: "signed-in" };
  }

  /** Asks Bitwarden to email a two-step code, for accounts that use email codes. */
  async sendEmailCode(request: { region: Region; email: string; password: string }): Promise<void> {
    const client = await this.deps.client(request.region);
    await client.sendEmailCode(request.email, request.password, await client.prelogin(request.email));
  }

  lock(): void {
    this.#open = undefined;
    void this.deps.store.clearKey().catch(() => {});
    if (this.#record?.tokens) this.#set({ state: "locked" });
  }

  /** Locks if unused for longer than the account's setting allows. */
  async lockIfIdle(): Promise<void> {
    if (this.#open && (await this.#idle(this.#open.lastUsed))) this.lock();
  }

  /** Signs out here: the tokens, keys and vault are forgotten. */
  async remove(): Promise<void> {
    this.#open = undefined;
    this.#record = undefined;
    await this.deps.store.clear();
    this.#set({ state: "needs-setup" });
  }

  /** Downloads the vault again, at most one sync at a time. Failing to reach Bitwarden keeps the copy. */
  sync(): Promise<void> {
    this.#syncing ??= (async () => {
      try {
        const data = await this.#authorized((token) => this.#client().then((client) => client.sync(token)));
        await this.#keep(data);
      } catch (error) {
        if (!(error instanceof BitwardenError) || error.code === "unauthorized") throw error;
      } finally {
        this.#syncing = undefined;
      }
    })();
    return this.#syncing;
  }

  async logins(page: URL): Promise<LoginItem[]> {
    return (await this.#matching(page)).map(({ id, username }) => ({ id, username }));
  }

  async login(page: URL, id: string): Promise<LoginItem | undefined> {
    return (await this.logins(page)).find((login) => login.id === id);
  }

  /** Only for a login saved for this page: a login is never filled into a site it isn't for. */
  async credential(page: URL, id: string): Promise<Credential | undefined> {
    const login = (await this.#matching(page)).find((l) => l.id === id);
    if (!login) return undefined;
    if (login.reprompt) throw new Error("This login asks for your master password first. Use it from Bitwarden.");
    return { username: login.username, password: login.password };
  }

  async oneTimeCodes(url: URL): Promise<OneTimeCodeItem[]> {
    return (await this.#matching(url))
      .filter((login) => login.totp && parseOtp(login.totp))
      .map(({ id, username }) => ({ id, username, domain: url.hostname }));
  }

  async oneTimeCode(url: URL, id: string): Promise<string | undefined> {
    const login = (await this.#matching(url)).find((l) => l.id === id);
    const setup = login?.totp ? parseOtp(login.totp) : undefined;
    if (!setup) throw new Error("that verification code is no longer saved");
    if (login?.reprompt) throw new Error("This login asks for your master password first. Use it from Bitwarden.");
    return (await otpCode(setup, this.#now())).code;
  }

  /**
   * Saves a login for a site: a new password for the login with that username, else a new login
   * (in the personal vault). Bitwarden doesn't ask first: the extension asked already.
   */
  async save(login: { hostname: string; username: string; password: string }): Promise<void> {
    await this.#save(login, true);
  }

  /** The web vault of the account's region, searching for the page's site (its `search` parameter). */
  async openApp(url?: string): Promise<void> {
    const record = this.#record ?? (await this.deps.store.load());
    const vault = SERVERS[record?.region ?? "us"].vault;
    const site = url ? new URL(url).hostname.replace(/^www\./, "") : "";
    await this.deps.openTab?.(`${vault}/#/vault${site ? `?search=${encodeURIComponent(site)}` : ""}`);
  }

  async #save(login: { hostname: string; username: string; password: string }, retry: boolean): Promise<void> {
    const vault = await this.#vault();
    const page = siteUrl(login.hostname);
    const lower = login.username.toLowerCase();
    const existing = loginsFor(vault, page).find((l) => l.username.toLowerCase() === lower);
    if (existing?.password === login.password) return;
    const cipher = existing && this.#record?.vault?.ciphers.find((c) => c.id === existing.id);
    let request: CipherRequest;
    if (cipher) request = await newPasswordRequest(cipher, login.password, vault.keys);
    else {
      const fields = { name: login.hostname, username: login.username, password: login.password, uri: page.origin };
      request = await newLoginRequest(fields, vault.keys);
    }
    let saved: CipherData;
    try {
      saved = await this.#authorized(async (token) => {
        const client = await this.#client();
        return cipher ? client.updateCipher(token, cipher.id, request) : client.createCipher(token, request);
      });
    } catch (error) {
      // changed elsewhere since the last sync: sync, and try again on what's saved now
      if (retry && error instanceof BitwardenError && error.code === "out-of-date") {
        await this.sync();
        return this.#save(login, false);
      }
      throw error;
    }
    const data = this.#record?.vault;
    if (!data) return this.sync();
    const ciphers = data.ciphers.filter((c) => c.id !== saved.id);
    await this.#keep({ ...data, ciphers: [...ciphers, saved] });
  }

  async #unlock(password: string): Promise<void> {
    const record = this.#record ?? (await this.deps.store.load());
    if (!record?.tokens) throw new Error("Sign in to Bitwarden first.");
    this.#record = record;
    let user: SymmetricKey;
    try {
      user = await this.#openUserKey(password, record);
    } catch {
      // the master password, or its settings, may have changed elsewhere: check with Bitwarden
      if (!(await this.#refreshKeys().catch(() => false))) throw new Error("Wrong master password.");
      user = await this.#openUserKey(password, this.#record).catch(() => {
        throw new Error("Wrong master password.");
      });
    }
    await this.#openVault(user, this.#now());
    void this.sync().catch(() => {});
  }

  async #openUserKey(password: string, record: BitwardenRecord): Promise<SymmetricKey> {
    const key = await masterKey(password, record.email, record.kdf, this.deps.argon2);
    return openUserKey(record.protectedUserKey, key);
  }

  /** Fetches the key settings and wrapped user key again: whether either changed. */
  async #refreshKeys(): Promise<boolean> {
    const record = this.#record;
    if (!record) return false;
    const client = await this.#client();
    const kdf = await client.prelogin(record.email);
    const data = await this.#authorized((token) => client.sync(token));
    const changed = JSON.stringify(kdf) !== JSON.stringify(record.kdf) || data.profile.key !== record.protectedUserKey;
    this.#record = { ...record, kdf, protectedUserKey: data.profile.key, vault: data, syncedAt: this.#now() };
    await this.deps.store.save(this.#record);
    return changed;
  }

  async #openVault(user: SymmetricKey, lastUsed: number): Promise<void> {
    const data = this.#record?.vault;
    const vault = data
      ? await decryptVault(data, user)
      : { keys: { user, organizations: new Map() }, logins: [], unreadable: 0 };
    this.#open = { vault, lastUsed, touched: lastUsed };
    await this.deps.store.saveKey({ key: toBase64(new Uint8Array([...user.enc, ...user.mac])), lastUsed });
    this.#set({ state: "unlocked" });
  }

  /** Keeps a vault Bitwarden sent: on disk as it came, and decrypted while unlocked. */
  async #keep(data: SyncData): Promise<void> {
    const record = this.#record;
    if (!record) return;
    const changed = revisions(record.vault) !== revisions(data);
    // a master password changed elsewhere wraps the same user key anew: unlocking needs the new one
    this.#record = {
      ...record,
      protectedUserKey: data.profile.key || record.protectedUserKey,
      vault: data,
      syncedAt: this.#now(),
    };
    await this.deps.store.save(this.#record);
    if (this.#open && changed) {
      this.#open.vault = await decryptVault(data, this.#open.vault.keys.user);
      for (const listener of this.#codeListeners) listener();
      for (const listener of this.#loginListeners) listener();
    }
  }

  /** The open vault, as it's used: locks first if it sat unused too long; syncs a stale copy after. */
  async #vault(): Promise<Vault> {
    const open = this.#open;
    if (!open || !this.isUnlocked) throw new Error("Bitwarden is locked");
    if (await this.#idle(open.lastUsed)) {
      this.lock();
      throw new Error("Bitwarden is locked");
    }
    const now = this.#now();
    open.lastUsed = now;
    if (now - open.touched >= TOUCH_EVERY_MS) {
      open.touched = now;
      const user = open.vault.keys.user;
      void this.deps.store
        .saveKey({ key: toBase64(new Uint8Array([...user.enc, ...user.mac])), lastUsed: now })
        .catch(() => {});
    }
    if (now - (this.#record?.syncedAt ?? 0) >= SYNC_AFTER_MS) void this.sync().catch(() => {});
    return open.vault;
  }

  async #matching(page: URL): Promise<VaultLogin[]> {
    return loginsFor(await this.#vault(), page);
  }

  async #idle(lastUsed: number): Promise<boolean> {
    const minutes = await this.deps.lockAfterMinutes();
    return minutes > 0 && this.#now() - lastUsed >= minutes * 60_000;
  }

  #client(): Promise<BitwardenClient> {
    const record = this.#record;
    if (!record) return Promise.reject(new Error("Sign in to Bitwarden first."));
    return this.deps.client(record.region);
  }

  /** Calls Bitwarden with a fresh access token, refreshing it first, or once more after a 401. */
  async #authorized<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    const tokens = this.#record?.tokens;
    if (!tokens) throw new BitwardenError("Signed out. Sign in again.", "unauthorized");
    const access = tokens.expiresAt - this.#now() < 60_000 ? (await this.#refresh()).accessToken : tokens.accessToken;
    try {
      return await call(access);
    } catch (error) {
      if (!(error instanceof BitwardenError) || error.code !== "unauthorized") throw error;
      return call((await this.#refresh()).accessToken);
    }
  }

  #refresh(): Promise<Tokens> {
    this.#refreshing ??= (async () => {
      const record = this.#record;
      if (!record?.tokens) throw new BitwardenError("Signed out. Sign in again.", "unauthorized");
      try {
        const tokens = await (await this.#client()).refresh(record.tokens.refreshToken);
        this.#record = { ...record, tokens };
        await this.deps.store.save(this.#record);
        return tokens;
      } catch (error) {
        if (error instanceof BitwardenError && error.code === "unauthorized") await this.#signedOut();
        throw error;
      }
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /** Bitwarden ended the session (signed out elsewhere, password changed): keep only who and where. */
  async #signedOut(): Promise<void> {
    const record = this.#record;
    if (!record) return;
    this.#open = undefined;
    this.#record = { ...record, tokens: null, vault: null, syncedAt: 0 };
    await this.deps.store.save(this.#record);
    await this.deps.store.clearKey();
    this.#set({ state: "needs-setup", error: "Signed out. Sign in again." });
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  #set(status: AccountStatus) {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }
}
