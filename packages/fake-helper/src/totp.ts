// RFC 6238 time-based one-time codes, so the fake helper's codes behave like real ones.

export interface TotpOptions {
  /** Seconds a code stays valid. */
  period?: number;
  digits?: number;
}

/** The code for `secret` (base32, as in otpauth:// URIs) at `now` (ms since the epoch). */
export async function totp(secret: string, now: number, { period = 30, digits = 6 }: TotpOptions = {}) {
  const counter = BigInt(Math.floor(now / 1000 / period));
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, counter);
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  const binary = new DataView(mac.buffer).getUint32(offset) & 0x7fff_ffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
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
