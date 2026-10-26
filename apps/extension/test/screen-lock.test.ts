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

let receive: (request: Request, sender: unknown, reply: (result: Envelope<unknown>) => void) => boolean;
let onIdle: (state: string) => Promise<void>;
let settings: { lockOnScreenLock: boolean } | undefined;
const event = () => ({ addListener: vi.fn() });
const sender = { id: "test-extension", url: "chrome-extension://test-extension/popup.html" };

function request<T = unknown>(message: Request): Promise<T> {
  return new Promise((resolve, reject) => {
    receive(message, sender, (result) => {
      if (result.ok) resolve(result.value as T);
      else reject(new Error(result.error));
    });
  });
}

beforeEach(async () => {
  vi.resetModules();
  settings = undefined;
  native.helper = new FakeHelper();
  vi.stubGlobal("browser", {
    runtime: {
      id: sender.id,
      getURL: (path: string) => `chrome-extension://test-extension${path}`,
      getPlatformInfo: async () => ({ os: "mac" }),
      sendMessage: async () => {},
      sendNativeMessage: async () => {
        throw new Error("no companion");
      },
      onMessage: {
        addListener: (listener: typeof receive) => {
          receive = listener;
        },
      },
      onInstalled: event(),
      onUpdateAvailable: event(),
    },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: event() },
    idle: {
      setDetectionInterval: () => {},
      onStateChanged: {
        addListener: (listener: typeof onIdle) => {
          onIdle = listener;
        },
      },
    },
    tabs: { onRemoved: event(), onUpdated: event() },
    storage: { local: { get: async () => ({ settings }), set: async () => {}, remove: async () => {} } },
    declarativeNetRequest: { updateSessionRules: async () => {} },
  });
  vi.stubGlobal("defineBackground", (main: () => void) => {
    main();
    return {};
  });
  await import("../entrypoints/background.ts");
});

afterEach(async () => {
  await request({ type: "lock" });
  vi.unstubAllGlobals();
});

it.each([
  { preference: undefined, expected: "locked" },
  { preference: false, expected: "unlocked" },
])("screen lock respects the saved preference $preference", async ({ preference, expected }) => {
  settings = preference === undefined ? undefined : { lockOnScreenLock: preference };
  await request({ type: "request-code" });
  await request({ type: "verify-code", code: native.helper.currentCode ?? "" });
  expect(await request({ type: "get-status" })).toMatchObject({ state: "unlocked" });
  await onIdle("locked");
  expect(await request({ type: "get-status" })).toMatchObject({ state: expected });
});
