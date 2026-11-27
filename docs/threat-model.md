# Threat model

What we protect: the user's passwords in Apple Passwords, and the session that can read them.

## Trust boundaries

| Component | Trusted? | Notes |
|---|---|---|
| Apple's helper and macOS | yes | Verified by macOS code signing. We never modify or wrap it. |
| Our background worker and popup | yes | The only code that holds the session key. |
| Web pages and their scripts | **no** | Never talk to the background; only receive values the user chose to fill. |
| Other extensions | **no** | Messages from other extension IDs are refused. |
| The local user account | mostly | Anything running as the user can already reach Apple's helper the same way we do. |

## What we rely on

- **The pairing code proves the user is present.** It appears only on the Mac's screen, and SRP turns it into a key without ever sending it. We never store it.
- **The session key stays in memory** in the background worker (a non-extractable WebCrypto key plus SRP state). It is never written to storage, and it is gone when the browser quits or the user locks.
- **Server proof.** Pairing completes only after the helper proves it derived the same key (`HAMK`, compared in constant time).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A page tricks a fill into a hidden field, or onto another origin | Fills only on a click in our UI, only into the active tab's page, its own-origin iframes, or a frame of the page's site right inside it (same registrable domain by the public suffix list, HTTPS), only if the origin still matches. Hidden, zero-size and transparent fields are skipped. |
| Clickjacking the inline menu (making it transparent or covering it, or moving it under the pointer, then luring a click; DOM-based extension clickjacking, Tóth 2025) | Layered checks:<br>(1) Chromium: the menu tracks its own visibility with IntersectionObserver v2 and ignores clicks unless it has been really visible for 300 ms. IntersectionObserver v2 doesn't count masks, so (2) checks those.<br>(2) Before filling, the content script checks that the menu is open in the top layer, that no other top-layer element is open (popover, modal dialog or fullscreen element), that it and its ancestors are fully opaque with no filters, blend modes, masks, clip paths or hidden content (`visibility`, `content-visibility`), and that hit-testing at its centre and corners lands on it.<br>(3) The content script runs those checks every frame while the menu is open, and fills only if the menu passed them without a break, and without moving, for the last 300 ms. A page that reveals a hidden menu once the click lands is refused, and so is a menu made to follow the pointer. `e2e/clickjacking.spec.ts` tries each technique. |
| The page frames its own copy of `menu.html` | Chromium serves `menu.html` only at a per-session address (`use_dynamic_url`), which pages never learn. In every browser, the background issues each menu's nonce to the tab's content script, which keeps it in a closed shadow root, and answers `menu.html` only with a nonce it issued to that tab. A copy with any other nonce can't list logins, fetch a password, change a setting or call iCloud. |
| The page reads usernames or the typed code | The menu is a cross-origin extension iframe inside a closed shadow root. The content script never receives usernames. |
| A page or other extension asks the background for passwords | `runtime.onMessage` accepts only our own extension pages (same ID and our extension URL). |
| Plain-http pages leak a filled password | Only `https:` pages (and `http://localhost` for development) are filled. |
| A longer-lived session widens the window of exposure | Sessions end on browser quit or "Lock". The optional "lock when my Mac locks" setting covers a walked-away Mac. Sensitive items still trigger macOS's own Touch ID prompt when read. |
| The setup script is tampered with | It is plain, short shell. It writes only one JSON file per browser, pointing at Apple's signed helper, and needs no admin rights. Read it before running. |
| A future macOS change in Apple's helper | Fail closed: unknown replies and protocol versions are rejected. |
| A page reads a generated password | It's generated in the background and shown only in our menu frame. The page gets it only when the user picks it, into that page's own new-password fields. |
| A generated password is filled but never saved | macOS asks before saving, and the user may decline. Until Apple Passwords lists the login, the password stays in memory, shown in the popup for the session. |
| Hide My Email needs icloud.com's Origin on our requests | Off until the user opts in. While on, a session-only rule sets Origin and Referer only on requests to iCloud that our extension starts outside any tab: our background's own. Both conditions matter: a website's service worker belongs to no tab either, so the rule also requires our extension as the initiator (tested end to end). Websites' requests to iCloud are never touched, so no page can borrow icloud.com's identity. Turning it off removes the rule. |
| Hide My Email uses an undocumented iCloud web service | Background only; the menu and pages never talk to iCloud. It relies on the user's icloud.com sign-in in that browser and stores no iCloud credentials. If Apple changes the service, the feature fails visibly and nothing else is affected. |
| A page fakes a sign-up to trigger save prompts | Only a password we filled can be saved, and only with a user-visible macOS prompt. A page can at worst cause an extra prompt. |

## Known gaps

- The clickjacking checks cover the known ways to hide or move the menu (`e2e/clickjacking.spec.ts`). A new CSS feature that hides content while it still takes clicks could get past them until it's added; there is no complete protection inside a page. The fullscreen case isn't tested, as headless browsers can't enter fullscreen. Users who want no such risk can turn off suggestions when signing in and fill from the toolbar popup, which no page can cover.
- On Firefox (no IntersectionObserver v2), an overlay with `pointer-events: none` placed in the page's own *closed* shadow root and in the top layer could evade the content script's checks, which rely on hit-testing. Overlays that take clicks, transparency and revealing the menu only as the click lands are caught.
- A page can see that our menu element exists. From that it can tell the extension is installed, and, when the menu opens, whether this site has a saved login or the session is locked. While the user types in a username field, the menu narrows its logins to those starting with the typed text and hides when none do, so the menu's size tells the page whether a saved username starts with what was typed. It reacts only to the user's own keystrokes, never to text the page puts in the field. It never sees usernames, passwords or the code. Other password managers' inline menus have the same property.
- Logins in iframes of other sites are not offered. A frame on another host of the page's site is, which trusts every host of that site as much as the page: a site that frames a host it doesn't control (a user-content subdomain) could have that host offered its logins. Apple's helper already matches logins across a domain's hosts, so a host of the site could reach them as a page of its own anyway.
- Firefox can't tell when the Mac locks (its idle API never reports "locked"), so "Lock when my Mac locks" is Chromium-only. On Firefox the session ends when Firefox quits or you press Lock.

## Touch ID companion

Reading the code automatically needs Accessibility access. That permission lives in the separate companion app, never in the browser. The app:
- requires Touch ID (or the login password) before every read
- reads only windows of Apple's signed helper that the asking browser launched
- returns only the six digits
- accepts XPC connections only from its own signed native host

The full design is in [companion.md](companion.md).

| Risk | Mitigation |
|---|---|
| Another program asks the agent for the code | The XPC connection must come from our signed host (team ID in releases, exact cdhash in development builds), and the user must confirm with Touch ID. |
| A fake window shows a code | Only windows of processes signed by Apple as the helper, and launched by the asking browser, are read. A wrong code would fail the SRP handshake anyway. |
| The companion is used to read other apps | It reads nothing but the helper's windows, and it returns only a 6-digit code, never other text. |
| A tampered update, or an appcast pointing elsewhere | Sparkle installs only disk images signed with our EdDSA key, verifies them before unpacking, and requires the appcast to be signed by the same key. The update is offered, never installed without asking (unless the user turns that on). |
| The update check leaks something | The agent fetches the appcast with no cookies or cache, at most once a day. The request carries the app's version and nothing else, and it can be turned off in the app. |
| A program runs our native host itself, to reach the agent | That passes the XPC check, since it's our signed host. So the agent also requires the host's parent to be running Apple's signed helper, which macOS lets only browsers start, before it reads the code or the contact card. Otherwise any program could read the "Me" card's emails without Contacts permission. |
