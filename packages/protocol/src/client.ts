// Client for Apple's password helper over an abstract native-messaging transport.
//
// One client wraps one connection. The helper keeps the session only in its process memory,
// so when the transport closes the session is gone and a new client must pair again.

import { bigIntToBytes, bytesToBigInt, randomBytes } from "./bytes.ts";
import {
  Action,
  BinaryCodec,
  type Capabilities,
  Command,
  type HelperMessage,
  type LoginEntry,
  ONE_TIME_CODES_TYPE,
  type OneTimeCodeEntry,
  PAKE_ERROR_INCORRECT_CODE,
  PakeMessage,
  PROTOCOL_VERSION,
  pake,
  QueryId,
  type QueryReply,
  QueryStatus,
  type SecureMessage,
  type ServerKeyExchange,
  type ServerVerification,
  SRP_WITH_RFC_VERIFICATION,
} from "./messages.ts";
import { SecureChannel } from "./secure-channel.ts";
import { isSameSite } from "./sites.ts";
import { SrpClient } from "./srp.ts";

/** A native-messaging port. Implemented with `runtime.connectNative` in the extension. */
export interface Transport {
  send(message: unknown): void;
  onMessage(listener: (message: HelperMessage) => void): void;
  onClose(listener: (error?: string) => void): void;
  close(): void;
}

export type ClientState = "locked" | "awaiting-code" | "unlocked" | "closed";

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code:
      | "timeout"
      | "closed"
      | "incorrect-code"
      | "challenge-expired"
      | "unsupported"
      | "invalid-reply"
      /** A newer request of the same kind replaced this one (see getPassword). */
      | "superseded"
      | "server-proof-mismatch"
      | "query-failed",
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export interface Login {
  username: string;
  sites: string[];
}

export interface Credential {
  username: string;
  password: string;
}

/** A verification code saved in Apple Passwords (or, for other sources, received by the Mac). */
export interface OneTimeCode {
  /** Missing when the helper wants the user to authenticate before the code is shown. */
  code: string | undefined;
  username: string;
  domain: string;
  /** "totp" for codes generated from a saved setup key. */
  source: string;
}

export interface OneTimeCodes {
  codes: OneTimeCode[];
  /** The helper asks for Touch ID (or the login password) before a code is filled. */
  requiresAuthentication: boolean;
}

export interface ClientOptions {
  /** Sent as HSTBRSR; the helper uses it in the pairing window's wording. */
  browserName?: string;
  /** Default timeout for replies, in ms. */
  timeoutMs?: number;
  /** How long a shown code stays usable before a new challenge is needed. */
  challengeTtlMs?: number;
  now?: () => number;
}

interface PendingChallenge {
  srp: SrpClient;
  B: bigint;
  salt: Uint8Array;
  issuedAt: number;
}

interface Waiter {
  resolve(message: HelperMessage): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Replies to tab-scoped queries echo the tab and frame; anything else isn't ours. */
  tab?: { tabId: number; frameId: number };
}

type Tab = { tabId: number; frameId?: number };

const DEFAULTS = { browserName: "Chrome", timeoutMs: 8_000, challengeTtlMs: 3 * 60_000 };

export class ApplePasswordsClient {
  #state: ClientState = "locked";
  #capabilities: Capabilities = {};
  #codec = new BinaryCodec(true);
  #username = "";
  #challenge: PendingChallenge | undefined;
  #channel: SecureChannel | undefined;
  #waiters = new Map<number, Waiter>();
  /** One queue per kind of request (see #serialized). */
  #queues = new Map<string, Promise<unknown>>();
  #stateListeners = new Set<(state: ClientState) => void>();
  #codeListeners = new Set<() => void>();

  readonly #options: Required<ClientOptions>;

  private constructor(
    private readonly transport: Transport,
    options: ClientOptions,
  ) {
    this.#options = { ...DEFAULTS, now: Date.now, ...options };
    transport.onMessage((message) => this.#dispatch(message));
    transport.onClose((error) => this.#closed(error));
  }

  /** Opens a client on a fresh transport and reads the helper's capabilities. */
  static async connect(transport: Transport, options: ClientOptions = {}) {
    const client = new ApplePasswordsClient(transport, options);
    const reply = await client.#request({ cmd: Command.GetCapabilities });
    const capabilities = reply.capabilities ?? {};
    if (
      capabilities.secretSessionVersion !== undefined &&
      capabilities.secretSessionVersion !== SRP_WITH_RFC_VERIFICATION
    ) {
      client.close();
      throw new ProtocolError("helper requires an unsupported session version", "unsupported");
    }
    client.#capabilities = capabilities;
    client.#codec = new BinaryCodec(capabilities.shouldUseBase64 === true);
    return client;
  }

  get state(): ClientState {
    return this.#state;
  }

  get capabilities(): Readonly<Capabilities> {
    return this.#capabilities;
  }

  /** True while a code is on screen and still usable. */
  get hasLiveChallenge(): boolean {
    const c = this.#challenge;
    return c !== undefined && this.#options.now() - c.issuedAt < this.#options.challengeTtlMs;
  }

  onStateChange(listener: (state: ClientState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /** Called when the helper announces a new verification code, e.g. one that just arrived by SMS. */
  onOneTimeCodeAvailable(listener: () => void): () => void {
    this.#codeListeners.add(listener);
    return () => this.#codeListeners.delete(listener);
  }

  /** Asks the helper to start pairing; macOS then shows a 6-digit code. */
  requestChallenge(): Promise<void> {
    return this.#serialized("pairing", async () => {
      this.#assertOpen();
      const username = this.#codec.encode(randomBytes(16));
      const srp = new SrpClient(username);
      const reply = await this.#request({
        cmd: Command.Handshake,
        msg: {
          QID: "m0",
          PAKE: pake.encode({
            TID: username,
            MSG: PakeMessage.ClientKeyExchange,
            A: this.#codec.encode(bigIntToBytes(srp.A)),
            VER: PROTOCOL_VERSION,
            PROTO: [SRP_WITH_RFC_VERIFICATION],
          }),
          HSTBRSR: this.#options.browserName,
        },
      });

      const exchange = pake.decode<ServerKeyExchange>(requireString(reply.payload?.PAKE));
      if (exchange.TID !== username) throw invalid("challenge for another session");
      if (exchange.ErrCode !== undefined) throw invalid(`helper refused pairing (${exchange.ErrCode})`);
      if (pakeNumber(exchange.MSG) !== PakeMessage.ServerKeyExchange) {
        throw invalid(`unexpected handshake message (MSG ${JSON.stringify(exchange.MSG)})`);
      }
      if (pakeNumber(exchange.PROTO) !== SRP_WITH_RFC_VERIFICATION) {
        throw new ProtocolError("helper chose an unsupported protocol", "unsupported");
      }

      this.#username = username;
      this.#channel = undefined;
      this.#challenge = {
        srp,
        B: bytesToBigInt(this.#codec.decode(exchange.B)),
        salt: this.#codec.decode(exchange.s),
        issuedAt: this.#options.now(),
      };
      this.#setState("awaiting-code");
    });
  }

  /** Completes pairing with the code shown on the Mac. Each challenge allows one attempt. */
  verifyCode(code: string): Promise<void> {
    return this.#serialized("pairing", async () => {
      this.#assertOpen();
      const challenge = this.#challenge;
      if (!challenge || !this.hasLiveChallenge) {
        throw new ProtocolError("the code expired, request a new one", "challenge-expired");
      }
      // the helper discards a challenge after one verification attempt, right or wrong
      this.#challenge = undefined;
      this.#setState("locked");

      const handshake = await challenge.srp.handshake(code, challenge.B, challenge.salt);
      const reply = await this.#request({
        cmd: Command.Handshake,
        msg: {
          QID: "m2",
          PAKE: pake.encode({
            TID: this.#username,
            MSG: PakeMessage.ClientVerification,
            M: this.#codec.encode(handshake.clientProof, false),
          }),
        },
      });

      const verification = pake.decode<ServerVerification>(requireString(reply.payload?.PAKE));
      if (verification.TID !== this.#username) throw invalid("verification for another session");
      if (pakeNumber(verification.MSG) !== PakeMessage.ServerVerification) {
        throw invalid(`unexpected handshake message (MSG ${JSON.stringify(verification.MSG)})`);
      }
      const errCode = pakeNumber(verification.ErrCode);
      if (errCode === PAKE_ERROR_INCORRECT_CODE) {
        throw new ProtocolError("incorrect code", "incorrect-code");
      }
      if (verification.ErrCode !== undefined && errCode !== 0) {
        throw invalid(`verification failed (${verification.ErrCode})`);
      }
      if (!handshake.verifyServerProof(this.#codec.decode(requireString(verification.HAMK)))) {
        throw new ProtocolError("helper's proof did not match", "server-proof-mismatch");
      }

      this.#channel = await SecureChannel.fromSessionKey(handshake.sessionKey);
      this.#setState("unlocked");
    });
  }

  /** Lists saved logins for a hostname, without passwords. */
  getLogins(hostname: string, tab: { tabId: number; frameId?: number }): Promise<Login[]> {
    return this.#serialized("logins", async () => {
      const reply = await this.#query(Command.GetLoginNamesForUrl, hostname, tab, {
        ACT: Action.GhostSearch,
        URL: hostname,
      });
      // a login saved without a username may come back without the field at all
      return (reply.Entries ?? []).map((e) => ({ username: e.USR ?? "", sites: e.sites ?? [] }));
    });
  }

  /**
   * Reads one password. No timeout: macOS may ask for Touch ID or the login password before the
   * helper answers. With that prompt dismissed, the helper never answers, so a newer read replaces
   * one still waiting instead of queueing behind it.
   */
  getPassword(
    hostname: string,
    username: string,
    tab: { tabId: number; frameId?: number },
  ): Promise<Credential | undefined> {
    // not serialized: a new read replaces one still waiting (see #request)
    return (async () => {
      const reply = await this.#query(
        Command.GetPasswordForLoginName,
        hostname,
        tab,
        { ACT: Action.Search, URL: hostname, USR: username },
        null,
      );
      // Replies carry no id: a late answer to a replaced read could arrive now. Use only the
      // password of the login asked for, on the site asked for.
      const entry = reply.Entries?.find(
        (e) => (e.USR ?? "") === username && (e.sites ?? []).some((site) => isSameSite(site, hostname)),
      );
      if (!entry && reply.Entries?.length) throw invalid("reply for another site or login");
      if (!entry || typeof entry.PWD !== "string") return undefined;
      return { username, password: entry.PWD };
    })();
  }

  /**
   * Lists verification codes for a page. `frameURLs` are the frame's URL followed by its parents'.
   * Without `username`, codes for every account on the site come back. Helpers that can't fill
   * codes are never asked.
   */
  getOneTimeCodes(frameURLs: string[], tab: Tab, username?: string): Promise<OneTimeCodes> {
    return this.#serialized("codes", () => this.#readOneTimeCodes(frameURLs, tab, Action.GhostSearch, username));
  }

  /** Searches one account's verification codes. Windows helpers require Search with a username. */
  searchOneTimeCodes(frameURLs: string[], tab: Tab, username: string): Promise<OneTimeCodes> {
    return this.#serialized("codes", () => {
      if (!username) return Promise.resolve({ codes: [], requiresAuthentication: false });
      return this.#readOneTimeCodes(frameURLs, tab, Action.Search, username);
    });
  }

  /**
   * The code to fill right now. For a TOTP code this reports the fill to the helper, whose reply
   * carries the current code (and which may first ask for Touch ID, so there is no timeout).
   * Other codes don't change and are returned as listed.
   */
  currentOneTimeCode(code: OneTimeCode, frameURLs: string[], tab: Tab): Promise<string | undefined> {
    if (code.source !== "totp") return Promise.resolve(code.code);
    // not serialized: like a password read, a new fill replaces one still waiting on Touch ID
    return (async () => {
      const reply = await this.#query<OneTimeCodeEntry>(
        Command.DidFillOneTimeCode,
        undefined,
        tab,
        {
          ACT: Action.Search,
          TYPE: ONE_TIME_CODES_TYPE,
          frameURLs,
          ...(code.username ? { username: code.username } : {}),
        },
        null,
      );
      const entries = (Array.isArray(reply.Entries) ? reply.Entries : []).flatMap(toOneTimeCode);
      if (entries.length === 0) return undefined;
      // a late answer to a replaced fill could arrive now: use only the account asked for
      const match = entries.find(
        (e) => e.source === code.source && e.username === code.username && e.domain === code.domain,
      );
      if (!match) throw new ProtocolError("reply for another code", "invalid-reply");
      return match.code;
    })();
  }

  /**
   * Opens Apple's Passwords app, searching for `url` when it is a web address. Works without
   * pairing, and the helper sends no reply.
   */
  openPasswordsApp(url?: string): void {
    this.#assertOpen();
    const message: { cmd: number; searchQueryURL?: string } = { cmd: Command.LaunchPasswordsApp };
    if (url && /^https?:\/\//.test(url)) message.searchQueryURL = url;
    this.transport.send(message);
  }

  /**
   * Asks Apple Passwords to save a login. macOS shows its own "Save password?" prompt; the helper
   * saves in the background once the user agrees and never reports back. To know the outcome,
   * look the login up afterwards (see `getLogins`).
   */
  savePassword(login: { hostname: string; username: string; password: string }, tab: Tab): Promise<void> {
    return this.#serialized("save", async () => {
      this.transport.send(
        await this.#secureMessage(Command.SetPassword, tab, {
          ACT: Action.MaybeAdd,
          URL: "",
          USR: "",
          PWD: "",
          NURL: login.hostname,
          NUSR: login.username,
          NPWD: login.password,
        }),
      );
    });
  }

  close(): void {
    if (this.#state === "closed") return;
    try {
      this.transport.send({ cmd: Command.End });
    } catch {
      // the port may already be gone
    }
    this.transport.close();
    this.#closed();
  }

  /** `hostname` goes along in clear as `url`, as Apple's extension sends it; code queries have none. */
  async #query<Entry = LoginEntry>(
    cmd: keyof typeof QueryId,
    hostname: string | undefined,
    tab: { tabId: number; frameId?: number },
    body: Record<string, unknown>,
    timeoutMs?: number | null,
    alsoAccept: readonly number[] = [],
  ): Promise<QueryReply<Entry>> {
    const secure = await this.#secureMessage(cmd, tab, body);
    const message = hostname === undefined ? secure : { ...secure, url: hostname };
    const result = (await this.#openReply(await this.#request(message, timeoutMs))) as QueryReply<Entry>;

    if (result.STATUS === QueryStatus.Success || alsoAccept.includes(result.STATUS)) return result;
    if (result.STATUS === QueryStatus.NoResults) return { ...result, Entries: [] };
    if (result.STATUS === QueryStatus.InvalidSession) this.#lock();
    throw new ProtocolError(`helper query failed (status ${result.STATUS})`, "query-failed");
  }

  async #readOneTimeCodes(
    frameURLs: string[],
    tab: Tab,
    action: (typeof Action)[keyof typeof Action],
    username?: string,
  ): Promise<OneTimeCodes> {
    if (!this.#capabilities.canFillOneTimeCodes) return { codes: [], requiresAuthentication: false };
    const reply = await this.#query<OneTimeCodeEntry>(Command.GetOneTimeCodes, undefined, tab, {
      ACT: action,
      TYPE: ONE_TIME_CODES_TYPE,
      frameURLs,
      ...(username ? { username } : {}),
    });
    return {
      codes: (Array.isArray(reply.Entries) ? reply.Entries : []).flatMap(toOneTimeCode),
      requiresAuthentication: reply.RequiresUserAuthenticationToFill === true,
    };
  }

  /** An encrypted, tab-scoped request. */
  async #secureMessage(cmd: keyof typeof QueryId, tab: Tab, body: Record<string, unknown>) {
    this.#assertOpen();
    const channel = this.#channel;
    if (this.#state !== "unlocked" || !channel) throw new ProtocolError("not paired", "closed");
    return {
      cmd,
      tabId: tab.tabId,
      frameId: tab.frameId ?? 0,
      payload: {
        QID: QueryId[cmd],
        SMSG: JSON.stringify({ TID: this.#username, SDATA: this.#codec.encode(await channel.encryptRequest(body)) }),
      },
    };
  }

  /** Decrypts an encrypted reply or push from the helper. */
  async #openReply(message: HelperMessage): Promise<QueryReply> {
    const channel = this.#channel;
    if (!channel) throw new ProtocolError("not paired", "closed");
    const raw = message.payload?.SMSG;
    const smsg = (typeof raw === "string" ? JSON.parse(raw) : raw) as SecureMessage | undefined;
    if (!smsg || smsg.TID !== this.#username) throw invalid("reply for another session");
    return (await channel.decryptReply(this.#codec.decode(smsg.SDATA))) as QueryReply;
  }

  /**
   * Runs `task` after every earlier one in its `lane`. Replies carry no correlation id but are told
   * apart by command, so different kinds of request may overlap; the same kind may not.
   */
  #serialized<T>(lane: string, task: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(lane) ?? Promise.resolve()).then(task, task);
    this.#queues.set(
      lane,
      run.catch(() => undefined),
    );
    return run;
  }

  #request(message: { cmd: number } & Record<string, unknown>, timeoutMs?: number | null) {
    return new Promise<HelperMessage>((resolve, reject) => {
      if (this.#state === "closed") return reject(new ProtocolError("connection closed", "closed"));
      const ms = timeoutMs === undefined ? this.#options.timeoutMs : timeoutMs;
      const tab =
        typeof message.tabId === "number"
          ? { tabId: message.tabId, frameId: typeof message.frameId === "number" ? message.frameId : 0 }
          : undefined;
      const waiter: Waiter = {
        ...(tab ? { tab } : {}),
        resolve,
        reject,
        timer:
          ms === null
            ? undefined
            : setTimeout(() => {
                if (this.#waiters.get(message.cmd) === waiter) this.#waiters.delete(message.cmd);
                reject(new ProtocolError("the helper did not answer in time", "timeout"));
              }, ms),
      };
      // only serialized requests' commands can't overlap; any other one replaces its predecessor
      const previous = this.#waiters.get(message.cmd);
      if (previous) {
        clearTimeout(previous.timer);
        previous.reject(new ProtocolError("replaced by a newer request", "superseded"));
      }
      this.#waiters.set(message.cmd, waiter);
      try {
        this.transport.send(message);
      } catch (error) {
        clearTimeout(waiter.timer);
        if (this.#waiters.get(message.cmd) === waiter) this.#waiters.delete(message.cmd);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #dispatch(message: HelperMessage): void {
    const waiter = this.#waiters.get(message.cmd);
    const forWaiter =
      waiter &&
      (!waiter.tab ||
        message.tabId === undefined ||
        (message.tabId === waiter.tab.tabId && (message.frameId ?? 0) === waiter.tab.frameId));
    if (waiter && forWaiter) {
      this.#waiters.delete(message.cmd);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    if (message.cmd === Command.PasswordsDisabled || message.cmd === Command.ReloginNeeded) this.#lock();
    if (message.cmd === Command.OneTimeCodeAvailable && this.#state === "unlocked") {
      for (const listener of this.#codeListeners) listener();
    }
  }

  #lock(): void {
    this.#channel = undefined;
    this.#challenge = undefined;
    if (this.#state !== "closed") this.#setState("locked");
  }

  #closed(error?: string): void {
    this.#channel = undefined;
    this.#challenge = undefined;
    for (const waiter of this.#waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new ProtocolError(error ?? "connection closed", "closed"));
    }
    this.#waiters.clear();
    this.#setState("closed");
  }

  #assertOpen(): void {
    if (this.#state === "closed") throw new ProtocolError("connection closed", "closed");
  }

  #setState(state: ClientState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }
}

/** Keeps entries that name their source; a code is kept only if it looks like one. */
function toOneTimeCode(entry: unknown): OneTimeCode[] {
  if (typeof entry !== "object" || entry === null) return [];
  const e = entry as OneTimeCodeEntry;
  if (typeof e.source !== "string") return [];
  const code = typeof e.code === "string" && /^[0-9A-Za-z]{4,16}$/.test(e.code) ? e.code : undefined;
  return [
    {
      code,
      username: typeof e.username === "string" ? e.username : "",
      domain: typeof e.domain === "string" ? e.domain : "",
      source: e.source,
    },
  ];
}

/** A number from a PAKE reply, which the Windows helper may send as a string; NaN if neither. */
function pakeNumber(value: unknown): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw invalid("missing field in reply");
  return value;
}

function invalid(message: string) {
  return new ProtocolError(message, "invalid-reply");
}
