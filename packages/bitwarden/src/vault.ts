// The vault, decrypted: logins as the extension fills them, which sites each one matches (Bitwarden's
// own rules, per URI), and the requests that save a new login or a new password. Decrypted data only
// ever lives in memory; what's stored is /sync's answer as it came, still encrypted.

import { getDomain } from "tldts";
import type { CipherData, CipherRequest, SyncData } from "./client.ts";
import {
  decrypt,
  decryptRsa,
  decryptText,
  encryptText,
  importPrivateKey,
  type SymmetricKey,
  stretch,
  symmetricKey,
} from "./crypto.ts";

/** How a saved URI matches a page, by Bitwarden's numbers. Null on a URI means the default. */
export const UriMatch = { Domain: 0, Host: 1, StartsWith: 2, Exact: 3, RegularExpression: 4, Never: 5 } as const;

export interface VaultLogin {
  id: string;
  organizationId: string | null;
  name: string;
  username: string;
  password: string;
  /** The authenticator setup, as saved (a secret, otpauth:// or steam://). */
  totp: string | null;
  uris: { uri: string; match: number | null }[];
  /** The user asked to type the master password again before this login is used. */
  reprompt: boolean;
  revisionDate: string;
}

/** The keys a vault opens with: the user's, and each organization's shared with them. */
export interface VaultKeys {
  user: SymmetricKey;
  organizations: Map<string, SymmetricKey>;
}

export interface Vault {
  keys: VaultKeys;
  logins: VaultLogin[];
  /** Items that couldn't be decrypted (a key we don't have): left out, but counted. */
  unreadable: number;
}

/** Opens the user key with the master key. Fails ("wrong key") on a wrong master password. */
export async function openUserKey(protectedUserKey: string, masterKey: Uint8Array<ArrayBuffer>): Promise<SymmetricKey> {
  return symmetricKey(await decrypt(protectedUserKey, await stretch(masterKey)));
}

export async function decryptVault(sync: SyncData, user: SymmetricKey): Promise<Vault> {
  const keys: VaultKeys = { user, organizations: new Map() };
  const orgs = sync.profile.organizations.filter((org) => org.key && org.enabled !== false);
  if (orgs.length > 0 && sync.profile.privateKey) {
    const privateKey = await importPrivateKey(await decrypt(sync.profile.privateKey, user));
    for (const org of orgs) {
      try {
        keys.organizations.set(org.id, symmetricKey(await decryptRsa(org.key as string, privateKey)));
      } catch {
        // an organization whose key won't open: its items are counted as unreadable below
      }
    }
  }
  const logins: VaultLogin[] = [];
  let unreadable = 0;
  for (const cipher of sync.ciphers) {
    if (cipher.type !== 1 || !cipher.login || cipher.deletedDate) continue;
    try {
      logins.push(await decryptLogin(cipher, keys));
    } catch {
      unreadable++;
    }
  }
  return { keys, logins, unreadable };
}

/** The key a cipher's fields are encrypted with: its own, else its organization's or the user's. */
export async function cipherKey(
  cipher: Pick<CipherData, "organizationId" | "key">,
  keys: VaultKeys,
): Promise<SymmetricKey> {
  const owner = cipher.organizationId ? keys.organizations.get(cipher.organizationId) : keys.user;
  if (!owner) throw new Error("no key for this item's organization");
  return cipher.key ? symmetricKey(await decrypt(cipher.key, owner)) : owner;
}

async function decryptLogin(cipher: CipherData, keys: VaultKeys): Promise<VaultLogin> {
  const key = await cipherKey(cipher, keys);
  const text = async (value: string | null | undefined) => (value ? decryptText(value, key) : "");
  const login = cipher.login as NonNullable<CipherData["login"]>;
  const uris: VaultLogin["uris"] = [];
  for (const entry of login.uris ?? []) {
    if (entry.uri) uris.push({ uri: await text(entry.uri), match: entry.match });
  }
  return {
    id: cipher.id,
    organizationId: cipher.organizationId,
    name: await text(cipher.name),
    username: await text(login.username),
    password: await text(login.password),
    totp: login.totp ? await text(login.totp) : null,
    uris,
    reprompt: cipher.reprompt === 1,
    revisionDate: cipher.revisionDate,
  };
}

/** A saved URI as a URL: Bitwarden lets people save "example.com" without a scheme. */
function asUrl(uri: string): URL | undefined {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `https://${uri}`);
  } catch {
    return undefined;
  }
}

/** The registrable domain ("example.co.uk"), or the host itself for IPs and local names. */
function baseDomain(hostname: string): string {
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}

/** Whether a saved URI matches the page at `url`, by its own rule or `defaultMatch`. */
export function uriMatches(
  saved: VaultLogin["uris"][number],
  url: URL,
  defaultMatch: number = UriMatch.Domain,
): boolean {
  const rule = saved.match ?? defaultMatch;
  if (rule === UriMatch.Never) return false;
  if (rule === UriMatch.RegularExpression) {
    try {
      return new RegExp(saved.uri, "i").test(url.href);
    } catch {
      return false;
    }
  }
  if (rule === UriMatch.Exact) return saved.uri === url.href;
  if (rule === UriMatch.StartsWith) return url.href.startsWith(saved.uri);
  const target = asUrl(saved.uri);
  if (!target || !/^https?:$/.test(target.protocol)) return false;
  if (rule === UriMatch.Host) return target.host.toLowerCase() === url.host.toLowerCase();
  return baseDomain(target.hostname.toLowerCase()) === baseDomain(url.hostname.toLowerCase());
}

/** The logins for the page at `url`. */
export function loginsFor(vault: Pick<Vault, "logins">, url: URL, defaultMatch?: number): VaultLogin[] {
  return vault.logins.filter((login) => login.uris.some((uri) => uriMatches(uri, url, defaultMatch)));
}

/** A new login, encrypted with the user key (personal vault, no folder). */
export async function newLoginRequest(
  login: { name: string; username: string; password: string; uri: string },
  keys: VaultKeys,
): Promise<CipherRequest> {
  const key = keys.user;
  return {
    type: 1,
    organizationId: null,
    folderId: null,
    favorite: false,
    reprompt: 0,
    key: null,
    notes: null,
    name: await encryptText(login.name, key),
    login: {
      username: login.username ? await encryptText(login.username, key) : null,
      password: await encryptText(login.password, key),
      totp: null,
      uris: [{ uri: await encryptText(login.uri, key), match: null }],
    },
  };
}

/** A saved login with a new password; the old one goes into its password history, as Bitwarden does. */
export async function newPasswordRequest(
  cipher: CipherData,
  password: string,
  keys: VaultKeys,
): Promise<CipherRequest> {
  const key = await cipherKey(cipher, keys);
  const login = cipher.login ?? { username: null, password: null, totp: null, uris: null };
  const history = [...(cipher.passwordHistory ?? [])];
  if (login.password) history.unshift({ password: login.password, lastUsedDate: new Date().toISOString() });
  return {
    type: 1,
    organizationId: cipher.organizationId,
    folderId: cipher.folderId,
    favorite: cipher.favorite,
    reprompt: cipher.reprompt,
    key: cipher.key,
    name: cipher.name,
    notes: cipher.notes,
    fields: cipher.fields ?? null,
    login: { ...login, password: await encryptText(password, key) },
    // Bitwarden keeps the last five
    passwordHistory: history.slice(0, 5),
    lastKnownRevisionDate: cipher.revisionDate,
  };
}
