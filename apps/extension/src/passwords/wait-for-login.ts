// Apple's helper saves a login in the background once the user clicks Save in macOS's prompt,
// and never reports back. The only way to know is to look the login up until it appears.

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Resolves with the saved login's username once the site's logins show the save, or undefined on
 * timeout or abort. Lookup errors are retried. `before` is the list from before the save: without
 * a username, macOS asks the user for one in its Save dialog, so the new login is the one that
 * wasn't there before.
 */
export async function waitForLogin(
  lookup: () => Promise<string[]>,
  username: string,
  before: string[],
  { timeoutMs = 120_000, intervalMs = 1_000, signal }: WaitOptions = {},
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const stop = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve();
      };
      const timer = setTimeout(stop, intervalMs);
      signal?.addEventListener("abort", stop, { once: true });
    });
    if (signal?.aborted) return undefined;
    const usernames = await lookup().catch(() => undefined);
    if (!usernames) continue;
    if (usernames.includes(username)) return username;
    if (username === "" && usernames.length > before.length) {
      return usernames.find((name) => !before.includes(name)) ?? "";
    }
  }
  return undefined;
}
