import { describe, expect, it } from "vitest";
import { base32Decode, totp } from "../src/totp.ts";

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
