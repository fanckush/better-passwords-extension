import { describe, expect, it } from "vitest";
import { base32Decode, otpCode, parseOtp, totp } from "../src/totp.ts";

// RFC 6238 Appendix B, SHA-1: the ASCII secret "12345678901234567890", 8 digits, 30 s steps
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("matches the RFC 6238 vector at %i s", async (seconds, code) => {
    expect(await totp(SECRET, seconds * 1000, { digits: 8 })).toBe(code);
  });

  it("defaults to 6 digits, changing every 30 seconds", async () => {
    expect(await totp(SECRET, 59_000)).toBe("287082");
    expect(await totp(SECRET, 60_000)).not.toBe(await totp(SECRET, 59_000));
    expect(await totp(SECRET, 30_000)).toBe(await totp(SECRET, 59_999));
  });

  it("decodes base32 the way otpauth URIs write it", () => {
    expect(new TextDecoder().decode(base32Decode("gezd gnbv gy3t qojq===="))).toBe("1234567890");
    expect(() => base32Decode("not!base32")).toThrow();
  });
});

describe("totp with other algorithms", () => {
  // RFC 6238 Appendix B: the seed repeated to the hash's key length
  const SHA256 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
  const SHA512 =
    "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";

  it.each([
    [59, "46119246", "90693936"],
    [1111111109, "68084774", "25091201"],
    [20000000000, "77737706", "47863826"],
  ])("matches the RFC 6238 vectors at %i s", async (seconds, sha256, sha512) => {
    expect(await totp(SHA256, seconds * 1000, { digits: 8, algorithm: "SHA-256" })).toBe(sha256);
    expect(await totp(SHA512, seconds * 1000, { digits: 8, algorithm: "SHA-512" })).toBe(sha512);
  });
});

describe("parseOtp", () => {
  it("reads a bare base32 secret", () => {
    expect(parseOtp("JBSW Y3DP EHPK 3PXP")).toEqual({
      kind: "totp",
      secret: "JBSW Y3DP EHPK 3PXP",
      period: 30,
      digits: 6,
      algorithm: "SHA-1",
    });
  });

  it("reads an otpauth URI with its options", () => {
    expect(
      parseOtp(
        "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=8&period=60&algorithm=SHA256",
      ),
    ).toEqual({ kind: "totp", secret: "JBSWY3DPEHPK3PXP", period: 60, digits: 8, algorithm: "SHA-256" });
  });

  it("reads Steam setups, in either spelling", () => {
    expect(parseOtp("steam://JBSWY3DPEHPK3PXP")).toMatchObject({ kind: "steam", digits: 5 });
    expect(parseOtp("otpauth://totp/Steam:alice?secret=JBSWY3DPEHPK3PXP&issuer=Steam")).toMatchObject({
      kind: "steam",
    });
  });

  it("leaves out what can't make codes", () => {
    expect(parseOtp("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1")).toBeUndefined();
    expect(parseOtp("otpauth://totp/x")).toBeUndefined();
    expect(parseOtp("hello world!")).toBeUndefined();
    expect(parseOtp("")).toBeUndefined();
  });
});

describe("otpCode", () => {
  it("gives a TOTP code and how long it lasts", async () => {
    const setup = parseOtp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    if (!setup) throw new Error("unparsed");
    expect(await otpCode(setup, 59_000)).toEqual({ code: "287082", remaining: 1 });
  });

  it("writes Steam codes in Steam's alphabet", async () => {
    const setup = parseOtp("steam://GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    if (!setup) throw new Error("unparsed");
    const { code } = await otpCode(setup, 59_000);
    expect(code).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
  });
});
