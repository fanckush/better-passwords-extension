import { describe, expect, it } from "vitest";
import { siteRules, withSiteRules } from "../src/passwords/site-rules.ts";

const rules = {
  "example.com": { "password-rules": "maxlength: 12;" },
  "a.example.com": { "password-rules": "maxlength: 8;" },
  "exact.org": { "password-rules": "allowed: digit;", "exact-domain-match-only": true },
};

describe("siteRules", () => {
  it("finds a host's own rules", () => {
    expect(siteRules("example.com", rules)).toBe("maxlength: 12;");
    expect(siteRules("A.Example.COM.", rules)).toBe("maxlength: 8;");
  });

  it("falls back to the closest parent domain", () => {
    expect(siteRules("www.example.com", rules)).toBe("maxlength: 12;");
    expect(siteRules("x.a.example.com", rules)).toBe("maxlength: 8;");
    expect(siteRules("b.example.com", rules)).toBe("maxlength: 12;");
  });

  it("keeps exact-domain rules to their domain", () => {
    expect(siteRules("exact.org", rules)).toBe("allowed: digit;");
    expect(siteRules("www.exact.org", rules)).toBeUndefined();
  });

  it("knows nothing of other sites", () => {
    expect(siteRules("example.net", rules)).toBeUndefined();
    expect(siteRules("localhost", rules)).toBeUndefined();
    expect(siteRules("constructor.com", rules)).toBeUndefined();
  });

  it("ships Apple's list", () => {
    // any listed site will do; this one has been on it for years
    expect(siteRules("www.163.com")).toMatch(/maxlength: 16/);
  });
});

describe("withSiteRules", () => {
  it("adds the list's rules to a field without its own", () => {
    expect(withSiteRules({ maxLength: 20 }, "163.com")).toEqual({
      maxLength: 20,
      passwordRules: siteRules("163.com"),
    });
  });

  it("leaves a field's own passwordrules alone", () => {
    expect(withSiteRules({ passwordRules: "minlength: 30;" }, "163.com")).toEqual({ passwordRules: "minlength: 30;" });
  });

  it("leaves fields with their own passwordrules alone, several too", () => {
    expect(withSiteRules({ passwordRules: ["minlength: 30;"] }, "163.com")).toEqual({
      passwordRules: ["minlength: 30;"],
    });
  });

  it("leaves unlisted sites alone", () => {
    expect(withSiteRules({ maxLength: 20 }, "example.net")).toEqual({ maxLength: 20 });
  });
});
