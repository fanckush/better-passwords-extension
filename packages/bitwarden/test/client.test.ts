import { FakeBitwarden } from "@app/fake-bitwarden";
import { totp } from "@app/otp";
import { describe, expect, it } from "vitest";
import {
  BitwardenClient,
  decryptVault,
  newLoginRequest,
  newPasswordRequest,
  openUserKey,
  selfHostedUrl,
  serversFor,
} from "../src/index.ts";

const LOGIN = { name: "Example", username: "alice", password: "pw-alice", uris: ["https://example.com/login"] };

function clientFor(server: FakeBitwarden, deviceId = crypto.randomUUID()) {
  return new BitwardenClient({
    server: "us",
    deviceId,
    deviceType: 2,
    deviceName: "chrome",
    clientVersion: "test",
    fetch: server.fetch,
  });
}

async function signedIn(server: FakeBitwarden) {
  const client = clientFor(server);
  const result = await client.signIn({ email: server.email, password: server.password });
  if (result.status !== "signed-in") throw new Error(result.status);
  const user = await openUserKey(result.account.protectedUserKey, result.account.masterKey);
  return { client, account: result.account, user };
}

describe("signing in", () => {
  it("signs in and opens the vault with the master password", async () => {
    const server = await FakeBitwarden.create({ logins: [LOGIN] });
    const { client, account, user } = await signedIn(server);
    const vault = await decryptVault(await client.sync(account.tokens.accessToken), user);
    expect(vault.logins.map((l) => [l.username, l.password])).toEqual([["alice", "pw-alice"]]);
    expect(account.kdf).toEqual({ kdf: 0, iterations: server.iterations });
  });

  it("says when the password is wrong", async () => {
    const server = await FakeBitwarden.create();
    await expect(clientFor(server).signIn({ email: server.email, password: "nope" })).rejects.toMatchObject({
      code: "wrong-password",
    });
  });

  it("asks for an authenticator code, then takes it", async () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const server = await FakeBitwarden.create({ twoFactorSecret: secret });
    const client = clientFor(server);
    const request = { email: server.email, password: server.password };
    expect(await client.signIn(request)).toEqual({ status: "two-factor", providers: [0] });
    await expect(client.signIn({ ...request, twoFactor: { provider: 0, code: "000000" } })).rejects.toMatchObject({
      code: "wrong-code",
    });
    const code = await totp(secret, Date.now());
    expect(
      (await client.signIn({ ...request, twoFactor: { provider: 0, code: ` ${code.slice(0, 3)} ${code.slice(3)}` } }))
        .status,
    ).toBe("signed-in");
  });

  it("offers email codes with the masked address, and sends one when asked", async () => {
    const server = await FakeBitwarden.create({ emailCode: "424242" });
    const client = clientFor(server);
    const result = await client.signIn({ email: server.email, password: server.password });
    expect(result).toEqual({ status: "two-factor", providers: [1], email: "t*****@example.com" });
    await client.sendEmailCode(server.email, server.password, { kdf: 0, iterations: server.iterations });
    expect(server.emailsSent).toBe(1);
    const done = await client.signIn({
      email: server.email,
      password: server.password,
      twoFactor: { provider: 1, code: "424242" },
    });
    expect(done.status).toBe("signed-in");
  });

  it("asks a new device for the emailed code, and remembers it after", async () => {
    const server = await FakeBitwarden.create({ newDeviceCode: "135790" });
    const device = crypto.randomUUID();
    const client = clientFor(server, device);
    const request = { email: server.email, password: server.password };
    expect(await client.signIn(request)).toEqual({ status: "new-device" });
    await expect(client.signIn({ ...request, newDeviceCode: "000000" })).rejects.toMatchObject({ code: "wrong-code" });
    expect((await client.signIn({ ...request, newDeviceCode: "135790" })).status).toBe("signed-in");
    expect((await client.signIn(request)).status).toBe("signed-in");
  });

  it("fails with a wrong master password when opening the vault", async () => {
    const server = await FakeBitwarden.create();
    const { account } = await signedIn(server);
    const { masterKey } = await import("../src/crypto.ts");
    const wrong = await masterKey("not it", server.email, account.kdf);
    await expect(openUserKey(account.protectedUserKey, wrong)).rejects.toThrow("wrong key");
  });

  it("says when Bitwarden can't be reached", async () => {
    const client = new BitwardenClient({
      server: "eu",
      deviceId: "d",
      deviceType: 2,
      deviceName: "chrome",
      clientVersion: "test",
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await expect(client.prelogin("a@b.c")).rejects.toMatchObject({ code: "network" });
  });
});

describe("sessions", () => {
  it("refreshes the access token, keeping the refresh token", async () => {
    const server = await FakeBitwarden.create({ logins: [LOGIN] });
    const { client, account } = await signedIn(server);
    const tokens = await client.refresh(account.tokens.refreshToken);
    expect(tokens.refreshToken).toBe(account.tokens.refreshToken);
    expect(tokens.accessToken).not.toBe(account.tokens.accessToken);
    expect((await client.sync(tokens.accessToken)).ciphers).toHaveLength(1);
  });

  it("reports a session Bitwarden ended", async () => {
    const server = await FakeBitwarden.create();
    const { client, account } = await signedIn(server);
    server.revoked = true;
    await expect(client.sync(account.tokens.accessToken)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(client.refresh(account.tokens.refreshToken)).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("saving", () => {
  it("saves a new login that syncs back decrypted", async () => {
    const server = await FakeBitwarden.create();
    const { client, account, user } = await signedIn(server);
    const keys = { user, organizations: new Map() };
    const request = await newLoginRequest(
      { name: "github.com", username: "bob", password: "pw", uri: "https://github.com/" },
      keys,
    );
    await client.createCipher(account.tokens.accessToken, request);
    const vault = await decryptVault(await client.sync(account.tokens.accessToken), user);
    expect(vault.logins).toMatchObject([
      { name: "github.com", username: "bob", password: "pw", uris: [{ uri: "https://github.com/", match: null }] },
    ]);
  });

  it("changes a password, keeping the old one in its history", async () => {
    const server = await FakeBitwarden.create({ logins: [LOGIN] });
    const { client, account, user } = await signedIn(server);
    const keys = { user, organizations: new Map() };
    const [cipher] = (await client.sync(account.tokens.accessToken)).ciphers;
    if (!cipher) throw new Error("no cipher");
    const saved = await client.updateCipher(
      account.tokens.accessToken,
      cipher.id,
      await newPasswordRequest(cipher, "pw-new", keys),
    );
    const vault = await decryptVault(await client.sync(account.tokens.accessToken), user);
    expect(vault.logins[0]?.password).toBe("pw-new");
    expect(saved.passwordHistory).toHaveLength(1);
    // the same change, based on the old revision, is refused
    await expect(
      client.updateCipher(account.tokens.accessToken, cipher.id, await newPasswordRequest(cipher, "pw-other", keys)),
    ).rejects.toMatchObject({ code: "out-of-date" });
  });
});

describe("self-hosted servers", () => {
  it("makes typed addresses canonical", () => {
    expect(selfHostedUrl("vault.example.com")).toBe("https://vault.example.com");
    expect(selfHostedUrl("  https://vault.example.com/  ")).toBe("https://vault.example.com");
    expect(selfHostedUrl("https://example.com/bitwarden/#/login")).toBe("https://example.com/bitwarden");
    expect(selfHostedUrl("http://192.168.1.10:8080")).toBe("http://192.168.1.10:8080");
    expect(selfHostedUrl("HTTPS://Vault.Example.com:8443/?x=1")).toBe("https://vault.example.com:8443");
    for (const bad of ["", "ftp://example.com", "https://user:pw@example.com", "javascript:alert(1)", "http://"]) {
      expect(() => selfHostedUrl(bad), bad).toThrow("That isn't a server address.");
    }
  });

  it("serves identity and API under the web vault's address", () => {
    expect(serversFor({ url: "https://example.com/bw/" })).toEqual({
      identity: "https://example.com/bw/identity",
      api: "https://example.com/bw/api",
      vault: "https://example.com/bw",
    });
    expect(serversFor("eu").api).toBe("https://api.bitwarden.eu");
  });

  it("signs in and syncs against a self-hosted server", async () => {
    const url = "https://vault.example.net";
    const server = await FakeBitwarden.create({ logins: [LOGIN], url });
    const client = new BitwardenClient({
      server: { url },
      deviceId: "d",
      deviceType: 2,
      deviceName: "chrome",
      clientVersion: "test",
      fetch: server.fetch,
    });
    const result = await client.signIn({ email: server.email, password: server.password });
    if (result.status !== "signed-in") throw new Error(result.status);
    expect((await client.sync(result.account.tokens.accessToken)).ciphers).toHaveLength(1);
    expect(server.requests).toEqual([
      "POST /identity/accounts/prelogin",
      "POST /identity/connect/token",
      "GET /api/sync",
    ]);
  });

  it("says when there's no Bitwarden server at the address", async () => {
    const options = { deviceId: "d", deviceType: 2, deviceName: "chrome", clientVersion: "test" };
    const page = new BitwardenClient({
      ...options,
      server: { url: "https://example.com" },
      fetch: async () => new Response("<!doctype html><p>Hello", { headers: { "Content-Type": "text/html" } }),
    });
    await expect(page.prelogin("a@b.c")).rejects.toThrow("No Bitwarden server answered at that address.");
    const missing = new BitwardenClient({
      ...options,
      server: { url: "https://example.com" },
      fetch: async () => new Response("Not found", { status: 404 }),
    });
    await expect(missing.prelogin("a@b.c")).rejects.toThrow("No Bitwarden server answered at that address.");
    const offline = new BitwardenClient({
      ...options,
      server: { url: "https://example.com" },
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await expect(offline.prelogin("a@b.c")).rejects.toThrow("Couldn't reach your server.");
  });
});
