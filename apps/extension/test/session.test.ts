import { FakeHelper, MemoryTransport } from "@app/fake-helper";
import { describe, expect, it, vi } from "vitest";
import { Session } from "../src/session/session.ts";

const vault = [{ hostname: "example.com", username: "alice", password: "pw" }];

function setup() {
  const helper = new FakeHelper({ vault });
  const transports: MemoryTransport[] = [];
  const session = new Session({
    openTransport: () => {
      const t = new MemoryTransport(helper);
      transports.push(t);
      return t;
    },
  });
  return { helper, transports, session };
}

describe("Session", () => {
  it("pairs once and reuses the connection", async () => {
    const { helper, transports, session } = setup();
    await session.requestCode();
    await session.verifyCode(helper.currentCode ?? "");
    expect(session.status.state).toBe("unlocked");

    await session.requestCode(); // e.g. popup reopened: must not re-pair
    await session.connect();
    expect(transports).toHaveLength(1);
    expect(session.isUnlocked).toBe(true);
  });

  it("keeps the code on screen when the popup reopens", async () => {
    const { helper, session } = setup();
    await session.requestCode();
    const shown = helper.currentCode;
    await session.requestCode();
    expect(helper.currentCode).toBe(shown);
  });

  it("rejects malformed codes without burning the challenge", async () => {
    const { helper, session } = setup();
    await session.requestCode();
    await expect(session.verifyCode("12ab")).rejects.toThrow();
    await session.verifyCode(helper.currentCode ?? "");
    expect(session.status.state).toBe("unlocked");
  });

  it("reports a missing host registration as setup needed", async () => {
    const session = new Session({
      openTransport: () => {
        throw new Error("Specified native messaging host not found.");
      },
    });
    await expect(session.connect()).rejects.toThrow();
    expect(session.status.state).toBe("no-helper");
  });

  it("reports when the helper exits, and reconnects on next use", async () => {
    const { helper, transports, session } = setup();
    await session.requestCode();
    await session.verifyCode(helper.currentCode ?? "");
    transports[0]?.kill();
    expect(session.status.state).toBe("closed");

    await session.requestCode();
    expect(transports).toHaveLength(2);
    expect(session.status.state).toBe("awaiting-code");
  });

  it("lock ends the session", async () => {
    const { helper, session } = setup();
    await session.requestCode();
    await session.verifyCode(helper.currentCode ?? "");
    session.lock();
    expect(session.status.state).toBe("disconnected");
    await expect(session.unlockedClient()).rejects.toThrow();
  });

  it("lock cancels a connection that has not received capabilities yet", async () => {
    const transport = new MemoryTransport(new FakeHelper());
    transport.send = () => {};
    const close = vi.spyOn(transport, "close");
    const session = new Session({ openTransport: () => transport });
    const opening = session.connect().catch((error: unknown) => error);
    session.lock();
    transport.push({ cmd: 14, capabilities: { shouldUseBase64: true } });
    expect(await opening).toMatchObject({ code: "closed" });
    expect(close).toHaveBeenCalled();
    expect(session.status.state).toBe("disconnected");
  });

  it("refuses delivery from a client obtained before Lock", async () => {
    const { helper, session } = setup();
    await session.requestCode();
    await session.verifyCode(helper.currentCode ?? "");
    const client = await session.unlockedClient();
    expect(await client.getPassword("example.com", "alice", { tabId: 1 })).toBeDefined();
    session.lock();
    expect(() => session.assertCurrent(client)).toThrow("session ended");
  });

  it("tells a missing host apart from one that failed during the handshake", async () => {
    const failing = (error: string) =>
      new Session({
        openTransport: () => {
          const transport = new MemoryTransport(new FakeHelper());
          transport.send = () => transport.kill(error);
          return transport;
        },
      });

    const missing = failing("Specified native messaging host not found.");
    await expect(missing.connect()).rejects.toThrow();
    expect(missing.status.state).toBe("no-helper");

    const crashed = failing("Native host has exited.");
    await expect(crashed.connect()).rejects.toThrow();
    expect(crashed.status).toEqual({ state: "disconnected", error: "Native host has exited." });
  });

  it("reports a wrong code, and shows a new one when asked", async () => {
    const { helper, session } = setup();
    await session.requestCode();
    const wrong = helper.currentCode === "000000" ? "111111" : "000000";
    await expect(session.verifyCode(wrong)).rejects.toThrow();
    expect(session.status).toEqual({ state: "locked", error: "incorrect code" });

    await session.requestCode();
    expect(session.status.state).toBe("awaiting-code");
    expect(helper.currentCode).toBeDefined();
  });
});
