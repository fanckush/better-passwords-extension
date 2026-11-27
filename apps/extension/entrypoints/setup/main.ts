import "./style.css";
import type { AccountView } from "@/src/accounts/types.ts";
import { DISPLAY_NAME } from "@/src/config.ts";
import { type Status, send } from "@/src/messages.ts";
import { toolbarAction } from "@/src/toolbar.ts";
import { applySystemAccent } from "@/src/ui/accent.ts";
import { bitwardenSignIn } from "@/src/ui/bitwarden-sign-in.ts";
import { h } from "@/src/ui/h.ts";
import { CHECK, CHEVRON_BACK, icon } from "@/src/ui/icons.ts";
import { providerPicker, providerTile } from "@/src/ui/providers.ts";
import { reportProblem } from "@/src/ui/report.ts";
import { setupFlow } from "@/src/ui/setup.ts";
import { animateSteps } from "@/src/ui/steps.ts";

// Setting up and managing password managers, in a tab of its own: opened on install, from the
// inline menu's "Set Up Better Passwords", and from the popup's "Manage…". It lists the accounts
// (to remove, or sign in again) above those that can be added; before any, it's a welcome. The
// address can name a setup to start with: #apple, #bitwarden, or #bitwarden=<account> to sign in
// again. Each setup (Apple's flow, src/ui/setup.ts, or Bitwarden's sign-in) ends back on the list.

applySystemAccent();

const page = document.getElementById("page") as HTMLElement;
animateSteps(page);

/** Unlocking happens in the popup; open it where the browser allows, or say where it is. */
async function openPopup(button: HTMLButtonElement) {
  const action = toolbarAction() as { openPopup?: () => Promise<void> } | undefined;
  try {
    if (!action?.openPopup) throw new Error("no openPopup");
    await action.openPopup();
  } catch {
    button.replaceWith(
      h("p", { class: "note", textContent: `Click the ${DISPLAY_NAME} button in your browser's toolbar to unlock.` }),
    );
  }
}

async function closeTab() {
  const tab = await browser.tabs.getCurrent();
  if (tab?.id !== undefined) await browser.tabs.remove(tab.id);
  else window.close();
}

/**
 * Shows a password manager's setup, with a Back button when the user came from the list: back a
 * step within the setup (`stepBack`, false at its first step), else to the list. Every setup gets
 * the same one, in the same place; it hides itself once connected (CSS: the flow's check badge),
 * since there's nothing to go back to then.
 */
function showFlow(flow: HTMLElement, toAccounts?: () => unknown, stepBack: () => boolean = () => false) {
  if (!toAccounts) return page.replaceChildren(flow);
  const button = h("button", { class: "back", type: "button" }, icon(CHEVRON_BACK), "Back");
  button.addEventListener("click", () => {
    if (stepBack()) return;
    void toAccounts();
  });
  page.replaceChildren(button, flow);
}

const apple = (status: Status | undefined) => status?.accounts.find((a) => a.provider === "apple");
const usable = (account: AccountView | undefined) =>
  account !== undefined && account.state !== "needs-setup" && account.state !== "unavailable";

/** The accounts worth listing: all but an Apple Passwords never set up (it's offered below). */
const connected = (status: Status | undefined) =>
  (status?.accounts ?? []).filter((a) => !(a.provider === "apple" && a.state === "needs-setup"));

/** The list again, as things are now; `added`: the account just set up, which it points out. */
async function toAccounts(added?: string) {
  history.replaceState(null, "", "#accounts");
  showAccounts(await send({ type: "get-status" }).catch(() => undefined), added);
}

async function showApple(status: Status | undefined, back?: () => unknown) {
  // removed earlier from this browser: added back, to be set up
  if (!apple(status)) status = await send({ type: "add-account", provider: "apple" });
  const account = apple(status);
  if (account?.state === "unlocked") return toAccounts(account.id);
  const flow = await setupFlow(status, {
    next: { label: "Unlock Now", run: (button) => void openPopup(button) },
    done: () => void toAccounts(account?.id),
  });
  showFlow(flow, back);
}

async function showBitwarden(account?: AccountView, back?: () => unknown) {
  const server = account ? await send({ type: "bitwarden-server", account: account.id }).catch(() => null) : null;
  const flow = bitwardenSignIn({
    ...(account
      ? {
          account: {
            id: account.id,
            ...(account.detail ? { email: account.detail } : {}),
            ...(server ? { server } : {}),
          },
        }
      : {}),
    done: (id) => void toAccounts(id),
  });
  showFlow(flow.element, back, flow.back);
}

/** An account in the list: what it is, and removing it (asked again in place, and easy to back out of). */
function accountRow(account: AccountView, added: boolean): HTMLElement {
  const signedOut = account.unlock.kind === "password" && account.state === "needs-setup";
  const detail = h("span", { class: "provider-detail" });
  const actions = h("span", { class: "row-actions" });
  const row = h(
    "div",
    { class: added ? "managed added" : "managed" },
    providerTile(account.provider),
    h("span", { class: "provider-text" }, h("span", { class: "name", textContent: account.label }), detail),
    actions,
  );
  const button = (label: string, kind: string, run: () => void) => {
    const b = h("button", { class: kind, type: "button", textContent: label });
    b.addEventListener("click", run);
    return b;
  };

  const idle = () => {
    const state = signedOut ? "Signed out" : account.state === "unavailable" ? "Can't be used in this browser" : "";
    detail.textContent = [state, account.detail].filter(Boolean).join(" · ");
    detail.hidden = !detail.textContent;
    const remove = button("Remove", "quiet", confirm);
    remove.setAttribute("aria-label", `Remove ${[account.label, account.detail].filter(Boolean).join(" ")}`);
    actions.replaceChildren(
      ...(signedOut ? [button("Sign In", "quiet accent", () => void showBitwarden(account, () => toAccounts()))] : []),
      ...(added ? [h("span", { class: "check", title: "Added" }, icon(CHECK))] : []),
      remove,
    );
  };

  const confirm = () => {
    detail.textContent = "Passwords stay saved.";
    detail.hidden = false;
    const cancel = () => {
      stop.abort();
      idle();
    };
    // Escape, or a click anywhere else, backs out
    const stop = new AbortController();
    document.addEventListener("keydown", (e) => e.key === "Escape" && cancel(), { signal: stop.signal });
    document.addEventListener("pointerdown", (e) => !row.contains(e.target as Node) && cancel(), {
      signal: stop.signal,
    });
    const keep = button("Cancel", "quiet", cancel);
    actions.replaceChildren(
      keep,
      button("Remove", "quiet danger", async () => {
        stop.abort();
        await send({ type: "remove-account", account: account.id }).catch(() => {});
        await toAccounts();
      }),
    );
    keep.focus();
  };

  idle();
  return row;
}

/**
 * The accounts, then those that can be added, and "Done". With none yet it's the welcome: which
 * password manager. Apple set up meanwhile (the README's command) moves on to its flow.
 */
function showAccounts(status: Status | undefined, added?: string) {
  const accounts = connected(status);
  const appleAccount = apple(status);
  const newest = accounts.find((a) => a.id === added);
  const picker = providerPicker({
    // Apple Passwords can be added once; Bitwarden once per account
    hidden: (id) => id === "apple" && accounts.some((a) => a.provider === "apple"),
    choose: (id) => {
      const back = () => toAccounts();
      if (id === "apple") void showApple(status, back);
      else void showBitwarden(undefined, back);
    },
  });
  let root: HTMLElement;
  if (accounts.length === 0) {
    root = h(
      "div",
      { class: "setup" },
      h("img", { class: "app-icon", src: "/icon/128.png", alt: "" }),
      h("h1", { textContent: `Welcome to ${DISPLAY_NAME}` }),
      h("p", { class: "lead", textContent: "Which password manager do you use?" }),
      picker,
      reportProblem(),
    );
  } else {
    const done = h("button", { class: "button primary", type: "button", textContent: "Done" });
    done.addEventListener("click", () => void closeTab());
    root = h(
      "div",
      { class: "setup" },
      h("img", { class: "app-icon", src: "/icon/128.png", alt: "" }),
      h("h1", { textContent: "Password Managers" }),
      newest
        ? h("p", {
            class: "lead",
            textContent: `${newest.label} is ready. Click a login field on any website to fill a password.`,
            attrs: { role: "status" },
          })
        : null,
      h("div", { class: "providers" }, ...accounts.map((a) => accountRow(a, a.id === added))),
      h("h2", { textContent: "Add Another" }),
      picker,
      done,
      reportProblem(),
    );
  }
  page.replaceChildren(root);

  // Apple connected while the user reads this: carry on with Apple's flow, which says so
  if (appleAccount && !usable(appleAccount)) {
    const timer = setInterval(async () => {
      if (!root.isConnected) return clearInterval(timer);
      const latest = await send({ type: "get-status" }).catch(() => undefined);
      if (!root.isConnected) return clearInterval(timer);
      if (usable(apple(latest))) {
        clearInterval(timer);
        void showApple(latest);
      }
    }, 1_500);
  }
}

async function render() {
  const status = await send({ type: "get-status" }).catch(() => undefined);
  const [route, id] = location.hash.slice(1).split("=");
  if (route === "apple") return showApple(status);
  if (route === "bitwarden") return showBitwarden(status?.accounts.find((a) => a.id === id));
  // Apple's setup under way (a reopened tab): its flow says where it's at; "#accounts" (the
  // popup's Manage) always lists
  const onlyApple = !status?.accounts.some((a) => a.provider !== "apple");
  const appleState = apple(status)?.state;
  if (route !== "accounts" && onlyApple && usable(apple(status)) && appleState !== "unlocked") {
    return showApple(status);
  }
  showAccounts(status);
}

void render();
