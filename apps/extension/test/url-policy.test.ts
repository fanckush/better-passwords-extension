import { describe, expect, it } from "vitest";
import { fillableUrl, frameOriginToFill, isAppleSignInFrame, sameFillableOrigin } from "../src/url-policy.ts";

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

describe("isAppleSignInFrame", () => {
  const frame = "https://idmsa.apple.com/appleauth/auth/signin";

  it("accepts Apple's sign-in frame on another Apple site", () => {
    expect(isAppleSignInFrame(frame, "https://appstoreconnect.apple.com/login")).toBe(true);
  });

  it.each([
    [frame, "https://evil.example/"],
    [frame, "https://apple.com.evil.example/"],
    [frame, "https://notapple.com/"],
    ["https://evil.apple.com.example/", "https://appstoreconnect.apple.com/login"],
    ["https://other.apple.com/", "https://appstoreconnect.apple.com/login"],
    ["http://idmsa.apple.com/", "https://appstoreconnect.apple.com/login"],
    [frame, "http://appstoreconnect.apple.com/login"],
    [undefined, undefined],
  ])("refuses %s inside %s", (inner, page) => {
    expect(isAppleSignInFrame(inner, page)).toBe(false);
  });
});

describe("frameOriginToFill", () => {
  const apple = "https://idmsa.apple.com";

  /** A chain of frames, innermost first; an origin of null can't be read, as with another site's frame. */
  function frames(...origins: (string | null)[]): Window {
    type Frame = { parent: Frame; top: Frame };
    let outer: Frame | undefined;
    let top: Frame | undefined;
    for (const origin of [...origins].reverse()) {
      const frame = {
        get location() {
          if (origin === null) throw new DOMException("Blocked", "SecurityError");
          return { origin, hostname: new URL(origin).hostname };
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
    expect(frameOriginToFill(frames("https://a.example"))).toBe("https://a.example");
  });

  it("gives the origin of nested iframes of the page's origin", () => {
    expect(frameOriginToFill(frames("https://a.example", "https://a.example", "https://a.example"))).toBe(
      "https://a.example",
    );
  });

  it("refuses an iframe inside another site", () => {
    expect(frameOriginToFill(frames("https://a.example", null))).toBeUndefined();
  });

  it("refuses an iframe of the page's origin with another site in between", () => {
    expect(frameOriginToFill(frames("https://a.example", null, "https://a.example"))).toBeUndefined();
  });

  it("gives the origin of Apple's sign-in frame right inside a page", () => {
    expect(frameOriginToFill(frames(apple, null))).toBe(apple);
  });

  it("refuses Apple's sign-in frame nested deeper", () => {
    expect(frameOriginToFill(frames(apple, null, null))).toBeUndefined();
  });
});
