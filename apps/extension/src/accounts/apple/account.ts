// Apple Passwords as an Account: Apple's password helper, reached through its native host and kept
// open by Session. Everything Apple-specific about it stays in here: the 6-digit pairing code, the
// helper macOS may refuse to start, the stand-in tab its lookups use, and the companion app
// entering the code after Touch ID.

import type { ApplePasswordsClient, Transport } from "@app/protocol";
import { findOneTimeCodes, oneTimeCodeId } from "../../passwords/one-time-codes.ts";
import type { Platform } from "../../platform.ts";
import type {
  Account,
  AccountSettings,
  AccountState,
  AccountStatus,
  Capabilities,
  Credential,
  LoginItem,
  OneTimeCodeItem,
  PairingCodeUnlock,
  Tab,
} from "../types.ts";
import { Session, type SessionState, type SessionStatus } from "./session.ts";

export const APPLE_PROVIDER = "apple";

/**
 * A tab id for our own lookups. Around a save the helper sends the real tab unrequested updates
 * that list no logins; replies echo the tab id, so these can't be mistaken for ours.
 */
const PROBE_TAB = { tabId: 2 ** 31 - 1, frameId: 0 };

export interface AppleAccountDeps {
  openTransport: () => Transport;
  browserName?: string;
  /** See SessionDeps.blockedEarlier. */
  blockedEarlier?: () => Promise<string | undefined>;
  /** Whether this is Windows, where the helper lists codes per account only (see findOneTimeCodes). */
  windows?: () => Promise<boolean>;
  /** The code on Apple's window, read by the companion app after Touch ID. */
  readCode?: () => Promise<string>;
  /** Whether the companion app is ready to read the code. */
  touchIdReady?: () => Promise<boolean>;
}

/**
 * The defaults on this platform. Apple's helper on Windows never asks before giving out a password,
 * so there the session ends when the PC locks unless the user says otherwise.
 */
export function appleDefaultSettings(platform: Platform): AccountSettings {
  return { lockOnScreenLock: platform === "windows", touchId: true };
}

const STATES: Record<SessionState, AccountState> = {
  "no-helper": "needs-setup",
  blocked: "unavailable",
  disconnected: "offline",
  closed: "offline",
  locked: "locked",
  "awaiting-code": "unlocking",
  unlocked: "unlocked",
};

function accountStatus({ state, error, remembered }: SessionStatus): AccountStatus {
  return { state: STATES[state], ...(error === undefined ? {} : { error }), ...(remembered ? { remembered } : {}) };
}

export class AppleAccount implements Account {
  readonly provider = APPLE_PROVIDER;
  readonly label = "Apple Passwords";
  readonly capabilities: Capabilities = { oneTimeCodes: true, savePasswords: true, openApp: true };
  readonly unlock: PairingCodeUnlock;
  readonly #session: Session;
  #codeListeners = new Set<() => void>();

  constructor(
    readonly id: string,
    private readonly deps: AppleAccountDeps,
  ) {
    this.#session = new Session({
      openTransport: deps.openTransport,
      ...(deps.browserName ? { browserName: deps.browserName } : {}),
      ...(deps.blockedEarlier ? { blockedEarlier: deps.blockedEarlier } : {}),
    });
    // each new connection announces its codes; listeners outlive connections
    const announcing = new WeakSet<object>();
    this.#session.onChange(async ({ state }) => {
      if (state !== "unlocked") return;
      const client = await this.#session.unlockedClient().catch(() => undefined);
      if (!client || announcing.has(client)) return;
      announcing.add(client);
      client.onOneTimeCodeAvailable(() => {
        for (const listener of this.#codeListeners) listener();
      });
    });
    this.unlock = this.#pairingCodeUnlock();
  }

  get status(): AccountStatus {
    return accountStatus(this.#session.status);
  }

  get isUnlocked(): boolean {
    return this.#session.isUnlocked;
  }

  onChange(listener: (status: AccountStatus) => void): () => void {
    return this.#session.onChange((status) => listener(accountStatus(status)));
  }

  onOneTimeCodesChanged(listener: () => void): () => void {
    this.#codeListeners.add(listener);
    return () => this.#codeListeners.delete(listener);
  }

  async connect(options: { retry?: boolean } = {}): Promise<void> {
    await this.#session.connect(options);
  }

  /** Closing the port makes Apple's helper exit and forget the key. */
  lock(): void {
    this.#session.lock();
  }

  async logins(hostname: string, tab: Tab = PROBE_TAB): Promise<LoginItem[]> {
    const client = await this.#session.unlockedClient();
    return (await client.getLogins(hostname, tab)).map(({ username }) => ({ id: username, username }));
  }

  /** Apple names logins by username within a site, so there's nothing to look up. */
  async login(_hostname: string, id: string): Promise<LoginItem | undefined> {
    return { id, username: id };
  }

  async credential(hostname: string, id: string, tab: Tab): Promise<Credential | undefined> {
    const client = await this.#session.unlockedClient();
    return client.getPassword(hostname, id, tab);
  }

  async oneTimeCodes(url: URL): Promise<OneTimeCodeItem[]> {
    const client = await this.#session.unlockedClient();
    return (await this.#codes(client, url)).map((code) => ({
      id: oneTimeCodeId(code),
      username: code.username,
      domain: code.domain,
    }));
  }

  async oneTimeCode(url: URL, id: string, tab: Tab): Promise<string | undefined> {
    const client = await this.#session.unlockedClient();
    const chosen = (await this.#codes(client, url)).find((code) => oneTimeCodeId(code) === id);
    if (!chosen) throw new Error("that verification code is no longer saved");
    return client.currentOneTimeCode(chosen, [url.href], tab);
  }

  async save(login: { hostname: string; username: string; password: string }, { tabId }: Tab): Promise<void> {
    const client = await this.#session.unlockedClient();
    await client.savePassword(login, { tabId, frameId: 0 });
  }

  async openApp(url?: string): Promise<void> {
    const client = await this.#session.connect();
    client.openPasswordsApp(url);
  }

  /** The codes for a page, asked for a stand-in tab, like logins (see PROBE_TAB). */
  async #codes(client: ApplePasswordsClient, url: URL) {
    const windows = (await this.deps.windows?.()) ?? false;
    const usernames = async () => (await this.logins(url.hostname)).map((login) => login.username);
    return findOneTimeCodes(client, [url.href], PROBE_TAB, windows, usernames);
  }

  #pairingCodeUnlock(): PairingCodeUnlock {
    const session = this.#session;
    const { readCode, touchIdReady } = this.deps;
    return {
      kind: "pairing-code",
      digits: 6,
      requestCode: (fresh) => (fresh ? session.requestNewCode() : session.requestCode()),
      verifyCode: (code) => session.verifyCode(code),
      ...(touchIdReady ? { touchIdReady } : {}),
      ...(readCode
        ? {
            unlockWithTouchId: async () => {
              if (session.isUnlocked) return;
              // fresh, like typing the code: one asked for earlier may be valid still, but its window closed
              await session.requestNewCode();
              const code = await readCode();
              try {
                await session.verifyCode(code);
              } catch (error) {
                // a wrong code burns the challenge; put a fresh one on screen for typing instead
                await session.requestNewCode().catch(() => {});
                throw error;
              }
            },
          }
        : {}),
    };
  }
}
