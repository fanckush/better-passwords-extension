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
 * Apple's sign-in frame on another Apple site (App Store Connect): the one cross-origin frame that's
 * filled. Everything else from another origin needs origin rules of its own.
 */
export function isAppleSignInFrame(frameUrl: string | undefined, pageUrl: string | undefined): boolean {
  const frame = fillableUrl(frameUrl);
  const page = fillableUrl(pageUrl);
  return (
    frame?.protocol === "https:" &&
    frame.hostname === "idmsa.apple.com" &&
    page?.protocol === "https:" &&
    page.hostname.endsWith(".apple.com")
  );
}

/**
 * This frame's origin if it may be filled, otherwise undefined: the page itself, an iframe of the
 * page's origin with only that origin around it, or Apple's sign-in frame right inside the page
 * (the frame can't see the page's address: the background checks it, see isAppleSignInFrame).
 * Another site around a frame could cover it from where the frame can't see. Also injected by
 * scripting.executeScript, so it must not reference anything outside its own body.
 */
export function frameOriginToFill(view: Window = window): string | undefined {
  try {
    for (let frame = view; frame !== frame.parent; frame = frame.parent) {
      // reading another origin's location throws
      if (frame.parent.location.origin !== view.location.origin) return undefined;
    }
    return view.location.origin;
  } catch {
    return view.location.hostname === "idmsa.apple.com" && view.parent === view.top ? view.location.origin : undefined;
  }
}
