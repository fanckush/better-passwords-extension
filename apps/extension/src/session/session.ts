// Owns the connection to Apple's helper for the lifetime of the background worker.
//
// Apple's extension drops the connection whenever its worker sleeps, and every new connection
// means a new code. Keeping one port open keeps the worker (and the helper's session) alive, so
// the user pairs once per browser launch instead.

import { ApplePasswordsClient, type ClientState, ProtocolError, type Transport } from "@app/protocol";

/**
 * "no-helper": this browser has no registration for the helper (setup needed). "blocked": it has
 * one, but the helper quits before answering: macOS kills it when the browser isn't one Apple lets
 * start it (its launch constraints), which Better Passwords can't fix.
 */
export type SessionState = "disconnected" | "no-helper" | "blocked" | ClientState;

export interface SessionStatus {
  state: SessionState;
  error?: string;
  /** Blocked as an earlier worker found in this browser session, not by trying just now. */
  remembered?: true;
}

export interface SessionDeps {
  openTransport: () => Transport;
  browserName?: string;
  /**
   * Whether an earlier worker found the helper blocked in this browser session: its error ("" for
   * none), or undefined if it wasn't. Workers restart often, and each launch of a blocked helper
   * leaves a crash report on the Mac, so a blocked session stays blocked until the user retries.
   */
  blockedEarlier?: () => Promise<string | undefined>;
}

/** What a browser says when the helper quit: Chromium's words; Firefox may give none. */
const EXITED = /native host has exited|^connection closed$/i;
/** A helper that quit before answering gets one more try, in case it just crashed. */
const RETRY_MS = 300;

/**
 * The errors when the host registration is missing or excludes this extension: Chromium's, then
 * Firefox's.
 */
const MISSING_HOST = /not found|forbidden|access to the specified native messaging host|no such native application/i;

export class Session {
  #client: ApplePasswordsClient | undefined;
  #connecting: Promise<ApplePasswordsClient> | undefined;
  #status: SessionStatus = { state: "disconnected" };
  #listeners = new Set<(status: SessionStatus) => void>();
  #restored: Promise<void>;

  constructor(private readonly deps: SessionDeps) {
    this.#restored = Promise.resolve(deps.blockedEarlier?.())
      .then((error) => {
        if (error === undefined || this.#client || this.#connecting) return;
        this.#set({ state: "blocked", ...(error ? { error } : {}), remembered: true });
      })
      .catch(() => {});
  }

  get status(): SessionStatus {
    return this.#status;
  }

  get isUnlocked(): boolean {
    return this.#client?.state === "unlocked";
  }

  onChange(listener: (status: SessionStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Connects if needed. Never re-pairs a live session. While macOS blocks the helper here, only
   * `retry` (the user asking) launches it again; anything else fails with code "blocked".
   */
  async connect({ retry = false }: { retry?: boolean } = {}): Promise<ApplePasswordsClient> {
    await this.#restored;
    if (this.#client && this.#client.state !== "closed") return this.#client;
    if (this.#status.state === "blocked" && !retry && !this.#connecting) {
      throw Object.assign(new Error("macOS doesn't let Apple's password helper run in this browser."), {
        code: "blocked",
      });
    }
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  /** Shows a code on the Mac, unless one is already on screen or the session is unlocked. */
  async requestCode(): Promise<void> {
    const client = await this.connect();
    if (client.state === "unlocked" || client.hasLiveChallenge) return;
    await this.#track(client.requestChallenge());
  }

  /** Forces a fresh code, replacing one the user may have lost. */
  async requestNewCode(): Promise<void> {
    const client = await this.connect();
    await this.#track(client.requestChallenge());
  }

  async verifyCode(code: string): Promise<void> {
    if (!/^\d{6}$/.test(code)) throw new ProtocolError("the code has 6 digits", "incorrect-code");
    const client = await this.connect();
    await this.#track(client.verifyCode(code));
  }

  async unlockedClient(): Promise<ApplePasswordsClient> {
    const client = await this.connect();
    if (client.state !== "unlocked") throw new ProtocolError("not paired", "closed");
    return client;
  }

  /** Ends the session. Closing the port makes Apple's helper exit and forget the key. */
  lock(): void {
    this.#client?.close();
    this.#client = undefined;
    this.#set({ state: "disconnected" });
  }

  /** A helper that quits before answering once may just have crashed; twice, it's blocked. */
  async #open(): Promise<ApplePasswordsClient> {
    try {
      return await this.#attempt(false);
    } catch (error) {
      if (!(error instanceof HelperExited)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      return this.#attempt(true);
    }
  }

  /** `last`: a helper that quits before answering now counts as blocked. */
  async #attempt(last: boolean): Promise<ApplePasswordsClient> {
    let transport: Transport;
    try {
      transport = this.deps.openTransport();
    } catch (error) {
      this.#set({ state: "no-helper", error: message(error) });
      throw error;
    }

    let closed = false;
    let closeError: string | undefined;
    transport.onClose((error) => {
      closed = true;
      closeError = error;
    });
    try {
      const client = await ApplePasswordsClient.connect(
        transport,
        this.deps.browserName ? { browserName: this.deps.browserName } : {},
      );
      client.onStateChange((state) => {
        if (state === "closed") {
          if (this.#client === client) this.#client = undefined;
          this.#set(
            closeError && MISSING_HOST.test(closeError) ? { state: "no-helper", error: closeError } : { state },
          );
        } else {
          this.#set({ state });
        }
      });
      this.#client = client;
      this.#set({ state: client.state });
      return client;
    } catch (error) {
      const reason = closeError ?? message(error);
      if (MISSING_HOST.test(reason)) {
        this.#set({ state: "no-helper", error: reason });
        throw error;
      }
      // the registration is there, but the helper quit before its first answer
      const quit = closed || (error instanceof ProtocolError && error.code === "closed");
      if (quit && EXITED.test(reason)) {
        if (!last) throw new HelperExited();
        this.#set({ state: "blocked", error: reason });
        throw error;
      }
      this.#set({ state: "disconnected", error: reason });
      throw error;
    }
  }

  async #track<T>(operation: Promise<T>): Promise<T> {
    try {
      const result = await operation;
      return result;
    } catch (error) {
      this.#set({ state: this.#client?.state ?? "disconnected", error: message(error) });
      throw error;
    }
  }

  #set(status: SessionStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The helper quit before its first answer, on a first try (see #open). */
class HelperExited extends Error {
  constructor() {
    super("the helper quit before answering");
  }
}
