import { FakeHelper } from "@app/fake-helper";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Envelope, Request } from "../src/messages.ts";

const native = vi.hoisted(() => ({ helper: undefined as unknown as FakeHelper }));
vi.mock("@/src/native/port-transport.ts", async () => {
  const { MemoryTransport } = await import("@app/fake-helper");
  return {
    PortTransport: class extends MemoryTransport {
      constructor() {
        super(native.helper);
      }
    },
  };
});

type Listener = (...args: unknown[]) => unknown;
const event = () => ({ addListener: vi.fn<(listener: Listener) => void>() });
let receive: (request: unknown, sender: unknown, reply: (result: Envelope<unknown>) => void) => boolean;
let helper: FakeHelper;
let execute: ReturnType<typeof vi.fn>;
let relay: ReturnType<typeof vi.fn>;
const page = { id: "test-extension", url: "chrome-extension://test-extension/popup.html" };
const content = { id: page.id, url: "https://example.com/signup", tab: { id: 1 }, frameId: 0 };

function request<T = unknown>(
  message: Request,
  sender: { id: string; url: string; tab?: { id: number }; frameId?: number } = page,
): Promise<T> {
  return new Promise((resolve, reject) => {
    receive(message, sender, (result) => {
      if (result.ok) resolve(result.value as T);
      else reject(new Error(result.error));
    });
  });
}

async function pair() {
  await request({ type: "request-code" });
  await request({ type: "verify-code", code: helper.currentCode ?? "" });
}

beforeEach(async () => {
  vi.resetModules();
  helper = new FakeHelper({
    vault: [
      { hostname: "example.com", username: "older", password: "fake-older" },
      { hostname: "example.com", username: "newer", password: "fake-newer" },
    ],
  });
  native.helper = helper;
  execute = vi.fn(async () => [{ result: "needs-password" }]);
  relay = vi.fn(async (_tab, message) =>
    message.type === "menu-new-password-context"
      ? { visible: true, rules: {}, username: "new-account" }
      : { result: "filled" },
  );
  const incoming = {
    addListener: (listener: typeof receive) => {
      receive = listener;
    },
  };
  vi.stubGlobal("browser", {
    runtime: {
      id: page.id,
      getURL: (path: string) => `chrome-extension://test-extension${path}`,
      getPlatformInfo: async () => ({ os: "mac" }),
      sendMessage: async () => {},
      sendNativeMessage: async () => {
        throw new Error("no companion");
      },
      onMessage: incoming,
      onInstalled: event(),
      onUpdateAvailable: event(),
    },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: event() },
    idle: { setDetectionInterval: () => {}, onStateChanged: event() },
    tabs: { get: async () => ({ url: content.url }), sendMessage: relay, onRemoved: event(), onUpdated: event() },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    scripting: { executeScript: execute },
    declarativeNetRequest: { updateSessionRules: async () => {} },
  });
  vi.stubGlobal("defineBackground", (main: () => void) => {
    main();
    return {};
  });
  await import("../entrypoints/background.ts");
  await pair();
});

afterEach(async () => {
  await request({ type: "lock" });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not let an older fill overtake a newer user choice while its field probe waits", async () => {
  const probe = Promise.withResolvers<{ result: string }[]>();
  const started = Promise.withResolvers<void>();
  const filled: string[] = [];
  execute.mockImplementation(async ({ args }: { args: [string, string, string | null] }) => {
    if (args[1] === "older" && args[2] === null) {
      started.resolve();
      return probe.promise;
    }
    if (args[2] === null) return [{ result: "needs-password" }];
    filled.push(args[2]);
    return [{ result: "filled" }];
  });
  const older = request({ type: "fill", tabId: 1, username: "older" }).catch((error: unknown) => error);
  await started.promise;
  await request({ type: "fill", tabId: 1, username: "newer" });
  probe.resolve([{ result: "needs-password" }]);
  expect(await older).toBeInstanceOf(Error);
  expect(filled).toEqual(["fake-newer"]);
});

it("cancels save polling across Lock and a new pairing without delivering the old password", async () => {
  const { nonce } = await request<{ nonce: string }>({ type: "autofill-status", kind: "new-password" }, content);
  await request({ type: "generate-passwords", nonce }, { ...page, tab: { id: 1 } });
  await request({ type: "use-generated-password", nonce, style: "strong" }, { ...page, tab: { id: 1 } });
  const saved = Promise.withResolvers<void>();
  const original = helper.handle.bind(helper);
  vi.spyOn(helper, "handle").mockImplementation(async (message) => {
    const result = await original(message);
    if (message.cmd === 6) saved.resolve();
    return result;
  });
  await request({ type: "generated-form-gone", username: "new-account" }, content);
  await saved.promise;
  await request({ type: "lock" });
  await pair();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(relay.mock.calls.filter(([, message]) => message.type === "generated-password-saved")).toEqual([]);
});

it.each(["saved", "generated"] as const)(
  "a newer choice cancels a pending %s fill across both fill paths",
  async (olderKind) => {
    const { nonce } = await request<{ nonce: string }>({ type: "autofill-status", kind: "new-password" }, content);
    const menu = { ...page, tab: { id: 1 } };
    await request({ type: "generate-passwords", nonce }, menu);
    const paused = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const delivered: string[] = [];
    execute.mockImplementation(async ({ args }: { args: [string, string, string | null] }) => {
      if (olderKind === "saved" && args[2] === null) {
        started.resolve();
        return paused.promise;
      }
      if (args[2] !== null) delivered.push("saved");
      return [{ result: args[2] === null ? "needs-password" : "filled" }];
    });
    relay.mockImplementation(async (_tab, message) => {
      if (message.type === "menu-new-password-context") {
        if (olderKind === "generated") {
          started.resolve();
          return paused.promise;
        }
        return { visible: true, rules: {}, username: "new-account" };
      }
      if (message.type === "menu-fill-new-password") delivered.push("generated");
      return { result: "filled" };
    });
    const savedRequest = () => request({ type: "fill", tabId: 1, username: "newer" });
    const generatedRequest = () => request({ type: "use-generated-password", nonce, style: "strong" }, menu);
    const older = (olderKind === "saved" ? savedRequest() : generatedRequest()).catch((error: unknown) => error);
    await started.promise;
    await (olderKind === "saved" ? generatedRequest() : savedRequest());
    paused.resolve(
      olderKind === "saved" ? [{ result: "needs-password" }] : { visible: true, rules: {}, username: "new-account" },
    );
    expect(await older).toBeInstanceOf(Error);
    expect(delivered).toEqual([olderKind === "saved" ? "generated" : "saved"]);
  },
);
