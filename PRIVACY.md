# Privacy policy

Better Passwords (the browser extension and the optional Mac companion app) handles the information described below to fill and save logins and suggest email addresses. The developer receives none of this information. It works with the password managers you add to it: Apple Passwords, through Apple’s local password helper (built into macOS, or part of iCloud for Windows), and Bitwarden, through Bitwarden’s servers or your own. Optional Hide My Email connects to Apple’s iCloud.

## What it handles, and where

### Apple Passwords

- **Passwords and usernames.** The extension asks Apple's password helper (built into macOS, or part of iCloud for Windows) for the usernames saved for the site you're on. When you choose a login, it asks for that password and fills it into the page. Usernames, passwords and generated-password suggestions are held temporarily in browser memory, not saved to the extension’s disk storage. When you submit a form using a generated password, the extension asks Apple’s local helper to save the login in Apple Passwords. When you sign in with a password that isn’t a generated one, the extension keeps the username and password in memory until the next page loads (at most one minute), then hands them to Apple’s local helper, which asks you to save or update them unless Apple Passwords already has that password. Apple manages any iCloud Keychain syncing. Filling a login makes it available to the website you choose.
- **The site's address.** The extension sends the current site's hostname to Apple's helper, on your computer, to look up matching logins.
- **Verification codes.** On a page that asks for a two-factor code, the extension asks Apple's local helper which accounts have a verification code for that page's address. The helper answers with the account names only. When you choose one, macOS asks for Touch ID (or your Mac password) before the helper gives the code (on Windows, Apple's helper decides what it asks for), which the extension fills into the page, or copies to your clipboard if you choose Copy in the toolbar popup. Codes are never stored, not even in memory beyond that one fill or copy.
- **The pairing key.** Pairing with your Mac creates a key that stays in the browser's memory until you quit the browser or press Lock. It is never written to disk.

### Bitwarden (only if you add a Bitwarden account)

The extension is a Bitwarden client, like Bitwarden’s own extension. It talks to the server you choose when you sign in: bitwarden.com, bitwarden.eu, or a self-hosted server at the address you type.

- **Signing in.** The extension sends the server your email address and a hash derived from your master password, as Bitwarden’s own apps do, plus a two-step login or new-device code if the server asks for one. Your master password itself is never sent or saved. The server also gets a name and random identifier for this browser, so it can list it among your devices.
- **Your vault.** The server sends back your vault, encrypted. The extension keeps that encrypted copy, your email, the server’s address and the server’s sign-in tokens in the browser’s extension storage on your device, so it can unlock without the network. Nothing in it opens the vault without your master password.
- **Unlocking.** Your master password unlocks the vault on your device. The key it opens is kept in the browser’s memory, never on disk, until you lock, the browser quits, or the account’s lock time passes. Decrypted logins are read from it when needed and never saved.
- **Saving.** When you save a login, the extension encrypts it on your device and sends it to your server: the site’s address, the username and the password, all encrypted.
- **Sites you choose “Never” for** on the save card are kept in the extension’s storage on your device, so it doesn’t ask there again.
- **Removing the account** deletes everything the extension kept for it on this device. Your vault on the server isn’t touched.

### Everything else

- **Settings.** Your settings (for example, whether to show suggestions in login fields) are saved in the browser's extension storage on your device.
- **Hide My Email (only if you turn it on).** The extension asks iCloud, using your icloud.com sign-in in that browser, for your Hide My Email addresses and creates new ones when you ask. It sends iCloud the site's hostname as the new address's label, as Safari does. The extension keeps temporary service information and site-specific alias suggestions in memory. It does not save them to disk. Your iCloud session cookies authenticate these requests to Apple. In Firefox, enabling this feature requests optional data permissions; revoking them prevents further iCloud requests.
- **Your email addresses (companion app only, if you allow Contacts).** The companion app reads the emails on your own contact card and passes them to the extension on your Mac, which shows them in email fields. They're kept in memory for ten minutes and are not saved to disk by the companion. Choosing an address fills it into the website’s form.
- **The pairing code (companion app only).** After you confirm with Touch ID, the companion app reads the 6-digit code from Apple's pairing window and passes it to the extension on your Mac. It isn't stored.

## What it doesn't do

- No analytics, telemetry, crash reporting or ads.
- No servers of ours. The project runs no backend. The extension's only network requests are to the Bitwarden server you sign in to, if you add a Bitwarden account, and to Apple's iCloud, for Hide My Email, only if you turn it on.
- **Update checks (companion app only).** Once a day the companion app fetches the list of releases from betterpasswords.app, and downloads an update from GitHub when you accept one. These requests carry the app's version and macOS version, as any download does, and your IP address; nothing else. You can turn the checks off in the app.
- **Reporting a problem (only when you click it).** "Email the developer" or "report it on GitHub" opens your mail app or GitHub's issue form, pre-filled with the extension, browser and macOS versions. Nothing is sent unless you submit the issue or send the email yourself.
- No sale of data or use for advertising. Information is shared only with Apple’s services, the local helper/companion, the Bitwarden server you sign in to, and the websites you choose, as described above.

## Contact

Questions: open an issue at https://github.com/fanckush/better-passwords-extension, or email fanckush@gmail.com. For security reports, see [SECURITY.md](SECURITY.md).

Last updated: November 2026.
