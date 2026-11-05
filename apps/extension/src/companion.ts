// The optional Mac companion app (apps/companion). After Touch ID it reads the pairing code off
// Apple's window, so the user doesn't have to type it. It is a separate native host, and the
// extension works the same without it. There is none for Windows.

import { COMPANION_HOST } from "./config.ts";

/**
 * "ready": installed and allowed; "needs-setup": installed but Accessibility is off;
 * "unavailable": not on a Mac, so there's no app to offer.
 */
export type CompanionState = "ready" | "needs-setup" | "not-installed" | "unavailable";

/**
 * A newer companion app is out. "app": the app updates itself once opened. "download": an app from
 * before it could, replaced by downloading the new one.
 */
export interface CompanionUpdate {
  how: "app" | "download";
  /** Unknown for "download": those apps don't say. */
  version?: string;
}

/** The first protocol version whose hello reports updates (the app updates itself from then on). */
const UPDATES_VERSION = 4;

interface HostResponse {
  ok: boolean;
  version?: number;
  /** On hello: a newer app version that's out. */
  update?: string;
  code?: string;
  emails?: string[];
  accessibility?: boolean;
  error?: string;
  message?: string;
}

export class CompanionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

type SendNative = (host: string, message: unknown) => Promise<unknown>;

const STATE_TTL_MS = 30_000;
/** Quick questions (status, emails) get this long; a stuck agent must not hold a menu up. */
const QUICK_MS = 3_500;

/** Rejects if `promise` takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CompanionError("The Better Passwords app didn't answer.", "timeout")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class Companion {
  #cached: { state: CompanionState; update: CompanionUpdate | undefined; at: number } | undefined;

  constructor(
    private readonly sendNative: SendNative = (host, message) =>
      browser.runtime.sendNativeMessage(host, message as object),
    private readonly now: () => number = Date.now,
    /** Whether the app can exist here at all (it is Mac only). */
    private readonly available: () => Promise<boolean> = async () => true,
  ) {}

  /** Whether the companion can unlock. Cached briefly: each check starts the host and the agent. */
  async state(): Promise<CompanionState> {
    return (await this.#hello()).state;
  }

  /** A newer app that's out, as the agent last saw (it looks once a day). Shares state()'s cache. */
  async update(): Promise<CompanionUpdate | undefined> {
    return (await this.#hello()).update;
  }

  async #hello() {
    if (this.#cached && this.now() - this.#cached.at < STATE_TTL_MS) return this.#cached;
    let state: CompanionState;
    let update: CompanionUpdate | undefined;
    if (!(await this.available())) {
      this.#cached = { state: "unavailable", update: undefined, at: this.now() };
      return this.#cached;
    }
    try {
      const reply = (await within(this.sendNative(COMPANION_HOST, { type: "hello" }), QUICK_MS)) as
        | HostResponse
        | undefined;
      state = reply?.ok ? (reply.accessibility ? "ready" : "needs-setup") : "needs-setup";
      if (reply?.ok && (reply.version ?? 1) < UPDATES_VERSION) update = { how: "download" };
      else if (reply?.ok && typeof reply.update === "string") update = { how: "app", version: reply.update };
    } catch (error) {
      // no answer in time: installed, but its agent isn't running properly
      // otherwise the host isn't registered: the app isn't installed, or its setup didn't run
      state = (error as { code?: string }).code === "timeout" ? "needs-setup" : "not-installed";
    }
    this.#cached = { state, update, at: this.now() };
    return this.#cached;
  }

  /** Asks for Touch ID and returns the code Apple's helper shows. */
  async readCode(): Promise<string> {
    let reply: HostResponse | undefined;
    try {
      reply = (await this.sendNative(COMPANION_HOST, { type: "read-code" })) as HostResponse | undefined;
    } catch (error) {
      this.#cached = undefined;
      throw new CompanionError(error instanceof Error ? error.message : String(error), "not-installed");
    }
    if (reply?.ok && typeof reply.code === "string" && /^\d{6}$/.test(reply.code)) return reply.code;
    if (reply?.error === "needs-accessibility" || reply?.error === "agent-unavailable") this.#cached = undefined;
    throw new CompanionError(reply?.message ?? "Touch ID didn't work.", reply?.error ?? "failed");
  }

  #emails: { value: string[]; at: number } | undefined;

  /**
   * The emails on the user's contact card, for email fields. Cached for ten minutes: the card
   * rarely changes, and each call starts the host. Throws "needs-contacts" while the app may not
   * read Contacts, "not-installed" without the app, and "outdated" for an app from before this.
   */
  async myEmails(): Promise<string[]> {
    if (this.#emails && this.now() - this.#emails.at < 10 * 60_000) return this.#emails.value;
    let reply: HostResponse | undefined;
    try {
      reply = (await within(this.sendNative(COMPANION_HOST, { type: "my-emails" }), QUICK_MS)) as
        | HostResponse
        | undefined;
    } catch (error) {
      if (error instanceof CompanionError) throw error;
      throw new CompanionError(error instanceof Error ? error.message : String(error), "not-installed");
    }
    if (reply?.ok && Array.isArray(reply.emails)) {
      const value = reply.emails.filter((email): email is string => typeof email === "string" && email.includes("@"));
      this.#emails = { value, at: this.now() };
      return value;
    }
    if ((reply?.version ?? 1) < 2) throw new CompanionError("Update the Better Passwords app.", "outdated");
    throw new CompanionError(reply?.message ?? "Couldn't read your contact card.", reply?.error ?? "failed");
  }

  /** Brings the Mac app's window up, e.g. to finish its setup. */
  async openApp(): Promise<void> {
    const reply = (await within(this.sendNative(COMPANION_HOST, { type: "open-app" }), QUICK_MS)) as
      | HostResponse
      | undefined;
    if (!reply?.ok) throw new CompanionError("Open Better Passwords from your Applications folder.", "failed");
  }

  /**
   * Tells the app whether macOS lets Apple's helper start in this browser, for its list of
   * browsers. Best effort: without the app, or with one from before this, nothing happens.
   */
  async reportHelper(blocked: boolean): Promise<void> {
    if (!(await this.available())) return;
    await within(this.sendNative(COMPANION_HOST, { type: "helper-status", blocked }), QUICK_MS).catch(() => {});
  }
}
