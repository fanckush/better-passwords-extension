// Owns the connection to Apple's helper for the lifetime of the background worker.
//
// Apple's extension drops the connection whenever its worker sleeps, and every new connection
// means a new code. Keeping one port open keeps the worker (and the helper's session) alive, so
// the user pairs once per browser launch instead.

import { ApplePasswordsClient, type ClientState, ProtocolError, type Transport } from "@app/protocol";

export type SessionState = "disconnected" | "no-helper" | ClientState;

export interface SessionStatus {
  state: SessionState;
  error?: string;
}

export interface SessionDeps {
  openTransport: () => Transport;
  browserName?: string;
}

/** Chromium's errors when the host registration is missing or excludes this extension. */
const MISSING_HOST = /not found|forbidden|access to the specified native messaging host/i;

export class Session {
  #client: ApplePasswordsClient | undefined;
  #connecting: Promise<ApplePasswordsClient> | undefined;
  #status: SessionStatus = { state: "disconnected" };
  #listeners = new Set<(status: SessionStatus) => void>();
  #openingTransport: Transport | undefined;
  #generation = 0;

  constructor(private readonly deps: SessionDeps) {}

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

  /** Connects if needed. Never re-pairs a live session. */
  async connect(): Promise<ApplePasswordsClient> {
    if (this.#client && this.#client.state !== "closed") return this.#client;
    if (!this.#connecting) {
      const connecting = this.#open(this.#generation).finally(() => {
        if (this.#connecting === connecting) this.#connecting = undefined;
      });
      this.#connecting = connecting;
    }
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

  /** Rechecks permission immediately before delivering a secret obtained asynchronously. */
  assertCurrent(client: ApplePasswordsClient): void {
    if (this.#client !== client || !this.isUnlocked) throw new ProtocolError("session ended", "closed");
  }

  /** Ends the session. Closing the port makes Apple's helper exit and forget the key. */
  lock(): void {
    this.#generation++;
    this.#connecting = undefined;
    this.#openingTransport?.close();
    this.#openingTransport = undefined;
    this.#client?.close();
    this.#client = undefined;
    this.#set({ state: "disconnected" });
  }

  async #open(generation: number): Promise<ApplePasswordsClient> {
    let transport: Transport;
    try {
      transport = this.deps.openTransport();
      this.#openingTransport = transport;
    } catch (error) {
      this.#set({ state: "no-helper", error: message(error) });
      throw error;
    }

    let closeError: string | undefined;
    transport.onClose((error) => {
      closeError = error;
    });
    try {
      const client = await ApplePasswordsClient.connect(
        transport,
        this.deps.browserName ? { browserName: this.deps.browserName } : {},
      );
      if (generation !== this.#generation) {
        client.close();
        throw new ProtocolError("session ended", "closed");
      }
      client.onStateChange((state) => {
        if (this.#client !== client || generation !== this.#generation) return;
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
      transport.close();
      const reason = closeError ?? message(error);
      if (generation === this.#generation)
        this.#set(
          MISSING_HOST.test(reason) ? { state: "no-helper", error: reason } : { state: "disconnected", error: reason },
        );
      throw error;
    } finally {
      if (this.#openingTransport === transport) this.#openingTransport = undefined;
    }
  }

  async #track<T>(operation: Promise<T>): Promise<T> {
    const generation = this.#generation;
    try {
      const result = await operation;
      return result;
    } catch (error) {
      if (generation === this.#generation)
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
