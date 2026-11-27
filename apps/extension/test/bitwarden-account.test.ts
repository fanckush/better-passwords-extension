import { BitwardenClient, type Server } from "@app/bitwarden";
import { FakeBitwarden, type FakeBitwardenOptions } from "@app/fake-bitwarden";
import { totp } from "@app/otp";
import { describe, expect, it } from "vitest";
import {
  BitwardenAccount,
  type BitwardenRecord,
  type BitwardenStore,
  type UnlockedKey,
} from "../src/accounts/bitwarden/account.ts";
import { withServer } from "../src/accounts/bitwarden/index.ts";

const SECRET = "JBSWY3DPEHPK3PXP";
const LOGINS = [
  { name: "Example", username: "alice", password: "pw-alice", uris: ["https://example.com/login"], totp: SECRET },
  { name: "Other", username: "bob", password: "pw-bob", uris: ["https://other.org"] },
];
const PAGE = new URL("https://www.example.com/signin");

interface Memory extends BitwardenStore {
  record: BitwardenRecord | undefined;
  key: UnlockedKey | undefined;
}

function memoryStore(): Memory {
  const store: Memory = {
    record: undefined,
    key: undefined,
    load: async () => store.record && structuredClone(store.record),
    save: async (record) => {
      store.record = structuredClone(record);
    },
    loadKey: async () => store.key,
    saveKey: async (key) => {
      store.key = key;
    },
    clearKey: async () => {
      store.key = undefined;
    },
    clear: async () => {
      store.record = undefined;
      store.key = undefined;
    },
  };
  return store;
}

async function setUp(options: FakeBitwardenOptions = { logins: LOGINS }, lockAfterMinutes = 0) {
  const server = await FakeBitwarden.create(options);
  const store = memoryStore();
  const clock = { now: Date.now() };
  const opened: string[] = [];
  const make = () =>
    new BitwardenAccount("bw", {
      store,
      client: async (where: Server) =>
        new BitwardenClient({
          server: where,
          deviceId: "device",
          deviceType: 2,
          deviceName: "test",
          clientVersion: "test",
          fetch: server.fetch,
        }),
      lockAfterMinutes: async () => lockAfterMinutes,
      now: () => clock.now,
      openTab: async (url) => {
        opened.push(url);
      },
    });
  const account = make();
  const credentials = { server: "us" as const, email: server.email, password: server.password };
  return { server, store, clock, account, make, credentials, opened };
}

async function signedIn(options?: FakeBitwardenOptions, lockAfterMinutes?: number) {
  const setup = await setUp(options, lockAfterMinutes);
  expect(await setup.account.signIn(setup.credentials)).toEqual({ status: "signed-in" });
  return setup;
}

describe("BitwardenAccount", () => {
  it("needs setting up until signed in, then lists the page's logins", async () => {
    const { account, credentials } = await setUp();
    await account.connect();
    expect(account.status.state).toBe("needs-setup");
    await account.signIn(credentials);
    expect(account.status.state).toBe("unlocked");
    expect(account.detail).toBe(credentials.email);
    const logins = await account.logins(PAGE);
    expect(logins.map((l) => l.username)).toEqual(["alice"]);
    expect(await account.credential(PAGE, logins[0]?.id ?? "")).toEqual({ username: "alice", password: "pw-alice" });
  });

  it("takes sign-in steps for two-step login", async () => {
    const { account, credentials } = await setUp({ twoFactorSecret: SECRET, logins: LOGINS });
    expect(await account.signIn(credentials)).toEqual({ status: "two-factor", providers: [0] });
    const code = await totp(SECRET, Date.now());
    expect(await account.signIn({ ...credentials, twoFactor: { provider: 0, code } })).toEqual({ status: "signed-in" });
  });

  it("never gives a password for a page the login isn't saved for", async () => {
    const { account } = await signedIn();
    const [alice] = await account.logins(PAGE);
    expect(await account.credential(new URL("https://evil.example.net/"), alice?.id ?? "")).toBeUndefined();
  });

  it("keeps only encrypted data on disk, and the key in memory", async () => {
    const { store } = await signedIn();
    const disk = JSON.stringify(store.record);
    expect(disk).not.toContain("pw-alice");
    expect(disk).not.toContain("alice");
    expect(store.key?.key).toBeTruthy();
  });

  it("locks, and unlocks with the master password only", async () => {
    const { account, server, store } = await signedIn();
    account.lock();
    expect(account.status.state).toBe("locked");
    expect(store.key).toBeUndefined();
    await expect(account.logins(PAGE)).rejects.toThrow("locked");
    await expect(account.unlock.unlock("wrong")).rejects.toThrow("Wrong master password.");
    await account.unlock.unlock(server.password);
    expect((await account.logins(PAGE)).length).toBe(1);
  });

  it("stays unlocked across a new background worker, from the key in memory", async () => {
    const { make } = await signedIn();
    const restarted = make();
    await restarted.connect();
    expect(restarted.status.state).toBe("unlocked");
    expect((await restarted.logins(PAGE)).map((l) => l.username)).toEqual(["alice"]);
  });

  it("is locked in a new browser session (no key in memory), and opens offline", async () => {
    const { make, store, server } = await signedIn();
    store.key = undefined;
    const next = make();
    await next.connect();
    expect(next.status.state).toBe("locked");
    server.revoked = true; // Bitwarden can't be used, but the copy on disk can
    await next.unlock.unlock(server.password);
    expect((await next.logins(PAGE)).length).toBe(1);
  });

  it("locks after sitting unused for the set time", async () => {
    const { account, clock, make } = await signedIn(undefined, 15);
    clock.now += 14 * 60_000;
    expect((await account.logins(PAGE)).length).toBe(1);
    clock.now += 15 * 60_000;
    await account.lockIfIdle();
    expect(account.status.state).toBe("locked");
    // a worker that starts after the time is up doesn't reopen it either
    const restarted = make();
    await restarted.connect();
    expect(restarted.status.state).toBe("locked");
  });

  it("gives verification codes from saved authenticator setups", async () => {
    const { account } = await signedIn();
    const [code] = await account.oneTimeCodes(PAGE);
    expect(code).toMatchObject({ username: "alice", domain: "www.example.com" });
    expect(await account.oneTimeCode(PAGE, code?.id ?? "")).toBe(await totp(SECRET, Date.now()));
  });

  it("saves a new login, and a new password for a saved one", async () => {
    const { account, server, make } = await signedIn();
    await account.save({ hostname: "github.com", username: "carol", password: "pw-carol" });
    const github = new URL("https://github.com/login");
    expect((await account.logins(github)).map((l) => l.username)).toEqual(["carol"]);

    await account.save({ hostname: "example.com", username: "Alice", password: "pw-new" });
    const [alice] = await account.logins(PAGE);
    expect((await account.credential(PAGE, alice?.id ?? ""))?.password).toBe("pw-new");
    expect(server.ciphers).toHaveLength(3);
    // and it's what the next worker sees too
    const restarted = make();
    await restarted.connect();
    expect((await restarted.logins(github)).length).toBe(1);
  });

  it("saves over a change made elsewhere since the last sync", async () => {
    const { account, server } = await signedIn();
    const cipher = server.ciphers[0];
    if (!cipher) throw new Error("no cipher");
    cipher.revisionDate = new Date(Date.now() + 1000).toISOString(); // edited on another device
    await account.save({ hostname: "example.com", username: "alice", password: "pw-newer" });
    const [alice] = await account.logins(PAGE);
    expect((await account.credential(PAGE, alice?.id ?? ""))?.password).toBe("pw-newer");
  });

  it("says when a sync brought changes to its logins, and only then", async () => {
    const { account, server } = await signedIn();
    let changes = 0;
    account.onLoginsChanged(() => changes++);
    await account.sync();
    expect(changes).toBe(0);
    await server.addLogin({ name: "New", username: "dave", password: "pw", uris: ["example.com"] });
    await account.sync();
    expect(changes).toBe(1);
  });

  it("picks up changes from Bitwarden when synced", async () => {
    const { account, server } = await signedIn();
    await server.addLogin({ name: "New", username: "dave", password: "pw", uris: ["example.com"] });
    await account.sync();
    expect((await account.logins(PAGE)).map((l) => l.username).sort()).toEqual(["alice", "dave"]);
  });

  it("refreshes an expired access token by itself", async () => {
    const { account, server, clock } = await signedIn();
    clock.now += 2 * 3600_000;
    await server.addLogin({ name: "New", username: "erin", password: "pw", uris: ["example.com"] });
    await account.sync();
    expect((await account.logins(PAGE)).length).toBe(2);
    expect(server.requests.filter((r) => r === "POST /connect/token")).toHaveLength(2);
  });

  it("asks to sign in again when Bitwarden ends the session, forgetting the vault", async () => {
    const { account, server, store } = await signedIn();
    server.revoked = true;
    await expect(account.sync()).rejects.toMatchObject({ code: "unauthorized" });
    expect(account.status).toEqual({ state: "needs-setup", error: "Signed out. Sign in again." });
    expect(store.record?.vault).toBeNull();
    expect(store.record?.email).toBe(server.email);
    expect(store.key).toBeUndefined();
  });

  it("opens the web vault of its server, searching for the page's site", async () => {
    const { account, opened, store, make } = await signedIn();
    await account.openApp("https://www.example.com/login");
    await account.openApp();
    if (store.record) store.record.server = "eu";
    await make().openApp("https://github.com/");
    expect(opened).toEqual([
      "https://vault.bitwarden.com/#/vault?search=example.com",
      "https://vault.bitwarden.com/#/vault",
      "https://vault.bitwarden.eu/#/vault?search=github.com",
    ]);
  });

  it("signs in to a self-hosted server, and opens its web vault", async () => {
    const { account, opened, store, server } = await setUp({ logins: LOGINS, url: "https://vault.example.net/bw" });
    const self = { url: "https://vault.example.net/bw" };
    expect(await account.signIn({ ...{ email: server.email, password: server.password }, server: self })).toEqual({
      status: "signed-in",
    });
    expect(store.record?.server).toEqual(self);
    expect(await account.server()).toEqual(self);
    expect(server.requests).toContain("POST /bw/identity/connect/token");
    expect(server.requests).toContain("GET /bw/api/sync");
    await account.openApp("https://example.com/");
    expect(opened).toEqual(["https://vault.example.net/bw/#/vault?search=example.com"]);
  });

  it("reads records saved with a region as on that server", () => {
    expect(withServer(undefined)).toBeUndefined();
    expect(withServer({ region: "eu", email: "a@b.c" })).toEqual({ server: "eu", email: "a@b.c" });
    expect(withServer({ server: { url: "https://x.test" } })).toEqual({ server: { url: "https://x.test" } });
  });

  it("forgets everything when removed", async () => {
    const { account, store } = await signedIn();
    await account.remove();
    expect(store.record).toBeUndefined();
    expect(store.key).toBeUndefined();
    expect(account.status.state).toBe("needs-setup");
  });
});
