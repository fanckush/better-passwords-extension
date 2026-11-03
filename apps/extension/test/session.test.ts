import { FakeHelper, MemoryTransport } from "@app/fake-helper";
import { describe, expect, it } from "vitest";
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

    const firefoxMissing = failing("No such native application io.github.fanckush.betterpasswords.bridge");
    await expect(firefoxMissing.connect()).rejects.toThrow();
    expect(firefoxMissing.status.state).toBe("no-helper");

    // other failures aren't macOS blocking the helper
    const garbled = failing("Error when communicating with the native messaging host.");
    await expect(garbled.connect()).rejects.toThrow();
    expect(garbled.status.state).toBe("disconnected");
  });

  it("calls the helper blocked once it quits before answering twice in a row", async () => {
    // macOS kills the helper at launch when the browser isn't one Apple allows
    let launches = 0;
    const killed = new Session({
      openTransport: () => {
        launches++;
        const transport = new MemoryTransport(new FakeHelper());
        transport.send = () => transport.kill("Native host has exited.");
        return transport;
      },
    });
    await expect(killed.connect()).rejects.toThrow();
    expect(killed.status).toEqual({ state: "blocked", error: "Native host has exited." });
    expect(launches).toBe(2);

    // Firefox may give no reason at all
    const silent = new Session({
      openTransport: () => {
        let closed: (error?: string) => void = () => {};
        return {
          send: () => closed(),
          onMessage: () => {},
          onClose: (listener) => {
            closed = listener;
          },
          close: () => {},
        };
      },
    });
    await expect(silent.connect()).rejects.toThrow();
    expect(silent.status.state).toBe("blocked");
  });

  it("takes a helper that crashed once and then answers as working", async () => {
    const helper = new FakeHelper({ vault });
    let launches = 0;
    const session = new Session({
      openTransport: () => {
        const transport = new MemoryTransport(helper);
        if (launches++ === 0) transport.send = () => transport.kill("Native host has exited.");
        return transport;
      },
    });
    await session.connect();
    expect(session.status.state).toBe("locked");
    expect(launches).toBe(2);
  });

  it("stays blocked as an earlier worker found, and launches the helper only when asked", async () => {
    const helper = new FakeHelper({ vault });
    const transports: MemoryTransport[] = [];
    const session = new Session({
      openTransport: () => {
        const transport = new MemoryTransport(helper);
        transports.push(transport);
        return transport;
      },
      blockedEarlier: async () => "Native host has exited.",
    });
    await expect(session.connect()).rejects.toMatchObject({ code: "blocked" });
    await expect(session.requestCode()).rejects.toMatchObject({ code: "blocked" });
    expect(session.status).toEqual({ state: "blocked", error: "Native host has exited.", remembered: true });
    expect(transports).toHaveLength(0);

    await session.connect({ retry: true });
    expect(transports).toHaveLength(1);
    expect(session.status.state).toBe("locked");
  });

  it("starts normally when no earlier worker found it blocked", async () => {
    const session = new Session({
      openTransport: () => new MemoryTransport(new FakeHelper({ vault })),
      blockedEarlier: async () => undefined,
    });
    await session.connect();
    expect(session.status.state).toBe("locked");
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
