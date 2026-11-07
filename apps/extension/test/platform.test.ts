import { afterEach, describe, expect, it, vi } from "vitest";

// platform() asks once per page, so each case loads the module afresh
async function detect() {
  vi.resetModules();
  const { platform } = await import("../src/platform.ts");
  return platform();
}

describe("platform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the browser", async () => {
    vi.stubGlobal("browser", { runtime: { getPlatformInfo: async () => ({ os: "win" }) } });
    expect(await detect()).toBe("windows");
  });

  it("falls back to the user agent where the API is missing (Firefox's inline menu frame)", async () => {
    vi.stubGlobal("browser", { runtime: {} });
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(await detect()).toBe("windows");
  });

  it("counts an unknown platform as a Mac", async () => {
    vi.stubGlobal("browser", { runtime: { getPlatformInfo: () => Promise.reject(new Error("no")) } });
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(await detect()).toBe("mac");
  });
});
