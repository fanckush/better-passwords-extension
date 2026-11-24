import { describe, expect, it } from "vitest";
import { isSameSiteFrame } from "../src/same-site-frame.ts";
import { fillableUrl, frameOriginToFill, sameFillableOrigin } from "../src/url-policy.ts";

describe("fillableUrl", () => {
  it.each([
    "https://example.com/login",
    "https://accounts.example.co.uk:8443/",
    "http://localhost:3000/",
    "http://127.0.0.1/",
  ])("allows %s", (url) => {
    expect(fillableUrl(url)?.href).toBe(new URL(url).href);
  });

  it.each([
    undefined,
    "",
    "not a url",
    "http://example.com/",
    "chrome://settings/",
    "chrome-extension://abc/popup.html",
    "file:///Users/me/login.html",
    "data:text/html,<input type=password>",
    "javascript:alert(1)",
  ])("refuses %s", (url) => {
    expect(fillableUrl(url)).toBeUndefined();
  });
});

describe("sameFillableOrigin", () => {
  it("accepts an iframe of the page's own origin", () => {
    expect(sameFillableOrigin("https://idmsa.apple.com/appleauth/signin", "https://idmsa.apple.com/IDMSWebAuth")).toBe(
      true,
    );
  });

  it.each([
    ["https://evil.example/", "https://bank.example/"],
    ["https://login.bank.example/", "https://bank.example/"],
    ["http://bank.example/", "https://bank.example/"],
    ["about:blank", "about:blank"],
    [undefined, undefined],
  ])("refuses %s inside %s", (frame, page) => {
    expect(sameFillableOrigin(frame, page)).toBe(false);
  });
});

describe("isSameSiteFrame", () => {
  it.each([
    ["https://sws-gateway-nr.schwab.com/ui/host/", "https://www.schwab.com/"],
    ["https://sws-gateway-nr.schwab.com/ui/host/", "https://client.schwab.com/Areas/Access/Login"],
    ["https://idmsa.apple.com/appleauth/auth/signin", "https://appstoreconnect.apple.com/login"],
    ["https://login.bank.example.co.uk/", "https://bank.example.co.uk/"],
    ["https://login.bank.example/", "https://bank.example/"],
  ])("accepts %s inside %s", (frame, page) => {
    expect(isSameSiteFrame(frame, page)).toBe(true);
  });

  it.each([
    // another site
    ["https://sws-gateway-nr.schwab.com/", "https://evil.example/"],
    ["https://schwab.com.evil.example/", "https://www.schwab.com/"],
    ["https://www.schwab.com/", "https://notschwab.com/"],
    // sites that only share a public suffix, including a private one
    ["https://a.co.uk/", "https://b.co.uk/"],
    ["https://mallory.github.io/", "https://alice.github.io/"],
    ["https://evil.workers.dev/", "https://bank.workers.dev/"],
    // not HTTPS
    ["http://login.bank.example/", "https://bank.example/"],
    ["https://login.bank.example/", "http://bank.example/"],
    ["http://localhost:3000/", "http://127.0.0.1:3000/"],
    // the same origin is the page's own iframe, not this
    ["https://bank.example/frame", "https://bank.example/"],
    ["https://127.0.0.1/", "https://127.0.0.1:8443/"],
    ["about:blank", "https://bank.example/"],
    [undefined, undefined],
  ])("refuses %s inside %s", (frame, page) => {
    expect(isSameSiteFrame(frame, page)).toBe(false);
  });
});

describe("frameOriginToFill", () => {
  const apple = "https://idmsa.apple.com";
  const schwab = "https://sws-gateway-nr.schwab.com";

  /**
   * A chain of frames, innermost first; an origin of null can't be read, as with another site's frame.
   * `ancestors`, when given, is what the innermost frame's location.ancestorOrigins holds.
   */
  function frames(origins: (string | null)[], ancestors?: string[]): Window {
    type Frame = { parent: Frame; top: Frame };
    let outer: Frame | undefined;
    let top: Frame | undefined;
    for (const origin of [...origins].reverse()) {
      const frame = {
        get location() {
          if (origin === null) throw new DOMException("Blocked", "SecurityError");
          const { protocol, hostname } = new URL(origin);
          const ancestorOrigins =
            frame === outer && ancestors ? { item: (i: number) => ancestors[i] ?? null } : undefined;
          return { origin, protocol, hostname, ancestorOrigins };
        },
      } as unknown as Frame;
      top ??= frame;
      frame.parent = outer ?? frame;
      frame.top = top;
      outer = frame;
    }
    return outer as unknown as Window;
  }

  it("gives the origin of the page itself", () => {
    expect(frameOriginToFill(frames(["https://a.example"]))).toBe("https://a.example");
  });

  it("gives the origin of nested iframes of the page's origin", () => {
    expect(frameOriginToFill(frames(["https://a.example", "https://a.example", "https://a.example"]))).toBe(
      "https://a.example",
    );
  });

  it("refuses an iframe of the page's origin with another site in between", () => {
    expect(frameOriginToFill(frames(["https://a.example", null, "https://a.example"]))).toBeUndefined();
  });

  it("gives the origin of an iframe of another origin right inside the page, for the background to check", () => {
    expect(frameOriginToFill(frames([apple, null]))).toBe(apple);
  });

  it("gives the origin of an iframe on another host of the page's domain", () => {
    expect(frameOriginToFill(frames([schwab, null], ["https://www.schwab.com"]))).toBe(schwab);
  });

  it.each([["https://evil.example"], ["http://www.schwab.com"], ["null"]])(
    "refuses an iframe of another origin inside %s",
    (page) => {
      expect(frameOriginToFill(frames([schwab, null], [page]))).toBeUndefined();
    },
  );

  it("refuses an iframe of another origin nested deeper", () => {
    expect(frameOriginToFill(frames([apple, null, null]))).toBeUndefined();
  });

  it("refuses a plain-HTTP iframe of another origin", () => {
    expect(frameOriginToFill(frames(["http://login.a.example", null]))).toBeUndefined();
  });
});
