# The helper protocol

Apple doesn't document this protocol. What follows was learned from earlier open-source clients (see [NOTICE](../NOTICE)) and checked against the live helper on macOS 27. The implementation is in `packages/protocol`.

## Transport

Chrome native messaging: every message is a 32-bit little-endian length followed by UTF-8 JSON. Replies echo the request's `cmd` and carry **no correlation id**, so the client never has two requests with the same `cmd` waiting at once: listing logins, pairing and saving each queue on their own, and a new password read replaces one still waiting (a dismissed Touch ID prompt leaves it unanswered). A password reply is used only if its `USR` is the login asked for, in case a replaced read's answer arrives late.

## Commands

| `cmd` | Meaning |
|---|---|
| 14 | Get capabilities (`shouldUseBase64`, OS version, feature flags) |
| 2 | Handshake: `msg.QID` is `m0` (client hello) or `m2` (client proof) |
| 4 | List login names for a URL (encrypted) |
| 5 | Get the password for a login name (encrypted; may trigger Touch ID) |
| 13 | Open the Passwords app; optional `searchQueryURL` (an http(s) URL) searches for that site. Plain, needs no pairing, no reply |
| 16 | List verification codes for a page (encrypted; see [Verification codes](#verification-codes)) |
| 17 | Report a filled verification code; the reply carries its digits (encrypted; asks for Touch ID) |
| 15 | From the helper: a new verification code is available, so lists of codes are stale (no data) |
| 9 / 10 | From the helper: passwords disabled / re-login needed, so drop the session |
| 0 | End |

### Not used yet

Apple's extension (3.4) also sends these. They're recorded here for later features; their replies haven't been checked against a real helper yet.

| `cmd` | QID | Encrypted body | Purpose |
|---|---|---|---|
| 6 | `CmdNewAccount4URL` or `CmdSetPassword4LoginName_URL` | `ACT: 4` (maybe add), `URL`/`USR`/`PWD` empty, `NURL`, `NUSR`, `NPWD` | Save a new or changed password |
| 1984 | – (plain `url`) | – | Open a URL in Safari |

Apple's extension also scans pages for `otpauth:` QR codes to set up new codes (capability `scanForOTPURI`, sent through cmd 13 with `setUpTOTPPageURL`/`setUpTOTPURI`). That isn't used.

Actions (`ACT`): 0 delete, 1 update, 2 search, 3 add new, 4 maybe add, 5 ghost search. The capabilities reply flags which features the helper supports, e.g. `canFillOneTimeCodes` and `canSaveAccountWithEmptyUserName`.

## Pairing (SRP-6a)

The group is the RFC 5054 3072-bit group (g = 5) with SHA-256. The *username* is a random 16-byte value encoded as text, and the *password* is the 6-digit code macOS shows.

1. **m0**: the client sends `A`, protocol version `"1.0"`, and `PROTO: [1]` (SRP with RFC verification). PAKE payloads are base64-encoded JSON.
2. The helper shows the code and answers with `B`, the salt `s`, and `PROTO: 1`.
3. Both sides compute:
   - `k = H(N | PAD(g))`
   - `x = H(s | H(I ":" P))`
   - `u = H(PAD(A) | PAD(B))`
   - `S` per RFC 5054
   - **`K = H(S)`**, with `S` in minimal big-endian form
4. **m2**: the client sends `M = H(H(N) xor H(PAD(g)) | H(I) | s | A | B | K)`. `A` and `B` are unpadded here.
5. The helper replies with `HAMK = H(A | M | K)`, or `ErrCode: 1` for a wrong code. The client must check `HAMK` (in constant time) before trusting the session.

A challenge allows exactly one verification attempt, and a new challenge replaces the old one. Binary fields are base64 when `shouldUseBase64` is set, otherwise hex.

The test suite checks `k`, `x`, `v`, `A`, `B`, `u` and `S` against the RFC 5054 Appendix B vectors, and checks that the 3072-bit `N` is prime. A shared bug between our client and our own fake helper could not hide behind self-consistency.

## Encrypted queries

The AES-128-GCM key is the first 16 bytes of `K`, with a 16-byte IV and a 128-bit tag. The framing is **asymmetric**:

- request: `ciphertext‖tag‖IV`
- reply: `IV‖ciphertext‖tag`

The query body goes in `payload.SMSG = JSON.stringify({ TID: username, SDATA: encode(encrypted) })`. The decrypted reply is `{ STATUS, Entries: [{ USR, PWD?, sites }] }`, where `STATUS` 0 means success and 3 means no results.

## Verification codes

Checked against the live helper on macOS 27.0.1, with a GitHub verification code saved in Apple Passwords. The helper reported `canFillOneTimeCodes: true` to an extension with its own ID.

**Listing (cmd 16, QID `CmdGetOneTimeCodes`).** The encrypted body is `{ ACT: 5, TYPE: "oneTimeCodes", frameURLs, username? }`. `frameURLs` lists the frame's URL followed by its parents' URLs. Without `username`, every account's codes for the site come back. Apple's extension sends no top-level `url`, and neither do we. The reply:

```json
{ "STATUS": 0, "RequiresUserAuthenticationToFill": true,
  "Entries": [{ "code": null, "username": "…", "domain": "github.com", "source": "totp" }] }
```

While `RequiresUserAuthenticationToFill` is set, `code` is `null`. A list never reveals digits, even right after a fill. No entry carries a period or an expiry.

**Filling (cmd 17, QID `CmdDidFillOneTimeCode`).** The body is the same, with `ACT: 2` and the `username` of the code being filled. macOS asks for Touch ID, and the reply only comes once the user approves. Each fill asked again. The reply has the same shape as a list, with the current digits in `code`. It also has a stray `Entry_0` field, which we ignore. The client fills the entry whose `source`, `username` and `domain` match the code asked for, so a late reply for another account is refused. Apple's extension sends cmd 17 only for `source: "totp"`; any other source's code is used as listed.

**Cmd 15** arrives from the helper without data. Apple's extension lists codes again when it gets one. It probably signals a code that arrived by SMS. We haven't seen one yet.


## Windows

iCloud for Windows' `iCloudPasswordsExtensionHelper.exe` (version 15.10.39.0) has the same commands, 0 to 18, under the same numbers, and the same pairing and query fields. Pairing and filling were checked against the live helper, in Brave. The differences:
- Its capabilities reply has `canFillOneTimeCodes`, `supportsSubURLs`, `scanForOTPURI` and `secretSessionVersion: 1`, and no `shouldUseBase64`. So the client encodes binary fields as hex, as for older macOS, and that pairs.
- Its PAKE replies send `MSG` as a string (`"1"`, `"3"`) where macOS sends a number. The client reads `MSG`, `PROTO` and `ErrCode` either way (`pakeNumber` in `client.ts`), and the fake helper's `windows` option answers like this.
- It doesn't advertise `canSaveAccountWithEmptyUserName`.
- It never asks for Windows Hello or a password before giving out a password or a code, so the extension locks when the PC locks by default there (`defaultSettings` in `src/messages.ts`).

Saving logins and verification codes haven't been checked on Windows yet.

The helper shows the pairing code in its own window. No check of the calling extension's ID was found: like on macOS, only the host manifest's allowed IDs decide which extension may start it.
