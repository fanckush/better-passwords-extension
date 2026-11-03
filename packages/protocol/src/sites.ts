/**
 * Whether a login the helper says is for `site` may answer a request made for `hostname`.
 *
 * Password replies carry no request id, so a late answer to a replaced read can arrive for a newer
 * one in the same tab. Apple's helper matches logins by domain, so `www.` or another subdomain of
 * the saved site is fine; an unrelated domain is not. Siblings sharing only a parent
 * (`alice.github.io` and `mallory.github.io`) don't match, so shared hosting stays apart without a
 * public suffix list.
 */
export function isSameSite(site: string, hostname: string): boolean {
  const a = normalize(site);
  const b = normalize(hostname);
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Lowercase hostname without a trailing dot; accepts a bare host or a full URL. */
function normalize(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  }
  return host.replace(/\.$/, "");
}
