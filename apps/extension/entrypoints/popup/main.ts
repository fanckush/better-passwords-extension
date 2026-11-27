import "./style.css";
import type { AccountView } from "@/src/accounts/types.ts";
import { HME_CONSENT_PORT, requestHideMyEmailConsent } from "@/src/aliases/icloud/consent.ts";
import { DISPLAY_NAME } from "@/src/config.ts";
import {
  type LoginsResult,
  type MenuMessage,
  type OneTimeCodesResult,
  POPUP_PORT,
  type Settings,
  type Status,
  send,
} from "@/src/messages.ts";
import { computerName, platform } from "@/src/platform.ts";
import { applySystemAccent } from "@/src/ui/accent.ts";
import { bindCodeInput } from "@/src/ui/code-input.ts";
import { h } from "@/src/ui/h.ts";
import { CHECK, CHEVRON_BACK, CHEVRON_DOWN, CHEVRON_FORWARD, icon, OPEN, TIMER } from "@/src/ui/icons.ts";
import { providerBadge, providerPicker, providerTile } from "@/src/ui/providers.ts";
import { reportProblem } from "@/src/ui/report.ts";
import { appleSetupStarted, setupFlow } from "@/src/ui/setup.ts";
import { animateSteps } from "@/src/ui/steps.ts";

applySystemAccent();

const app = document.getElementById("app") as HTMLElement;
animateSteps(app);
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

/** The account the inline menu asked to unlock (it opened this popup, or this window, for it). */
let unlockTarget = new URLSearchParams(location.search).get("unlock") ?? undefined;
/** Opened as a small window to unlock (where the popup can't open): it closes once unlocked. */
const unlockWindow = unlockTarget !== undefined;

/** Accounts that can be used here: set up (or signed in), and not refused by the system. */
function usable(account: AccountView): boolean {
  return account.state !== "needs-setup" && account.state !== "unavailable";
}

/** Signed out by Bitwarden (its password changed, say): signing in again, on the setup page. */
function signedOut(account: AccountView): boolean {
  return account.unlock.kind === "password" && account.state === "needs-setup";
}

/** Counts renders: one overtaken by a newer one (a lock while it loaded) draws nothing. */
let turn = 0;
/** The accounts unlocked as the screen shows them. */
let shownUnlocked = "";
const unlockedIds = (accounts: AccountView[]) =>
  accounts
    .filter((a) => a.state === "unlocked")
    .map((a) => a.id)
    .join();

async function refresh(error?: string) {
  const mine = ++turn;
  let status: Status;
  try {
    status = await send({ type: "get-status" });
  } catch (e) {
    return showRetry(messageOf(e));
  }
  if (mine !== turn) return;
  const { accounts } = status;
  shownUnlocked = unlockedIds(accounts);
  // opened by the inline menu (or as a window) for one account: its unlock, open
  const target = accounts.find((a) => a.id === unlockTarget);
  unlockTarget = undefined;
  if (target && target.state !== "unlocked" && usable(target)) {
    expanded = target.id;
    if (unlockWindow) return showUnlockWindow(status, target, error);
  } else if (unlockWindow) {
    return window.close();
  }

  const ready = accounts.filter(usable);
  // nothing set up yet, set up moments ago (the popup closes while the user does it), or set up in
  // a browser macOS doesn't let start Apple's helper (the setup flow explains)
  if (status.justConnected || (ready.length === 0 && !accounts.some(signedOut))) return showSetup(status);
  await showHome(status, mine, error);
}

// --- unlocking -----------------------------------------------------------------------------------
// One layout whatever is locked: the site's logins (of the accounts unlocked), then a card with a
// row per account still locked, then settings. A row opens in place to unlock (Apple's code box,
// Bitwarden's master password); with one account locked and nothing else, it's open already.

/**
 * The account whose unlock is open, if any. Remembered for a few minutes: the popup closes when the
 * user goes to look the master password up, and should be where they left it when they're back.
 */
let expanded: string | undefined;
const EXPANDED_KEY = "popupUnlock";
const REMEMBER_MS = 5 * 60_000;

async function rememberedUnlock(): Promise<string | undefined> {
  const stored = await browser.storage.session.get(EXPANDED_KEY).catch(() => ({}) as Record<string, unknown>);
  const saved = stored[EXPANDED_KEY] as { account: string; at: number } | undefined;
  return saved && Date.now() - saved.at < REMEMBER_MS ? saved.account : undefined;
}

function rememberUnlock(account: string | undefined) {
  const change = account
    ? browser.storage.session.set({ [EXPANDED_KEY]: { account, at: Date.now() } })
    : browser.storage.session.remove(EXPANDED_KEY);
  void change.catch(() => {});
}

/** Opens an account's unlock (from its row, or Accounts' Unlock button), and shows it. */
async function openUnlock(account: string | undefined) {
  expanded = account;
  rememberUnlock(account);
  await refresh();
  if (account) app.querySelector(".unlock-area")?.scrollIntoView({ block: "nearest" });
}

/** Unlocked: nothing stays open, and the popup shows what's there now. */
async function unlocked() {
  expanded = undefined;
  rememberUnlock(undefined);
  if (unlockWindow) return window.close();
  await refresh();
}

/** A row per account still locked (or signed out), the open one with its way to unlock. */
function unlockArea(status: Status, locked: AccountView[]): HTMLElement | null {
  if (locked.length === 0) return null;
  // one row alone has nothing to switch to: it's simply open
  const several = locked.length > 1;
  const card = h("div", { class: "card unlock-area" });
  for (const account of locked) {
    const open = account.id === expanded;
    const label = signedOut(account) ? `Sign In to ${account.label}` : `Unlock ${account.label}`;
    const text = h(
      "span",
      { class: "unlock-text" },
      h("span", { class: "unlock-name", textContent: label }),
      account.detail ? h("span", { class: "unlock-detail", textContent: account.detail }) : null,
    );
    const toggles = several || !open;
    const head = toggles
      ? h(
          "button",
          { class: "unlock-row", type: "button", ariaExpanded: String(open) },
          providerTile(account.provider),
          text,
          chevron(open ? CHEVRON_DOWN : CHEVRON_FORWARD),
        )
      : h("div", { class: "unlock-row" }, providerTile(account.provider), text);
    head.addEventListener("click", () => {
      if (!toggles) return;
      if (signedOut(account)) return void openSetup(`bitwarden=${account.id}`);
      void openUnlock(open ? undefined : account.id);
    });
    card.append(head);
    if (open && !signedOut(account)) {
      const body = h("div", { class: "unlock-body" });
      card.append(body);
      if (account.unlock.kind === "password") passwordUnlock(account, body);
      else void codeUnlock(status, account, body);
    }
  }
  return card;
}

function chevron(path: string) {
  const svg = icon(path);
  svg.classList.add("chevron");
  return svg;
}

/** The small window Firefox opens to unlock (it can't open the popup by itself): just that. */
function showUnlockWindow(status: Status, account: AccountView, error?: string) {
  show(h("h1", { textContent: DISPLAY_NAME }), errorLine(error), unlockArea(status, [account]), reportProblem());
  focusUnlock();
}

function focusUnlock() {
  requestAnimationFrame(() => app.querySelector<HTMLInputElement>(".unlock-body input")?.focus());
}

function passwordUnlock(account: AccountView, body: HTMLElement, error?: string) {
  const input = h("input", {
    class: "password",
    type: "password",
    autocomplete: "current-password",
    ariaLabel: "Master password",
    placeholder: "Master password",
    required: true,
  });
  const submit = h("button", { class: "primary", type: "submit", textContent: "Unlock" });
  const form = h("form", { class: "unlock" }, input, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    input.disabled = submit.disabled = true;
    submit.textContent = "Unlocking…";
    try {
      await send({ type: "unlock-with-password", account: account.id, password: input.value });
      await unlocked();
    } catch (e) {
      passwordUnlock(account, body, messageOf(e));
      body.querySelector("input")?.focus();
    }
  });
  const problem = errorLine(error);
  body.replaceChildren(form, ...(problem ? [problem] : []));
}

/** Touch ID is tried once per popup: after it's dismissed, the code box. */
let touchIdTried = false;

async function codeUnlock(status: Status, account: AccountView, body: HTMLElement) {
  // locked or disconnected: start unlocking right away, saving the user a click
  const awaitingCode = account.state === "unlocking";
  if (touchIdFor(status) && !awaitingCode && !touchIdTried) {
    touchIdTried = true;
    return touchIdUnlock(status, body);
  }
  // a fresh code even if one is still valid: the user may have closed Apple's window since, and
  // nothing tells us
  codeRequest = popupSettled().then(() => send({ type: "request-code", fresh: true }));
  const input = codeEntry(status, body, awaitingCode ? account.error : undefined);
  try {
    await codeRequest;
  } catch (e) {
    if (body.isConnected) codeEntry(status, body, messageOf(e));
    return;
  }
  // Apple's code window can take the keyboard as it opens (on Windows it opens slowly, and only
  // then does the helper answer), so give it back to the box, unless the user is typing already
  if (input.isConnected && !input.disabled && input.value === "") {
    window.focus();
    input.focus();
  }
}

async function touchIdUnlock(status: Status, body: HTMLElement) {
  body.replaceChildren(
    h("p", { class: "hint", textContent: "Confirm with Touch ID. The code your Mac shows is entered for you." }),
  );
  try {
    await send({ type: "unlock-with-touch-id" });
    await unlocked();
  } catch (e) {
    // the code is on screen either way, so typing it still works
    codeEntry(status, body, messageOf(e));
  }
}

async function openSetup(route: string) {
  await browser.tabs.create({ url: browser.runtime.getURL(`/setup.html#${route}`) });
  window.close();
}

/** The account that unlocks with a code shown on the computer (Apple Passwords), if any. */
function codeAccount(status: Status): AccountView | undefined {
  return status.accounts.find((a) => a.unlock.kind === "pairing-code");
}

/** Whether the companion app can enter the code-unlocked account's code after Touch ID. */
function touchIdFor(status: Status): boolean {
  const account = codeAccount(status);
  return account?.unlock.kind === "pairing-code" && account.unlock.touchId === true;
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

/** Set once this popup has shown the setup flow, so the first unlock after it says "all set". */
let settingUp = false;

/** `choose`: the picker, even with Apple's setup under way (the user went back to it). */
async function showSetup(status: Status, choose = false) {
  settingUp = true;
  const apple = status.accounts.find((a) => a.provider === "apple");
  // Apple's setup under way (or done moments ago, or blocked here): its flow says where it's at
  const appleUnderWay =
    status.justConnected || appleSetupStarted() || (apple !== undefined && apple.state !== "needs-setup");
  if (appleUnderWay && !choose) return showAppleSetup(status);
  const picker = h(
    "div",
    { class: "setup" },
    h("img", { class: "app-icon", src: "/icon/128.png", alt: "" }),
    h("h1", { textContent: `Welcome to ${DISPLAY_NAME}` }),
    h("p", { class: "lead", textContent: "Which password manager do you use?" }),
    providerPicker({
      // signing in to Bitwarden happens in a tab: the popup closes while the user fetches a code
      choose: (id) => (id === "apple" ? void showAppleSetup(status, true) : void openSetup("bitwarden")),
    }),
    reportProblem(),
  );
  show(picker);

  // Apple connected meanwhile (the Terminal command, say), or found blocked: its flow says so
  const timer = setInterval(async () => {
    const latest = await send({ type: "get-status" }).catch(() => undefined);
    if (!picker.isConnected) return clearInterval(timer);
    const apple = latest?.accounts.find((a) => a.provider === "apple");
    if (latest && apple && apple.state !== "needs-setup") {
      clearInterval(timer);
      void showAppleSetup(latest);
    }
  }, 1_500);
}

/** Apple's setup flow, with a way back to the picker when the user came from it. */
async function showAppleSetup(status: Status, fromPicker = false) {
  // removed earlier from this browser: added back, to be set up
  if (!status.accounts.some((a) => a.provider === "apple")) {
    status = await send({ type: "add-account", provider: "apple" });
  }
  const flow = await setupFlow(status, { next: { label: "Continue", run: () => void refresh() } });
  if (!fromPicker) return show(flow);
  const back = h("button", { class: "back", type: "button" }, icon(CHEVRON_BACK), "Back");
  back.addEventListener("click", () => {
    void showSetup(status, true);
  });
  show(back, flow);
}

function showRetry(error: string) {
  const retry = h("button", { class: "primary", textContent: "Try Again" });
  retry.addEventListener("click", () => void refresh());
  show(
    h("h1", { textContent: DISPLAY_NAME }),
    errorLine(error),
    h("div", { class: "actions" }, retry),
    reportProblem(),
  );
}

/** The box for Apple's code, in its row's body; returns it. */
function codeEntry(status: Status, body: HTMLElement, error?: string): HTMLInputElement {
  const input = h("input", {
    class: "code",
    inputMode: "numeric",
    autocomplete: "one-time-code",
    ariaLabel: "Verification code",
  });
  const newCode = h("button", { class: "link", type: "button", textContent: "Show Code Again" });

  const submit = async (code: string) => {
    input.disabled = true;
    try {
      await codeRequest.catch(() => {});
      await send({ type: "verify-code", code });
      await unlocked();
    } catch (e) {
      // a wrong code burns the challenge, so ask the Mac for a fresh one
      await send({ type: "request-code", fresh: true }).catch(() => {});
      codeEntry(status, body, messageOf(e)).focus();
    }
  };

  bindCodeInput(input, (code) => void submit(code));
  newCode.addEventListener("click", async () => {
    await send({ type: "request-code", fresh: true }).catch((e) => codeEntry(status, body, messageOf(e)));
    input.value = "";
    input.focus();
  });

  let touchId: HTMLButtonElement | null = null;
  if (touchIdFor(status)) {
    touchId = h("button", { class: "link", type: "button", textContent: "Enter It for Me" });
    touchId.addEventListener("click", () => void touchIdUnlock(status, body));
  }
  const companionHint =
    status.companion === "needs-setup"
      ? h("p", { class: "hint" }, "To skip typing the code, finish setting up the companion app.")
      : null;

  const parts: (Node | null)[] = [
    h("p", {
      class: "hint",
      textContent: `Enter the code shown on your ${computer}. You do this once per browser session.`,
    }),
    input,
    errorLine(error),
    h("div", { class: "actions" }, newCode, touchId ?? h("span")),
    companionHint,
  ];
  // (the companion app's own section, right below, offers it: no second pitch here)
  body.replaceChildren(...parts.filter((n): n is Node => n !== null));
  // Apple's code window can take focus as it appears; take it back when the popup regains it
  const refocus = () => {
    if (input.isConnected && !input.disabled) input.focus();
    else window.removeEventListener("focus", refocus);
  };
  window.addEventListener("focus", refocus);
  requestAnimationFrame(refocus);
  return input;
}

async function showHome(status: Status, mine: number, error?: string) {
  const tabId = await activeTabId();
  const ready = status.accounts.filter(usable);
  const locked = [...ready.filter((a) => a.state !== "unlocked"), ...status.accounts.filter(signedOut)];
  const anyUnlocked = ready.some((a) => a.state === "unlocked");
  expanded ??= await rememberedUnlock();
  if (expanded !== undefined && !locked.some((a) => a.id === expanded)) {
    expanded = undefined;
    rememberUnlock(undefined);
  }
  // one account to unlock and nothing else (Apple Passwords, for most): open already, saving a click
  const [only] = locked;
  if (expanded === undefined && !anyUnlocked && locked.length === 1 && only && !signedOut(only)) expanded = only.id;

  let result: LoginsResult = { logins: [] };
  try {
    if (tabId !== undefined && anyUnlocked) result = await send({ type: "list-logins", tabId });
  } catch (e) {
    error ??= messageOf(e);
  }

  if (mine !== turn) return;

  // logins from more than one account: each icon carries its account's badge
  const from = new Set(result.logins.map((l) => l.account));
  const sources = from.size > 1 ? new Map(ready.map((a) => [a.id, a])) : undefined;
  let body: Node | null = null;
  if (!anyUnlocked) {
    // the unlock card says it all
  } else if (!result.hostname) {
    body = h("p", {}, "Open a website to see its saved passwords.");
  } else if (result.logins.length === 0) {
    // with others locked, which were looked in
    const searched = ready.filter((a) => a.state === "unlocked");
    const where = locked.length > 0 && searched.length === 1 ? ` in ${searched[0]?.label}` : "";
    body = h("p", {}, `No saved passwords for ${result.hostname}${where}.`);
  } else {
    body = loginList(tabId as number, result.logins, result.chosen, sources);
  }

  const justSetUp = settingUp;
  const allSet = justSetUp
    ? h(
        "p",
        { class: "card padded all-set" },
        icon(CHECK),
        "You're all set. Click a login field on any website to fill a password.",
      )
    : null;

  const hostname = result.hostname ?? (tabId === undefined ? undefined : await siteOf(tabId));
  const codes = tabId === undefined || !result.hostname ? null : await oneTimeCodes(tabId);
  const unconfirmed = await unconfirmedPasswords(tabId);
  const settings = await footer(status, tabId);
  if (mine !== turn) return;
  if (justSetUp) settingUp = false;
  show(
    h("h1", { textContent: hostname ?? DISPLAY_NAME }),
    allSet,
    extensionUpdate(status.extensionUpdate),
    codes,
    body,
    unconfirmed,
    errorLine(error),
    // built last: an open unlock asks for a code as it's made
    unlockArea(status, locked),
    settings,
    reportProblem(),
  );
  // the box to type in: the search, or the unlock that's open
  if (expanded !== undefined) focusUnlock();
  else app.querySelector<HTMLInputElement>(".search")?.focus();
}

/** The tab's site, for the heading while nothing is unlocked to list its logins. */
async function siteOf(tabId: number): Promise<string | undefined> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  try {
    const url = new URL(tab?.url ?? "");
    return url.protocol === "https:" ? url.hostname : undefined;
  } catch {
    return undefined;
  }
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
function loginList(tabId: number, logins: LoginsResult["logins"], chosen?: string, sources?: Map<string, AccountView>) {
  const items = logins.map(({ ref, username, account }) => {
    const name = username || "(no username)";
    const source = sources?.get(account);
    const button = h(
      "button",
      { class: "login", title: source ? `Fill ${username} from ${source.label}` : `Fill ${username}` },
      h(
        "span",
        { class: "avatar" },
        (username[0] ?? "?").toUpperCase(),
        source ? providerBadge(source.provider, source.label) : null,
      ),
      h("span", { class: "name", textContent: name }),
    );
    button.addEventListener("click", () => void fill(tabId, ref));
    return { name: name.toLowerCase(), ref, li: h("li", {}, button) };
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
    if (event.key === "Enter" && matches[0]) void fill(tabId, matches[0].ref);
  });
  update();

  return h(
    "div",
    { class: "card" },
    search,
    h("ul", { class: "logins" }, ...items.map((item) => item.li), moreItem, noMatches),
  );
}

/** How long a code fetched for Copy stays for another click, which copies it without Touch ID. */
const COPY_WAIT_MS = 30_000;

/** How long Copy waits for the popup to get focus back after Touch ID before asking for a click. */
const FOCUS_WAIT_MS = 3_000;

/** Whether the popup gets focus back within `ms`. */
function focusReturns(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (focused: boolean) => {
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      resolve(focused);
    };
    const onFocus = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    window.addEventListener("focus", onFocus);
  });
}

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
    // fetched digits, kept briefly so another click copies them without Touch ID again: after a
    // copy, or when the browser wouldn't let us copy them any more (Touch ID took a while)
    let held: { digits: string; timer: ReturnType<typeof setTimeout> } | undefined;
    const hold = (digits: string) => {
      if (held) clearTimeout(held.timer);
      held = {
        digits,
        timer: setTimeout(() => {
          held = undefined;
          copy.textContent = "Copy";
        }, COPY_WAIT_MS),
      };
    };
    const write = async (digits: string) => {
      await navigator.clipboard.writeText(digits);
      copy.textContent = "Copied";
      say("");
    };
    // copying again changes nothing on screen otherwise (Touch ID marks the first copy)
    const pulse = () => {
      copy.classList.remove("copied");
      void copy.offsetWidth;
      copy.classList.add("copied");
    };
    copy.addEventListener("click", async () => {
      if (held) {
        return write(held.digits)
          .then(pulse)
          .catch((e) => say(messageOf(e), true));
      }
      copy.disabled = true;
      say(fetchingCode);
      try {
        const { code: digits } = await send({ type: "copy-one-time-code", tabId, id: code.id });
        hold(digits);
        // the code can come back just before the browser hands focus back from Touch ID, and the
        // clipboard is off limits until it does
        await write(digits)
          .catch(async () => {
            if (document.hasFocus() || !(await focusReturns(FOCUS_WAIT_MS))) throw new Error("not focused");
            await write(digits);
          })
          .catch(() => {
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
 * Generated passwords Apple Passwords may not have yet: an update it can't confirm, or a save the
 * user declined. Save asks macOS again; the password itself never reaches the popup.
 */
async function unconfirmedPasswords(tabId: number | undefined) {
  if (tabId === undefined) return null;
  const entries = await send({ type: "unconfirmed-passwords", tabId }).catch(() => []);
  if (entries.length === 0) return null;
  const note = h("p", { class: "hint" }, "New passwords from this session, in case one wasn't saved.");
  return h(
    "section",
    { class: "recent" },
    h("h2", { textContent: "Recent passwords" }),
    h(
      "ul",
      { class: "card" },
      ...entries.map(({ id, username }) => {
        const save = h("button", { class: "secondary", textContent: "Save" });
        save.addEventListener("click", async () => {
          save.disabled = true;
          try {
            await send({ type: "save-unconfirmed-password", tabId, id });
            note.className = "hint";
            note.textContent = "If Passwords already has it, macOS won't ask.";
          } catch (e) {
            note.className = "hint error";
            note.textContent = messageOf(e);
          } finally {
            save.disabled = false;
          }
        });
        return h("li", { class: "actions" }, h("span", { textContent: username || "(no username)" }), save);
      }),
    ),
    note,
  );
}

async function fill(tabId: number, ref: string) {
  try {
    const { result } = await send({ type: "fill", tabId, ref });
    if (result === "filled") return window.close();
    await refresh(result === "no-fields" ? "No login fields found on this page." : "The page changed, try again.");
  } catch (e) {
    // chosen again (say, after dismissing Touch ID): that newer choice carries on
    if ((e as { code?: string }).code === "superseded") return;
    await refresh(messageOf(e));
  }
}

/** The options that are on/off switches. */
type Toggle = Exclude<keyof Settings, "saveNewLoginsTo">;
type AccountToggle = "lockOnScreenLock" | "touchId";

type Option<K extends string> = (key: K, label: string, detail?: string, disabled?: boolean) => HTMLElement;

/** A switch for a boolean setting, saved with `save` as it's flipped (false: the user backed out). */
function toggleFor<K extends string>(
  values: Record<K, boolean>,
  save: (key: K, on: boolean) => Promise<unknown>,
): Option<K> {
  return (key, label, detail, disabled = false) => {
    const toggle = h("input", { type: "checkbox", checked: !disabled && values[key], disabled });
    toggle.addEventListener("change", async () => {
      try {
        if ((await save(key, toggle.checked)) === false) toggle.checked = values[key];
      } catch (error) {
        toggle.checked = values[key];
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
}

/** `tabId`: the tab the popup is for, so an account's app opens at its site. */
async function footer(status: Status, tabId?: number) {
  const settings: Settings = await send({ type: "get-settings" });
  const option = toggleFor<Toggle>(settings, async (key, on) => {
    if (key === "hideMyEmail" && on && !(await requestHideMyEmailConsent())) return false;
    await send({ type: "set-settings", settings: { [key]: on } });
    return true;
  });
  const accountOption = (account: AccountView) =>
    toggleFor<AccountToggle>(account.settings, (key, on) =>
      send({ type: "set-account-settings", account: account.id, settings: { [key]: on } }),
    );
  const apple = codeAccount(status);
  const several = listedAccounts(status).length > 1;
  const lock = h("button", { class: "secondary", textContent: several ? "Lock All" : "Lock" });
  lock.addEventListener("click", async () => {
    await send({ type: "lock" });
    window.close();
  });
  return h(
    "div",
    { class: "settings" },
    h("h2", { textContent: "Suggestions" }),
    option("inlineMenu", "When signing in", "saved passwords"),
    // Chromium only: Firefox has no passkey list over login fields
    ...(import.meta.env.FIREFOX
      ? []
      : [option("hidePasskeyList", "Passkeys", "an icon in the field instead of the browser's list")]),
    option("oneTimeCodes", "Verification codes", "when a site asks for one"),
    option("generatePasswords", "When signing up", "strong passwords and emails"),
    option("hideMyEmail", "Hide My Email", "iCloud+ addresses, labeled with the site's name"),
    // the companion app is Mac only, and for Apple Passwords; elsewhere there's nothing to offer
    ...(status.companion === "unavailable" || !apple || !usable(apple)
      ? []
      : [h("hr"), macAppSection(status, option, accountOption(apple))]),
    h("hr"),
    accountsSection(status, settings, accountOption, tabId),
    // nothing unlocked: nothing to lock
    ...(status.accounts.some((a) => a.state === "unlocked") ? [h("hr"), h("div", { class: "actions end" }, lock)] : []),
  );
}

function openIcon() {
  const svg = icon(OPEN);
  svg.classList.add("open");
  return svg;
}

/**
 * An account's tile and name: a link to its app or web vault, at the tab's site, where it has one.
 * (Apple's app opens at the site's entry; Bitwarden's web vault searches for the site.)
 */
function accountName(account: AccountView, tabId?: number): HTMLElement {
  const content = [
    providerTile(account.provider),
    h("span", { class: "account-name", textContent: account.label }),
  ] as const;
  if (!account.capabilities.openApp || !usable(account)) return h("span", { class: "account-link" }, ...content);
  const link = h(
    "button",
    { class: "account-link", title: `Open ${account.label}`, ariaLabel: `Open ${account.label}` },
    ...content,
    openIcon(),
  );
  link.addEventListener("click", async () => {
    await send({ type: "open-passwords-app", account: account.id, ...(tabId === undefined ? {} : { tabId }) }).catch(
      () => {},
    );
    window.close();
  });
  return link;
}

/**
 * The accounts the popup lists: all but an Apple Passwords never set up next to others (added for
 * every install, it's only there to be set up; "Add Account…" offers it).
 */
function listedAccounts(status: Status): AccountView[] {
  const notSetUp = (a: AccountView) => a.unlock.kind !== "password" && a.state === "needs-setup";
  const others = status.accounts.filter((a) => !notSetUp(a));
  return others.length > 0 ? others : status.accounts;
}

/** What stands between an account and filling from it, in a few words; unlocked needs none. */
function stateText(account: AccountView): string | undefined {
  if (account.state === "unlocked") return undefined;
  if (account.state === "unavailable") return "Can't be used in this browser";
  if (account.state === "needs-setup") return account.unlock.kind === "password" ? "Signed out" : "Not set up";
  return "Locked";
}

const LOCK_AFTER: [minutes: number, label: string][] = [
  [0, "When the browser quits"],
  [5, "After 5 minutes unused"],
  [15, "After 15 minutes unused"],
  [60, "After an hour unused"],
];

/**
 * The accounts filled from: each with what can be done now (lock, set up, sign in) and its options,
 * "Manage…" (adding and removing, on the setup page), and where new logins are saved when more than
 * one account saves.
 */
function accountsSection(
  status: Status,
  settings: Settings,
  accountOption: (account: AccountView) => Option<AccountToggle>,
  tabId?: number,
) {
  const listed = listedAccounts(status);
  const several = listed.length > 1;
  const manage = h("button", { class: "link", textContent: "Manage…" });
  manage.addEventListener("click", () => void openSetup("accounts"));
  const rows = listed.map((account) => {
    let action: HTMLButtonElement | null = null;
    const button = (label: string, run: () => void) => {
      action = h("button", { class: "secondary small", textContent: label });
      action.addEventListener("click", run);
    };
    if (several && account.state === "unlocked") {
      button("Lock", async () => {
        await send({ type: "lock", account: account.id });
        await refresh();
      });
    } else if (account.state === "needs-setup" || account.state === "unavailable") {
      const route = account.unlock.kind === "password" ? `bitwarden=${account.id}` : "apple";
      button(account.unlock.kind === "password" ? "Sign In" : "Set Up", () => void openSetup(route));
    }
    const options: Node[] = [];
    // Firefox's idle API never reports "locked", so the option would do nothing there
    if (!import.meta.env.FIREFOX && usable(account)) {
      options.push(accountOption(account)("lockOnScreenLock", `Lock when my ${computer} locks`));
    }
    if (account.unlock.kind === "password" && usable(account)) options.push(lockAfterPicker(account));
    // the state first: an email cut short says enough, a state cut short doesn't
    const detail = [stateText(account), account.detail].filter(Boolean).join(" · ");
    return h(
      "div",
      { class: "account" },
      h(
        "div",
        { class: "account-head" },
        h(
          "span",
          { class: "account-text" },
          accountName(account, tabId),
          detail ? h("span", { class: "account-detail", textContent: detail }) : null,
        ),
        action,
      ),
      ...options,
    );
  });

  // where new logins go, when more than one account could take them
  const savers = listed.filter((a) => a.capabilities.savePasswords && usable(a));
  let saveTo: Node | null = null;
  if (savers.length > 1) {
    const select = h(
      "select",
      { ariaLabel: "Save new logins to" },
      ...savers.map((a) => h("option", { value: a.id, textContent: a.detail ? `${a.label} (${a.detail})` : a.label })),
    );
    select.value = savers.some((a) => a.id === settings.saveNewLoginsTo)
      ? settings.saveNewLoginsTo
      : (savers[0]?.id ?? "");
    select.addEventListener("change", () => {
      void send({ type: "set-settings", settings: { saveNewLoginsTo: select.value } }).catch((e) =>
        refresh(messageOf(e)),
      );
    });
    saveTo = h(
      "label",
      { class: "toggle select" },
      h("span", { class: "text", textContent: "Save new logins to" }),
      select,
    );
  }

  return h(
    "section",
    { class: "accounts" },
    h("div", { class: "actions" }, h("h2", { textContent: "Accounts" }), manage),
    ...rows,
    saveTo,
  );
}

/** When an account the extension unlocks locks by itself. */
function lockAfterPicker(account: AccountView) {
  const select = h(
    "select",
    { ariaLabel: `Lock ${account.label}` },
    ...LOCK_AFTER.map(([minutes, label]) => h("option", { value: String(minutes), textContent: label })),
  );
  const current = account.settings.lockAfterMinutes;
  if (!LOCK_AFTER.some(([minutes]) => minutes === current)) {
    select.append(h("option", { value: String(current), textContent: `After ${current} minutes unused` }));
  }
  select.value = String(current);
  select.addEventListener("change", () => {
    void send({
      type: "set-account-settings",
      account: account.id,
      settings: { lockAfterMinutes: Number(select.value) },
    }).catch((e) => refresh(messageOf(e)));
  });
  return h("label", { class: "toggle select" }, h("span", { class: "text", textContent: "Lock" }), select);
}

/**
 * What the companion app adds. Without it (or before its setup is done) the options are shown, greyed
 * out, next to one button that gets it, so they're discoverable but never a switch that does nothing.
 */
function macAppSection(status: Status, option: Option<Toggle>, accountOption: Option<AccountToggle>) {
  const ready = status.companion === "ready";
  const openApp = (label: string) => {
    const button = h("button", { class: "link", textContent: label });
    button.addEventListener("click", () => void openCompanion("open-companion-app"));
    return button;
  };
  const options = h(
    "div",
    { class: "options" },
    accountOption("touchId", "Enter the 6-digit code for me", "after Touch ID", !ready),
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

/**
 * Firefox: opened from an email field's menu, which can't ask for Hide My Email's permissions
 * itself. The background tells that menu once this closes, and turns Hide My Email on when Firefox
 * grants them (even if Firefox closes this popup as its prompt opens).
 */
function showHideMyEmailConsent() {
  browser.runtime.connect({ name: HME_CONSENT_PORT });
  const notNow = h("button", { class: "secondary", textContent: "Not Now" });
  notNow.addEventListener("click", () => window.close());
  const turnOn = h("button", { class: "primary", textContent: "Turn On" });
  const error = h("p", { class: "error", hidden: true });
  turnOn.addEventListener("click", async () => {
    try {
      if (await requestHideMyEmailConsent()) await send({ type: "set-settings", settings: { hideMyEmail: true } });
      window.close();
    } catch (e) {
      error.textContent = messageOf(e);
      error.hidden = false;
    }
  });
  show(
    h("h1", { textContent: "Turn On Hide My Email" }),
    h("p", {}, "Get a unique iCloud+ address for each site, labeled with its name."),
    h("p", { class: "hint" }, "Firefox will ask you to allow this, since the site's name is sent to iCloud."),
    error,
    h("div", { class: "actions end" }, notNow, turnOn),
  );
  turnOn.focus();
}

async function start() {
  const intent = await send({ type: "popup-intent" }).catch(() => undefined);
  if (intent?.hideMyEmailConsent) return showHideMyEmailConsent();
  // opened by the inline menu to unlock an account
  if (intent?.unlock) unlockTarget = intent.unlock;
  await refresh();
}

// tells the background the popup is on screen (see POPUP_PORT)
browser.runtime.connect({ name: POPUP_PORT });

// locked or unlocked elsewhere (the computer locked, the inline menu) while the popup is open: show
// what's there now. Only on an actual difference, and never over a password being typed.
browser.runtime.onMessage.addListener((message: MenuMessage, sender) => {
  if (sender.id !== browser.runtime.id || message.type !== "accounts-changed") return false;
  if (!app.querySelector(".settings, .unlock-area")) return false;
  void send({ type: "list-accounts" }).then((accounts) => {
    if (unlockedIds(accounts) === shownUnlocked) return;
    if (app.querySelector<HTMLInputElement>(".unlock-body input")?.value) return;
    void refresh();
  });
  return false;
});

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text || "Something went wrong. Try again, or reload the extension.";
}

void platform()
  .then((os) => {
    computer = computerName(os);
    if (os === "windows") fetchingCode = "Getting the code…";
  })
  .finally(() => void start());
