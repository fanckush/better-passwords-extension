// The first thing a new user sees: a welcome, the one step that connects this browser to Apple's
// helper, and a confirmation that it worked. Shown in the popup and on the setup page (setup.html),
// which opens on install and from the inline menu.

import "./setup.css";
import {
  COMPANION_CONNECT_URL,
  COMPANION_DOWNLOAD_URL,
  ICLOUD_FOR_WINDOWS_URL,
  REPO_URL,
  SETUP_COMMAND,
  WINDOWS_SETUP_COMMAND,
} from "../config.ts";
import { type Status, send } from "../messages.ts";
import { computerName, type Platform, platform } from "../platform.ts";
import { h } from "./h.ts";
import { CHECK, icon } from "./icons.ts";
import { browserName, reportProblem } from "./report.ts";

/** How the user chose to connect. Remembered because the popup closes while they do it. */
type Route = "app" | "terminal";
const ROUTE_KEY = "setupRoute";
/** How often to look for the connection while the welcome is on screen. */
const POLL_MS = 1_500;
/** Where this flow runs, as found by setupFlow: setup differs between a Mac and Windows. */
let os: Platform = "mac";

export interface SetupAction {
  label: string;
  run: (button: HTMLButtonElement) => void;
}

export interface SetupOptions {
  /** Once connected: what moves the user on to unlocking. */
  next: SetupAction;
  /** Once unlocked, where the flow can still be on screen (the setup page). */
  finish?: SetupAction;
}

/**
 * Renders the step the user is at: the welcome while this browser can't reach the helper, then
 * "connected", then (on the setup page) "all set". It moves on by itself as setup completes. When
 * the helper can't be reached although setup is done, it says why instead of "connected".
 */
export async function setupFlow(status: Status, options: SetupOptions): Promise<HTMLElement> {
  const root = h("div", { class: "setup" });
  os = await platform();
  if (os === "other") {
    root.append(
      h("img", { class: "app-icon", src: "/icon/128.png", alt: "" }),
      h("h1", { textContent: "Better Passwords needs a Mac or a PC" }),
      h("p", {
        class: "lead",
        textContent:
          "It fills passwords from Apple Passwords, on macOS 14 or later, or on Windows with iCloud for Windows.",
      }),
    );
    return root;
  }
  await showStep(root, status, options);
  return root;
}

type Step = "welcome" | "blocked" | "unreachable" | "connected" | "done";

function stepOf(status: Status): Step {
  if (status.state === "no-helper") return "welcome";
  if (status.state === "blocked") return "blocked";
  if (status.state === "disconnected" && status.error) return "unreachable";
  return status.state === "unlocked" ? "done" : "connected";
}

async function showStep(root: HTMLElement, status: Status, options: SetupOptions) {
  switch (stepOf(status)) {
    case "welcome":
      return showWelcome(root, status, options);
    case "blocked":
      return showBlocked(root, status, options);
    case "unreachable":
      return showUnreachable(root, status, options);
    case "done":
      return showDone(root, options);
    case "connected":
      return showConnected(root, options);
  }
}

function connected(status: Status | undefined): boolean {
  return status?.state === "locked" || status?.state === "awaiting-code" || status?.state === "unlocked";
}

/** Calls `check` every few seconds until it returns true, or `root` leaves the page. */
function poll(root: HTMLElement, check: () => Promise<boolean>) {
  let shown = false;
  let busy = false;
  const timer = setInterval(async () => {
    if (!root.isConnected) {
      // not on the page yet is fine; gone again means another screen replaced it
      if (shown) clearInterval(timer);
      return;
    }
    shown = true;
    if (busy) return;
    busy = true;
    try {
      if (await check()) clearInterval(timer);
    } finally {
      busy = false;
    }
  }, POLL_MS);
}

function showWelcome(root: HTMLElement, status: Status, options: SetupOptions) {
  // The route last acted on, so a reopened popup is still waiting; one route is shown at a time,
  // so nobody thinks they need both
  let acted = savedRoute();
  let view: Route = acted ?? "app";
  const route = h("div", { class: "route" });
  const waiting = h(
    "p",
    { class: "waiting", attrs: { role: "status" } },
    h("span", { class: "spinner", attrs: { "aria-hidden": "true" } }),
    "Waiting for the connection…",
  );

  function act(chosen: Route) {
    acted = chosen;
    try {
      localStorage.setItem(ROUTE_KEY, chosen);
    } catch {
      // storage can be unavailable; the popup then just forgets the choice when it closes
    }
    waiting.hidden = false;
  }

  function switchTo(next: Route) {
    view = next;
    // Windows has no companion app: its one route is the PowerShell command
    if (os === "windows") route.replaceChildren(...windowsRoute(act));
    else route.replaceChildren(...(view === "app" ? appRoute(act, switchTo) : terminalRoute(act, switchTo)));
  }
  switchTo(view);
  waiting.hidden = acted === undefined;

  // "forbidden": a registration with our name exists but leaves this extension out
  const repair = /forbidden/i.test(status.error ?? "");
  show(
    root,
    h("img", { class: "app-icon", src: "/icon/128.png", alt: "" }),
    h("h1", { textContent: repair ? "Let's reconnect" : "Welcome to Better Passwords" }),
    h("p", {
      class: "lead",
      textContent: repair
        ? "This browser's link to Apple Passwords needs repairing. Connect it once more."
        : `First, connect this browser to Apple Passwords on your ${computerName(os)}.`,
    }),
    route,
    waiting,
    repair ? details(status.error) : null,
    // setup is where people get stuck, so the way to say so is right there
    reportProblem(),
  );

  poll(root, async () => {
    const latest = await send({ type: "get-status" }).catch(() => undefined);
    if (!latest || (!connected(latest) && latest.state !== "blocked")) return false;
    await showStep(root, latest, options);
    return true;
  });
}

/**
 * Set up, but macOS kills Apple's helper as this browser starts it: only browsers Apple allows may
 * (the helper's launch constraints). Nothing on our side can change that, so say so plainly.
 */
async function showBlocked(root: HTMLElement, status: Status, options: SetupOptions) {
  if (os === "windows") return showHelperMissing(root, status, options);
  // Forks often present themselves as Chrome (Ardia does), and Chrome itself is one Apple allows, so
  // a blocked "Google Chrome" or "Chromium" is some other browser
  const name = await browserName();
  const who = name && !/^(google chrome|chromium)$/i.test(name) ? name : "this browser";
  show(
    root,
    h("img", { class: "app-icon", src: "/icon/128.png", alt: "" }),
    h("h1", { textContent: `${capitalized(who)} can't use Apple Passwords yet` }),
    h("p", {
      class: "lead",
      textContent: `macOS only lets Apple's password helper run in browsers Apple has approved, and ${who} isn't one yet.`,
    }),
    h(
      "p",
      { class: "note" },
      `Apple's own iCloud Passwords extension can't work here either. Once Apple approves ${who}, Better Passwords starts working the next time you open it.`,
    ),
    retryRoute(root, status, options, `${capitalized(who)} is still blocked by macOS.`),
    details(status.error),
    reportProblem(),
  );
}

/**
 * Windows doesn't block browsers. Set up, but the helper quits as it starts: iCloud for Windows was
 * removed, or its helper alias was turned off.
 */
function showHelperMissing(root: HTMLElement, status: Status, options: SetupOptions) {
  show(
    root,
    h("img", { class: "app-icon", src: "/icon/128.png", alt: "" }),
    h("h1", { textContent: "Apple's password helper didn't start" }),
    h("p", {
      class: "lead",
      textContent: "It comes with iCloud for Windows. Check that it's installed and signed in.",
    }),
    h("p", { class: "note" }, "Need it? ", storeLink("Get iCloud for Windows")),
    retryRoute(root, status, options, "It still didn't start. Restarting the browser usually helps."),
    details(status.error),
    reportProblem(),
  );
}

/** Set up, but the helper didn't answer for some other reason (it usually does next time). */
function showUnreachable(root: HTMLElement, status: Status, options: SetupOptions) {
  show(
    root,
    h("img", { class: "app-icon", src: "/icon/128.png", alt: "" }),
    h("h1", { textContent: "Couldn't reach Apple Passwords" }),
    h("p", { class: "lead", textContent: `Apple's password helper on your ${computerName(os)} didn't answer.` }),
    retryRoute(root, status, options, "Still no answer. Restarting the browser usually helps."),
    details(status.error),
    reportProblem(),
  );
}

/**
 * "Try Again", which tries the helper once more. Whatever it finds that's different (connected,
 * blocked, or no answer) gets its own screen; the same again says `same` under the button.
 */
function retryRoute(root: HTMLElement, status: Status, options: SetupOptions, same: string) {
  const button = h("button", { class: "button primary", type: "button", textContent: "Try Again" });
  const outcome = h("p", { class: "note", attrs: { role: "status" } });
  outcome.hidden = true;
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Trying…";
    const latest = await send({ type: "retry-connection" }).catch(() => undefined);
    if (latest && stepOf(latest) !== stepOf(status)) return showStep(root, latest, options);
    button.disabled = false;
    button.textContent = "Try Again";
    outcome.textContent = same;
    outcome.hidden = false;
  });
  return h("div", { class: "route" }, button, outcome);
}

/** The raw error, for a bug report; kept out of the way. */
function details(error: string | undefined) {
  return error ? h("details", { class: "details" }, h("summary", { textContent: "Details" }), error) : null;
}

function capitalized(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Opens the companion app through its link. Chromium browsers ignore a link no app handles;
 * Firefox would show an error page in its place, so there it opens in a hidden frame.
 */
function openCompanionLink(event: Event) {
  if (!import.meta.env.FIREFOX) return;
  event.preventDefault();
  const frame = h("iframe", { src: COMPANION_CONNECT_URL, hidden: true });
  document.body.append(frame);
  setTimeout(() => frame.remove(), 5_000);
}

function appRoute(act: (route: Route) => void, switchTo: (route: Route) => void): Node[] {
  const download = h("a", {
    class: "button primary",
    href: COMPANION_DOWNLOAD_URL,
    target: "_blank",
    rel: "noopener",
    textContent: "Download the Mac App",
  });
  download.addEventListener("click", () => act("app"));
  // someone adding another browser may have the app already; it connects the browser that opens it
  const open = h("a", { href: COMPANION_CONNECT_URL, textContent: "Open Better Passwords" });
  open.addEventListener("click", (event) => {
    openCompanionLink(event);
    act("app");
  });
  const other = h("button", { class: "link", type: "button", textContent: "Rather not install an app?" });
  other.addEventListener("click", () => switchTo("terminal"));
  return [
    download,
    h("p", { class: "note", textContent: "Free. Open it and click Connect." }),
    h("p", { class: "note" }, "Already have it? ", open),
    other,
  ];
}

function terminalRoute(act: (route: Route) => void, switchTo: (route: Route) => void): Node[] {
  const copy = h("button", { class: "button primary", type: "button", textContent: "Copy Terminal Command" });
  // shown only if copying fails, to select by hand
  const command = h("code", { class: "command", textContent: SETUP_COMMAND });
  command.hidden = true;
  copy.addEventListener("click", async () => {
    act("terminal");
    try {
      await navigator.clipboard.writeText(SETUP_COMMAND);
      copy.textContent = "Copied";
    } catch {
      command.hidden = false;
      getSelection()?.selectAllChildren(command);
    }
  });
  const other = h("button", { class: "link", type: "button", textContent: "Use the Mac app instead" });
  other.addEventListener("click", () => switchTo("app"));
  return [
    copy,
    command,
    h("p", { class: "note", textContent: "Then paste it into Terminal and press Return." }),
    h(
      "p",
      { class: "links" },
      other,
      h("a", {
        href: `${REPO_URL}/blob/main/scripts/setup-mac.sh`,
        target: "_blank",
        rel: "noopener",
        textContent: "Read the script",
      }),
    ),
  ];
}

/** The setup on Windows: iCloud for Windows, then one PowerShell command. */
function windowsRoute(act: (route: Route) => void): Node[] {
  const copy = h("button", { class: "button primary", type: "button", textContent: "Copy PowerShell Command" });
  // shown only if copying fails, to select by hand
  const command = h("code", { class: "command", textContent: WINDOWS_SETUP_COMMAND });
  command.hidden = true;
  copy.addEventListener("click", async () => {
    act("terminal");
    try {
      await navigator.clipboard.writeText(WINDOWS_SETUP_COMMAND);
      copy.textContent = "Copied";
    } catch {
      command.hidden = false;
      getSelection()?.selectAllChildren(command);
    }
  });
  return [
    h("p", { class: "note" }, "You need ", storeLink("iCloud for Windows"), ", signed in with Passwords turned on."),
    copy,
    command,
    h("p", { class: "note", textContent: "Then paste it into PowerShell and press Enter." }),
    h(
      "p",
      { class: "links" },
      h("a", {
        href: `${REPO_URL}/blob/main/scripts/setup-windows.ps1`,
        target: "_blank",
        rel: "noopener",
        textContent: "Read the script",
      }),
    ),
  ];
}

function storeLink(text: string) {
  return h("a", { href: ICLOUD_FOR_WINDOWS_URL, target: "_blank", rel: "noopener", textContent: text });
}

function showConnected(root: HTMLElement, options: SetupOptions) {
  void send({ type: "setup-seen" }).catch(() => {});
  forgetRoute();
  const next = h("button", { class: "button primary", type: "button", textContent: options.next.label });
  next.addEventListener("click", () => options.next.run(next));
  show(
    root,
    h("div", { class: "badge" }, icon(CHECK)),
    h("h1", { textContent: "You're connected" }),
    h("p", { class: "lead", textContent: `Next, unlock with the code your ${computerName(os)} shows.` }),
    h(
      "div",
      { class: "route" },
      next,
      h("p", { class: "note", textContent: "You do this once each time you open your browser." }),
    ),
  );

  if (!options.finish) return;
  poll(root, async () => {
    const latest = await send({ type: "get-status" }).catch(() => undefined);
    if (latest?.state !== "unlocked") return false;
    showDone(root, options);
    return true;
  });
}

function showDone(root: HTMLElement, options: SetupOptions) {
  forgetRoute();
  let finish: HTMLButtonElement | null = null;
  if (options.finish) {
    const action = options.finish;
    finish = h("button", { class: "button primary", type: "button", textContent: action.label });
    finish.addEventListener("click", () => action.run(finish as HTMLButtonElement));
  }
  show(
    root,
    h("div", { class: "badge" }, icon(CHECK)),
    h("h1", { textContent: "You're all set" }),
    h("p", {
      class: "lead",
      textContent: "Click a login field on any website to fill a password from Apple Passwords.",
    }),
    finish,
  );
}

function show(root: HTMLElement, ...children: (Node | false | null)[]) {
  root.replaceChildren(...children.filter((child): child is Node => Boolean(child)));
}

function savedRoute(): Route | undefined {
  try {
    const route = localStorage.getItem(ROUTE_KEY);
    return route === "app" || route === "terminal" ? route : undefined;
  } catch {
    return undefined;
  }
}

function forgetRoute() {
  try {
    localStorage.removeItem(ROUTE_KEY);
  } catch {
    // nothing remembered then
  }
}
