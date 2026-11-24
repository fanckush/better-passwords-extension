// Sign-in frames on another host of the page's site. Kept apart from url-policy.ts: the public
// suffix list is large, and content scripts, which run in every frame, don't need it.

import { getDomain } from "tldts";
import { fillableUrl } from "./url-policy.ts";

/**
 * Whether `frameUrl` is a sign-in frame of the page's own site on another of its hosts, such as
 * Schwab's sign-in on sws-gateway-nr.schwab.com inside www.schwab.com, or Apple's on idmsa.apple.com
 * inside appstoreconnect.apple.com: both HTTPS with the same registrable domain, by the public suffix
 * list with its private part, so two github.io sites stay apart. The frame can't see the page's
 * address, so this is checked here, in the background; the frame checks it sits right inside the
 * page (frameOriginToFill in url-policy.ts).
 */
export function isSameSiteFrame(frameUrl: string | undefined, pageUrl: string | undefined): boolean {
  const frame = fillableUrl(frameUrl);
  const page = fillableUrl(pageUrl);
  if (frame?.protocol !== "https:" || page?.protocol !== "https:" || frame.origin === page.origin) return false;
  const site = getDomain(frame.hostname, { allowPrivateDomains: true });
  return site !== null && site === getDomain(page.hostname, { allowPrivateDomains: true });
}
