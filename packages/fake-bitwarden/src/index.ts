// A test double of Bitwarden's servers (identity and API), answering what Better Passwords sends,
// the way bitwarden.com was seen to answer (docs/bitwarden.md). Its account is real: the user key
// is wrapped with the master password's key, and logins are encrypted, so the client's
// cryptography runs for real against it. `handle` takes a standard Request, for unit tests
// (through `fetch`) and for Playwright's request routing in e2e tests.

import {
  type CipherData,
  encrypt,
  encryptText,
  type Fetch,
  masterKey,
  masterPasswordHash,
  SERVERS,
  type Servers,
  type SymmetricKey,
  serversFor,
  stretch,
} from "@app/bitwarden";
import { totp } from "@app/otp";

export interface FakeLogin {
  name: string;
  username: string;
  password: string;
  uris: string[];
  totp?: string;
}

export interface FakeBitwardenOptions {
  email?: string;
  password?: string;
  /** PBKDF2 iterations: few, so tests run fast. */
  iterations?: number;
  /** An authenticator secret: two-step login is on with it. */
  twoFactorSecret?: string;
  /** Code emailed for two-step login (provider 1), when set: email codes are on too. */
  emailCode?: string;
  /** Code emailed for new devices: asked of every device not seen before. */
  newDeviceCode?: string;
  logins?: FakeLogin[];
  /** A self-hosted server's address: it answers there too, under /identity and /api. */
  url?: string;
}

const ACCESS_TTL_S = 3600;

export class FakeBitwarden {
  readonly email: string;
  readonly password: string;
  readonly ciphers: CipherData[] = [];
  /** Every request, for assertions: method and path. */
  readonly requests: string[] = [];
  /** Answers every API call with 401 while true, as an expired session does. */
  revoked = false;
  readonly #options: FakeBitwardenOptions;
  readonly #devices = new Set<string>();
  readonly #accessTokens = new Set<string>();
  readonly #refreshTokens = new Set<string>();
  #userKey!: SymmetricKey;
  #protectedUserKey = "";
  #hash = "";
  #emailsSent = 0;

  private constructor(options: FakeBitwardenOptions) {
    this.#options = options;
    this.email = options.email ?? "tester@example.com";
    this.password = options.password ?? "correct horse battery staple";
  }

  static async create(options: FakeBitwardenOptions = {}): Promise<FakeBitwarden> {
    const server = new FakeBitwarden(options);
    await server.#setUp();
    return server;
  }

  get iterations(): number {
    return this.#options.iterations ?? 5_000;
  }

  /** How many two-step login emails were asked for. */
  get emailsSent(): number {
    return this.#emailsSent;
  }

  /** `fetch` for the client: every request goes to `handle`. */
  readonly fetch: Fetch = (url, init) => this.handle(new Request(url, init));

  async addLogin(login: FakeLogin): Promise<CipherData> {
    const key = this.#userKey;
    const cipher: CipherData = {
      id: crypto.randomUUID(),
      type: 1,
      organizationId: null,
      folderId: null,
      favorite: false,
      reprompt: 0,
      key: null,
      notes: null,
      name: await encryptText(login.name, key),
      revisionDate: new Date().toISOString(),
      deletedDate: null,
      passwordHistory: null,
      login: {
        username: await encryptText(login.username, key),
        password: await encryptText(login.password, key),
        totp: login.totp ? await encryptText(login.totp, key) : null,
        uris: await Promise.all(login.uris.map(async (uri) => ({ uri: await encryptText(uri, key), match: null }))),
      },
    };
    this.ciphers.push(cipher);
    return cipher;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}`);
    const servers: Servers[] = [
      ...Object.values(SERVERS),
      ...(this.#options.url ? [serversFor({ url: this.#options.url })] : []),
    ];
    const address = `${url.origin}${url.pathname}`;
    const under = (base: string) => (address.startsWith(`${base}/`) ? address.slice(base.length) : undefined);
    const identity = servers.map((s) => under(s.identity)).find((path) => path !== undefined);
    const path = servers.map((s) => under(s.api)).find((path) => path !== undefined);
    if (identity === "/accounts/prelogin") return this.#prelogin(request);
    if (identity === "/connect/token") return this.#token(request);
    if (path === undefined) return json({ message: "Not found" }, 404);
    if (path === "/two-factor/send-email-login") return this.#sendEmail(request);
    if (this.revoked || !this.#accessTokens.has(bearer(request))) return new Response(null, { status: 401 });
    if (path === "/sync" && request.method === "GET") return this.#sync();
    if (path === "/ciphers" && request.method === "POST") return this.#saveCipher(request);
    const update = /^\/ciphers\/([^/]+)$/.exec(path);
    if (update && request.method === "PUT") return this.#saveCipher(request, update[1]);
    return json({ message: "Not found" }, 404);
  }

  async #setUp() {
    const key = await masterKey(this.password, this.email, { kdf: 0, iterations: this.iterations });
    this.#hash = await masterPasswordHash(key, this.password);
    const userKey = crypto.getRandomValues(new Uint8Array(64));
    this.#userKey = { enc: userKey.slice(0, 32), mac: userKey.slice(32) };
    this.#protectedUserKey = await encrypt(userKey, await stretch(key));
    for (const login of this.#options.logins ?? []) await this.addLogin(login);
  }

  async #prelogin(request: Request) {
    const { email } = (await request.json()) as { email: string };
    // like Bitwarden, any email gets an answer (the defaults for unknown ones)
    const known = email.trim().toLowerCase() === this.email;
    return json({
      kdf: 0,
      kdfIterations: known ? this.iterations : 600_000,
      kdfMemory: null,
      kdfParallelism: null,
    });
  }

  async #token(request: Request) {
    const form = new URLSearchParams(await request.text());
    if (form.get("client_id") !== "browser") return json({ error: "invalid_client" }, 400);
    if (form.get("grant_type") === "refresh_token") {
      const refresh = form.get("refresh_token") ?? "";
      if (this.revoked || !this.#refreshTokens.has(refresh)) return json({ error: "invalid_grant" }, 400);
      return json(this.#issue(refresh));
    }
    const badPassword = {
      error: "invalid_grant",
      error_description: "invalid_username_or_password",
      ErrorModel: { Object: "error", Message: "Username or password is incorrect. Try again." },
    };
    if (form.get("username")?.toLowerCase() !== this.email || form.get("password") !== this.#hash) {
      return json(badPassword, 400);
    }
    const providers: Record<string, unknown> = {};
    if (this.#options.twoFactorSecret) providers["0"] = null;
    if (this.#options.emailCode) providers["1"] = { Email: maskEmail(this.email) };
    const provider = form.get("twoFactorProvider");
    const code = form.get("twoFactorToken");
    if (Object.keys(providers).length > 0) {
      if (provider === null || code === null) {
        return json(
          { error: "invalid_grant", error_description: "Two factor required.", TwoFactorProviders2: providers },
          400,
        );
      }
      const valid =
        (provider === "0" &&
          this.#options.twoFactorSecret &&
          code === (await totp(this.#options.twoFactorSecret, Date.now()))) ||
        (provider === "1" && code === this.#options.emailCode);
      if (!valid) {
        return json(
          { ...badPassword, ErrorModel: { Object: "error", Message: "Two-step token is invalid. Try again." } },
          400,
        );
      }
    } else if (this.#options.newDeviceCode) {
      const device = form.get("deviceIdentifier") ?? "";
      if (!this.#devices.has(device)) {
        const otp = form.get("newDeviceOtp");
        if (otp === null)
          return json({ error: "device_error", error_description: "new device verification required" }, 400);
        if (otp !== this.#options.newDeviceCode) {
          return json({ error: "invalid_grant", error_description: "invalid new device otp" }, 400);
        }
      }
    }
    this.#devices.add(form.get("deviceIdentifier") ?? "");
    return json({
      ...this.#issue(),
      Key: this.#protectedUserKey,
      PrivateKey: null,
      Kdf: 0,
      KdfIterations: this.iterations,
      KdfMemory: null,
      KdfParallelism: null,
    });
  }

  async #sendEmail(request: Request) {
    const body = (await request.json()) as { email: string; masterPasswordHash: string };
    if (body.email.toLowerCase() !== this.email || body.masterPasswordHash !== this.#hash) {
      return json({ message: "Username or password is incorrect. Try again." }, 400);
    }
    this.#emailsSent++;
    return new Response(null, { status: 200 });
  }

  #issue(refresh?: string) {
    const access = `access-${crypto.randomUUID()}`;
    const refreshToken = refresh ?? `refresh-${crypto.randomUUID()}`;
    this.#accessTokens.add(access);
    this.#refreshTokens.add(refreshToken);
    return {
      access_token: access,
      expires_in: ACCESS_TTL_S,
      token_type: "Bearer",
      refresh_token: refreshToken,
      scope: "api offline_access",
    };
  }

  #sync() {
    return json({
      profile: { id: "user", email: this.email, key: this.#protectedUserKey, privateKey: null, organizations: [] },
      folders: [],
      collections: [],
      ciphers: this.ciphers,
      policies: [],
      sends: [],
      object: "sync",
    });
  }

  async #saveCipher(request: Request, id?: string) {
    const body = (await request.json()) as Partial<CipherData> & { lastKnownRevisionDate?: string };
    const existing = id === undefined ? undefined : this.ciphers.find((c) => c.id === id);
    if (id !== undefined && !existing) return json({ message: "Resource not found." }, 404);
    if (existing && body.lastKnownRevisionDate !== existing.revisionDate) {
      return json(
        {
          message:
            "The item cannot be saved because it is out of date. To edit this item, first sync your vault, or log out and back in.",
          object: "error",
        },
        400,
      );
    }
    const { lastKnownRevisionDate: _, ...fields } = body;
    // a millisecond later at least, so a stale revision date never matches again
    const revisionDate = new Date(Math.max(Date.now(), Date.parse(existing?.revisionDate ?? "0") + 1)).toISOString();
    const cipher: CipherData = {
      ...(existing ?? { id: crypto.randomUUID(), deletedDate: null }),
      ...fields,
      revisionDate,
    } as CipherData;
    if (existing) this.ciphers[this.ciphers.indexOf(existing)] = cipher;
    else this.ciphers.push(cipher);
    return json(cipher);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function bearer(request: Request): string {
  return request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
}

function maskEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 1)}${"*".repeat(Math.max(name.length - 1, 1))}@${domain}`;
}
