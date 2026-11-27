import { afterEach, describe, expect, it, vi } from "vitest";
import { hasHideMyEmailConsent, requestHideMyEmailConsent } from "../src/aliases/icloud/consent.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Hide My Email data consent", () => {
  it("does not call Firefox-only permission APIs in Chromium", async () => {
    vi.stubEnv("FIREFOX", "");
    expect(await hasHideMyEmailConsent()).toBe(true);
    expect(await requestHideMyEmailConsent()).toBe(true);
  });

  it("requests Firefox consent synchronously in the user gesture and respects refusal", async () => {
    vi.stubEnv("FIREFOX", "true");
    const request = vi.fn().mockResolvedValue(false);
    vi.stubGlobal("browser", { permissions: { request } });
    const result = requestHideMyEmailConsent();
    expect(request).toHaveBeenCalledWith({
      data_collection: ["personallyIdentifyingInfo", "websiteContent"],
    });
    expect(await result).toBe(false);
  });

  it("checks current grants again after consent is revoked", async () => {
    vi.stubEnv("FIREFOX", "true");
    const contains = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.stubGlobal("browser", { permissions: { contains } });
    expect(await hasHideMyEmailConsent()).toBe(true);
    expect(await hasHideMyEmailConsent()).toBe(false);
  });
});
