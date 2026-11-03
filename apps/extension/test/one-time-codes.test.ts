import { describe, expect, it } from "vitest";
import { oneTimeCodeId, oneTimeCodeViews } from "../src/passwords/one-time-codes.ts";

const code = (username: string, domain = "example.com", source = "totp") => ({
  code: undefined,
  username,
  domain,
  source,
});

describe("oneTimeCodeViews", () => {
  it("lists accounts without digits, each once", () => {
    const views = oneTimeCodeViews([code("alice"), { ...code("alice"), code: "123456" }, code("bob")]);
    expect(views).toEqual([
      { id: oneTimeCodeId(code("alice")), username: "alice", domain: "example.com" },
      { id: oneTimeCodeId(code("bob")), username: "bob", domain: "example.com" },
    ]);
    expect(JSON.stringify(views)).not.toContain("123456");
  });

  it("puts the account just signed in with first, whatever its case", () => {
    const views = oneTimeCodeViews([code("alice"), code("Bob"), code("carol")], "bob");
    expect(views.map((v) => v.username)).toEqual(["Bob", "alice", "carol"]);
  });

  it("keeps the order when that account has no code", () => {
    expect(oneTimeCodeViews([code("alice"), code("bob")], "dana").map((v) => v.username)).toEqual(["alice", "bob"]);
  });

  it("tells apart codes of other sites and sources", () => {
    const ids = new Set([code("a"), code("a", "other.test"), code("a", "example.com", "messages")].map(oneTimeCodeId));
    expect(ids.size).toBe(3);
  });
});
