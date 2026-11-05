// Where Apple Passwords comes from on this computer: built into macOS, or the iCloud for Windows app.
// Everything else works the same on both; setup, the companion app and some wording differ.

export type Platform = "mac" | "windows" | "other";

let detected: Promise<Platform> | undefined;

/** The platform this browser runs on. Asked once; a browser that won't say counts as a Mac. */
export function platform(): Promise<Platform> {
  detected ??= browser.runtime
    .getPlatformInfo()
    .then(({ os }): Platform => (os === "mac" ? "mac" : os === "win" ? "windows" : "other"))
    .catch((): Platform => "mac");
  return detected;
}

/** What the user calls the computer that shows Apple's pairing code. */
export function computerName(platform: Platform): string {
  return platform === "windows" ? "PC" : "Mac";
}
