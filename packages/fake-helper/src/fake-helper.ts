// Behaves like Apple's PasswordManagerBrowserExtensionHelper closely enough to test the client:
// capabilities, the SRP handshake (with a known code) and encrypted login/password queries.
//
// It is built from the same SRP formulas as the client, so passing tests here proves the two
// sides agree, not that they match Apple. The RFC 5054 vectors and the live test cover that.

import {
  Action,
  BinaryCodec,
  bigIntToBytes,
  bytesToBigInt,
  type Capabilities,
  Command,
  computeClientProof,
  computeK,
  computeServerProof,
  computeSessionKey,
  computeU,
  computeX,
  constantTimeEqual,
  type HelperMessage,
  type LoginEntry,
  type OneTimeCodeEntry,
  PAKE_ERROR_INCORRECT_CODE,
  PakeMessage,
  pake,
  QueryStatus,
  RFC5054_3072,
  randomBytes,
  SecureChannel,
  SRP_WITH_RFC_VERIFICATION,
  server,
  sha256,
} from "@app/protocol";
import { type TotpOptions, totp } from "./totp.ts";

export interface VaultEntry {
  hostname: string;
  username: string;
  password: string;
  /** A verification code set up for this login. */
  totp?: { secret: string } & TotpOptions;
}

export interface FakeHelperOptions {
  vault?: VaultEntry[];
  /** Fixed pairing code; random when omitted. Read it from `currentCode`. */
  code?: string;
  base64?: boolean;
  /**
   * Answer like iCloud for Windows' helper: hex encoding, no `shouldUseBase64` in the capabilities,
   * and the handshake's MSG as a string ("MSG": "1").
   */
  windows?: boolean;
  capabilities?: Capabilities;
  /** Answer macOS's "Save password?" prompt with Don't Save. */
  declineSaves?: boolean;
  /** The clock for verification codes. */
  now?: () => number;
  /**
   * Like the real helper (macOS 27), ask for Touch ID before filling a verification code: lists
   * then carry no digits, and only a reported fill returns the code. Default true.
   */
  requiresAuthenticationForCodes?: boolean;
  /** Answer requests for verification codes with this reply instead, to play an odd helper. */
  oneTimeCodesReply?: Record<string, unknown>;
}

interface Handshake {
  tid: string;
  A: bigint;
  b: bigint;
  B: bigint;
  v: bigint;
  salt: Uint8Array;
}

const group = RFC5054_3072;

export class FakeHelper {
  readonly vault: VaultEntry[];
  /** Every login saved through the helper, in order. */
  readonly saved: VaultEntry[] = [];
  /** The search URL of every request to open the Passwords app ("" when none). */
  readonly passwordsAppLaunches: string[] = [];
  /** Every request to list verification codes: the frame URLs and the username asked for. */
  readonly oneTimeCodeReads: { frameURLs: string[]; username?: string }[] = [];
  /** Every reported fill of a verification code. */
  readonly oneTimeCodeFills: { frameURLs: string[]; username?: string }[] = [];
  readonly #fixedCode: string | undefined;
  readonly #codec: BinaryCodec;
  readonly #windows: boolean;
  readonly #capabilities: Capabilities;
  readonly #declineSaves: boolean;
  readonly #now: () => number;
  readonly #codesNeedAuthentication: boolean;
  readonly #codesReply: Record<string, unknown> | undefined;
  #handshake: Handshake | undefined;
  #session: { tid: string; channel: SecureChannel } | undefined;
  /** The code the "pairing window" currently shows, if any. */
  currentCode: string | undefined;

  constructor(options: FakeHelperOptions = {}) {
    // a copy, so saves in one test can't leak into another sharing the same vault
    this.vault = (options.vault ?? []).map((entry) => ({ ...entry }));
    this.#fixedCode = options.code;
    this.#declineSaves = options.declineSaves ?? false;
    this.#now = options.now ?? Date.now;
    this.#codesNeedAuthentication = options.requiresAuthenticationForCodes ?? true;
    this.#codesReply = options.oneTimeCodesReply;
    this.#windows = options.windows ?? false;
    const base64 = !this.#windows && (options.base64 ?? true);
    this.#codec = new BinaryCodec(base64);
    this.#capabilities = this.#windows
      ? { canFillOneTimeCodes: true, supportsSubURLs: true, scanForOTPURI: true, secretSessionVersion: 1 }
      : { shouldUseBase64: base64, canFillOneTimeCodes: true };
    Object.assign(this.#capabilities, options.capabilities);
  }

  /** Handles one request and returns the replies to send (usually exactly one). */
  async handle(message: HelperMessage): Promise<HelperMessage[]> {
    switch (message.cmd) {
      case Command.GetCapabilities:
        return [{ cmd: message.cmd, capabilities: this.#capabilities }];
      case Command.Handshake:
        return [await this.#handshakeStep(message)];
      case Command.GetLoginNamesForUrl:
      case Command.GetPasswordForLoginName:
        return [await this.#query(message)];
      case Command.SetPassword:
        return this.#save(message);
      case Command.GetOneTimeCodes:
      case Command.DidFillOneTimeCode:
        return this.#oneTimeCodes(message);
      case Command.LaunchPasswordsApp:
        this.passwordsAppLaunches.push(typeof message.searchQueryURL === "string" ? message.searchQueryURL : "");
        return [];
      default:
        return [];
    }
  }

  /** Simulates the user locking the Mac or signing out: the helper drops the session. */
  invalidateSession(): HelperMessage {
    this.#session = undefined;
    return { cmd: Command.ReloginNeeded };
  }

  /** Simulates a new verification code arriving: the helper tells the extension, without data. */
  announceOneTimeCode(): HelperMessage {
    return { cmd: Command.OneTimeCodeAvailable };
  }

  async #handshakeStep(message: HelperMessage): Promise<HelperMessage> {
    const msg = message.msg as { QID: string; PAKE: string };
    const reply = (value: { MSG: number } & Record<string, unknown>): HelperMessage => ({
      cmd: Command.Handshake,
      payload: { PAKE: pake.encode(this.#windows ? { ...value, MSG: String(value.MSG) } : value) },
    });

    if (msg.QID === "m0") {
      const hello = pake.decode<{ TID: string; A: string; PROTO: number[] }>(msg.PAKE);
      if (!hello.PROTO.includes(SRP_WITH_RFC_VERIFICATION)) {
        return reply({ TID: hello.TID, MSG: PakeMessage.ServerKeyExchange, ErrCode: 2 });
      }
      const code = this.#fixedCode ?? String(bytesToBigInt(randomBytes(4)) % 1_000_000n).padStart(6, "0");
      const salt = randomBytes(16);
      const x = await computeX(sha256, salt, hello.TID, code);
      const v = server.verifier(group, x);
      const b = bytesToBigInt(randomBytes(32));
      const B = server.publicKey(group, await computeK(group, sha256), v, b);
      const A = bytesToBigInt(this.#codec.decode(hello.A));
      this.#handshake = { tid: hello.TID, A, b, B, v, salt };
      this.#session = undefined;
      this.currentCode = code;
      return reply({
        TID: hello.TID,
        MSG: PakeMessage.ServerKeyExchange,
        B: this.#codec.encode(bigIntToBytes(B)),
        s: this.#codec.encode(salt),
        PROTO: SRP_WITH_RFC_VERIFICATION,
      });
    }

    const verify = pake.decode<{ TID: string; M: string }>(msg.PAKE);
    const hs = this.#handshake;
    // one attempt per challenge, like the real helper
    this.#handshake = undefined;
    this.currentCode = undefined;
    if (!hs || hs.tid !== verify.TID) {
      return reply({ TID: verify.TID, MSG: PakeMessage.ServerVerification, ErrCode: 3 });
    }

    const u = await computeU(group, sha256, hs.A, hs.B);
    const K = await computeSessionKey(sha256, server.premasterSecret(group, hs.A, hs.v, u, hs.b));
    const expectedM = await computeClientProof(group, sha256, {
      username: hs.tid,
      salt: hs.salt,
      A: hs.A,
      B: hs.B,
      K,
    });
    const M = this.#codec.decode(verify.M);
    if (!constantTimeEqual(M, expectedM)) {
      return reply({ TID: hs.tid, MSG: PakeMessage.ServerVerification, ErrCode: PAKE_ERROR_INCORRECT_CODE });
    }

    this.#session = { tid: hs.tid, channel: await SecureChannel.fromSessionKey(K) };
    const HAMK = await computeServerProof(sha256, hs.A, M, K);
    return reply({ TID: hs.tid, MSG: PakeMessage.ServerVerification, HAMK: this.#codec.encode(HAMK), ErrCode: 0 });
  }

  /** Decrypts a request; undefined when it isn't for the current session. */
  async #open<T>(
    message: HelperMessage,
  ): Promise<{ session: { tid: string; channel: SecureChannel }; request: T } | undefined> {
    const payload = (typeof message.payload === "string" ? JSON.parse(message.payload) : message.payload) as {
      SMSG: string;
    };
    const smsg = JSON.parse(payload.SMSG) as { TID: string; SDATA: string };
    const session = this.#session;
    if (!session || session.tid !== smsg.TID) return undefined;
    return { session, request: (await session.channel.decryptRequest(this.#codec.decode(smsg.SDATA))) as T };
  }

  async #query(message: HelperMessage): Promise<HelperMessage> {
    const opened = await this.#open<{ URL: string; USR?: string }>(message);
    if (!opened) return { cmd: message.cmd, payload: { SMSG: JSON.stringify({ TID: "", SDATA: "" }) } };
    const { session, request } = opened;
    const matches = this.vault.filter((e) => e.hostname === request.URL);
    let entries: LoginEntry[];
    if (message.cmd === Command.GetLoginNamesForUrl) {
      // like the real helper may, leave the field out for a login without a username
      entries = matches.map((e) => ({ ...(e.username ? { USR: e.username } : {}), sites: [e.hostname] }) as LoginEntry);
    } else {
      entries = matches
        .filter((e) => e.username === request.USR)
        .map((e) => ({ USR: e.username, PWD: e.password, sites: [e.hostname] }));
    }
    const result =
      entries.length > 0 ? { STATUS: QueryStatus.Success, Entries: entries } : { STATUS: QueryStatus.NoResults };
    return this.#reply(session, message, message.cmd, result);
  }

  /**
   * Lists codes (16) or reports a fill (17). Both answer with the codes current now, but a list
   * withholds the digits while authentication is required, as the real helper does.
   */
  async #oneTimeCodes(message: HelperMessage): Promise<HelperMessage[]> {
    const opened = await this.#open<{ TYPE?: string; frameURLs?: string[]; username?: string }>(message);
    if (!opened) return [{ cmd: message.cmd, payload: { SMSG: JSON.stringify({ TID: "", SDATA: "" }) } }];
    const { session, request } = opened;
    const frameURLs = request.frameURLs ?? [];
    const asked = { frameURLs, ...(request.username ? { username: request.username } : {}) };
    (message.cmd === Command.GetOneTimeCodes ? this.oneTimeCodeReads : this.oneTimeCodeFills).push(asked);
    if (this.#codesReply) return [await this.#reply(session, message, message.cmd, this.#codesReply)];
    if (request.TYPE !== "oneTimeCodes") {
      return [await this.#reply(session, message, message.cmd, { STATUS: QueryStatus.InvalidParam })];
    }
    const hostnames = new Set(frameURLs.flatMap((url) => (URL.canParse(url) ? [new URL(url).hostname] : [])));
    const entries: OneTimeCodeEntry[] = [];
    for (const e of this.vault) {
      if (!e.totp || !hostnames.has(e.hostname)) continue;
      if (request.username && e.username !== request.username) continue;
      const hidden = this.#codesNeedAuthentication && message.cmd === Command.GetOneTimeCodes;
      const code = hidden ? null : await totp(e.totp.secret, this.#now(), e.totp);
      entries.push({ code, username: e.username, domain: e.hostname, source: "totp" });
    }
    const result =
      entries.length > 0
        ? {
            STATUS: QueryStatus.Success,
            Entries: entries,
            ...(this.#codesNeedAuthentication ? { RequiresUserAuthenticationToFill: true } : {}),
          }
        : { STATUS: QueryStatus.NoResults };
    return [await this.#reply(session, message, message.cmd, result)];
  }

  /**
   * "Maybe add", as the real helper does it: no reply to the request, and the login is saved once
   * the user clicks Save in macOS's prompt. Like the real helper, it also sends the tab an update
   * that lists no logins, which callers must not mistake for an answer. A login saved already,
   * with that password, gets no prompt.
   */
  async #save(message: HelperMessage): Promise<HelperMessage[]> {
    const opened = await this.#open<{ ACT?: number; NURL?: string; NUSR?: string; NPWD?: string }>(message);
    if (!opened) return [];
    const { session, request } = opened;
    const { NURL: hostname, NUSR: username = "", NPWD: password } = request;
    if (request.ACT !== Action.MaybeAdd || !hostname || !password) return [];
    const update = await this.#reply(session, message, Command.GetLoginNamesForUrl, { STATUS: QueryStatus.Success });
    const existing = this.vault.find((e) => e.hostname === hostname && e.username === username);
    if (this.#declineSaves || existing?.password === password) return [update];
    if (existing) existing.password = password;
    else this.vault.push({ hostname, username, password });
    this.saved.push({ hostname, username, password });
    return [update];
  }

  /** An encrypted message for the request's tab and frame (replies echo them). */
  async #reply(
    session: { tid: string; channel: SecureChannel },
    request: HelperMessage,
    cmd: number,
    result: unknown,
  ): Promise<HelperMessage> {
    const SDATA = this.#codec.encode(await session.channel.encryptReply(result));
    return {
      cmd,
      ...(request.tabId === undefined ? {} : { tabId: request.tabId, frameId: request.frameId ?? 0 }),
      payload: { SMSG: JSON.stringify({ TID: session.tid, SDATA }) },
    };
  }
}
