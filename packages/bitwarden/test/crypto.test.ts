import { describe, expect, it } from "vitest";
import {
  decrypt,
  decryptText,
  encryptText,
  masterKey,
  masterPasswordHash,
  parseEncString,
  stretch,
  symmetricKey,
  toBase64,
  utf8,
} from "../src/crypto.ts";

const key = symmetricKey(crypto.getRandomValues(new Uint8Array(64)));

describe("EncStrings", () => {
  it("round-trip text through AES-CBC with an HMAC", async () => {
    const enc = await encryptText("hunter2 ✓", key);
    expect(enc).toMatch(/^2\.[^|]+\|[^|]+\|[^|]+$/);
    expect(await decryptText(enc, key)).toBe("hunter2 ✓");
  });

  it("use a fresh IV every time", async () => {
    expect(await encryptText("same", key)).not.toBe(await encryptText("same", key));
  });

  it("refuse a wrong key before decrypting", async () => {
    const other = symmetricKey(crypto.getRandomValues(new Uint8Array(64)));
    await expect(decrypt(await encryptText("secret", key), other)).rejects.toThrow("wrong key");
  });

  it("refuse a tampered value", async () => {
    const enc = parseEncString(await encryptText("secret", key));
    if (enc.type !== 2) throw new Error("type");
    enc.data[0] = (enc.data[0] as number) ^ 1;
    const tampered = `2.${toBase64(enc.iv)}|${toBase64(enc.data)}|${toBase64(enc.mac)}`;
    await expect(decrypt(tampered, key)).rejects.toThrow("tampered");
  });

  it("name the types they don't support", () => {
    expect(() => parseEncString("0.abc|def")).toThrow("unsupported encryption type 0");
    expect(() => parseEncString("garbage")).toThrow("unsupported");
  });
});

describe("the master key", () => {
  const kdf = { kdf: 0 as const, iterations: 5_000 };

  it("is salted with the email, whatever its case or spaces", async () => {
    const a = await masterKey("pw", "User@Example.com ", kdf);
    const b = await masterKey("pw", "user@example.com", kdf);
    expect(toBase64(a)).toBe(toBase64(b));
  });

  it("gives a hash for the server that isn't the key", async () => {
    const key = await masterKey("pw", "user@example.com", kdf);
    const hash = await masterPasswordHash(key, "pw");
    expect(hash).not.toBe(toBase64(key));
    expect(await masterPasswordHash(key, "pw")).toBe(hash);
  });

  it("stretches into two different 32-byte keys", async () => {
    const stretched = await stretch(await masterKey("pw", "user@example.com", kdf));
    expect(stretched.enc).toHaveLength(32);
    expect(toBase64(stretched.enc)).not.toBe(toBase64(stretched.mac));
  });

  it("needs Argon2id from outside for accounts that use it", async () => {
    await expect(masterKey("pw", "a@b.c", { kdf: 1, iterations: 3, memory: 64, parallelism: 4 })).rejects.toThrow(
      "Argon2id",
    );
    let salt = "";
    await masterKey("pw", "a@b.c", { kdf: 1, iterations: 3, memory: 64, parallelism: 4 }, async (input) => {
      salt = toBase64(input.salt);
      expect(input.memoryKiB).toBe(64 * 1024);
      return new Uint8Array(32);
    });
    // Argon2id's salt is the email's SHA-256
    expect(salt).toBe(toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8("a@b.c")))));
  });
});
