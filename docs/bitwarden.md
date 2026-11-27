# Bitwarden

How Better Passwords talks to Bitwarden's servers, as tested against bitwarden.com on 2026-11-27 with a throwaway account. Bitwarden's own clients are the reference. Anything not tested yet is marked as such.

Bitwarden has no local app we can ask for logins, the way Apple's helper answers for Apple Passwords. The extension is a Bitwarden client: it signs in, downloads the encrypted vault, and decrypts it in memory while unlocked.

## Servers

| Region | Identity | API |
|---|---|---|
| US | `https://identity.bitwarden.com` | `https://api.bitwarden.com` |
| EU | `https://identity.bitwarden.eu` | `https://api.bitwarden.eu` |

**Self-hosted** (Bitwarden's own server, or Vaultwarden): the user types the web vault's address. Identity and API are served under it, as Bitwarden's own clients assume when only a server URL is given:

| | Address |
|---|---|
| Identity | `{base}/identity` |
| API | `{base}/api` |
| Web vault | `{base}` |

The address is made canonical before use (`selfHostedUrl`): `https://` when no scheme is typed, no trailing slash, query or `#/` route. Plain `http://` works too (a home server, or one reached over Tailscale). A prelogin that answers 404, or with something that isn't JSON, means there's no Bitwarden server at that address. *Tested only against the fake server (packages/fake-bitwarden), not a real Vaultwarden yet.*

Every request carries `Bitwarden-Client-Name: browser`, `Bitwarden-Client-Version` and `Device-Type`. The token endpoint is rate-limited (about 10 requests a minute).

**CORS:** the servers' preflight answers extension origins with `Access-Control-Allow-Origin: null`. The background worker gets around this with the extension's host permissions (`https://*/*`). Tested in a Chromium MV3 build: sign-in with two-step login, sync, unlock and fill all worked. *Firefox not tested yet.* An `http://` self-hosted server isn't covered by those, so the sign-in form asks for that one origin (`optional_host_permissions: http://*/*`, `optional_permissions` in Firefox's MV2 build) when the user signs in.

**CSP:** `connect-src` is `'self' https: http:`, since a self-hosted server can be anywhere. It used to list only iCloud and Bitwarden's cloud. That was defense in depth against injected code sending data out, but injected code can already do that other ways (opening a tab, a content script's request, the native host). What keeps other code out is `script-src 'self'`: no remote, inline or eval'd scripts.

**New devices:** every new `deviceIdentifier` makes Bitwarden email the account owner about a new device. The extension keeps one per install (`bitwardenDeviceId` in storage).

## Signing in

1. `POST {identity}/accounts/prelogin` with `{ "email" }` returns the KDF: `kdf` (0 = PBKDF2-SHA256, 1 = Argon2id), `kdfIterations`, `kdfMemory` (MiB) and `kdfParallelism`. New accounts default to PBKDF2 with 600,000 iterations.
2. **Master key** = PBKDF2-SHA256(password, salt = email trimmed and lowercased, iterations, 32 bytes). For Argon2id, the salt is SHA-256 of that email.
3. **Master password hash** (the only thing sent) = base64(PBKDF2-SHA256(master key, salt = password, 1 iteration)).
4. `POST {identity}/connect/token`, form-encoded: `grant_type=password`, `username`, `password` (the hash), `scope=api offline_access`, `client_id=browser`, `deviceType` (2 for a Chromium extension, 3 for Firefox), `deviceIdentifier` (a UUID kept per install), `deviceName`.
   - **200:** `access_token` (1 hour), `refresh_token`, `Key` (the user key, an EncString wrapped with the stretched master key), `PrivateKey`, `Kdf*`, and `UserDecryptionOptions`.
   - **Wrong password:** 400 `{"error":"invalid_grant","error_description":"invalid_username_or_password","ErrorModel":{"Message":"Username or password is incorrect. Try again."}}`.
   - **Two-step login:** 400 `{"error":"invalid_grant","error_description":"Two factor required.","TwoFactorProviders2":{"0":null}}`. The keys are the providers on offer (0 authenticator, 1 email, …; email's value holds the masked address). Send the same request again with `twoFactorToken`, `twoFactorProvider` and `twoFactorRemember` (0/1). A wrong code gets the same `invalid_username_or_password` as a wrong password, with only `ErrorModel.Message` ("Two-step token is invalid…") telling them apart. Since the password already passed to reach this step, a failure with a code means a wrong code. A code can be used only once: sending the same code again within its 30 seconds fails as wrong. (2FA settings can't be changed through the API by a browser client: 403. They're turned on in the web vault.)
   - **New-device verification:** for accounts without two-step login, a new device gets a 400 `device_error` and an emailed code, which is sent back as `newDeviceOtp` (as other third-party clients handle it). *Not seen yet: even with `verifyDevices: true` in its profile, an account created minutes earlier wasn't asked from two new devices. Retest with an older account.*
5. **Refresh:** `grant_type=refresh_token`, `client_id=browser`, `refresh_token`. The refresh token stayed the same.

## Keys

- **Stretched master key:** HKDF-Expand(SHA-256, master key, "enc", 32) and HKDF-Expand(…, "mac", 32).
- **User key:** decrypt `Key` with the stretched master key, giving 64 bytes (AES-256 key + HMAC key). It decrypts everything else.
- **Private key:** decrypt `PrivateKey` with the user key, giving PKCS #8 RSA. It decrypts organization keys (type 4, RSA-OAEP-SHA1).
- **Per-item keys:** a cipher may have `key` (an EncString under the user or org key) that decrypts its fields. Items we created through the API had none.

**EncString type 2:** `2.<iv>|<data>|<mac>`, base64 parts, AES-256-CBC with HMAC-SHA256 over iv‖data. The MAC is checked before decrypting.

## The vault

`GET {api}/sync?excludeDomains=true` (Bearer token) returns `profile`, `folders`, `collections`, `ciphers`, `policies`, `sends`. A login is `type: 1`. Its encrypted fields are `name`, `notes`, `login.username`, `login.password`, `login.totp` and `login.uris[].uri`. `login.uris[].match` is in the clear (null = the default, base domain). `revisionDate` is used for edits.

## Saving

- **New login:** `POST {api}/ciphers` with `type: 1`, the encrypted `name` and `login` fields, and `organizationId`/`folderId` null.
- **New password:** `PUT {api}/ciphers/{id}` with the whole cipher, the new `login.password`, the old one appended to `passwordHistory`, and `lastKnownRevisionDate`. An out-of-date revision gets 400 ("The item cannot be saved because it is out of date"): sync and try again.
