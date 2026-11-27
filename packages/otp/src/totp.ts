// One-time codes: RFC 6238 TOTP, as saved in Apple Passwords (the fake helper's) and Bitwarden.
// Bitwarden keeps a login's authenticator setup as a bare base32 secret, an otpauth:// URI or a
// steam:// one, so all three are read here.

export type OtpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface TotpOptions {
  /** Seconds a code stays valid. */
  period?: number;
  digits?: number;
  algorithm?: OtpAlgorithm;
}

/** The code for `secret` (base32, as in otpauth:// URIs) at `now` (ms since the epoch). */
export async function totp(
  secret: string,
  now: number,
  { period = 30, digits = 6, algorithm = "SHA-1" }: TotpOptions = {},
): Promise<string> {
  const binary = await hotpValue(base32Decode(secret), Math.floor(now / 1000 / period), algorithm);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** RFC 4226's dynamic truncation of the HMAC of `counter`: a 31-bit number. */
async function hotpValue(secret: Uint8Array<ArrayBuffer>, counter: number, algorithm: OtpAlgorithm): Promise<number> {
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: algorithm }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  return new DataView(mac.buffer).getUint32(offset) & 0x7fff_ffff;
}

/** An authenticator setup, read from how it was saved. */
export interface OtpSetup {
  kind: "totp" | "steam";
  secret: string;
  period: number;
  digits: number;
  algorithm: OtpAlgorithm;
}

const ALGORITHMS: Record<string, OtpAlgorithm> = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };

/**
 * Reads a saved setup: a base32 secret, `otpauth://totp/…?secret=…`, or `steam://<secret>`.
 * Undefined for anything else (an HOTP counter, which can't be used without saving it back).
 */
export function parseOtp(value: string): OtpSetup | undefined {
  const text = value.trim();
  const defaults = { period: 30, digits: 6, algorithm: "SHA-1" as const };
  if (/^steam:\/\//i.test(text)) return { kind: "steam", ...defaults, digits: 5, secret: text.slice(8) };
  if (/^otpauth:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    if (url.host.toLowerCase() !== "totp") return undefined;
    const secret = url.searchParams.get("secret");
    if (!secret) return undefined;
    const issuer = url.searchParams.get("issuer") ?? "";
    // Steam's own codes, saved by apps that write them as otpauth URIs
    const steam = /^steam$/i.test(issuer) || url.searchParams.get("encoder")?.toLowerCase() === "steam";
    const period = Number(url.searchParams.get("period")) || 30;
    const digits = Number(url.searchParams.get("digits")) || 6;
    const algorithm = ALGORITHMS[(url.searchParams.get("algorithm") ?? "SHA1").toUpperCase()] ?? "SHA-1";
    return steam
      ? { kind: "steam", secret, period, digits: 5, algorithm: "SHA-1" }
      : { kind: "totp", secret, period, digits, algorithm };
  }
  if (/^[a-z2-7\s=]+$/i.test(text) && text.replace(/[\s=]/g, "").length >= 8) {
    return { kind: "totp", secret: text, ...defaults };
  }
  return undefined;
}

const STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY";

/** The code a setup gives at `now`, and how many seconds it stays valid. */
export async function otpCode(setup: OtpSetup, now: number): Promise<{ code: string; remaining: number }> {
  const remaining = setup.period - (Math.floor(now / 1000) % setup.period);
  if (setup.kind === "totp") return { code: await totp(setup.secret, now, setup), remaining };
  let value = await hotpValue(base32Decode(setup.secret), Math.floor(now / 1000 / setup.period), "SHA-1");
  let code = "";
  for (let i = 0; i < setup.digits; i++) {
    code += STEAM_ALPHABET[value % STEAM_ALPHABET.length];
    value = Math.floor(value / STEAM_ALPHABET.length);
  }
  return { code, remaining };
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.toUpperCase().replace(/[\s=]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}
