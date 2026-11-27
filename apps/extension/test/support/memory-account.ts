// A second kind of account, for tests only: an in-memory vault that unlocks with a password and
// names logins by id, unlike Apple's. It keeps the registry honest about what an account is.

import type {
  Account,
  AccountStatus,
  Capabilities,
  Credential,
  LoginItem,
  OneTimeCodeItem,
  PasswordUnlock,
  Tab,
} from "../../src/accounts/types.ts";

export interface MemoryLogin {
  id: string;
  hostname: string;
  username: string;
  password: string;
}

export class MemoryAccount implements Account {
  readonly provider = "memory";
  readonly capabilities: Capabilities = { oneTimeCodes: false, savePasswords: true, openApp: false };
  readonly unlock: PasswordUnlock;
  readonly saved: { hostname: string; username: string; password: string }[] = [];
  #status: AccountStatus = { state: "locked" };
  #listeners = new Set<(status: AccountStatus) => void>();
  #nextId = 0;

  constructor(
    readonly id: string,
    readonly label: string,
    readonly vault: MemoryLogin[],
    password = "secret",
  ) {
    this.unlock = {
      kind: "password",
      unlock: async (given) => {
        if (given !== password) throw new Error("wrong password");
        this.#set({ state: "unlocked" });
      },
    };
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

  onOneTimeCodesChanged(): () => void {
    return () => {};
  }

  async connect(): Promise<void> {}

  lock(): void {
    this.#set({ state: "locked" });
  }

  async logins(hostname: string): Promise<LoginItem[]> {
    this.#assertUnlocked();
    return this.vault.filter((l) => l.hostname === hostname).map(({ id, username }) => ({ id, username }));
  }

  async login(hostname: string, id: string): Promise<LoginItem | undefined> {
    return (await this.logins(hostname)).find((login) => login.id === id);
  }

  async credential(hostname: string, id: string, _tab: Tab): Promise<Credential | undefined> {
    this.#assertUnlocked();
    const login = this.vault.find((l) => l.hostname === hostname && l.id === id);
    return login && { username: login.username, password: login.password };
  }

  async oneTimeCodes(): Promise<OneTimeCodeItem[]> {
    return [];
  }

  async oneTimeCode(): Promise<string | undefined> {
    return undefined;
  }

  async save(login: { hostname: string; username: string; password: string }): Promise<void> {
    this.#assertUnlocked();
    this.saved.push(login);
    this.vault.push({ id: `new-${this.#nextId++}`, ...login });
  }

  async openApp(): Promise<void> {
    throw new Error("no app");
  }

  #assertUnlocked() {
    if (!this.isUnlocked) throw new Error("locked");
  }

  #set(status: AccountStatus) {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }
}
