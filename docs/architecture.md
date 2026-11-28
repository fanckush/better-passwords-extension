# Architecture

Better Passwords is a browser extension that fills and saves logins from the password managers the user adds to it:
- **Apple Passwords** (iCloud Keychain) on macOS and Windows. It stores no passwords: every request goes to Apple's own helper program, which ships with macOS 14 and later, and with iCloud for Windows.
- **Bitwarden** (bitwarden.com, bitwarden.eu or a self-hosted server). Bitwarden has nothing on the computer to ask, so the extension is a Bitwarden client: it signs in, keeps the encrypted vault, and decrypts it in memory while unlocked. See [bitwarden.md](bitwarden.md).

It runs no server of its own.

```
popup · inline menu (our extension pages)      autofill content script (on login pages)
   │ runtime messages                              │ one read-only question: "show a menu here?"
   ▼                                               ▼
background worker ─── Accounts: every connected password manager
   │                       ├─ AppleAccount ─── Session: one connection, kept open all browser session
   │                       └─ BitwardenAccount (one per Bitwarden account) ─── fetch ──▶ Bitwarden's server
   │ runtime.connectNative(host)
   ▼
Apple's PasswordManagerBrowserExtensionHelper   ← launched by the browser itself
   │ Apple's private APIs
   ▼
Apple Passwords / iCloud Keychain
```

## Packages

| Path | What it is |
|---|---|
| `packages/protocol` | Client for the helper's protocol: SRP-6a pairing, the AES-GCM channel, login and password queries. Pure TypeScript with no browser APIs, so it is unit-tested directly. |
| `packages/fake-helper` | A test double of Apple's helper. Used in-process by unit tests and as a real native-messaging host by the e2e tests. |
| `packages/bitwarden` | Bitwarden client: the KDFs (PBKDF2, Argon2id through `hash-wasm`), EncStrings, sign-in with its code steps, sync, saving, and Bitwarden's URI matching. Pure TypeScript with `fetch` passed in. |
| `packages/fake-bitwarden` | An in-memory Bitwarden server, for unit tests and (through Playwright's routing) e2e tests. |
| `packages/otp` | Verification codes (TOTP, `otpauth://`, Steam), shared by Bitwarden and the fake helper. |
| `apps/extension` | The WXT extension: background worker, popup, the page-fill function, and the browser packages. |
| `apps/companion` | The optional Touch ID companion app (Swift). See [companion.md](companion.md). |
| `scripts/setup-mac.sh` | One-time browser setup on macOS (see below). |
| `scripts/setup-windows.ps1` | The same setup on Windows (see [Windows](#windows)). |

## Accounts

The extension doesn't talk to Apple Passwords directly: it talks to *accounts* (`src/accounts/`). An account is one connected password manager, an instance of a provider: Apple Passwords (`src/accounts/apple/`, at most one) and Bitwarden (`src/accounts/bitwarden/`, one per Bitwarden account). Nothing outside an adapter knows which provider an account is, so another provider can be added without touching the rest.

- `src/accounts/types.ts` is what an account does: its status in provider-neutral words (`needs-setup`, `unavailable`, `offline`, `locked`, `unlocking`, `unlocked`), how it unlocks (`pairing-code` for Apple, `password` for Bitwarden; the screen to show depends on this), what it can do (`capabilities`), and its logins, codes and saving. Each adapter maps its provider's quirks onto that. For Apple, that covers the helper's states, the stand-in tab its lookups use, and the companion app entering the code.
- `src/accounts/registry.ts` (`Accounts`) holds the accounts. Reads go to every unlocked account and are merged. Each login or code carries a `ref` naming its account and its id there, so filling it goes back to that account. Saving goes to one account, picked in one place (`saveTarget`): a new password for a username goes to the unlocked account that has that username for the site, and a new login to the one chosen under "Save new logins to" in the popup (else the first unlocked one that can save). Per-account settings (`lockOnScreenLock`, `touchId`) are kept under `accounts` in local storage. Older versions kept them in `settings`, and they're moved over once.
- Pages get `Status.accounts` and show whatever unlock screen each account's `unlock.kind` calls for. With one account, they show no account names; with more, each login carries a small badge of its provider.
- The accounts themselves are a list in local storage (provider and id), managed from the setup page (`entrypoints/setup/`): add one from the provider picker, sign in again, or remove one, which forgets everything kept for it. Existing installs start with Apple Passwords, as before.
- `test/support/memory-account.ts` is a second kind of account (password unlock, real item ids), used only by unit tests to keep the registry honest.

Email aliases are separate from accounts (`src/aliases/`): they work with any password manager. Hide My Email is the one `AliasProvider` so far (`src/aliases/icloud/`).

## Saving to accounts that don't ask

macOS asks before Apple's helper saves anything, so for Apple the extension just hands the login over. Bitwarden saves whatever it's sent, so for Bitwarden the extension asks first, with a card in the page (`entrypoints/save/`, framed by the content script like the menu, with its own nonce): Save, Not Now, or Never for this site. Which one happens depends on the account's `asksBeforeSaving` capability, not its provider (`offerSave` in `entrypoints/background.ts`).

## Unlocking Bitwarden

A Bitwarden account unlocks with its master password, typed in the popup (or in a small window of its own where the popup can't open, as on Firefox from the menu). The inline menu never takes it, since it lives inside a web page: its unlock row opens the popup. Once unlocked, the vault key is kept in `storage.session`, so a restarted background worker stays unlocked, and the account locks after its idle time, on Lock, or when the browser quits. The vault syncs on unlock and, when it's been a minute, the next time it's used. See the [threat model](threat-model.md#bitwarden).

## One identity, separate browser packages

Better Passwords uses its own extension identity whether installed from a browser store or loaded unpacked from GitHub. Both use `io.github.fanckush.betterpasswords.bridge`, registered once by `scripts/setup-mac.sh` or the optional companion app. The manifest points at Apple's unmodified helper; the browser still launches that helper directly.

macOS's preinstalled `com.apple.passwordmanager` manifest allows only Apple's extension IDs. Better Passwords does not reuse those IDs or alter Apple's registration, and can be installed alongside Apple's extension.

Chromium builds carry the Chrome Web Store's public key, so unpacked builds get the same extension ID as the store version. Firefox has its own add-on identity and manifest format. Build output lives in `chrome-mv3` and `firefox-mv2`; GitHub and store distribution do not select different runtime behavior. The companion host allows only Better Passwords' own browser identities.

## Why the browser has to launch Apple's helper

The helper's code signature has *parent launch constraints*: macOS kills it unless an approved browser is its parent process. So a helper of ours cannot sit between the browser and Apple's helper. The extension always talks to Apple's helper directly. Native code of ours, such as the [Touch ID companion](companion.md), runs beside it, never in front of it.

## First run

A fresh install that can't reach Apple's helper yet opens `setup.html`, which asks which password manager the user has. Bitwarden's setup is its sign-in. Apple's is below.

Until the bridge is registered, connecting fails with the browser's "host not found", and the extension treats that as "not set up yet", not as an error. A fresh install that can't reach the helper opens `setup.html`; password fields offer "Set Up Better Passwords", which opens the same page; and the popup shows the same flow (`src/ui/setup.ts`). It offers the companion app or the setup command, retries the connection every 1.5 seconds while on screen, and says when it worked. That is said once, even if the popup closed while the user ran the command: the background remembers that setup was pending until the user sees it or unlocks. On Windows it offers the PowerShell command instead (there's no companion app). On anything else, it only says that a Mac or a PC is needed.

## Windows

iCloud for Windows (a Microsoft Store package) ships the same helper as `iCloudPasswordsExtensionHelper.exe`, and registers it as `com.apple.passwordmanager` for Apple's own extension IDs only. `scripts/setup-windows.ps1` writes our manifests to `%LOCALAPPDATA%\Better Passwords\` and registers them under `HKCU\Software\<browser>\NativeMessagingHosts`, pointing at the package's app execution alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\iCloudPasswordsExtensionHelper.exe`). The package's own folder is renamed with each iCloud update; the alias isn't. Firefox refuses to start a host whose path is a link, which the alias is, so Firefox's manifest points at a one-line `.bat` next to it that starts the alias through `cmd.exe` (as Chromium does for every host).

Windows has no launch constraints, so no browser is blocked. A helper that quits as it starts means iCloud for Windows was removed or its alias turned off, and the setup flow says that instead. The companion app is Mac only: off a Mac, it's never asked or offered (`unavailable` in `src/companion.ts`). Apple's Windows helper never asks for Windows Hello before giving out a password or a code, so on Windows the session ends when the PC locks unless the user turns that off (`appleDefaultSettings` in `src/accounts/apple/account.ts`), and the code screens don't say "Confirm with Touch ID". What's different in the helper's protocol is in [protocol.md](protocol.md#windows).

## Sessions

Apple's helper keeps the pairing key only in its own memory. When the native port closes, the helper exits and the key is gone, and the next connection needs a new 6-digit code. Apple's extension lets that happen whenever its background worker goes idle, which is why it asks so often.

Our background worker keeps the port open. Chrome keeps an extension's worker alive while it has an open native-messaging port (Chrome 105+), and a 30-second `chrome.alarms` fallback is armed while unlocked. The result is one pairing per browser launch. Optionally, the session also ends when the computer locks (`idle.onStateChanged`).

## Updates

The browser installs a downloaded version only once the extension is idle, and ours never is while the port is open, so updates would wait for a browser restart. Instead the background worker restarts itself (`runtime.reload()`) when that ends nothing: as soon as `runtime.onUpdateAvailable` fires while locked, and otherwise the moment the session ends (Lock, the Mac locking with that setting on, the helper going away). While unlocked, the popup offers the update, warning that the code is needed again. A version waiting a day ends the session at the user's next break: the screen locking, or an hour without input (Firefox on macOS doesn't report screen locks). After an update Chromium leaves open tabs without the content script, so the worker injects it again; the old copy notices the new one and steps aside. A local build with `WXT_SIMULATE_UPDATE=<version>` pretends that version arrived at the first unlock, to try this flow.

## The inline menu

When a login field gets focus, the content script asks the background one question: show logins, offer to unlock, offer the setup (before this browser can reach Apple's helper), or stay out of the way. That answer is all it learns; it never sees usernames or passwords.

To show the menu, the content script opens a top-layer popover holding a closed shadow root with an iframe of our own `menu.html`. The menu page is an extension page, so:
- the web page can't read the usernames in it
- the web page can't listen to keys typed into it, which includes the pairing code, typed inline when locked

Every menu gets a random nonce, issued by the background with its answer to the content script, and passed in the menu's URL fragment. The fragment is invisible to the page, because the shadow root is closed. The menu sends its nonce with every request, and the background answers `menu.html` only with a nonce it issued to that tab, so a copy of `menu.html` framed by the page can't ask anything. (Chromium also serves `menu.html` only at a per-session address.) When the user picks a login, the menu asks the background, which fetches the password and relays it to the content script with the nonce. The content script then:
1. refuses nonces that aren't its current menu's,
2. refuses unless the menu has been genuinely visible for the last 300 ms (see the [threat model](threat-model.md)),
3. fills around the field the menu was opened on, within that field's form.

The content script runs in the page, in iframes of the page's own origin with only that origin around them, and in HTTPS iframes on another host of the page's site right inside the page (Schwab's sign-in on `sws-gateway-nr.schwab.com` inside `www.schwab.com`, Apple's on `idmsa.apple.com` inside `appstoreconnect.apple.com`). Such a frame can't read the page's address, so the background checks the site: the same registrable domain by the public suffix list, private part included, so two `github.io` sites stay apart (`isSameSiteFrame` in `apps/extension/src/same-site-frame.ts`). Once that frame asks for the menu, the tab is filled and saved for the frame's host until a field of the page's own origin asks. Logins in iframes of other sites are never filled.

## Passkeys (Chromium)

Chromium shows its own passkey list on a login field whose `autocomplete` has the `webauthn` token, on top of our menu. With the **Passkeys** setting on (the default), `passkey-list.content.ts` takes that token out of every such field from the start of the page, and keeps the page's value to put it back (`apps/extension/src/autofill/passkey-list.ts`). The site's own passkey request is untouched.

The browser opens its list only for a real click in the field, which no script can make. So we put the token back at the right moment, on the capture `mousedown` of a click in the field, before the browser looks at it (a `click` handler is too late: the browser decided at mousedown and focus):
- a click on the passkey icon at the field's end opens the browser's list with that click, and closes our menu
- "Use a Passkey" in our menu (for keyboards and screen readers) gives the browser the next click in the field
- after the browser's turn, a click on the field's text is ours again: the token comes out before the browser sees it

Leaving the field takes the token out again. We can't tell whether the user has a passkey for the site: the browser doesn't say.

## Icons in fields

An icon of ours at the end of a field is a `FieldIcon` (`apps/extension/src/autofill/field-icon.ts`), placed by the pure `fieldIconLayout` (`field-icon-layout.ts`). Both are generic: the content script decides which field gets an icon and what a click on it does. The passkey icon and minimal mode's icon use it.
- **Clicks pass through** (unless it `takesClicks`, see Minimal mode). The icon has `pointer-events: none`, so a click on it is the user's click on the field. The content script's capture `mousedown` asks `hits()` and acts before the browser handles the click. The page has nothing of ours to click, cover or fake clicks on.
- **Layout follows the field:** size from its font and height (14–20 px), inside its border and padding, clear of rounded corners, centred vertically, at the left end in a right-to-left field, in the field's text colour, faded. One icon per field so far: a second one would need an offset in `fieldIconLayout`. The layout cases are unit tested in `field-icon-layout.test.ts`, and measured on real fields in `e2e/passkey-list.spec.ts` with `e2e/pages/passkey-fields.html`.
- **Hidden where a click wouldn't reach the field:** off screen, too small, or something of the page's on top at the icon's spot.
- **The menu's visibility check must know about it.** The icon is in the top layer, which the check reads as the page covering the menu, so `MenuHost` takes our own top-layer elements (`ours`) to ignore. Pass any new icon's element there too.

## Minimal mode

An opt-in setting (`minimalMode`, off by default) for people who don't want a menu on every field. The menu never opens by itself then. Every field that would get one shows the extension's icon (the toolbar's) at its end instead, and a click on it (or ↓ in the field) opens the menu. Another click on the icon closes it. The icons are `MenuIcons` (`apps/extension/src/autofill/menu-icons.ts`).
- **Same answer, asked up front.** The content script asks the background which of the page's fields would get a menu (`menu-icons`, the same check as `autofill-status` without issuing nonces), again whenever the page's fields change, and again when the settings change. Settings changes apply to open pages right away.
- **The icon takes its own clicks.** Unlike the passkey icon, its element has `pointer-events: auto`, and the content script's capture `mousedown` takes trusted presses on it and focuses the field by script. The click never reaches the field, so the page doesn't hear of it and the browser shows no passkey list for it.
- **A click in the field is the browser's.** The browser's passkey list isn't hidden in minimal mode (`passkey-list.content.ts`), so the passkey icon and "Use a Passkey" don't appear. A click in a passkey field closes our menu, since the browser's list shows there.
- **Cheap to keep around.** Icons show only for fields in view (an `IntersectionObserver`). They follow their fields every frame only for a second after something changes (scroll, resize, page changes, animations, input), and otherwise check once a second.

## Filling (popup)

1. The popup asks the background for the active tab's logins.
2. The background reads the tab URL itself (granted by `activeTab` when the user opens the popup) and refuses anything that is not `https:` (or `http://localhost`).
3. On click, the background first injects `fillCredentials` without the password. On a username-only step of a multi-step sign-in, that fills the username and nothing else: no password is read, so no Touch ID. The background remembers the choice for that site (only the username, for 10 minutes, until it's used, or until locking): the sign-in's next step in that tab lists that login alone, the others a click away, and a password reset on that site saves for it (see below).
4. On a form with a password field, the background fetches the password from the helper (macOS may ask for Touch ID here) and injects `fillCredentials` again with it, with the expected origin. If the page navigated elsewhere in the meantime, nothing is filled.
5. The fill function skips hidden and zero-size fields, and fills the username field from the password field's own form.

The inline menu fills the same way, through the content script.

## New passwords (sign-up and change-password forms)

Password fields on sign-up and change-password forms get a menu with two generated passwords: Apple's style (`xxxxxx-xxxxxx-xxxxxx`) and one without special characters. Both follow the field's `minlength`, `maxlength` and `passwordrules`. When those limits make a password weaker than usual (a short `maxlength`, digits only), it's still offered, since anything the user makes up instead would be weaker: it's called Suggested Password, with a yellow or red badge that says which rule held it back (`src/passwords/generate.ts` counts how many passwords the rules leave). Only rules no password can meet, or that leave too few passwords to keep one secret, get no suggestion, and the menu says so in one line. The alternative without special characters is left out when the site requires one. They are generated in the background worker, and shown masked until the user hovers the eye.

Like Safari, the chosen password is filled right away, and Apple Passwords is asked to save it once the page moves on with it. Apple's helper shows macOS's "Save password?" prompt but never reports the outcome, so the background then looks the login up until it appears.

"Moves on" means the tab navigates or changes URL (watched by the background, so leaving the page can't lose it), or the password field goes away: a dialog closes, or a multi-step form moves on (`src/autofill/submission.ts`). An invalid or rejected form keeps the field and the URL, so nothing is asked then. Otherwise, asking once too often beats missing a save: the prompt has Not Now, and it's asked only once per generated password.

The username is the one in the form, tracked as the user types, or the last username or email typed on the page (multi-step sign-ups). A form with no username or email field at all (a password reset, or a change of password) gets a guess: the login just chosen on that site (say, in its "forgot password" form, even in another tab, since reset links open a new one), or the site's only login. The menu shows it ("For bob@example.com"), and macOS's own prompt confirms the update. A remembered choice is forgotten once a password is saved with it, after a completed sign-in on that site, after 10 minutes, or on locking; no guess is better than a stale one. A sign-up's email field, even empty, means no guess. Without a username, macOS asks for it in its dialog, and the new login that appears tells us which name was saved.

Until Apple Passwords confirms a new login, the password is kept in memory and listed in the popup with a Copy button for the rest of the session. An update to an existing login can't be confirmed (the list looks the same), so it is assumed and kept listed too.

## Your email addresses (with the companion app)

Below Hide My Email, email fields list the emails on the user's own contact card ("Me" in Contacts), as Safari does. The extension can't read Contacts; the companion app can, once the user allows it in the app's setup window. It answers the extension's `my-emails` request through its native host, but only for a browser running Apple's helper (see the [threat model](threat-model.md)); the extension connects to the helper first, which needs no pairing. Without the app, the menu shows a hint pointing to it, with a ✕ to dismiss it for good.

## Hide My Email (opt-in)

Email fields get a menu that offers Hide My Email: a sign-up's, and any other that isn't part of a sign-in (a newsletter, a contact form). A lone field named for the account (`name="username"`, a forgot-password form) or in a form that signs in gets saved logins instead. Until the user turns it on, it's a hint with a ✕ that dismisses it for good (the popup can still turn it on). Once on, the menu shows the address made for this site before, or creates one: "Hide My Email…" proposes a random address ("Try Another" for a new one), and choosing it reserves it with the site as its label, then fills it in.

Apple's helper has no Hide My Email, so this uses icloud.com's web service with the browser's icloud.com sign-in (`src/aliases/icloud/`, background only). That service accepts only icloud.com's Origin. While the feature is on, a session rule sets Origin and Referer on requests to iCloud that our extension starts outside any tab, which means our background's own. Turning the feature off removes the rule. See the [threat model](threat-model.md).
