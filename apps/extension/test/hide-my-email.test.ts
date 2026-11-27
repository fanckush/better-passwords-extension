import { describe, expect, it } from "vitest";
import { HideMyEmail, headerRule, ICloudError } from "../src/aliases/icloud/hide-my-email.ts";

type Call = { url: string; init?: RequestInit };

/** A fake icloud.com: answers by path, records calls. */
function fakeICloud(routes: Record<string, () => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const path = new URL(url).pathname;
    const route = routes[path];
    const { status = 200, body } = route ? route() : { status: 404, body: {} };
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

const signedIn = () => ({
  body: { webservices: { premiummailsettings: { url: "https://p1-maildomainws.icloud.com" } } },
});

describe("HideMyEmail", () => {
  it("finds the address made for a site before", async () => {
    const icloud = fakeICloud({
      "/setup/ws/1/validate": signedIn,
      "/v2/hme/list": () => ({
        body: {
          success: true,
          result: {
            hmeEmails: [
              { hme: "old@icloud.com", label: "example.com", isActive: false },
              { hme: "kept@icloud.com", label: "example.com", isActive: true },
              { hme: "other@icloud.com", label: "other.test", isActive: true },
            ],
          },
        },
      }),
    });
    const hme = new HideMyEmail(icloud.fetchImpl);
    expect(await hme.addressFor("example.com")).toBe("kept@icloud.com");
    expect(await hme.addressFor("new.test")).toBeUndefined();
    // the session is validated once and reused
    expect(icloud.calls.filter((c) => c.url.endsWith("/validate"))).toHaveLength(1);
    expect(icloud.calls.every((c) => c.init?.credentials === "include")).toBe(true);
  });

  it("generates, then reserves with the site as its label", async () => {
    const icloud = fakeICloud({
      "/setup/ws/1/validate": signedIn,
      "/v1/hme/generate": () => ({ body: { success: true, result: { hme: "fresh@icloud.com" } } }),
      "/v1/hme/reserve": () => ({ body: { success: true, result: { hme: { hme: "fresh@icloud.com" } } } }),
    });
    const hme = new HideMyEmail(icloud.fetchImpl);
    const address = await hme.generate();
    expect(await hme.reserve(address, "example.com")).toBe("fresh@icloud.com");
    const reserve = icloud.calls.find((c) => c.url.endsWith("/v1/hme/reserve"));
    expect(JSON.parse(String(reserve?.init?.body))).toEqual({
      hme: "fresh@icloud.com",
      label: "example.com",
      note: "Created by Better Passwords",
    });
  });

  it("says when the browser isn't signed in to iCloud", async () => {
    const icloud = fakeICloud({ "/setup/ws/1/validate": () => ({ status: 421, body: { success: false } }) });
    await expect(new HideMyEmail(icloud.fetchImpl).generate()).rejects.toMatchObject({ code: "signed-out" });
  });

  it("tells when the account has no iCloud+", async () => {
    const noService = fakeICloud({
      "/setup/ws/1/validate": () => ({ body: { webservices: { contacts: { url: "x" } } } }),
    });
    await expect(new HideMyEmail(noService.fetchImpl).generate()).rejects.toMatchObject({ code: "no-icloud-plus" });
    const inactive = fakeICloud({
      "/setup/ws/1/validate": () => ({
        body: {
          webservices: { premiummailsettings: { url: "https://p1-maildomainws.icloud.com", status: "inactive" } },
        },
      }),
    });
    await expect(new HideMyEmail(inactive.fetchImpl).generate()).rejects.toMatchObject({ code: "no-icloud-plus" });
    const refused = fakeICloud({
      "/setup/ws/1/validate": signedIn,
      "/v1/hme/generate": () => ({
        body: { success: false, error: { errorMessage: "Upgrade to iCloud+ to use this." } },
      }),
    });
    await expect(new HideMyEmail(refused.fetchImpl).generate()).rejects.toMatchObject({ code: "no-icloud-plus" });
  });

  it("forgets an expired session", async () => {
    let expired = false;
    const icloud = fakeICloud({
      "/setup/ws/1/validate": signedIn,
      "/v1/hme/generate": () =>
        expired ? { status: 421, body: {} } : { body: { success: true, result: { hme: "a@icloud.com" } } },
    });
    const hme = new HideMyEmail(icloud.fetchImpl);
    await hme.generate();
    expired = true;
    await expect(hme.generate()).rejects.toBeInstanceOf(ICloudError);
    expect(icloud.calls.filter((c) => c.url.endsWith("/validate"))).toHaveLength(1);
    expired = false;
    await hme.generate();
    expect(icloud.calls.filter((c) => c.url.endsWith("/validate"))).toHaveLength(2);
  });

  it("passes on iCloud's own error message", async () => {
    const icloud = fakeICloud({
      "/setup/ws/1/validate": signedIn,
      "/v1/hme/generate": () => ({ body: { success: false, error: { errorMessage: "You've reached the limit." } } }),
    });
    await expect(new HideMyEmail(icloud.fetchImpl).generate()).rejects.toMatchObject({
      code: "failed",
      message: "You've reached the limit.",
    });
  });
});

describe("headerRule", () => {
  it("only touches our background's requests to iCloud", () => {
    expect(headerRule("ocongmkplhijgajnipnhhggfcjfdilgj").condition).toEqual({
      requestDomains: ["icloud.com"],
      // a website's service worker has no tab either: only requests we start qualify
      initiatorDomains: ["ocongmkplhijgajnipnhhggfcjfdilgj"],
      tabIds: [-1],
      resourceTypes: ["xmlhttprequest"],
    });
  });
});
