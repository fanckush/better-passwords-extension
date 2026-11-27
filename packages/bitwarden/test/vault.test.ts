import { describe, expect, it } from "vitest";
import { encryptText, symmetricKey } from "../src/crypto.ts";
import { decryptVault, loginsFor, UriMatch, uriMatches, type VaultLogin } from "../src/vault.ts";

const at = (href: string) => new URL(href);
const uri = (value: string, match: number | null = null) => ({ uri: value, match });

describe("uriMatches", () => {
  it("matches the base domain by default, subdomains and paths included", () => {
    const saved = uri("https://example.com/login");
    expect(uriMatches(saved, at("https://www.example.com/"))).toBe(true);
    expect(uriMatches(saved, at("https://accounts.example.com/signin?x=1"))).toBe(true);
    expect(uriMatches(saved, at("https://example.org/"))).toBe(false);
    expect(uriMatches(saved, at("https://notexample.com/"))).toBe(false);
  });

  it("keeps sites on a shared host apart (public suffixes)", () => {
    const saved = uri("https://alice.github.io/");
    expect(uriMatches(saved, at("https://alice.github.io/app"))).toBe(true);
    expect(uriMatches(saved, at("https://mallory.github.io/"))).toBe(false);
    expect(uriMatches(uri("https://shop.example.co.uk"), at("https://www.example.co.uk/"))).toBe(true);
  });

  it("reads URIs saved without a scheme", () => {
    expect(uriMatches(uri("example.com"), at("https://login.example.com/"))).toBe(true);
  });

  it("follows each URI's own rule", () => {
    expect(uriMatches(uri("https://login.example.com", UriMatch.Host), at("https://login.example.com/x"))).toBe(true);
    expect(uriMatches(uri("https://login.example.com", UriMatch.Host), at("https://www.example.com/"))).toBe(false);
    expect(uriMatches(uri("https://example.com:8443", UriMatch.Host), at("https://example.com/"))).toBe(false);
    expect(uriMatches(uri("https://example.com/app", UriMatch.StartsWith), at("https://example.com/app/login"))).toBe(
      true,
    );
    expect(uriMatches(uri("https://example.com/app", UriMatch.StartsWith), at("https://example.com/other"))).toBe(
      false,
    );
    expect(uriMatches(uri("https://example.com/login", UriMatch.Exact), at("https://example.com/login"))).toBe(true);
    expect(uriMatches(uri("https://example.com/login", UriMatch.Exact), at("https://example.com/login?x"))).toBe(false);
    expect(
      uriMatches(uri("^https://(a|b)\\.example\\.com/", UriMatch.RegularExpression), at("https://b.example.com/")),
    ).toBe(true);
    expect(uriMatches(uri("[broken", UriMatch.RegularExpression), at("https://example.com/"))).toBe(false);
    expect(uriMatches(uri("https://example.com", UriMatch.Never), at("https://example.com/"))).toBe(false);
  });

  it("never matches app URIs on the web", () => {
    expect(uriMatches(uri("androidapp://com.example.app"), at("https://example.com/"))).toBe(false);
  });
});

describe("loginsFor", () => {
  it("lists a login when any of its URIs matches", () => {
    const login = { uris: [uri("https://other.org"), uri("https://example.com")] } as VaultLogin;
    expect(loginsFor({ logins: [login] }, at("https://example.com/"))).toEqual([login]);
  });
});

describe("decryptVault", () => {
  it("leaves out deleted items and other types, and counts what it can't read", async () => {
    const user = symmetricKey(crypto.getRandomValues(new Uint8Array(64)));
    const other = symmetricKey(crypto.getRandomValues(new Uint8Array(64)));
    const cipher = async (id: string, key = user, extra = {}) => ({
      id,
      type: 1,
      organizationId: null,
      folderId: null,
      favorite: false,
      reprompt: 0,
      key: null,
      notes: null,
      name: await encryptText(id, key),
      revisionDate: "2026-01-01T00:00:00Z",
      deletedDate: null,
      passwordHistory: null,
      login: { username: await encryptText("u", key), password: await encryptText("p", key), totp: null, uris: [] },
      ...extra,
    });
    const sync = {
      profile: { id: "u", email: "e", key: "", privateKey: null, organizations: [] },
      ciphers: [
        await cipher("kept"),
        await cipher("deleted", user, { deletedDate: "2026-02-01T00:00:00Z" }),
        await cipher("card", user, { type: 3 }),
        await cipher("foreign", other),
      ],
    };
    const vault = await decryptVault(sync, user);
    expect(vault.logins.map((l) => l.name)).toEqual(["kept"]);
    expect(vault.unreadable).toBe(1);
  });

  it("opens items that carry their own key", async () => {
    const user = symmetricKey(crypto.getRandomValues(new Uint8Array(64)));
    const itemBytes = crypto.getRandomValues(new Uint8Array(64));
    const item = symmetricKey(itemBytes);
    const { encrypt } = await import("../src/crypto.ts");
    const sync = {
      profile: { id: "u", email: "e", key: "", privateKey: null, organizations: [] },
      ciphers: [
        {
          id: "x",
          type: 1,
          organizationId: null,
          folderId: null,
          favorite: false,
          reprompt: 0,
          key: await encrypt(itemBytes, user),
          notes: null,
          name: await encryptText("own key", item),
          revisionDate: "2026-01-01T00:00:00Z",
          deletedDate: null,
          passwordHistory: null,
          login: {
            username: await encryptText("u", item),
            password: await encryptText("p", item),
            totp: null,
            uris: [],
          },
        },
      ],
    };
    expect((await decryptVault(sync, user)).logins.map((l) => l.name)).toEqual(["own key"]);
  });
});
