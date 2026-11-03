# Store listings

The text and answers behind the [Chrome Web Store](https://chromewebstore.google.com/detail/better-passwords/ocongmkplhijgajnipnhhggfcjfdilgj) listing (ID `ocongmkplhijgajnipnhhggfcjfdilgj`) and the [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/better-passwords/) listing (`better-passwords`). Update this file when either listing changes.

Reviewer build and testing instructions: [reviewer-build.md](reviewer-build.md). Screenshots and promotional art: [store-media.md](store-media.md).

On Firefox, the screen-lock bullet reads “Lock any time from the toolbar popup.” Firefox summary: “Fill and save logins from Apple Passwords on your Mac, with inline suggestions and optional Touch ID and Hide My Email.”

## Name and compatibility

The product name is **Better Passwords**. Use the separate compatibility line:

> A browser companion for Apple Passwords.

`DISPLAY_NAME` in `apps/extension/src/config.ts` controls the extension name. Use the same name for the Mac companion. Describe Apple Passwords, iCloud and Touch ID as compatibility or features, without implying Apple authorship or endorsement. Every listing carries "Not affiliated with or endorsed by Apple Inc."

## Short description (Chrome: 132 characters max)

> Fill logins from Apple Passwords on your Mac. Pair once per browser session, or unlock with Touch ID.

## Detailed description

> Use the passwords you keep in Apple Passwords (iCloud Keychain) in your browser on your Mac.
>
> Better Passwords keeps the connection to Apple's password helper open, so you can stay paired for the browser session. With the optional, free Mac companion, you can unlock with Touch ID instead of typing a pairing code.
>
> • Suggestions in login fields: click a field, pick your account
> • Fill from the toolbar button
> • Generate strong passwords for sign-up forms and save them to Apple Passwords
> • Save new logins and changed passwords to Apple Passwords after you sign in
> • Fill two-factor verification codes saved in Apple Passwords
> • Use Hide My Email in email fields (optional; requires iCloud+)
> • Open the Passwords app for the current site
> • Lock any time; on Chromium browsers, optionally lock when your Mac locks
>
> Password lookup and saving use Apple's password helper locally on your Mac, over encrypted pairing. Settings are saved on your device; credentials and temporary suggestions are held in memory. The project runs no backend and includes no analytics or advertising.
>
> If you enable Hide My Email, the extension connects to Apple's iCloud using your existing icloud.com sign-in. Creating an alias sends the alias and the current site's hostname to Apple. The optional companion can also provide email suggestions from your own contact card, with your permission.
>
> Requires macOS 14 or later, signed in to iCloud with Passwords turned on, and a one-time setup command or the companion app. Setup: https://github.com/fanckush/better-passwords-extension#setup
>
> Free and open source (MIT). Not affiliated with or endorsed by Apple Inc.

## Chrome Web Store: privacy practices tab

**Single purpose:** Help users sign in and sign up on websites using Apple Passwords and optional iCloud Hide My Email on macOS.

**Permission justifications:**

| Permission | Why |
|---|---|
| `nativeMessaging` | To talk to the password helper built into macOS (and, if installed, to the companion app for Touch ID). This is the only way to reach Apple Passwords. |
| `host_permissions` `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` | To show login suggestions in login fields on any site the user visits, and to fill the login the user picks. |
| `activeTab`, `scripting` | To fill the chosen login into the current tab when the user picks it from the toolbar popup. |
| `storage` | To remember the user's settings. |
| `alarms` | To keep the connection to the Mac alive, so the user isn't asked for a new code. |
| `idle` | To lock when the Mac's screen locks, if the user turned that on. |
| `declarativeNetRequestWithHostAccess` | Only for the opt-in Hide My Email feature: iCloud's web service accepts requests only with icloud.com's Origin, so while the user has it on, a session rule sets that header on the extension's own requests to iCloud. Websites' requests are never modified. |

**Remote code:** No. All code ships in the package.

**Data usage:** Declares **Authentication information** (passwords/usernames), **Personally identifiable information** (email addresses), and **Web history** (site addresses used for lookup and alias labels). Certifies that data is not sold, not used for unrelated purposes, and not used for creditworthiness. Password lookup and filling are local; opt-in Hide My Email sends requests and site labels to the user's iCloud account.

**Privacy policy URL:** `https://github.com/fanckush/better-passwords-extension/blob/main/PRIVACY.md`

## Firefox Add-ons

- **Data collection:** required `authenticationInfo` and `browsingActivity` describe the core local native-helper exchange. Optional `personallyIdentifyingInfo` and `websiteContent` cover Hide My Email aliases and iCloud session cookies. Firefox prompts when Hide My Email is enabled, and network requests check the permission grant. No data is sent to the developer.
- **Platforms:** macOS only.
- **Payment requirement:** discloses that the optional Hide My Email feature needs an Apple iCloud+ subscription; the extension itself is free.
- **Source code:** the build bundles code, so each version uploads the sources zip (`bun run zip:all` makes `better-passwords-<version>-sources.zip`). It includes the workspace packages and root lockfile; run the reviewer commands from its root.
- **Notes for reviewers:**
  > Built with Bun 1.3.14 and WXT 0.21.4. To reproduce: `bun install --frozen-lockfile --ignore-scripts && bun run --filter @app/extension build:firefox`. The output is `apps/extension/.output/firefox-mv2`. The extension uses native messaging to reach Apple's PasswordManagerBrowserExtensionHelper, which ships with macOS. Testing needs a Mac signed in to iCloud and the setup in scripts/setup-mac.sh.
