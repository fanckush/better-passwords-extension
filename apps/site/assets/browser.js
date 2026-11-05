// Browser logos and setup buttons for the visitor's browser.
// Markup hooks:
//   <a data-add>      primary button. Gets the store link, `Get for <Browser>`, and the logo.
//   <a data-other>    secondary store link for the other browser.
//   [data-browser]    replaced with the browser's name, for headlines.
//   [data-note]       replaced with a line for Safari or non-Mac visitors; left alone otherwise.
// Preview another browser with ?browser=firefox|chrome|edge|brave|arc|safari|windows.

(() => {
  // Store listings (README.md links the same pages).
  // Every Chromium browser (Edge, Brave, Arc…) installs from the Chrome Web Store.
  const STORE = {
    chrome: "https://chromewebstore.google.com/detail/better-passwords/ocongmkplhijgajnipnhhggfcjfdilgj",
    firefox: "https://addons.mozilla.org/firefox/addon/better-passwords/",
  };

  const SPRITE = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <radialGradient id="ff-glow" cx="70%" cy="20%" r="95%">
      <stop offset="0" stop-color="#fff44f"/><stop offset=".35" stop-color="#ff980e"/>
      <stop offset=".7" stop-color="#ff3750"/><stop offset="1" stop-color="#c50080"/>
    </radialGradient>
    <linearGradient id="ff-globe" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7542e5"/><stop offset="1" stop-color="#3a1c9c"/>
    </linearGradient>
  </defs>
  <symbol id="logo-chrome" viewBox="0 0 48 48">
    <path fill="#ea4335" d="M24 24 4.95 13A22 22 0 0 1 43.05 13Z"/>
    <path fill="#fbbc04" d="M24 24 43.05 13A22 22 0 0 1 24 46Z"/>
    <path fill="#34a853" d="M24 24 24 46A22 22 0 0 1 4.95 13Z"/>
    <circle cx="24" cy="24" r="10.4" fill="#fff"/>
    <circle cx="24" cy="24" r="8.2" fill="#1a73e8"/>
  </symbol>
  <symbol id="logo-firefox" viewBox="0 0 48 48">
    <circle cx="24" cy="24" r="22" fill="url(#ff-glow)"/>
    <circle cx="25.5" cy="25.5" r="12.5" fill="url(#ff-globe)"/>
    <path fill="#ff7a1a" d="M5.5 17c1.4 13 11.8 22.6 23.6 21.3 7-.8 11.9-5.1 13.6-10.5-3.4 5-10.2 7.5-16.4 4.7-5.4-2.4-7.2-8.4-4.6-12.6-5.3 2-12.3.6-16.2-2.9Z"/>
    <path fill="#ffbd4f" d="M17.5 9.5c3.5-1.2 8-1 11.2.7-4.6-.2-8.3 1.6-10 4.6-1-1.6-1.4-3.4-1.2-5.3Z"/>
  </symbol>
  <symbol id="logo-browser" viewBox="0 0 48 48">
    <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="3.5"/>
    <path d="M3 24h42M24 3c6 6 8.5 13 8.5 21S30 39 24 45M24 3c-6 6-8.5 13-8.5 21S18 39 24 45" fill="none" stroke="currentColor" stroke-width="3"/>
  </symbol>
  <symbol id="logo-safari" viewBox="0 0 48 48">
    <circle cx="24" cy="24" r="22" fill="#1d8cf8"/>
    <circle cx="24" cy="24" r="18" fill="#fff"/>
    <path d="m24 24 9-11-11 9Z" fill="#ff3b30"/><path d="m24 24-9 11 11-9Z" fill="#8e8e93"/>
  </symbol>
</svg>`;
  document.body.insertAdjacentHTML("afterbegin", SPRITE);

  const query = new URLSearchParams(location.search).get("browser");
  const ua = navigator.userAgent;
  const brands = (navigator.userAgentData?.brands ?? []).map((b) => b.brand);
  const isArc = () => !!getComputedStyle(document.documentElement).getPropertyValue("--arc-palette-title");

  function detect() {
    if (query) return { id: query, name: null };
    if (/Firefox\//.test(ua)) return { id: "firefox" };
    if (/Edg\//.test(ua)) return { id: "edge" };
    if (navigator.brave) return { id: "brave" };
    if (isArc()) return { id: "arc" };
    if (brands.includes("Google Chrome")) return { id: "chrome" };
    if (/Chrome\//.test(ua)) {
      // Other Chromium browsers (Vivaldi, Helium, Opera…) often name themselves in their brands.
      const own = brands.find((b) => !/Chromium|Not.?A.?Brand|Google Chrome/i.test(b));
      return { id: "chromium", name: own ?? null };
    }
    if (/Safari\//.test(ua)) return { id: "safari" };
    return { id: "chrome" };
  }

  const NAMES = {
    chrome: "Chrome",
    firefox: "Firefox",
    edge: "Edge",
    brave: "Brave",
    arc: "Arc",
    chromium: "Chrome",
    safari: "Chrome",
    windows: "Chrome",
  };
  const found = detect();
  const id = found.id in NAMES ? found.id : "chrome";
  const name = found.name ?? NAMES[id];
  const firefox = id === "firefox";
  const mac = query ? query !== "windows" : /Mac/.test(navigator.platform) || /Mac OS X/.test(ua);
  const windows = query ? query === "windows" : /Win/.test(navigator.platform) || /Windows NT/.test(ua);
  const logo = firefox
    ? "logo-firefox"
    : id === "chrome" || id === "safari" || id === "windows"
      ? "logo-chrome"
      : "logo-browser";

  const setIcon = (el, symbol) => {
    const svg = el.querySelector("svg[data-logo]");
    if (svg) svg.innerHTML = `<use href="#${symbol}"></use>`;
  };

  document.querySelectorAll("a[data-add]").forEach((a) => {
    a.href = firefox ? STORE.firefox : STORE.chrome;
    const label = a.querySelector("[data-label]");
    if (label) label.textContent = `Get for ${name}`;
    setIcon(a, logo);
  });
  document.querySelectorAll("a[data-other]").forEach((a) => {
    a.href = firefox ? STORE.chrome : STORE.firefox;
    const label = a.querySelector("[data-label]");
    if (label) label.textContent = firefox ? "Also for Chrome" : "Also for Firefox";
    setIcon(a, firefox ? "logo-chrome" : "logo-firefox");
  });

  const note =
    id === "safari"
      ? "You're in Safari, which already fills from Apple Passwords. This brings the same to Chrome and Firefox."
      : windows
        ? "On Windows, it needs iCloud for Windows with Passwords turned on. Works in Chrome, Edge, Brave and Firefox."
        : !mac
          ? "Better Passwords is for Mac and Windows. Open this page on your computer to install it."
          : null;
  document.querySelectorAll("[data-browser]").forEach((el) => {
    el.textContent = name;
  });
  if (note)
    document.querySelectorAll("[data-note]").forEach((el) => {
      el.textContent = note;
    });
})();
