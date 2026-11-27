import { FakeHelper, MemoryTransport } from "@app/fake-helper";
import { ApplePasswordsClient } from "@app/protocol";
import { describe, expect, it, vi } from "vitest";
import { findOneTimeCodes, oneTimeCodeId, oneTimeCodeViews } from "../src/passwords/one-time-codes.ts";

const code = (username: string, domain = "example.com", source = "totp") => ({
  code: undefined as string | undefined,
  username,
  domain,
  source,
});

/** A code as the background lists it: named by its id. */
const withId = <T extends ReturnType<typeof code>>(c: T) => ({ ...c, id: oneTimeCodeId(c) });

describe("oneTimeCodeViews", () => {
  it("lists accounts without digits, each once", () => {
    const views = oneTimeCodeViews([code("alice"), { ...code("alice"), code: "123456" }, code("bob")].map(withId));
    expect(views).toEqual([
      { id: oneTimeCodeId(code("alice")), username: "alice", domain: "example.com" },
      { id: oneTimeCodeId(code("bob")), username: "bob", domain: "example.com" },
    ]);
    expect(JSON.stringify(views)).not.toContain("123456");
  });

  it("puts the account just signed in with first, whatever its case", () => {
    const views = oneTimeCodeViews([code("alice"), code("Bob"), code("carol")].map(withId), "bob");
    expect(views.map((v) => v.username)).toEqual(["Bob", "alice", "carol"]);
  });

  it("keeps the order when that account has no code", () => {
    expect(oneTimeCodeViews([code("alice"), code("bob")].map(withId), "dana").map((v) => v.username)).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("tells apart codes of other sites and sources", () => {
    const ids = new Set([code("a"), code("a", "other.test"), code("a", "example.com", "messages")].map(oneTimeCodeId));
    expect(ids.size).toBe(3);
  });
});

describe("findOneTimeCodes", () => {
  const SECRET = "JBSWY3DPEHPK3PXP";
  const vault = [
    { hostname: "example.com", username: "alice", password: "pw-a", totp: { secret: SECRET } },
    { hostname: "example.com", username: "bob", password: "pw-b" },
    { hostname: "no-codes.test", username: "carol", password: "pw-c" },
  ];
  const tab = { tabId: 7 };
  const page = (hostname: string) => [`https://${hostname}/2fa`];

  async function setup(windows: boolean) {
    const helper = new FakeHelper({ vault, windows });
    const client = await ApplePasswordsClient.connect(new MemoryTransport(helper));
    await client.requestChallenge();
    await client.verifyCode(helper.currentCode ?? "");
    const usernames = vi.fn(async (hostname: string) => (await client.getLogins(hostname, tab)).map((l) => l.username));
    return { helper, client, usernames };
  }

  it("on Windows, asks about each of the site's accounts: the helper lists none for a whole site", async () => {
    const { helper, client, usernames } = await setup(true);
    expect((await client.getOneTimeCodes(page("example.com"), tab)).codes).toEqual([]);
    helper.oneTimeCodeReads.length = 0;

    const codes = await findOneTimeCodes(client, page("example.com"), tab, true, () => usernames("example.com"));
    expect(codes.map((code) => [code.username, code.domain, code.source])).toEqual([["alice", "example.com", "totp"]]);
    expect(helper.oneTimeCodeReads).toEqual([
      { frameURLs: page("example.com") },
      { frameURLs: page("example.com"), username: "alice" },
      { frameURLs: page("example.com"), username: "bob" },
    ]);
    // and the code found that way fills
    const [alice] = codes;
    if (!alice) throw new Error("no code found");
    expect(await client.currentOneTimeCode(alice, page("example.com"), tab)).toMatch(/^\d{6}$/);
  });

  it("asks about each account once, and never without a username", async () => {
    const { helper, client } = await setup(true);
    await findOneTimeCodes(client, page("example.com"), tab, true, async () => ["alice", "", "alice"]);
    expect(helper.oneTimeCodeReads.map((read) => read.username)).toEqual([undefined, "alice"]);
  });

  it("finds nothing on a Windows site without codes", async () => {
    const { client, usernames } = await setup(true);
    expect(await findOneTimeCodes(client, page("no-codes.test"), tab, true, () => usernames("no-codes.test"))).toEqual(
      [],
    );
  });

  it("on a Mac, takes the site's list as it is", async () => {
    const { helper, client, usernames } = await setup(false);
    const codes = await findOneTimeCodes(client, page("example.com"), tab, false, () => usernames("example.com"));
    expect(codes.map((code) => code.username)).toEqual(["alice"]);
    expect(await findOneTimeCodes(client, page("no-codes.test"), tab, false, () => usernames("x"))).toEqual([]);
    expect(usernames).not.toHaveBeenCalled();
    expect(helper.oneTimeCodeReads).toHaveLength(2);
  });
});
