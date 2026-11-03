// Shared product identity. Browser packages and download routes use the same configuration.

export const DISPLAY_NAME = "Better Passwords";
export const STORE_TITLE = "Better Passwords - for Apple Passwords";

export const REPO_URL = "https://github.com/fanckush/better-passwords-extension";
/** Where problems can be reported without a GitHub account. */
export const SUPPORT_EMAIL = "fanckush@gmail.com";
export const SETUP_COMMAND = `curl -fsSL ${REPO_URL}/raw/main/scripts/setup-mac.sh | sh`;

/** Our own registration of Apple's helper, written by scripts/setup-mac.sh or the companion app. */
export const BRIDGE_HOST = "io.github.fanckush.betterpasswords.bridge";

/** The optional Touch ID companion app's own native host (see apps/companion). */
export const COMPANION_HOST = "io.github.fanckush.betterpasswords.companion";

export const HELPER_PATH =
  "/System/Cryptexes/App/System/Library/CoreServices/PasswordManagerBrowserExtensionHelper.app/Contents/MacOS/PasswordManagerBrowserExtensionHelper";

/**
 * Chrome Web Store public key, keeping unpacked builds on the published extension ID.
 * Store ZIPs omit the key field; the store supplies the identity when signing.
 */
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAp2/Wf1H7oA9Gtl9Ek7ELlADUenHSFBzcfTaH0whjkdyrb1SlmHATUiZrEjSwAc0LuGveH+dcB+adUZYshW8sfNH+/ymV8UI5QbYfeECSg7hcLOe6AKFD+zPr1C0ezHkAfcvPvIxZyZFvUu+wJ2kKVkunObN0ccth2+W0xubpQF3xZ7OcGS8nsjekjFM6rIIQw1X74lKS5tqLwh74THpNmnNsR3RajFUPajT9U8jXPOO3Azf5wvNwrr0qIUGRuzvHawzDWvuB/+RBahE8rFYL45u8nxgTCLdt/EuEdMeUmoGgDmzD87fnFQo0OQxZ3bzz3sc35bnAjdmt+aS2RObMQwIDAQAB";

export const EXTENSION_ID = "ocongmkplhijgajnipnhhggfcjfdilgj";
export const FIREFOX_EXTENSION_ID = "better-passwords@fanckush.github.io";

/** Pages where the inline menu runs and passwords may be filled (see src/url-policy.ts). */
export const FILL_MATCHES = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];

export const SITE_URL = "https://betterpasswords.app";

/**
 * The same optional companion app is used by every extension installation. The site redirects to
 * the newest release (apps/site/worker.js), so where releases live can change without an update.
 */
export const COMPANION_DOWNLOAD_URL = `${SITE_URL}/download/mac`;

/**
 * Opens the companion app, which then connects the browser that opened it. Its scheme is in the
 * app's Info.plist. Without the app, browsers ignore it (see openCompanionLink in src/ui/setup.ts).
 */
export const COMPANION_CONNECT_URL = "betterpasswords://connect";
