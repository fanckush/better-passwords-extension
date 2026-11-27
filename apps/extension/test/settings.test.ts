import { describe, expect, it } from "vitest";
import { appleDefaultSettings } from "../src/accounts/apple/account.ts";
import { DEFAULT_SETTINGS, LEGACY_ACCOUNT_SETTINGS } from "../src/messages.ts";

describe("appleDefaultSettings", () => {
  it("locks with the PC on Windows, where Apple's helper never asks before filling", () => {
    expect(appleDefaultSettings("windows")).toEqual({ lockOnScreenLock: true, touchId: true });
  });

  it("leaves the Mac defaults as they are", () => {
    expect(appleDefaultSettings("mac")).toEqual({ lockOnScreenLock: false, touchId: true });
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("leaves out the options each account keeps", () => {
    for (const key of LEGACY_ACCOUNT_SETTINGS) expect(DEFAULT_SETTINGS).not.toHaveProperty(key);
  });
});
