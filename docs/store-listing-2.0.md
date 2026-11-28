# Store listings for 2.0 (draft)

What the listings in [store-listing.md](store-listing.md) become when 2.0 (Apple Passwords and Bitwarden) ships. Nothing here is live yet. When 2.0 is submitted, move this into store-listing.md and delete this file.

## Name

| | Title | Limit |
|---|---|---|
| Chrome Web Store | Better Passwords – Autofill for Apple Passwords & more | 75 |
| Firefox Add-ons | Better Passwords – Apple Passwords & more | 50 |

Both come from `STORE_TITLE` and `FIREFOX_STORE_TITLE` in `apps/extension/src/config.ts`. Bitwarden's trademark guidelines don't allow its name in another product's name, so it's named only in descriptions, as compatibility ("works with Bitwarden"), never as part of the product. The same goes for its logo: the extension's Bitwarden tile is an original shield glyph.

## Short description

Chrome (132 characters max; also the manifest's `description`, `STORE_SUMMARY`):

> Fill and save logins from Apple Passwords or Bitwarden, with suggestions right in login fields.

Firefox summary (250 max):

> Fill and save logins from Apple Passwords or Bitwarden, with suggestions right in login fields, strong passwords for sign-ups, verification codes, optional Hide My Email, and optional Touch ID on a Mac.

## Detailed description

> Better Passwords fills and saves your logins in the browser, from the password manager you already use: Apple Passwords (iCloud Keychain) on your Mac or Windows PC, or Bitwarden. Use one, or both at once.
>
> • Suggestions in login fields: click a field, pick your account
> • Strong passwords suggested right in sign-up forms
> • Save new logins and changed passwords after you sign in
> • Fill two-factor verification codes saved in your password manager
> • Use Hide My Email in email fields (optional; requires iCloud+)
> • Fill from the toolbar button
> • Lock any time; on Chromium browsers, optionally lock when your computer locks
>
> Apple Passwords: Better Passwords keeps the connection to Apple's password helper open, so you pair once per browser session instead of typing a new code again and again. With the optional, free Mac companion, you unlock with Touch ID instead. Password lookup and saving use Apple's password helper locally on your computer, over encrypted pairing. Requires macOS 14 or later, or Windows with iCloud for Windows, and a one-time setup (the companion app, or a setup command).
>
> Bitwarden: sign in to bitwarden.com, bitwarden.eu or your own server, then unlock with your master password. Better Passwords keeps your vault encrypted on your device and decrypts it in memory while unlocked, like Bitwarden's own extension. Your master password is never sent or saved.
>
> The project runs no backend and includes no analytics or advertising. The extension talks only to Apple's helper on your computer, to the Bitwarden server you sign in to, and to iCloud if you turn on Hide My Email.
>
> Setup: https://github.com/fanckush/better-passwords-extension#setup
>
> Free and open source (MIT). Not affiliated with or endorsed by Apple Inc. or Bitwarden, Inc. Bitwarden is a trademark of Bitwarden, Inc.

On Firefox, the lock bullet reads “Lock any time from the toolbar popup.”

## Chrome Web Store: privacy practices tab

**Single purpose:** Help users sign in and sign up on websites with the logins in their password manager (Apple Passwords or Bitwarden), and optional iCloud Hide My Email.

**Permission justifications** (changes from today's; the rest stay as in store-listing.md):

| Permission | Why |
|---|---|
| `host_permissions` `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` | To show login suggestions in login fields on any site the user visits, and to fill the login the user picks. Also how the extension reaches the Bitwarden server the user signs in to, which may be bitwarden.com, bitwarden.eu or the user's own server at any address. |
| `optional_host_permissions` `http://*/*` | Asked for only when the user signs in to a self-hosted Bitwarden server on plain `http://` (a home server, say), and only for that server's address. |
| `nativeMessaging` | To talk to Apple's password helper built into macOS or iCloud for Windows (and, if installed, the companion app for Touch ID). Not used for Bitwarden. |

**Remote code:** No. All code ships in the package. `'wasm-unsafe-eval'` in the CSP lets the bundled Argon2id WebAssembly (`hash-wasm`) compile, for Bitwarden accounts that use Argon2id; no code is downloaded.

**Data usage:** Same categories as today: **Authentication information** (now also the Bitwarden account's email, password hash, tokens and encrypted vault, sent to and from the user's Bitwarden server), **Personally identifiable information** (email addresses), and **Web history** (site addresses, now also saved encrypted with Bitwarden logins). Data goes only to the services the user connects (Apple's helper, the user's Bitwarden server, iCloud); none to the developer. Certifies that data is not sold, not used for unrelated purposes, and not used for creditworthiness.

## Firefox Add-ons

- **Data collection:** unchanged in the manifest. Required `authenticationInfo` and `browsingActivity` cover Apple's local helper and Bitwarden: the account's email, password hash, tokens and vault, and saved logins' site addresses. Optional `personallyIdentifyingInfo` and `websiteContent` stay Hide My Email's.
- **Platforms:** macOS, Windows and Linux. Apple Passwords needs macOS or Windows; Bitwarden works anywhere.
- **Notes for reviewers** (add to today's):
  > Bitwarden: the extension is a Bitwarden client (packages/bitwarden; protocol notes in docs/bitwarden.md). To test, choose Bitwarden in the setup tab and sign in to a bitwarden.com account. The master password is used only to derive keys locally; Bitwarden's server gets a hash, as with Bitwarden's own clients.
