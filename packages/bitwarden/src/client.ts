// Bitwarden's servers, as Better Passwords uses them: signing in (with two-step login and new-device
// codes as steps the caller answers, not errors), refreshing tokens, syncing the encrypted vault and
// saving logins. See docs/bitwarden.md. No browser APIs, and `fetch` is injected, for tests.

import { type Argon2id, type KdfConfig, masterKey, masterPasswordHash } from "./crypto.ts";

export type Region = "us" | "eu";

/** `fetch`, as far as the client uses it. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface Request {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  /** A Bearer token to send. */
  token?: string;
  /** The answer has no body. */
  empty?: boolean;
}

export const SERVERS: Record<Region, { identity: string; api: string; vault: string }> = {
  us: {
    identity: "https://identity.bitwarden.com",
    api: "https://api.bitwarden.com",
    vault: "https://vault.bitwarden.com",
  },
  eu: {
    identity: "https://identity.bitwarden.eu",
    api: "https://api.bitwarden.eu",
    vault: "https://vault.bitwarden.eu",
  },
};

/** Two-step login methods, by Bitwarden's numbers. Only those we can answer have names. */
export const TwoFactorProvider = { Authenticator: 0, Email: 1, Duo: 2, YubiKey: 3, WebAuthn: 7 } as const;
export type TwoFactorProviderId = number;

export interface ClientOptions {
  region: Region;
  /** A UUID kept per install: Bitwarden lists signed-in devices by it. */
  deviceId: string;
  /** 2 for a Chromium extension, 3 for Firefox's. */
  deviceType: number;
  deviceName: string;
  clientVersion: string;
  fetch?: Fetch;
  argon2?: Argon2id;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, in ms since the epoch. */
  expiresAt: number;
}

/** What a sign-in gives: tokens, and the keys that need the master password to open. */
export interface SignedIn {
  tokens: Tokens;
  kdf: KdfConfig;
  /** The user key, wrapped with the stretched master key (an EncString). */
  protectedUserKey: string;
  /** The RSA private key, wrapped with the user key. */
  protectedPrivateKey?: string;
  /** The master key, derived on the way: kept only long enough to open the user key. */
  masterKey: Uint8Array<ArrayBuffer>;
}

export type SignInResult =
  | { status: "signed-in"; account: SignedIn }
  /** Ask for a code from one of `providers` and sign in again with it. */
  | { status: "two-factor"; providers: TwoFactorProviderId[]; email?: string }
  /** Bitwarden emailed a code to confirm this new device: sign in again with it. */
  | { status: "new-device" };

export interface SignInRequest {
  email: string;
  password: string;
  twoFactor?: { provider: TwoFactorProviderId; code: string; remember?: boolean };
  newDeviceCode?: string;
}

export type BitwardenErrorCode =
  | "wrong-password"
  | "wrong-code"
  | "rate-limited"
  | "unauthorized"
  | "out-of-date"
  | "server"
  | "network"
  | "unsupported";

export class BitwardenError extends Error {
  constructor(
    message: string,
    readonly code: BitwardenErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BitwardenError";
  }
}

/** A cipher as /sync and the cipher endpoints give it: encrypted fields stay EncStrings. */
export interface CipherData {
  id: string;
  type: number;
  organizationId: string | null;
  folderId: string | null;
  favorite: boolean;
  reprompt: number;
  name: string;
  notes: string | null;
  key: string | null;
  revisionDate: string;
  deletedDate: string | null;
  login: {
    username: string | null;
    password: string | null;
    totp: string | null;
    uris: { uri: string | null; match: number | null }[] | null;
    [field: string]: unknown;
  } | null;
  passwordHistory: { password: string; lastUsedDate: string }[] | null;
  [field: string]: unknown;
}

export interface SyncData {
  profile: {
    id: string;
    email: string;
    key: string;
    privateKey: string | null;
    organizations: { id: string; name: string; key: string | null; enabled?: boolean }[];
    [field: string]: unknown;
  };
  ciphers: CipherData[];
  [field: string]: unknown;
}

/** The fields a new or changed login sends, already encrypted. */
export interface CipherRequest {
  type: 1;
  organizationId: string | null;
  folderId: string | null;
  favorite: boolean;
  reprompt: number;
  name: string;
  notes: string | null;
  key: string | null;
  login: Record<string, unknown>;
  fields?: unknown;
  passwordHistory?: { password: string; lastUsedDate: string }[] | null;
  lastKnownRevisionDate?: string;
}

export class BitwardenClient {
  readonly #fetch: Fetch;
  readonly #servers: (typeof SERVERS)[Region];

  constructor(private readonly options: ClientOptions) {
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#servers = SERVERS[options.region];
  }

  get servers() {
    return this.#servers;
  }

  async prelogin(email: string): Promise<KdfConfig> {
    const body = await this.#json<{
      kdf: 0 | 1;
      kdfIterations: number;
      kdfMemory: number | null;
      kdfParallelism: number | null;
    }>(`${this.#servers.identity}/accounts/prelogin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (body.kdf !== 0 && body.kdf !== 1)
      throw new BitwardenError("This account's key settings aren't supported.", "unsupported");
    return {
      kdf: body.kdf,
      iterations: body.kdfIterations,
      ...(body.kdfMemory ? { memory: body.kdfMemory } : {}),
      ...(body.kdfParallelism ? { parallelism: body.kdfParallelism } : {}),
    };
  }

  /**
   * Signs in with the master password. Two-step login and new-device verification come back as
   * steps: call again with the code. The KDF runs on every call (it's what the server checks).
   */
  async signIn(request: SignInRequest, kdf?: KdfConfig): Promise<SignInResult> {
    const config = kdf ?? (await this.prelogin(request.email));
    const key = await masterKey(request.password, request.email, config, this.options.argon2);
    const hash = await masterPasswordHash(key, request.password);
    const form: Record<string, string> = {
      grant_type: "password",
      username: request.email.trim(),
      password: hash,
      scope: "api offline_access",
      client_id: "browser",
      deviceType: String(this.options.deviceType),
      deviceIdentifier: this.options.deviceId,
      deviceName: this.options.deviceName,
    };
    if (request.twoFactor) {
      form.twoFactorToken = request.twoFactor.code.replace(/\s/g, "");
      form.twoFactorProvider = String(request.twoFactor.provider);
      form.twoFactorRemember = request.twoFactor.remember ? "1" : "0";
    }
    if (request.newDeviceCode) form.newDeviceOtp = request.newDeviceCode.trim();

    const response = await this.#send(`${this.#servers.identity}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(form),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return { status: "signed-in", account: signedIn(body, config, key) };
    if (response.status === 429) throw rateLimited();
    if (response.status !== 400) throw serverError(response.status);

    const providers = body.TwoFactorProviders2 as Record<string, { Email?: string } | null> | undefined;
    if (providers && !request.twoFactor) {
      const email = providers[String(TwoFactorProvider.Email)]?.Email;
      return { status: "two-factor", providers: Object.keys(providers).map(Number), ...(email ? { email } : {}) };
    }
    if (isNewDevice(body) && !request.newDeviceCode) return { status: "new-device" };
    // a code was sent, so the password had passed already (it's how the code was asked for)
    if (request.twoFactor || request.newDeviceCode)
      throw new BitwardenError("That code didn't work. Try again.", "wrong-code", 400);
    if (body.error === "invalid_grant")
      throw new BitwardenError("Wrong email or master password.", "wrong-password", 400);
    throw new BitwardenError(errorMessage(body) ?? "Bitwarden didn't accept the sign-in.", "server", 400);
  }

  /** Asks Bitwarden to email a two-step login code (when the account uses email codes). */
  async sendEmailCode(email: string, password: string, kdf: KdfConfig): Promise<void> {
    const key = await masterKey(password, email, kdf, this.options.argon2);
    await this.#json(`${this.#servers.api}/two-factor/send-email-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email.trim(),
        masterPasswordHash: await masterPasswordHash(key, password),
        deviceIdentifier: this.options.deviceId,
      }),
      empty: true,
    });
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    const response = await this.#send(`${this.#servers.identity}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "browser", refresh_token: refreshToken }),
    });
    if (response.status === 400 || response.status === 401) {
      throw new BitwardenError("Signed out of Bitwarden. Sign in again.", "unauthorized", response.status);
    }
    if (response.status === 429) throw rateLimited();
    if (!response.ok) throw serverError(response.status);
    return tokensOf((await response.json()) as Record<string, unknown>, refreshToken);
  }

  sync(accessToken: string): Promise<SyncData> {
    return this.#json(`${this.#servers.api}/sync?excludeDomains=true`, { token: accessToken });
  }

  createCipher(accessToken: string, cipher: CipherRequest): Promise<CipherData> {
    return this.#json(`${this.#servers.api}/ciphers`, {
      method: "POST",
      token: accessToken,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cipher),
    });
  }

  /** Fails with "out-of-date" when someone changed it since `lastKnownRevisionDate`. */
  updateCipher(accessToken: string, id: string, cipher: CipherRequest): Promise<CipherData> {
    return this.#json(`${this.#servers.api}/ciphers/${encodeURIComponent(id)}`, {
      method: "PUT",
      token: accessToken,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cipher),
    });
  }

  async #json<T>(url: string, request: Request = {}): Promise<T> {
    const { token, empty, ...rest } = request;
    const response = await this.#send(url, {
      ...rest,
      headers: { ...rest.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (response.status === 401) throw new BitwardenError("Bitwarden needs you to sign in again.", "unauthorized", 401);
    if (response.status === 429) throw rateLimited();
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const message = errorMessage(body);
      if (response.status === 400 && message && /out of date/i.test(message)) {
        throw new BitwardenError(message, "out-of-date", 400);
      }
      throw new BitwardenError(message ?? `Bitwarden answered ${response.status}.`, "server", response.status);
    }
    return (empty ? undefined : await response.json()) as T;
  }

  async #send(url: string, request: Omit<Request, "token" | "empty">): Promise<Response> {
    try {
      return await this.#fetch(url, {
        ...request,
        headers: {
          Accept: "application/json",
          "Bitwarden-Client-Name": "browser",
          "Bitwarden-Client-Version": this.options.clientVersion,
          "Device-Type": String(this.options.deviceType),
          ...request.headers,
        },
      });
    } catch {
      throw new BitwardenError("Couldn't reach Bitwarden. Check your connection.", "network");
    }
  }
}

function signedIn(body: Record<string, unknown>, kdf: KdfConfig, key: Uint8Array<ArrayBuffer>): SignedIn {
  const protectedUserKey = body.Key;
  if (typeof protectedUserKey !== "string") {
    throw new BitwardenError(
      "This account signs in without a master password, which isn't supported yet.",
      "unsupported",
    );
  }
  return {
    tokens: tokensOf(body),
    kdf,
    protectedUserKey,
    ...(typeof body.PrivateKey === "string" ? { protectedPrivateKey: body.PrivateKey } : {}),
    masterKey: key,
  };
}

function tokensOf(body: Record<string, unknown>, previousRefresh?: string): Tokens {
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token ?? previousRefresh;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new BitwardenError("Bitwarden's answer had no tokens.", "server");
  }
  const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return { accessToken, refreshToken, expiresAt: Date.now() + seconds * 1000 };
}

function isNewDevice(body: Record<string, unknown>): boolean {
  const text = `${String(body.error ?? "")} ${String(body.error_description ?? "")} ${errorMessage(body) ?? ""}`;
  return /device_error|new device/i.test(text);
}

function errorMessage(body: Record<string, unknown>): string | undefined {
  const model = (body.ErrorModel ?? body) as { Message?: unknown; message?: unknown };
  const message = model.Message ?? model.message;
  return typeof message === "string" ? message : undefined;
}

function rateLimited() {
  return new BitwardenError("Too many tries. Wait a minute, then try again.", "rate-limited", 429);
}

function serverError(status: number) {
  return new BitwardenError(`Bitwarden had a problem (${status}). Try again later.`, "server", status);
}
