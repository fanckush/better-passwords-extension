import {
  type FieldKind,
  fieldKind,
  isOneTimeCodeField,
  isUnsurePasswordField,
  mayTakeNewPassword,
  oneTimeCodeGroup,
} from "@/src/autofill/fields.ts";
import { MenuHost } from "@/src/autofill/menu-host.ts";
import {
  isGone,
  isUsernameInput,
  type SentLogin,
  sentLogin,
  submittedScope,
  watchUntilGone,
} from "@/src/autofill/submission.ts";
import { FILL_MATCHES } from "@/src/config.ts";
import {
  asksForUsername,
  fillCredentials,
  fillEmail,
  fillNewPassword,
  fillOneTimeCode,
  newPasswordRules,
  usernameNear,
} from "@/src/fill.ts";
import {
  type ContentMessage,
  type MenuMessage,
  type NewPasswordContext,
  type SignInState,
  send,
} from "@/src/messages.ts";

/** Omit for each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// Top frame only for now. Logins inside cross-origin iframes need their own origin rules.
export default defineContentScript({
  matches: FILL_MATCHES,
  runAt: "document_idle",
  main(ctx) {
    const menu = new MenuHost(browser.runtime.getURL("/menu.html"), (above) =>
      tellMenu({ type: "menu-placement", above }),
    );
    let request = 0;
    // the field whose menu the user just dismissed; it stays closed there until they ask again
    let dismissed: HTMLInputElement | undefined;
    // the same for a code split into one box per digit: all its boxes, which focus moves across
    let dismissedCode = new Set<HTMLInputElement>();
    // a code being filled moves focus from box to box: no menu for those
    let fillingCode = false;

    /** Keeps the menu closed on `field`, and on every box of its code if it's one. */
    function dismiss(field: HTMLInputElement | undefined) {
      dismissed = field;
      dismissedCode = new Set(field && fieldKind(field) === "one-time-code" ? oneTimeCodeGroup(field) : []);
    }
    // new-password fields by menu nonce: a save can outlast the menu (macOS asks the user first)
    const newPasswordFields = new Map<string, HTMLInputElement>();
    // the last generated password we filled: to recognise it, and to save it once the form is sent
    let generated:
      | { field: HTMLInputElement; value: string; saved: boolean; username: string; weaker: boolean }
      | undefined;

    async function offer(field: HTMLInputElement, kind: FieldKind) {
      if (menu.anchor === field || dismissed === field || dismissedCode.has(field) || fillingCode) return;
      // like Safari: a code is offered while the field is empty, not over one being typed
      if (kind === "one-time-code" && oneTimeCodeGroup(field).some((box) => box.value !== "")) return;
      const ticket = ++request;
      const unsure = kind === "login" && isUnsurePasswordField(field);
      const { show, nonce, orGenerate } = await send({ type: "autofill-status", kind, unsure }).catch(() => ({
        show: "none" as const,
        nonce: undefined,
        orGenerate: undefined,
      }));
      // the user may have moved on while we asked
      if (ticket !== request || document.activeElement !== field) return;
      if (nonce === undefined) {
        menu.close();
      } else if ((kind === "new-password" || (unsure && field === generated?.field)) && field.value !== "") {
        // our own password: say it's saved; one the user typed: stay out of the way
        if (show !== "none" && generated?.field.form === field.form && field.value === generated.value) {
          menu.open(field, generated.saved ? "generated" : "generated-unsaved", kind, nonce, {
            weaker: generated.weaker,
          });
        } else {
          menu.close();
        }
      } else if (show === "email" && kind === "email") {
        menu.open(field, "email", kind, nonce);
      } else if (show === "codes" && kind === "one-time-code") {
        menu.open(field, "codes", kind, nonce);
      } else if (show === "logins" || show === "generate" || show === "locked" || show === "setup") {
        // "locked" and "setup" too: login fields include guessed usernames, but only next to a
        // password field, and the email field is usually the first one people click
        menu.open(field, show, kind, nonce, { orGenerate: orGenerate ?? false });
      } else {
        menu.close();
      }
    }

    /** Sends the open menu a message straight (see MenuMessage). */
    function tellMenu(message: DistributiveOmit<MenuMessage, "nonce">) {
      const nonce = menu.nonce;
      if (!nonce) return;
      void browser.runtime.sendMessage({ ...message, nonce } as MenuMessage).catch(() => {});
    }

    /** Tells the open menu what's typed in its username field, so it lists only the logins that match. */
    function filterMenu(query: string) {
      tellMenu({ type: "menu-filter", query });
    }

    /** Offers a menu for `target` if it gets one; returns whether it does. */
    function offerFor(target: EventTarget | null): boolean {
      const kind = fieldKind(target);
      if (!kind) return false;
      void offer(target as HTMLInputElement, kind);
      return true;
    }

    ctx.addEventListener(
      document,
      "focusin",
      (event) => {
        if (event.target === menu.element || fillingCode) return;
        if (event.target !== dismissed) dismissed = undefined;
        if (!dismissedCode.has(event.target as HTMLInputElement)) dismissedCode.clear();
        if (!offerFor(event.target) && menu.isOpen) menu.close();
      },
      { capture: true },
    );
    ctx.addEventListener(
      document,
      "mousedown",
      (event) => {
        if (menu.isOpen && event.target !== menu.element && event.target !== menu.anchor) menu.close();
        // clicking the field while nothing typed matches brings every login back
        if (menu.isOpen && !menu.isShowing && event.target === menu.anchor) filterMenu("");
        // clicking a field whose menu was dismissed asks for it again
        if (event.target === dismissed || dismissedCode.has(event.target as HTMLInputElement)) {
          dismiss(undefined);
          offerFor(event.target);
        }
      },
      { capture: true },
    );
    ctx.addEventListener(
      document,
      "keydown",
      (event) => {
        const wasDismissed = event.target === dismissed || dismissedCode.has(event.target as HTMLInputElement);
        if (event.key === "ArrowDown" && !menu.isOpen && wasDismissed) {
          event.preventDefault();
          dismiss(undefined);
          offerFor(event.target);
          return;
        }
        if (!menu.isOpen || event.target !== menu.anchor) return;
        if (event.key === "Escape") {
          dismiss(menu.anchor);
          menu.close();
        }
        // the arrow pointing at the menu leads into it (↑ when it sits above the field)
        if (event.key === (menu.isAbove ? "ArrowUp" : "ArrowDown")) {
          event.preventDefault();
          if (!menu.isShowing) filterMenu("");
          menu.focusMenu();
        }
      },
      { capture: true },
    );
    // typing a username (or a sign-up email) narrows the suggestions down; typing a sign-in password
    // hides them until it's emptied or they're asked for again; typing a new password of one's own
    // closes the suggestions
    ctx.addEventListener(
      document,
      "input",
      (event) => {
        // only the user's own typing: text the page sets itself must not probe which logins match
        if (!event.isTrusted || !menu.isOpen || event.target !== menu.anchor) return;
        const kind = fieldKind(event.target);
        if (kind === "login" && menu.anchor.type !== "password") filterMenu(menu.anchor.value);
        if (kind === "email") filterMenu(menu.anchor.value);
        if (kind === "login" && menu.anchor.type === "password") {
          tellMenu({ type: "menu-typing", typing: menu.anchor.value !== "" });
        }
        // typing a code of one's own (one sent by SMS, say) closes the suggestions too
        if (kind !== "new-password" && kind !== "one-time-code") return;
        dismiss(menu.anchor);
        menu.close();
      },
      { capture: true },
    );
    ctx.addEventListener(window, "scroll", () => menu.position(), { capture: true, passive: true });
    ctx.addEventListener(window, "resize", () => menu.position());
    ctx.onInvalidated(() => menu.close());

    // Like Safari: a generated password is filled right away, and Apple Passwords is asked to save
    // it once the page moves on with it: the password field goes away (a dialog closes, a step
    // moves on) or the tab navigates (watched by the background). An invalid or rejected form
    // keeps the field, so it isn't asked. Asking once too often beats missing a save: macOS's
    // prompt has Not Now.
    let lastUsername = "";
    let stopWatching = () => {};

    /** The username to save with: the form's, or the last one typed on the page (multi-step sign-ups). */
    function trackUsername() {
      if (!generated || isGone(generated.field)) return;
      const username = usernameNear(generated.field) || lastUsername;
      if (username === generated.username) return;
      generated.username = username;
      void send({ type: "generated-username", username }).catch(() => {});
    }
    ctx.addEventListener(
      document,
      "change",
      (event) => {
        if (isUsernameInput(event.target) && event.target.value.trim()) lastUsername = event.target.value.trim();
        trackUsername();
      },
      { capture: true },
    );

    function watchGenerated(field: HTMLInputElement) {
      stopWatching();
      stopWatching = watchUntilGone(field, () => {
        if (generated?.field !== field || field.value !== generated.value) return;
        void send({ type: "generated-form-gone", username: generated.username }).catch(() => {});
      });
    }

    // A password (typed, or filled) is captured as its form is sent (a submit, Enter, a click on a
    // button) and Apple Passwords is asked to save it once the page moves on, as with a generated
    // one: its field goes away, or the tab navigates (the background then asks, see
    // saveSentLogin). Apple's helper asks only about a new account or password.
    let sent: SentLogin | undefined;
    let stopWatchingSent = () => {};

    function noteSent(scope: ParentNode | undefined) {
      const login = scope && sentLogin(scope, lastUsername);
      // a password we generated has its own save
      if (!login || login.password === generated?.value) return;
      const same = sent?.field === login.field && sent.password === login.password;
      if (same && sent?.username === login.username) return;
      sent = login;
      void send({ type: "login-sent", username: login.username, password: login.password }).catch(() => {});
      stopWatchingSent();
      // the background has it from here; the page keeps no copy past the form
      stopWatchingSent = watchUntilGone(login.field, () => {
        if (sent?.field !== login.field) return;
        sent = undefined;
        void send({ type: "login-form-gone" }).catch(() => {});
      });
    }
    ctx.addEventListener(document, "submit", (event) => noteSent(event.target as HTMLFormElement), { capture: true });
    ctx.addEventListener(
      document,
      "click",
      (event) => {
        if (event.isTrusted) noteSent(submittedScope(event.target));
      },
      { capture: true },
    );
    ctx.addEventListener(
      document,
      "keydown",
      (event) => {
        if (event.isTrusted && event.key === "Enter") noteSent(submittedScope(event.target, "Enter"));
      },
      { capture: true },
    );
    // typing the password again (the site said it was wrong): the one sent is no good
    ctx.addEventListener(
      document,
      "input",
      (event) => {
        if (!event.isTrusted || !sent || event.target !== sent.field || sent.field.value === sent.password) return;
        sent = undefined;
        stopWatchingSent();
        void send({ type: "login-edited" }).catch(() => {});
      },
      { capture: true },
    );

    /** Whether the sign-in with the sent login went through: the page moved on without asking again. */
    function signInState(): SignInState {
      if (sent && !isGone(sent.field)) return "watching";
      // a password field on the page that loaded next: back at the sign-in, the password was wrong
      const inputs = Array.from(document.querySelectorAll("input"));
      return inputs.some((el) => el.type === "password" && !isGone(el)) ? "failed" : "moved-on";
    }

    // messages relayed by the background from our menu page; only our extension can send these
    browser.runtime.onMessage.addListener((message: ContentMessage, sender, sendResponse) => {
      if (sender.id !== browser.runtime.id) return false;
      if (message.type === "generated-password-saved") {
        if (generated?.value === message.password) generated.saved = true;
        return false;
      }
      if (message.type === "menu-fill-new-password") {
        const field = newPasswordFields.get(message.nonce);
        newPasswordFields.delete(message.nonce);
        if (!field) {
          sendResponse({ result: "no-fields" });
          return false;
        }
        const result = fillNewPassword(message.origin, message.password, field);
        if (result === "filled") {
          generated = {
            field,
            value: message.password,
            saved: false,
            username: "",
            weaker: message.strength !== "strong",
          };
          trackUsername();
          watchGenerated(field);
        }
        if (menu.isCurrent(message.nonce)) {
          dismissed = field;
          menu.close();
        }
        sendResponse({ result });
        return false;
      }
      if (message.type === "sign-in-state") {
        sendResponse(signInState());
        return false;
      }
      if (message.type === "fill-one-time-code") {
        // from the popup: the focused code field, else the page's first one
        const focused = document.activeElement;
        const field =
          focused instanceof HTMLInputElement && isOneTimeCodeField(focused)
            ? focused
            : Array.from(document.querySelectorAll("input")).find(
                (el) => fieldKind(el) === "one-time-code" && !isGone(el),
              );
        sendResponse({ result: field ? fillCode(message.origin, message.code, field) : "no-fields" });
        return false;
      }
      if (!menu.isCurrent(message.nonce)) return false;
      switch (message.type) {
        case "menu-resize":
          menu.resize(message.height);
          return false;
        case "menu-close": {
          const anchor = menu.anchor;
          dismissed = anchor;
          menu.close();
          anchor?.focus();
          return false;
        }
        case "menu-focus-field":
          menu.anchor?.focus();
          return false;
        case "menu-new-password-context": {
          const field = menu.anchor;
          if (!field || !mayTakeNewPassword(field)) {
            sendResponse(undefined);
            return false;
          }
          newPasswordFields.set(message.nonce, field);
          const context: NewPasswordContext = {
            // the limits of every field the password goes into, the confirmation's too
            rules: newPasswordRules(field),
            // or the one typed on an earlier step (multi-step sign-ups): then nobody's account is guessed
            username: usernameNear(field) || lastUsername,
            asksForUsername: asksForUsername(field),
            visible: menu.isTrustworthy(),
          };
          sendResponse(context);
          return false;
        }
        case "menu-fill-email": {
          const anchor = menu.anchor;
          if (!anchor || !menu.isTrustworthy()) {
            sendResponse({ result: "menu-hidden" });
            menu.close();
            return false;
          }
          const result = fillEmail(message.origin, message.email, anchor);
          dismissed = anchor;
          menu.close();
          sendResponse({ result });
          return false;
        }
        case "menu-visible":
          sendResponse(menu.isTrustworthy());
          return false;
        case "menu-fill-one-time-code": {
          const anchor = menu.anchor;
          if (!anchor || !menu.isTrustworthy()) {
            sendResponse({ result: "menu-hidden" });
            menu.close();
            return false;
          }
          sendResponse({ result: fillCode(message.origin, message.code, anchor) });
          return false;
        }
        case "menu-fill": {
          const anchor = menu.anchor;
          if (!anchor || !menu.isTrustworthy()) {
            sendResponse({ result: "menu-hidden" });
            menu.close();
            return false;
          }
          const result = fillCredentials(message.origin, message.username, message.password, anchor);
          // "needs-password": the background reads the password and asks again, menu still open
          if (result !== "needs-password") {
            dismissed = anchor;
            menu.close();
          }
          sendResponse({ result });
          return false;
        }
      }
    });

    /** Fills a code; the menu stays closed on its boxes, which the fill focuses one by one. */
    function fillCode(origin: string, code: string, field: HTMLInputElement) {
      fillingCode = true;
      try {
        const result = fillOneTimeCode(origin, code, field);
        dismiss(field);
        menu.close();
        return result;
      } finally {
        fillingCode = false;
      }
    }

    offerFor(document.activeElement);
  },
});
