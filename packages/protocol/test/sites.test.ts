import { describe, expect, it } from "vitest";
import { isSameSite } from "../src/sites.ts";

describe("isSameSite", () => {
  it("matches the same host, ignoring case, a trailing dot and a URL form", () => {
    expect(isSameSite("example.com", "example.com")).toBe(true);
    expect(isSameSite("Example.COM.", "example.com")).toBe(true);
    expect(isSameSite("https://example.com/login", "example.com")).toBe(true);
  });

  it("matches subdomains in either direction", () => {
    expect(isSameSite("github.com", "gist.github.com")).toBe(true);
    expect(isSameSite("github.com", "www.github.com")).toBe(true);
    expect(isSameSite("accounts.google.com", "google.com")).toBe(true);
  });

  it("refuses unrelated domains and lookalikes", () => {
    expect(isSameSite("bank.com", "evil.com")).toBe(false);
    expect(isSameSite("bank.com", "evilbank.com")).toBe(false);
    expect(isSameSite("bank.com", "bank.com.evil.com")).toBe(false);
  });

  it("keeps siblings on shared hosting apart", () => {
    expect(isSameSite("alice.github.io", "mallory.github.io")).toBe(false);
  });

  it("refuses empty or unparsable sites", () => {
    expect(isSameSite("", "example.com")).toBe(false);
    expect(isSameSite("https://", "example.com")).toBe(false);
  });
});
