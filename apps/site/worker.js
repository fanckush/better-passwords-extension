// Routes that aren't files. Requests for files in this folder never reach it (see wrangler.jsonc).
//   /download/mac              the newest companion app disk image, wherever its release lives
//   /companion/appcast.xml     that release's Sparkle appcast, which the app checks for updates

const REPO = "fanckush/better-passwords-extension";
const RELEASES = `https://github.com/${REPO}/releases`;
/** GitHub is asked at most this often per route. */
const CACHE_SECONDS = 600;
/** A release gets its files a moment after its tag, so the routes fall back to the releases before it. */
const TRIES = 3;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/download/mac") return cached(url, ctx, downloadMac);
    if (url.pathname === "/companion/appcast.xml") return cached(url, ctx, appcast);
    return env.ASSETS.fetch(request);
  },
};

async function cached(url, ctx, respond) {
  const key = new Request(url.origin + url.pathname);
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const response = await respond();
  if (response.headers.has("Cache-Control")) ctx.waitUntil(caches.default.put(key, response.clone()));
  return response;
}

async function downloadMac() {
  // GitHub redirects a release file that exists to its storage, and answers 404 otherwise
  const dmg = await newest((version) => `better-passwords-${version}-mac.dmg`, { method: "HEAD", redirect: "manual" });
  // no release yet, or GitHub is unreachable: the release list is the next best place
  if (!dmg) return Response.redirect(RELEASES, 302);
  return new Response(null, {
    status: 302,
    headers: { Location: dmg.url, "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
  });
}

// Served rather than redirected, so the address the app knows never changes. Sparkle checks the
// appcast's signature, so this copy needs no more trust than GitHub's.
async function appcast() {
  const file = await newest(() => "appcast.xml");
  if (!file) return new Response("No appcast yet.", { status: 404 });
  return new Response(file.response.body, {
    headers: { "Content-Type": "application/xml", "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
  });
}

/** The newest companion release that has this file: the file's address, and GitHub's answer for it. */
async function newest(name, init) {
  for (const version of (await companionVersions()).slice(0, TRIES)) {
    const url = `${RELEASES}/download/companion-v${version}/${name(version)}`;
    const response = await fetch(url, init).catch(() => undefined);
    if (response?.ok || response?.status === 302) return { url, response };
  }
  return undefined;
}

// The companion's versions, newest first, from its companion-v* tags. GitHub's releases/latest is the
// extension's, and its REST API is no use here: Workers share Cloudflare's addresses, so the API's limit
// for callers without a token (60 an hour per address) is always used up. The tag list git itself
// reads has no such limit.
async function companionVersions() {
  const res = await fetch(`https://github.com/${REPO}.git/info/refs?service=git-upload-pack`, {
    headers: { "User-Agent": "betterpasswords.app" },
  }).catch(() => undefined);
  if (!res?.ok) return [];
  const tags = (await res.text()).matchAll(/refs\/tags\/companion-v(\d+)\.(\d+)\.(\d+)$/gm);
  return [...tags]
    .map((tag) => tag.slice(1, 4).map(Number))
    .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])
    .map((version) => version.join("."));
}
