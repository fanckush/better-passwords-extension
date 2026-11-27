// Bitwarden's client-side cryptography: the master key from the master password (the KDF), the
// hash the server checks at sign-in, and EncStrings, the format every encrypted field uses.
// See docs/bitwarden.md. WebCrypto only, so it runs in the extension's worker and in tests.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type Bytes = Uint8Array<ArrayBuffer>;

export interface KdfConfig {
  /** 0: PBKDF2-SHA256; 1: Argon2id. */
  kdf: 0 | 1;
  iterations: number;
  /** Argon2id only, in MiB. */
  memory?: number;
  /** Argon2id only. */
  parallelism?: number;
}

/** A 64-byte symmetric key: AES-256 for encryption, HMAC-SHA256 for authentication. */
export interface SymmetricKey {
  enc: Bytes;
  mac: Bytes;
}

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

export function utf8(text: string): Bytes {
  return encoder.encode(text) as Bytes;
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function fromBase64(text: string): Bytes {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function pbkdf2(password: Bytes, salt: Bytes, iterations: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** HKDF's expand step alone (RFC 5869), for one 32-byte block: the master key is already uniform. */
async function hkdfExpand32(prk: Bytes, info: string): Promise<Bytes> {
  return hmac(prk, concat(utf8(info), new Uint8Array([1])));
}

/** Argon2id, supplied by the caller (a wasm build in the extension): WebCrypto has none. */
export type Argon2id = (input: {
  password: Bytes;
  salt: Bytes;
  iterations: number;
  memoryKiB: number;
  parallelism: number;
}) => Promise<Bytes>;

/** The master key: the master password stretched by the account's KDF, salted with the email. */
export async function masterKey(password: string, email: string, kdf: KdfConfig, argon2?: Argon2id): Promise<Bytes> {
  const salt = utf8(email.trim().toLowerCase());
  if (kdf.kdf === 0) return pbkdf2(utf8(password), salt, kdf.iterations);
  if (!argon2) throw new CryptoError("This account uses Argon2id, which isn't available here.");
  return argon2({
    password: utf8(password),
    salt: new Uint8Array(await crypto.subtle.digest("SHA-256", salt)),
    iterations: kdf.iterations,
    memoryKiB: (kdf.memory ?? 64) * 1024,
    parallelism: kdf.parallelism ?? 4,
  });
}

/** What the server checks at sign-in: never the master key itself. */
export async function masterPasswordHash(key: Bytes, password: string): Promise<string> {
  return toBase64(await pbkdf2(key, utf8(password), 1));
}

/** The master key stretched into the key that protects the user key. */
export async function stretch(key: Bytes): Promise<SymmetricKey> {
  return { enc: await hkdfExpand32(key, "enc"), mac: await hkdfExpand32(key, "mac") };
}

export function symmetricKey(bytes: Uint8Array): SymmetricKey {
  if (bytes.length !== 64) throw new CryptoError(`expected a 64-byte key, got ${bytes.length} bytes`);
  return { enc: bytes.slice(0, 32), mac: bytes.slice(32) };
}

/** An EncString: "2.iv|data|mac" (AES-256-CBC + HMAC-SHA256) or "4.data" (RSA-OAEP-SHA1). */
export type EncString = { type: 2; iv: Bytes; data: Bytes; mac: Bytes } | { type: 4; data: Bytes };

export function parseEncString(text: string): EncString {
  const dot = text.indexOf(".");
  const type = Number(text.slice(0, dot));
  const parts = text.slice(dot + 1).split("|");
  if (type === 2 && parts.length === 3) {
    const [iv, data, mac] = parts.map(fromBase64) as [Bytes, Bytes, Bytes];
    return { type, iv, data, mac };
  }
  if (type === 4 && parts.length === 1) return { type, data: fromBase64(parts[0] as string) };
  throw new CryptoError(`unsupported encryption type ${Number.isNaN(type) ? "?" : type}`);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Decrypts a type 2 EncString, checking its MAC first. */
export async function decrypt(text: string, key: SymmetricKey): Promise<Bytes> {
  const enc = parseEncString(text);
  if (enc.type !== 2) throw new CryptoError("expected a symmetrically encrypted value");
  const mac = await hmac(key.mac, concat(enc.iv, enc.data));
  if (!constantTimeEqual(mac, enc.mac)) throw new CryptoError("wrong key, or the value was tampered with");
  const aes = await crypto.subtle.importKey("raw", key.enc, "AES-CBC", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: enc.iv }, aes, enc.data));
}

export async function decryptText(text: string, key: SymmetricKey): Promise<string> {
  return fromUtf8(await decrypt(text, key));
}

/** Encrypts into a type 2 EncString. */
export async function encrypt(plain: Bytes, key: SymmetricKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const aes = await crypto.subtle.importKey("raw", key.enc, "AES-CBC", false, ["encrypt"]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, aes, plain));
  const mac = await hmac(key.mac, concat(iv, data));
  return `2.${toBase64(iv)}|${toBase64(data)}|${toBase64(mac)}`;
}

export function encryptText(text: string, key: SymmetricKey): Promise<string> {
  return encrypt(utf8(text), key);
}

/** The account's RSA private key (PKCS #8), for organization keys. */
export function importPrivateKey(pkcs8: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSA-OAEP", hash: "SHA-1" }, false, ["decrypt"]);
}

/** Decrypts a type 4 EncString (an organization's key, shared with the user). */
export async function decryptRsa(text: string, privateKey: CryptoKey): Promise<Bytes> {
  const enc = parseEncString(text);
  if (enc.type !== 4) throw new CryptoError("expected an RSA-encrypted value");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, enc.data));
}
