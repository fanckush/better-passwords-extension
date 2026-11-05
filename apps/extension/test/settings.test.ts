import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, defaultSettings } from "../src/messages.ts";

describe("defaultSettings", () => {
  it("locks with the PC on Windows, where Apple's helper never asks before filling", () => {
    expect(defaultSettings("windows")).toEqual({ ...DEFAULT_SETTINGS, lockOnScreenLock: true });
  });

  it("leaves the Mac defaults as they are", () => {
    expect(defaultSettings("mac")).toEqual(DEFAULT_SETTINGS);
    expect(defaultSettings("mac").lockOnScreenLock).toBe(false);
  });
});
