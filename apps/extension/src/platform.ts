// Where Apple Passwords comes from on this computer: built into macOS, or the iCloud for Windows app.
// Everything else works the same on both; setup, the companion app and some wording differ.

export type Platform = "mac" | "windows" | "other";

let detected: Promise<Platform> | undefined;

/**
 * The platform this browser runs on. Asked once. Firefox's inline menu frame has no
 * `runtime.getPlatformInfo`, so there the user agent's platform answers instead;
 * one that says neither Windows nor anything else counts as a Mac.
 */
export function platform(): Promise<Platform> {
  detected ??= (async () => (await browser.runtime.getPlatformInfo()).os)()
    .then((os): Platform => (os === "mac" ? "mac" : os === "win" ? "windows" : "other"))
    .catch((): Platform => (/^win/i.test(globalThis.navigator?.platform ?? "") ? "windows" : "mac"));
  return detected;
}

/** What the user calls the computer that shows Apple's pairing code. */
export function computerName(platform: Platform): string {
  return platform === "windows" ? "PC" : "Mac";
}
