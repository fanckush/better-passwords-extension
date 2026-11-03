import { FakeHelper, MemoryTransport } from "@app/fake-helper";
import { describe, expect, it, vi } from "vitest";
import {
  ApplePasswordsClient,
  BinaryCodec,
  Command,
  type HelperMessage,
  ProtocolError,
  pake,
  randomBytes,
} from "../src/index.ts";

const vault = [
  { hostname: "example.com", username: "alice@example.com", password: "correct horse" },
  { hostname: "example.com", username: "bob", password: "battery staple" },
  { hostname: "other.test", username: "carol", password: "hunter2" },
];
const tab = { tabId: 1 };

async function setup(options: { base64?: boolean; now?: () => number } = {}) {
  const helper = new FakeHelper({ vault, ...(options.base64 === undefined ? {} : { base64: options.base64 }) });
  const transport = new MemoryTransport(helper);
  const client = await ApplePasswordsClient.connect(transport, options.now ? { now: options.now } : {});
  return { helper, transport, client };
}

async function pair(helper: FakeHelper, client: ApplePasswordsClient) {
  await client.requestChallenge();
  await client.verifyCode(helper.currentCode ?? "");
}

/** A helper that rewrites its own replies, to play a buggy or hostile one. Undefined drops a reply. */
class TamperingHelper extends FakeHelper {
  constructor(private readonly tamper: (request: HelperMessage, reply: HelperMessage) => HelperMessage | undefined) {
    super({ vault });
  }

  override async handle(message: HelperMessage): Promise<HelperMessage[]> {
    return (await super.handle(message)).flatMap((reply) => this.tamper(message, reply) ?? []);
  }
}

/** Changes fields of one handshake step's PAKE reply ("m0": the challenge, "m2": the verification). */
function tamperHandshake(step: "m0" | "m2", change: Record<string, unknown>) {
  return (request: HelperMessage, reply: HelperMessage): HelperMessage => {
    if (request.cmd !== Command.Handshake || (request.msg as { QID: string }).QID !== step) return reply;
    const original = pake.decode<Record<string, unknown>>(String(reply.payload?.PAKE));
    return { ...reply, payload: { PAKE: pake.encode({ ...original, ...change }) } };
  };
}

describe("ApplePasswordsClient", () => {
  it("pairs with the shown code and reads logins and passwords", async () => {
    const { helper, client } = await setup();
    expect(client.state).toBe("locked");

    await client.requestChallenge();
    expect(client.state).toBe("awaiting-code");
    expect(client.hasLiveChallenge).toBe(true);

    await client.verifyCode(helper.currentCode ?? "");
    expect(client.state).toBe("unlocked");

    const logins = await client.getLogins("example.com", tab);
    expect(logins.map((l) => l.username)).toEqual(["alice@example.com", "bob"]);
    expect(await client.getPassword("example.com", "bob", tab)).toEqual({
      username: "bob",
      password: "battery staple",
    });
  });

  it("returns nothing for unknown sites and users", async () => {
    const { helper, client } = await setup();
    await pair(helper, client);
    expect(await client.getLogins("nowhere.test", tab)).toEqual([]);
    expect(await client.getPassword("example.com", "mallory", tab)).toBeUndefined();
  });

  it("works with the older hex encoding", async () => {
    const { helper, client } = await setup({ base64: false });
    await pair(helper, client);
    expect(await client.getLogins("other.test", tab)).toHaveLength(1);
  });

  it("rejects a wrong code and burns the challenge", async () => {
    const { helper, client } = await setup();
    await client.requestChallenge();
    const wrong = helper.currentCode === "000000" ? "111111" : "000000";

    await expect(client.verifyCode(wrong)).rejects.toMatchObject({ code: "incorrect-code" });
    expect(client.state).toBe("locked");
    await expect(client.verifyCode(wrong)).rejects.toMatchObject({ code: "challenge-expired" });
  });

  it("refuses a code after the challenge expired", async () => {
    let now = 0;
    const { helper, client } = await setup({ now: () => now });
    await client.requestChallenge();
    now += 3 * 60_000;
    await expect(client.verifyCode(helper.currentCode ?? "")).rejects.toMatchObject({
      code: "challenge-expired",
    });
  });

  it("refuses queries before pairing", async () => {
    const { client } = await setup();
    await expect(client.getLogins("example.com", tab)).rejects.toBeInstanceOf(ProtocolError);
  });

  it("opens the Passwords app without pairing, passing only web addresses", async () => {
    const { helper, client } = await setup();
    client.openPasswordsApp("https://example.com/login");
    client.openPasswordsApp("chrome://settings");
    client.openPasswordsApp();
    await vi.waitFor(() => expect(helper.passwordsAppLaunches).toEqual(["https://example.com/login", "", ""]));
  });

  it("saves a login, which a lookup then finds", async () => {
    const { helper, client } = await setup();
    await pair(helper, client);
    const login = { hostname: "new.test", username: "dana", password: "s3cret-one" };
    await client.savePassword(login, tab);
    await vi.waitFor(() => expect(helper.saved).toEqual([login]));
    expect((await client.getLogins("new.test", { tabId: 99 })).map((l) => l.username)).toEqual(["dana"]);
  });

  it("keeps working when the user declines", async () => {
    const helper = new FakeHelper({ vault, declineSaves: true });
    const client = await ApplePasswordsClient.connect(new MemoryTransport(helper));
    await pair(helper, client);
    await client.savePassword({ hostname: "new.test", username: "dana", password: "x" }, tab);
    expect(await client.getLogins("new.test", { tabId: 99 })).toEqual([]);
    expect(helper.saved).toEqual([]);
  });

  it("refuses to save before pairing", async () => {
    const { client } = await setup();
    await expect(
      client.savePassword({ hostname: "new.test", username: "dana", password: "x" }, tab),
    ).rejects.toMatchObject({ code: "closed" });
  });

  it("ignores updates for another tab while waiting for a reply", async () => {
    const { helper, transport, client } = await setup();
    await pair(helper, client);
    const pending = client.getLogins("example.com", { tabId: 1 });
    // an unrequested update for tab 2 arrives first; it must not answer tab 1's query
    transport.push({ cmd: Command.GetLoginNamesForUrl, tabId: 2, frameId: 0, payload: { SMSG: "{}" } });
    expect((await pending).map((l) => l.username)).toEqual(["alice@example.com", "bob"]);
  });

  it("locks when the helper asks to re-login", async () => {
    const { helper, transport, client } = await setup();
    await pair(helper, client);
    transport.push(helper.invalidateSession());
    expect(client.state).toBe("locked");
    await expect(client.getLogins("example.com", tab)).rejects.toMatchObject({ code: "closed" });
  });

  it("closes and fails pending requests when the helper exits", async () => {
    const { helper, transport, client } = await setup();
    await pair(helper, client);
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));
    transport.kill();
    expect(client.state).toBe("closed");
    expect(states).toEqual(["closed"]);
    await expect(client.requestChallenge()).rejects.toMatchObject({ code: "closed" });
  });

  it("serializes concurrent queries of one kind so replies cannot cross", async () => {
    const { helper, transport, client } = await setup();
    await pair(helper, client);
    const before = transport.sent.length;
    const results = await Promise.all([
      client.getLogins("example.com", tab),
      client.getLogins("other.test", tab),
      client.getPassword("other.test", "carol", tab),
    ]);
    expect(results[0]).toHaveLength(2);
    expect(results[1]?.[0]).toMatchObject({ username: "carol" });
    expect(results[2]).toEqual({ username: "carol", password: "hunter2" });
    const sent = transport.sent.slice(before).map((m) => (m as { cmd: number }).cmd);
    expect(sent.filter((cmd) => cmd === Command.GetLoginNamesForUrl)).toHaveLength(2);
    expect(sent.filter((cmd) => cmd === Command.GetPasswordForLoginName)).toHaveLength(1);
  });

  it("never sends the code or password in clear text", async () => {
    const { helper, transport, client } = await setup();
    await client.requestChallenge();
    const code = helper.currentCode ?? "";
    await client.verifyCode(code);
    await client.getPassword("example.com", "bob", tab);
    const wire = JSON.stringify(transport.sent);
    expect(wire).not.toContain(code);
    expect(wire).not.toContain("battery staple");
  });

  it("refuses a helper that requires an unsupported session version", async () => {
    const helper = new FakeHelper({ vault, capabilities: { secretSessionVersion: 2 } });
    const transport = new MemoryTransport(helper);
    await expect(ApplePasswordsClient.connect(transport)).rejects.toMatchObject({ code: "unsupported" });
    expect(transport.sent.at(-1)).toEqual({ cmd: Command.End });
  });

  it("refuses a helper that can't prove it knows the code", async () => {
    const forged = new BinaryCodec(true).encode(randomBytes(32));
    const helper = new TamperingHelper(tamperHandshake("m2", { HAMK: forged }));
    const client = await ApplePasswordsClient.connect(new MemoryTransport(helper));
    await client.requestChallenge();
    await expect(client.verifyCode(helper.currentCode ?? "")).rejects.toMatchObject({
      code: "server-proof-mismatch",
    });
    expect(client.state).toBe("locked");
    await expect(client.getLogins("example.com", tab)).rejects.toMatchObject({ code: "closed" });
  });

  it.each([
    ["m0", "is for another session", { TID: "someone-else" }, "invalid-reply"],
    ["m0", "reports an error", { ErrCode: 2 }, "invalid-reply"],
    ["m0", "is the wrong message", { MSG: 3 }, "invalid-reply"],
    ["m0", "picks an unsupported protocol", { PROTO: 2 }, "unsupported"],
    ["m2", "is for another session", { TID: "someone-else" }, "invalid-reply"],
    ["m2", "is the wrong message", { MSG: 1 }, "invalid-reply"],
    ["m2", "reports an unknown error", { ErrCode: 5 }, "invalid-reply"],
  ] as const)("stays locked when the helper's %s reply %s", async (step, _, change, code) => {
    const helper = new TamperingHelper(tamperHandshake(step, change));
    const client = await ApplePasswordsClient.connect(new MemoryTransport(helper));
    await expect(pair(helper, client)).rejects.toMatchObject({ code });
    expect(client.state).toBe("locked");
  });

  it("refuses an encrypted reply for another session", async () => {
    const helper = new TamperingHelper((request, reply) => {
      if (request.cmd !== Command.GetLoginNamesForUrl) return reply;
      const smsg = JSON.parse(String(reply.payload?.SMSG)) as Record<string, unknown>;
      return { ...reply, payload: { SMSG: JSON.stringify({ ...smsg, TID: "someone-else" }) } };
    });
    const client = await ApplePasswordsClient.connect(new MemoryTransport(helper));
    await pair(helper, client);
    await expect(client.getLogins("example.com", tab)).rejects.toMatchObject({ code: "invalid-reply" });
  });

  describe("when a password never comes (Touch ID dismissed)", () => {
    /** Drops the reply to the first password read, as the helper does when its prompt is dismissed. */
    function silentOnce() {
      let dropped = false;
      return new TamperingHelper((request, reply) => {
        if (request.cmd !== Command.GetPasswordForLoginName || dropped) return reply;
        dropped = true;
        return undefined;
      });
    }

    it("still lists logins meanwhile", async () => {
      const helper = silentOnce();
      const client = await ApplePasswordsClient.connect(new MemoryTransport(helper));
      await pair(helper, client);
      const password = client.getPassword("example.com", "bob", tab).catch((error: unknown) => error);
      expect(await client.getLogins("example.com", tab)).toHaveLength(2);
      client.close();
      expect(await password).toMatchObject({ code: "closed" });
    });

    it("lets a new read replace it, keeping the session", async () => {
      const helper = silentOnce();
      const transport = new MemoryTransport(helper);
      const client = await ApplePasswordsClient.connect(transport);
      await pair(helper, client);
      const first = client.getPassword("example.com", "bob", tab).catch((error: unknown) => error);
      await vi.waitFor(() => expect(transport.sent.some((message) => (message as HelperMessage).cmd === 5)).toBe(true));
      expect(await client.getPassword("example.com", "bob", tab)).toEqual({
        username: "bob",
        password: "battery staple",
      });
      expect(await first).toMatchObject({ code: "superseded" });
      expect(client.state).toBe("unlocked");
    });

    it("refuses its late answer when another login was asked for since", async () => {
      // bob's answer comes late, just as alice's is expected
      let late: HelperMessage | undefined;
      const helper = new TamperingHelper((request, reply) => {
        if (request.cmd !== Command.GetPasswordForLoginName) return reply;
        if (!late) {
          late = reply;
          return undefined;
        }
        return late;
      });
      const client = await ApplePasswordsClient.connect(new MemoryTransport(helper));
      await pair(helper, client);
      const first = client.getPassword("example.com", "bob", tab).catch((error: unknown) => error);
      await vi.waitFor(() => expect(late).toBeDefined());
      await expect(client.getPassword("example.com", "alice@example.com", tab)).rejects.toMatchObject({
        code: "invalid-reply",
      });
      expect(await first).toMatchObject({ code: "superseded" });
    });

    it("refuses a late password for another site with the same username and tab", async () => {
      let late: HelperMessage | undefined;
      const helper = new TamperingHelper((request, reply) => {
        if (request.cmd !== Command.GetPasswordForLoginName) return reply;
        if (!late) {
          late = reply;
          return undefined;
        }
        return late;
      });
      const client = await ApplePasswordsClient.connect(new MemoryTransport(helper));
      await pair(helper, client);
      const first = client.getPassword("example.com", "bob", tab).catch((error: unknown) => error);
      await vi.waitFor(() => expect(late).toBeDefined());
      await expect(client.getPassword("other.test", "bob", tab)).rejects.toMatchObject({ code: "invalid-reply" });
      expect(await first).toMatchObject({ code: "superseded" });
      client.close();
    });
  });

  it("gives up on a reply that never comes, and keeps working after", async () => {
    let dropped = false;
    const helper = new TamperingHelper((request, reply) => {
      if (request.cmd !== Command.GetLoginNamesForUrl || dropped) return reply;
      dropped = true;
      return undefined;
    });
    const client = await ApplePasswordsClient.connect(new MemoryTransport(helper), { timeoutMs: 50 });
    await pair(helper, client);
    await expect(client.getLogins("example.com", tab)).rejects.toMatchObject({ code: "timeout" });
    expect(await client.getLogins("example.com", tab)).toHaveLength(2);
  });
});
