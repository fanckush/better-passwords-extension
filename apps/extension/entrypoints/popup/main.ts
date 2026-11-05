import "./style.css";
import { DISPLAY_NAME } from "@/src/config.ts";
import { requestHideMyEmailConsent } from "@/src/icloud/consent.ts";
import { type LoginsResult, type OneTimeCodesResult, type Settings, type Status, send } from "@/src/messages.ts";
import { computerName, platform } from "@/src/platform.ts";
import { applySystemAccent } from "@/src/ui/accent.ts";
import { bindCodeInput } from "@/src/ui/code-input.ts";
import { companionPitch } from "@/src/ui/companion-pitch.ts";
import { h } from "@/src/ui/h.ts";
import { CHECK, icon, OPEN, TIMER } from "@/src/ui/icons.ts";
import { reportProblem } from "@/src/ui/report.ts";
import { setupFlow } from "@/src/ui/setup.ts";

applySystemAccent();

const app = document.getElementById("app") as HTMLElement;
/** "Mac" or "PC": the computer showing Apple's code (set before the first screen). */
let computer = "Mac";
/** What's shown while a verification code is fetched: macOS asks for Touch ID, Windows nothing. */
let fetchingCode = "Confirm with Touch ID…";

function show(...children: (Node | false | null | undefined)[]) {
  app.replaceChildren(...children.filter((c): c is Node => Boolean(c)));
}

function errorLine(message: string | undefined) {
  return message ? h("p", { class: "error", textContent: message }) : null;
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function refresh(error?: string) {
  let status: Status;
  try {
    status = await send({ type: "get-status" });
  } catch (e) {
    return showRetry(messageOf(e));
  }

  // not set up yet, set up moments ago (the popup closes while the user does it), or set up in a
  // browser macOS doesn't let start Apple's helper (the setup flow explains)
  if (status.state === "no-helper" || status.state === "blocked" || status.justConnected) return showSetup(status);

  if (status.state === "unlocked") return showLogins(status, error);
  // locked or disconnected: start unlocking right away, saving the user a click
  const awaitingCode = status.state === "awaiting-code";
  if (status.touchId && !error && !awaitingCode) return unlockWithTouchId(status);
  // a fresh code even if one is still valid: the user may have closed Apple's window since, and
  // nothing tells us
  codeRequest = popupSettled().then(() => send({ type: "request-code", fresh: true }));
  const input = showCodeEntry(status, error ?? (awaitingCode ? status.error : undefined));
  try {
    await codeRequest;
  } catch (e) {
    return showRetry(error ?? messageOf(e));
  }
  // Apple's code window can take the keyboard as it opens (on Windows it opens slowly, and only
  // then does the helper answer), so give it back to the box, unless the user is typing already
  if (input.isConnected && !input.disabled && input.value === "") {
    window.focus();
    input.focus();
  }
}

/** The pending request for a code; a code typed meanwhile is checked once it's done. */
let codeRequest: Promise<unknown> = Promise.resolve();

/**
 * Resolves once the popup has the keyboard and a moment has passed. Asked while the popup is
 * still opening, Apple's code window takes the keyboard from it; asked afterwards, it doesn't.
 * Never waits more than a second.
 */
function popupSettled(): Promise<void> {
  return new Promise((resolve) => {
    const done = setTimeout(resolve, 1_000);
    const settle = () => {
      clearTimeout(done);
      setTimeout(resolve, 300);
    };
    if (document.hasFocus()) settle();
    else window.addEventListener("focus", settle, { once: true });
  });
}

async function unlockWithTouchId(status: Status) {
  show(h("h1", { textContent: "Confirm with Touch ID" }), h("p", {}, "The code your Mac shows is entered for you."));
  try {
    await send({ type: "unlock-with-touch-id" });
    await refresh();
  } catch (e) {
    // the code is on screen either way, so typing it still works
    showCodeEntry(status, messageOf(e));
  }
}

/** Set once this popup has shown the setup flow, so the first unlock after it says "all set". */
let settingUp = false;

async function showSetup(status: Status) {
  settingUp = true;
  show(await setupFlow(status, { next: { label: "Continue", run: () => void refresh() } }));
}

function showRetry(error: string) {
  const retry = h("button", { class: "primary", textContent: "Try again" });
  retry.addEventListener("click", () => void refresh());
  show(
    h("h1", { textContent: DISPLAY_NAME }),
    errorLine(error),
    h("div", { class: "actions" }, retry),
    reportProblem(),
  );
}

/** Shows the box for the code and returns it. */
function showCodeEntry(status: Status, error?: string): HTMLInputElement {
  const input = h("input", {
    class: "code",
    inputMode: "numeric",
    autocomplete: "one-time-code",
    ariaLabel: "Verification code",
    autofocus: true,
  });
  const newCode = h("button", { class: "link", textContent: "Show code again" });

  const submit = async (code: string) => {
    input.disabled = true;
    try {
      await codeRequest.catch(() => {});
      await send({ type: "verify-code", code });
      await refresh();
    } catch (e) {
      // a wrong code burns the challenge, so ask the Mac for a fresh one
      await send({ type: "request-code", fresh: true }).catch(() => {});
      showCodeEntry(status, messageOf(e));
    }
  };

  bindCodeInput(input, (code) => void submit(code));
  newCode.addEventListener("click", async () => {
    await send({ type: "request-code", fresh: true }).catch((e) => showCodeEntry(status, messageOf(e)));
    input.value = "";
    input.focus();
  });

  let touchId: HTMLButtonElement | null = null;
  if (status.touchId) {
    touchId = h("button", { class: "link", textContent: "Enter it for me" });
    touchId.addEventListener("click", () => void unlockWithTouchId(status));
  }
  const companionHint =
    status.companion === "needs-setup"
      ? h("p", { class: "hint" }, "To skip typing the code, finish setting up the companion app.")
      : null;
  const report = reportProblem();

  show(
    h("h1", { textContent: `Enter the code shown on your ${computer}` }),
    h(
      "p",
      {},
      `Your ${computer} is showing a 6-digit verification code. You only need to do this once per browser session.`,
    ),
    input,
    errorLine(error),
    h("div", { class: "actions" }, newCode, touchId),
    companionHint,
    report,
  );
  void companionPitch(() => {
    void send({ type: "open-companion-page" }).catch(() => {});
    window.close();
  }).then((pitch) => {
    if (pitch && input.isConnected) report.before(pitch);
  });
  // Apple's code window can take focus as it appears; take it back when the popup regains it
  const refocus = () => {
    if (input.isConnected && !input.disabled) input.focus();
    else window.removeEventListener("focus", refocus);
  };
  window.addEventListener("focus", refocus);
  requestAnimationFrame(refocus);
  return input;
}

async function showLogins(status: Status, error?: string) {
  const tabId = await activeTabId();
  let result: LoginsResult = { logins: [] };
  try {
    if (tabId !== undefined) result = await send({ type: "list-logins", tabId });
  } catch (e) {
    error ??= messageOf(e);
  }

  let body: Node;
  if (!result.hostname) {
    body = h("p", {}, "Open a website to see its saved passwords.");
  } else if (result.logins.length === 0) {
    body = h("p", {}, `No saved passwords for ${result.hostname}.`);
  } else {
    body = loginList(tabId as number, result.logins, result.chosen);
  }

  const openApp = h("button", { class: "link with-icon" }, icon(OPEN), "Open Passwords App");
  openApp.addEventListener("click", async () => {
    await send({ type: "open-passwords-app", ...(tabId === undefined ? {} : { tabId }) }).catch(() => {});
    window.close();
  });

  const allSet = settingUp
    ? h(
        "p",
        { class: "card padded all-set" },
        icon(CHECK),
        "You're all set. Click a login field on any website to fill a password.",
      )
    : null;
  settingUp = false;

  show(
    h("h1", { textContent: result.hostname ?? DISPLAY_NAME }),
    allSet,
    extensionUpdate(status.extensionUpdate),
    tabId === undefined || !result.hostname ? null : await oneTimeCodes(tabId),
    body,
    await unconfirmedPasswords(tabId),
    errorLine(error),
    h("div", { class: "actions" }, openApp),
    await footer(status),
    reportProblem(),
  );
  app.querySelector<HTMLInputElement>(".search")?.focus();
}

/** A downloaded version waits for the session to end; installing it now ends it. */
function extensionUpdate(version: string | undefined) {
  if (!version) return null;
  const install = h("button", { class: "primary", textContent: "Update" });
  install.addEventListener("click", () => {
    // the extension restarts before it can answer
    void send({ type: "install-update" }).catch(() => {});
    window.close();
  });
  return h(
    "section",
    { class: "card padded" },
    h("div", { class: "actions" }, h("span", { textContent: `Version ${version} is ready` }), install),
    h("p", { class: "hint" }, "Updating locks Better Passwords, so you'll enter the code again."),
  );
}

/** Logins shown before "Show more", so the settings below stay in view. */
const COLLAPSED = 3;
/** Past this many logins, a search field filters them. */
const SEARCH_AFTER = 10;

/** `chosen`: the login picked on the sign-in's previous step (listed first), shown alone at first. */
function loginList(tabId: number, logins: LoginsResult["logins"], chosen?: string) {
  const items = logins.map(({ username }) => {
    const name = username || "(no username)";
    const button = h(
      "button",
      { class: "login", title: `Fill ${username}` },
      h("span", { class: "avatar", textContent: (username[0] ?? "?").toUpperCase() }),
      h("span", { class: "name", textContent: name }),
    );
    button.addEventListener("click", () => void fill(tabId, username));
    return { name: name.toLowerCase(), username, li: h("li", {}, button) };
  });

  const collapsed = chosen === undefined ? COLLAPSED : 1;
  // hiding a single login behind a button the same size as it saves nothing, unless it's to single
  // out the chosen one
  let expanded = chosen === undefined ? items.length <= COLLAPSED + 1 : items.length <= 1;
  const others = items.length - collapsed;
  const more = h("button", {
    class: "login more",
    textContent:
      chosen === undefined ? `Show ${others} more` : others === 1 ? "1 other account" : `${others} other accounts`,
  });
  const moreItem = h("li", {}, more);
  const noMatches = h("li", { class: "hint no-matches", textContent: "No matching accounts." });
  const search =
    items.length > SEARCH_AFTER
      ? h("input", { class: "search", type: "search", placeholder: `Search ${items.length} accounts` })
      : null;
  search?.setAttribute("aria-label", "Search accounts");

  let matches = items;
  const update = () => {
    const query = search?.value.trim().toLowerCase() ?? "";
    matches = items.filter((item) => item.name.includes(query));
    const shown = new Set(query || expanded ? matches : matches.slice(0, collapsed));
    for (const item of items) item.li.hidden = !shown.has(item);
    moreItem.hidden = Boolean(query) || expanded;
    noMatches.hidden = matches.length > 0;
  };
  more.addEventListener("click", () => {
    expanded = true;
    update();
    items[collapsed]?.li.querySelector("button")?.focus();
  });
  search?.addEventListener("input", update);
  search?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && matches[0]) void fill(tabId, matches[0].username);
  });
  update();

  return h(
    "div",
    { class: "card" },
    search,
    h("ul", { class: "logins" }, ...items.map((item) => item.li), moreItem, noMatches),
  );
}

/** How long a code fetched for Copy waits for a second click, when the first one couldn't copy it. */
const COPY_WAIT_MS = 30_000;

/**
 * The site's verification codes. Their digits only come after Touch ID: clicking a code fills
 * the page's code field, Copy puts it on the clipboard.
 */
async function oneTimeCodes(tabId: number) {
  let result: OneTimeCodesResult;
  try {
    result = await send({ type: "list-one-time-codes", tabId });
  } catch {
    return null;
  }
  if (result.codes.length === 0) return null;
  const note = h("p", { class: "hint", hidden: true });
  const say = (text: string, isError = false) => {
    note.textContent = text;
    note.className = isError ? "hint error" : "hint";
    note.hidden = !text;
  };
  const items = result.codes.map((code) => {
    const account = code.username ? `${code.username} · ${code.domain}` : code.domain;
    const fillButton = h(
      "button",
      { class: "login", title: "Fill this code into the page" },
      h("span", { class: "avatar" }, icon(TIMER)),
      h(
        "span",
        { class: "name" },
        h("span", { textContent: "Verification Code" }),
        h("span", { class: "detail", textContent: account }),
      ),
    );
    fillButton.addEventListener("click", async () => {
      say(fetchingCode);
      try {
        const { result: filled } = await send({ type: "fill-one-time-code", tabId, id: code.id });
        if (filled === "filled") return window.close();
        say(
          filled === "no-fields"
            ? "No verification code field on this page. Copy the code instead."
            : "The page changed, try again.",
          true,
        );
      } catch (e) {
        if ((e as { code?: string }).code === "superseded") return;
        say(messageOf(e), true);
      }
    });

    const copy = h("button", { class: "secondary", textContent: "Copy" });
    // fetched, but the browser wouldn't let us copy it any more (Touch ID took a while)
    let waiting: { digits: string; timer: ReturnType<typeof setTimeout> } | undefined;
    const forget = () => {
      if (waiting) clearTimeout(waiting.timer);
      waiting = undefined;
    };
    const write = async (digits: string) => {
      await navigator.clipboard.writeText(digits);
      forget();
      copy.textContent = "Copied";
      say("");
    };
    copy.addEventListener("click", async () => {
      if (waiting) return write(waiting.digits).catch((e) => say(messageOf(e), true));
      copy.disabled = true;
      say(fetchingCode);
      try {
        const { code: digits } = await send({ type: "copy-one-time-code", tabId, id: code.id });
        await write(digits).catch(() => {
          waiting = {
            digits,
            timer: setTimeout(() => {
              forget();
              copy.textContent = "Copy";
            }, COPY_WAIT_MS),
          };
          copy.textContent = "Click to Copy";
          say("");
        });
      } catch (e) {
        if ((e as { code?: string }).code !== "superseded") say(messageOf(e), true);
      } finally {
        copy.disabled = false;
      }
    });
    return h("li", { class: "code-item" }, fillButton, copy);
  });
  return h(
    "section",
    { class: "recent codes" },
    h("h2", { textContent: "Verification Codes" }),
    h("ul", { class: "card" }, ...items),
    note,
  );
}

/**
 * Generated passwords that replaced a saved one on this site. Apple's helper can't confirm the
 * update, so if the user didn't click Update Password, this is where the new password still is.
 */
async function unconfirmedPasswords(tabId: number | undefined) {
  if (tabId === undefined) return null;
  const entries = await send({ type: "unconfirmed-passwords", tabId }).catch(() => []);
  if (entries.length === 0) return null;
  return h(
    "section",
    { class: "recent" },
    h("h2", { textContent: "Recent passwords" }),
    h(
      "ul",
      { class: "card" },
      ...entries.map(({ username, password }) => {
        const copy = h("button", { class: "secondary", textContent: "Copy" });
        copy.addEventListener("click", async () => {
          await navigator.clipboard.writeText(password);
          copy.textContent = "Copied";
        });
        return h("li", { class: "actions" }, h("span", { textContent: username || "(no username)" }), copy);
      }),
    ),
    h("p", { class: "hint" }, "New passwords from this session, in case one wasn't saved."),
  );
}

async function fill(tabId: number, username: string) {
  try {
    const { result } = await send({ type: "fill", tabId, username });
    if (result === "filled") return window.close();
    await refresh(result === "no-fields" ? "No login fields found on this page." : "The page changed, try again.");
  } catch (e) {
    // chosen again (say, after dismissing Touch ID): that newer choice carries on
    if ((e as { code?: string }).code === "superseded") return;
    await refresh(messageOf(e));
  }
}

type Option = (key: keyof Settings, label: string, detail?: string, disabled?: boolean) => HTMLElement;

async function footer(status: Status) {
  const settings: Settings = await send({ type: "get-settings" });
  const option: Option = (key, label, detail, disabled = false) => {
    const toggle = h("input", { type: "checkbox", checked: !disabled && settings[key], disabled });
    toggle.addEventListener("change", async () => {
      try {
        if (key === "hideMyEmail" && toggle.checked && !(await requestHideMyEmailConsent())) {
          toggle.checked = false;
          return;
        }
        await send({ type: "set-settings", settings: { [key]: toggle.checked } });
      } catch (error) {
        toggle.checked = settings[key];
        await refresh(messageOf(error));
      }
    });
    return h(
      "label",
      { class: "toggle" },
      toggle,
      h("span", { class: "text" }, label, detail ? h("span", { class: "detail", textContent: detail }) : null),
    );
  };
  const lock = h("button", { class: "secondary", textContent: "Lock" });
  lock.addEventListener("click", async () => {
    await send({ type: "lock" });
    window.close();
  });
  return h(
    "div",
    { class: "settings" },
    h("h2", { textContent: "Suggestions" }),
    option("inlineMenu", "When signing in", "saved passwords"),
    option("oneTimeCodes", "Verification codes", "when a site asks for one"),
    option("generatePasswords", "When signing up", "strong passwords and emails"),
    option("hideMyEmail", "Hide My Email", "iCloud+ addresses, labeled with the site's name"),
    // the companion app is Mac only; elsewhere there's nothing to offer
    ...(status.companion === "unavailable" ? [] : [h("hr"), macAppSection(status, option)]),
    h("hr"),
    // Firefox's idle API never reports "locked", so the option would do nothing there
    h(
      "div",
      { class: "actions" },
      import.meta.env.FIREFOX ? h("span") : option("lockOnScreenLock", `Lock when my ${computer} locks`),
      lock,
    ),
  );
}

/**
 * What the companion app adds. Without it (or before its setup is done) the options are shown, greyed
 * out, next to one button that gets it, so they're discoverable but never a switch that does nothing.
 */
function macAppSection(status: Status, option: Option) {
  const ready = status.companion === "ready";
  const openApp = (label: string) => {
    const button = h("button", { class: "link", textContent: label });
    button.addEventListener("click", () => void openCompanion("open-companion-app"));
    return button;
  };
  const options = h(
    "div",
    { class: "options" },
    option("touchId", "Enter the 6-digit code for me", "after Touch ID", !ready),
    option("suggestEmails", "Suggest my emails", "from your contact card", !ready),
  );
  if (ready) {
    // an app that updates itself offers the update once opened; an older one is downloaded again
    const update = status.companionUpdate;
    let action = openApp("Open Companion App…");
    if (update?.how === "app") action = openApp(`Update to ${update.version}…`);
    if (update?.how === "download") {
      action = h("button", { class: "link", textContent: "Update Available…" });
      action.addEventListener("click", () => void openCompanion("open-companion-page"));
    }
    return h(
      "section",
      { class: "mac-app" },
      h("div", { class: "actions" }, h("h2", { textContent: "Companion app" }), action),
      options,
    );
  }
  const installed = status.companion === "needs-setup";
  const cta = h(
    "button",
    { class: "cta" },
    h("img", { src: "/icon/32.png", alt: "" }),
    installed ? "Finish Setting Up" : "Get Companion App",
  );
  cta.addEventListener("click", () => void openCompanion(installed ? "open-companion-app" : "open-companion-page"));
  return h(
    "section",
    { class: "mac-app unavailable" },
    h("h2", { textContent: "Companion app" }),
    h("div", { class: "offer" }, options, cta),
  );
}

async function openCompanion(type: "open-companion-app" | "open-companion-page") {
  await send({ type }).catch(() => {});
  window.close();
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text || "Something went wrong. Try again, or reload the extension.";
}

void platform()
  .then((os) => {
    computer = computerName(os);
    if (os === "windows") fetchingCode = "Getting the code…";
  })
  .finally(() => void refresh());
