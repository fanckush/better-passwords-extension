// Which pages may receive credentials. Fills target only the page the user is on, matched by origin.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Returns the URL if passwords may be listed and filled on it, otherwise undefined. */
export function fillableUrl(rawUrl: string | undefined): URL | undefined {
  if (!rawUrl) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:") return url;
  // plain http only for local development servers
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return url;
  return undefined;
}

/** Whether both URLs may be filled and share one origin. */
export function sameFillableOrigin(a: string | undefined, b: string | undefined): boolean {
  const origin = fillableUrl(a)?.origin;
  return origin !== undefined && origin === fillableUrl(b)?.origin;
}

/**
 * This frame's origin if it may be filled, otherwise undefined: the page itself, an iframe of the
 * page's origin with only that origin around it, or an HTTPS iframe of another origin right inside
 * the page. The last can't read the page's address: where the browser shows the page's origin, a
 * frame on another domain is left out here; either way the background allows it only on the page's
 * own site (see isSameSiteFrame). Another site around a frame could cover it from where the frame
 * can't see. Also injected by scripting.executeScript, so it must not reference anything outside
 * its own body.
 */
export function frameOriginToFill(view: Window = window): string | undefined {
  try {
    for (let frame = view; frame !== frame.parent; frame = frame.parent) {
      // reading another origin's location throws
      if (frame.parent.location.origin !== view.location.origin) return undefined;
    }
    return view.location.origin;
  } catch {
    const { protocol, hostname, origin } = view.location;
    if (protocol !== "https:" || view.parent !== view.top) return undefined;
    // not in Firefox; the background decides there
    const page = view.location.ancestorOrigins?.item(0);
    if (page) {
      // a site shares at least its last two labels: anything else is another site for sure
      const lastTwo = (host: string) => host.split(".").slice(-2).join(".");
      if (!page.startsWith("https://") || lastTwo(new URL(page).hostname) !== lastTwo(hostname)) return undefined;
    }
    return origin;
  }
}
