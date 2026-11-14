import { FakeHelper, MemoryTransport, totp } from "@app/fake-helper";
import { describe, expect, it, vi } from "vitest";
import { Action, ApplePasswordsClient, Command, type HelperMessage, QueryStatus, SecureChannel } from "../src/index.ts";

const SECRET = "JBSWY3DPEHPK3PXP";
const NOW = 1_800_000_000_000;
const vault = [
  { hostname: "example.com", username: "alice", password: "pw-a", totp: { secret: SECRET } },
  { hostname: "example.com", username: "bob", password: "pw-b", totp: { secret: "GEZDGNBVGY3TQOJQ" } },
  { hostname: "example.com", username: "carol", password: "pw-c" },
  { hostname: "other.test", username: "dana", password: "pw-d", totp: { secret: SECRET } },
];
const tab = { tabId: 1 };
const page = ["https://example.com/2fa"];

async function setup(options: ConstructorParameters<typeof FakeHelper>[0] = {}) {
  let now = NOW;
  const helper = new FakeHelper({ vault, now: () => now, ...options });
  const transport = new MemoryTransport(helper);
  const client = await ApplePasswordsClient.connect(transport);
  await client.requestChallenge();
  await client.verifyCode(helper.currentCode ?? "");
  return { helper, transport, client, tick: (ms: number) => (now += ms) };
}

describe("verification codes", () => {
  it("lists a page's codes without digits while Touch ID is required, as the real helper does", async () => {
    const { helper, client } = await setup();
    const { codes, requiresAuthentication } = await client.getOneTimeCodes(page, tab);
    expect(requiresAuthentication).toBe(true);
    expect(codes).toEqual([
      { code: undefined, username: "alice", domain: "example.com", source: "totp" },
      { code: undefined, username: "bob", domain: "example.com", source: "totp" },
    ]);
    expect(helper.oneTimeCodeReads).toEqual([{ frameURLs: page }]);
  });

  it("lists digits when the helper doesn't require Touch ID", async () => {
    const { client } = await setup({ requiresAuthenticationForCodes: false });
    const { codes, requiresAuthentication } = await client.getOneTimeCodes(page, tab);
    expect(requiresAuthentication).toBe(false);
    expect(codes).toEqual([
      { code: await totp(SECRET, NOW), username: "alice", domain: "example.com", source: "totp" },
      { code: await totp("GEZDGNBVGY3TQOJQ", NOW), username: "bob", domain: "example.com", source: "totp" },
    ]);
  });

  it("asks for one account's codes", async () => {
    const { helper, client } = await setup();
    const { codes } = await client.getOneTimeCodes(page, tab, "bob");
    expect(codes.map((c) => c.username)).toEqual(["bob"]);
    expect(helper.oneTimeCodeReads).toEqual([{ frameURLs: page, username: "bob" }]);
  });

  it("uses Search for targeted codes and GhostSearch for the existing list", async () => {
    const { client } = await setup();
    const encryptRequest = vi.spyOn(SecureChannel.prototype, "encryptRequest");

    await client.searchOneTimeCodes(page, tab, "bob");
    expect(encryptRequest).toHaveBeenLastCalledWith({
      ACT: Action.Search,
      TYPE: "oneTimeCodes",
      frameURLs: page,
      username: "bob",
    });

    await client.getOneTimeCodes(page, tab, "bob");
    expect(encryptRequest).toHaveBeenLastCalledWith({
      ACT: Action.GhostSearch,
      TYPE: "oneTimeCodes",
      frameURLs: page,
      username: "bob",
    });
    encryptRequest.mockRestore();
  });

  it("does not send a targeted search without a username", async () => {
    const { helper, client } = await setup();
    await expect(client.searchOneTimeCodes(page, tab, "")).resolves.toEqual({
      codes: [],
      requiresAuthentication: false,
    });
    expect(helper.oneTimeCodeReads).toEqual([]);
  });

  it("returns nothing for a page without codes", async () => {
    const { client } = await setup();
    expect(await client.getOneTimeCodes(["https://nowhere.test/"], tab)).toEqual({
      codes: [],
      requiresAuthentication: false,
    });
  });

  it("never asks a helper that can't fill codes", async () => {
    const { helper, transport, client } = await setup({ capabilities: { canFillOneTimeCodes: false } });
    const before = transport.sent.length;
    expect(await client.getOneTimeCodes(page, tab)).toEqual({ codes: [], requiresAuthentication: false });
    expect(transport.sent.length).toBe(before);
    expect(helper.oneTimeCodeReads).toEqual([]);
  });

  it("refuses before pairing", async () => {
    const helper = new FakeHelper({ vault });
    const client = await ApplePasswordsClient.connect(new MemoryTransport(helper));
    await expect(client.getOneTimeCodes(page, tab)).rejects.toMatchObject({ code: "closed" });
  });

  it("sends the request like Apple's extension: encrypted, without a url in clear", async () => {
    const { transport, client } = await setup();
    const before = transport.sent.length;
    await client.getOneTimeCodes(page, tab, "alice");
    const [sent] = transport.sent.slice(before) as HelperMessage[];
    expect(sent).toMatchObject({ cmd: Command.GetOneTimeCodes, tabId: 1, frameId: 0 });
    expect(sent).not.toHaveProperty("url");
    expect(sent?.payload).toMatchObject({ QID: "CmdGetOneTimeCodes" });
    expect(JSON.stringify(sent)).not.toContain("alice");
    expect(JSON.stringify(sent)).not.toContain("example.com");
  });

  it("drops entries it can't use, and codes that don't look like codes", async () => {
    const { client } = await setup({
      oneTimeCodesReply: {
        STATUS: QueryStatus.Success,
        Entries: [
          null,
          "123456",
          { code: "123456" },
          { code: "<img src=x>", username: "eve", domain: "example.com", source: "totp" },
          { code: "654321", source: "messages" },
        ],
      },
    });
    expect((await client.getOneTimeCodes(page, tab)).codes).toEqual([
      { code: undefined, username: "eve", domain: "example.com", source: "totp" },
      { code: "654321", username: "", domain: "", source: "messages" },
    ]);
  });

  describe("filling", () => {
    it("reports the fill and uses the code current at that moment", async () => {
      const { helper, client, tick } = await setup();
      const [alice] = (await client.getOneTimeCodes(page, tab)).codes;
      if (!alice) throw new Error("no code");
      tick(30_000);
      const current = await client.currentOneTimeCode(alice, page, tab);
      expect(current).toBe(await totp(SECRET, NOW + 30_000));
      expect(current).not.toBe(await totp(SECRET, NOW));
      expect(helper.oneTimeCodeFills).toEqual([{ frameURLs: page, username: "alice" }]);
    });

    it("uses codes that aren't TOTP as listed, without telling the helper", async () => {
      const { helper, client } = await setup();
      const sms = { code: "424242", username: "", domain: "example.com", source: "messages" };
      expect(await client.currentOneTimeCode(sms, page, tab)).toBe("424242");
      expect(helper.oneTimeCodeFills).toEqual([]);
    });

    it("refuses a late answer for another account", async () => {
      // the first fill's answer is held back (Touch ID dismissed), then arrives as the second's
      let held: (replies: HelperMessage[]) => void = () => {};
      const firstReplies = new Promise<HelperMessage[]>((resolve) => (held = resolve));
      let fills = 0;
      class LateHelper extends FakeHelper {
        override async handle(message: HelperMessage) {
          if (message.cmd !== Command.DidFillOneTimeCode) return super.handle(message);
          // by arrival, not by when the (async) code is ready
          const first = fills++ === 0;
          const replies = await super.handle(message);
          if (!first) return firstReplies;
          held(replies);
          return [];
        }
      }
      const helper = new LateHelper({ vault, now: () => NOW });
      const client = await ApplePasswordsClient.connect(new MemoryTransport(helper));
      await client.requestChallenge();
      await client.verifyCode(helper.currentCode ?? "");
      const [alice, bob] = (await client.getOneTimeCodes(page, tab)).codes;
      if (!alice || !bob) throw new Error("no codes");
      const first = client.currentOneTimeCode(alice, page, tab).catch((error: unknown) => error);
      await expect(client.currentOneTimeCode(bob, page, tab)).rejects.toMatchObject({ code: "invalid-reply" });
      expect(await first).toMatchObject({ code: "superseded" });
    });

    it("waits as long as Touch ID takes", async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      class SlowHelper extends FakeHelper {
        override async handle(message: HelperMessage) {
          if (message.cmd === Command.DidFillOneTimeCode) await gate;
          return super.handle(message);
        }
      }
      const helper = new SlowHelper({ vault, now: () => NOW });
      const client = await ApplePasswordsClient.connect(new MemoryTransport(helper), { timeoutMs: 20 });
      await client.requestChallenge();
      await client.verifyCode(helper.currentCode ?? "");
      const [alice] = (await client.getOneTimeCodes(page, tab)).codes;
      if (!alice) throw new Error("no code");
      const filled = client.currentOneTimeCode(alice, page, tab);
      await new Promise((resolve) => setTimeout(resolve, 60));
      release?.();
      expect(await filled).toBe(await totp(SECRET, NOW));
    });
  });

  it("tells listeners when the helper announces a new code, only while unlocked", async () => {
    const { helper, transport, client } = await setup();
    const heard = vi.fn();
    client.onOneTimeCodeAvailable(heard);
    transport.push(helper.announceOneTimeCode());
    expect(heard).toHaveBeenCalledTimes(1);
    transport.push(helper.invalidateSession());
    transport.push(helper.announceOneTimeCode());
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("locks when the helper says the session is gone", async () => {
    const { client } = await setup({ oneTimeCodesReply: { STATUS: QueryStatus.InvalidSession } });
    await expect(client.getOneTimeCodes(page, tab)).rejects.toMatchObject({ code: "query-failed" });
    expect(client.state).toBe("locked");
  });
});
