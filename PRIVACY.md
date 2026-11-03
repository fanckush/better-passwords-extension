# Privacy policy

Better Passwords (the browser extension and the optional Mac companion app) handles the information described below to fill and save logins and suggest email addresses. The developer receives none of this information. Password operations use Apple’s local macOS helper; optional Hide My Email connects to Apple’s iCloud.

## What it handles, and where

- **Passwords and usernames.** The extension asks the password helper built into macOS for the usernames saved for the site you're on. When you choose a login, it asks for that password and fills it into the page. Usernames, passwords and generated-password suggestions are held temporarily in browser memory, not saved to the extension’s disk storage. When you submit a form using a generated password, the extension asks Apple’s local helper to save the login in Apple Passwords. When you sign in with a password that isn’t a generated one, the extension keeps the username and password in memory until the next page loads (at most one minute), then hands them to Apple’s local helper, which asks you to save or update them unless Apple Passwords already has that password. Apple manages any iCloud Keychain syncing. Filling a login makes it available to the website you choose.
- **The site's address.** The extension sends the current site's hostname to Apple's helper, on your Mac, to look up matching logins.
- **Verification codes.** On a page that asks for a two-factor code, the extension asks Apple's local helper which accounts have a verification code for that page's address. The helper answers with the account names only. When you choose one, macOS asks for Touch ID (or your Mac password) before the helper gives the code, which the extension fills into the page, or copies to your clipboard if you choose Copy in the toolbar popup. Codes are never stored, not even in memory beyond that one fill or copy.
- **The pairing key.** Pairing with your Mac creates a key that stays in the browser's memory until you quit the browser or press Lock. It is never written to disk.
- **Settings.** Your settings (for example, whether to show suggestions in login fields) are saved in the browser's extension storage on your device.
- **Hide My Email (only if you turn it on).** The extension asks iCloud, using your icloud.com sign-in in that browser, for your Hide My Email addresses and creates new ones when you ask. It sends iCloud the site's hostname as the new address's label, as Safari does. The extension keeps temporary service information and site-specific alias suggestions in memory. It does not save them to disk. Your iCloud session cookies authenticate these requests to Apple. In Firefox, enabling this feature requests optional data permissions; revoking them prevents further iCloud requests.
- **Your email addresses (companion app only, if you allow Contacts).** The companion app reads the emails on your own contact card and passes them to the extension on your Mac, which shows them in email fields. They're kept in memory for ten minutes and are not saved to disk by the companion. Choosing an address fills it into the website’s form.
- **The pairing code (companion app only).** After you confirm with Touch ID, the companion app reads the 6-digit code from Apple's pairing window and passes it to the extension on your Mac. It isn't stored.

## What it doesn't do

- No analytics, telemetry, crash reporting or ads.
- No servers. The project runs no backend. The extension's only network requests are to Apple's iCloud, for Hide My Email, and only if you turn it on.
- **Update checks (companion app only).** Once a day the companion app fetches the list of releases from betterpasswords.app, and downloads an update from GitHub when you accept one. These requests carry the app's version and macOS version, as any download does, and your IP address; nothing else. You can turn the checks off in the app.
- **Reporting a problem (only when you click it).** "Email the developer" or "report it on GitHub" opens your mail app or GitHub's issue form, pre-filled with the extension, browser and macOS versions. Nothing is sent unless you submit the issue or send the email yourself.
- No sale of data or use for advertising. Information is shared only with Apple’s services, the local helper/companion, and the websites you choose, as described above.

## Contact

Questions: open an issue at https://github.com/fanckush/better-passwords-extension, or email fanckush@gmail.com. For security reports, see [SECURITY.md](SECURITY.md).

Last updated: October 2026.
