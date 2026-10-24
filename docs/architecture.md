# Architecture

Better Passwords is a browser extension that reads logins from Apple Passwords (iCloud Keychain) on macOS. It doesn't store passwords and doesn't run a server: every request goes to Apple's own helper program, which ships with macOS 14 and later.

```
popup · inline menu (our extension pages)      autofill content script (on login pages)
   │ runtime messages                              │ one read-only question: "show a menu here?"
   ▼                                               ▼
background worker ─── Session: one connection, kept open for the whole browser session
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
| `apps/extension` | The WXT extension: background worker, popup, the page-fill function, and the browser packages. |
| `apps/companion` | The optional Touch ID companion app (Swift). See [companion.md](companion.md). |
| `scripts/setup-mac.sh` | One-time browser setup (see below). |

## One identity, separate browser packages

Better Passwords uses its own extension identity whether installed from a browser store or loaded unpacked from GitHub. Both use `io.github.fanckush.betterpasswords.bridge`, registered once by `scripts/setup-mac.sh` or the optional companion app. The manifest points at Apple's unmodified helper; the browser still launches that helper directly.

macOS's preinstalled `com.apple.passwordmanager` manifest allows only Apple's extension IDs. Better Passwords does not reuse those IDs or alter Apple's registration, and can be installed alongside Apple's extension.

Chromium builds carry the Chrome Web Store's public key, so unpacked builds get the same extension ID as the store version. Firefox has its own add-on identity and manifest format. Build output lives in `chrome-mv3` and `firefox-mv2`; GitHub and store distribution do not select different runtime behavior. The companion host allows only Better Passwords' own browser identities.

## Why the browser has to launch Apple's helper

The helper's code signature has *parent launch constraints*: macOS kills it unless an approved browser is its parent process. So a helper of ours cannot sit between the browser and Apple's helper. The extension always talks to Apple's helper directly. Native code of ours, such as the [Touch ID companion](companion.md), runs beside it, never in front of it.

## First run

Until the bridge is registered, connecting fails with the browser's "host not found", and the extension treats that as "not set up yet", not as an error. A fresh install that can't reach the helper opens `setup.html`; password fields offer "Set Up Better Passwords", which opens the same page; and the popup shows the same flow (`src/ui/setup.ts`). It offers the companion app or the setup command, retries the connection every 1.5 seconds while on screen, and says when it worked. That is said once, even if the popup closed while the user ran the command: the background remembers that setup was pending until the user sees it or unlocks. On anything but macOS, it only says that a Mac is needed.

## Sessions

Apple's helper keeps the pairing key only in its own memory. When the native port closes, the helper exits and the key is gone, and the next connection needs a new 6-digit code. Apple's extension lets that happen whenever its background worker goes idle, which is why it asks so often.

Our background worker keeps the port open. Chrome keeps an extension's worker alive while it has an open native-messaging port (Chrome 105+), and a 30-second `chrome.alarms` fallback is armed while unlocked. The result is one pairing per browser launch. Optionally, the session also ends when the Mac locks (`idle.onStateChanged`).

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

The content script runs in the top frame only. Logins inside cross-origin iframes are a later step.

## Filling (popup)

1. The popup asks the background for the active tab's logins.
2. The background reads the tab URL itself (granted by `activeTab` when the user opens the popup) and refuses anything that is not `https:` (or `http://localhost`).
3. On click, the background first injects `fillCredentials` without the password. On a username-only step of a multi-step sign-in, that fills the username and nothing else: no password is read, so no Touch ID. The background remembers the choice for that site (only the username, for 10 minutes, until it's used, or until locking): the sign-in's next step in that tab lists that login alone, the others a click away, and a password reset on that site saves for it (see below).
4. On a form with a password field, the background fetches the password from the helper (macOS may ask for Touch ID here) and injects `fillCredentials` again with the original expected origin. Changing origin cancels the choice. The background rechecks the active session before delivering the secret. Lock invalidates operations already processing a reply.
5. The fill function skips hidden and zero-size fields, and fills the username field from the password field's own form.

The inline menu fills the same way, through the content script.

## New passwords (sign-up and change-password forms)

Password fields on sign-up and change-password forms get a menu with two generated passwords: Apple's style (`xxxxxx-xxxxxx-xxxxxx`) and one without special characters. Both follow the field's `minlength`, `maxlength` and `passwordrules`. They are generated in the background worker, and shown masked until the user hovers the eye.

The first option is **Create in Apple Passwords**, available even before pairing. It uses Apple's helper to open the native creation sheet when supported, or opens the app at the site on older helpers. Creation, generation and saving then happen in Apple's app; this action reads no password and fills nothing into the page. Return to the browser and choose the saved login to fill it.

Inline suggestions require a conservative rule-space bound with a margin above 80 bits. Predictable, short, contradictory or excessively complex rules are refused before randomness is used. Bounded generation must satisfy every parsed rule; exhaustion returns an error. The menu keeps native creation available when inline generation is refused. A restrictive website may still require a weak password; opening Apple's app does not remove the site's restriction.

Like Safari, the chosen password is filled right away, and Apple Passwords is asked to save it once the page moves on with it. Apple's helper shows macOS's "Save password?" prompt but never reports the outcome, so the background then looks the login up until it appears.

"Moves on" means the tab navigates or changes URL (watched by the background, so leaving the page can't lose it), or the password field goes away: a dialog closes, or a multi-step form moves on (`src/autofill/submission.ts`). An invalid or rejected form keeps the field and the URL, so nothing is asked then. Otherwise, asking once too often beats missing a save: the prompt has Not Now, and it's asked only once per generated password.

The username is the one in the form, tracked as the user types, or the last username or email typed on the page (multi-step sign-ups). A form with no username or email field at all (a password reset, or a change of password) gets a guess: the login just chosen on that site (say, in its "forgot password" form, even in another tab, since reset links open a new one), or the site's only login. The menu shows it ("For bob@example.com"), and macOS's own prompt confirms the update. A remembered choice is forgotten once a password is saved with it, after a completed sign-in on that site, after 10 minutes, or on locking; no guess is better than a stale one. A sign-up's email field, even empty, means no guess. Without a username, macOS asks for it in its dialog, and the new login that appears tells us which name was saved.

Until Apple Passwords confirms a new login, the password is kept in memory and listed in the popup with a Copy button for the rest of the session. An update to an existing login can't be confirmed (the list looks the same), so it is assumed and kept listed too.

## Your email addresses (with the companion app)

Below Hide My Email, sign-up email fields list the emails on the user's own contact card ("Me" in Contacts), as Safari does. The extension can't read Contacts; the companion app can, once the user allows it in the app's setup window. It answers the extension's `my-emails` request through its native host, but only for a browser running Apple's helper (see the [threat model](threat-model.md)); the extension connects to the helper first, which needs no pairing. Without the app, the menu shows a hint pointing to it, with a ✕ to dismiss it for good.

## Hide My Email (opt-in)

Sign-up email fields get a menu that offers Hide My Email. Until the user turns it on, it's a hint with a ✕ that dismisses it for good (the popup can still turn it on). Once on, the menu shows the address made for this site before, or creates one: "Hide My Email…" proposes a random address ("Try Another" for a new one), and choosing it reserves it with the site as its label, then fills it in.

Apple's helper has no Hide My Email, so this uses icloud.com's web service with the browser's icloud.com sign-in (`src/icloud/hide-my-email.ts`, background only). That service accepts only icloud.com's Origin. While the feature is on, a session rule sets Origin and Referer on requests to iCloud that our extension starts outside any tab, which means our background's own. Turning the feature off removes the rule. See the [threat model](threat-model.md).
