import { isNewPasswordField, isOneTimeCodeField, mayTakeNewPassword, oneTimeCodeGroup } from "./autofill/fields.ts";

// fillCredentials runs inside the page: injected by scripting.executeScript (popup) or called by the
// autofill content script (inline menu), so it must not reference anything outside its own body.
// It refuses to fill if the page navigated to another origin since the user chose the login, and
// only touches visible fields. The functions after it are used by the content script only.

/** "needs-password": asked to fill without the password, but the form has a password field. */
export type FillResult = "filled" | "origin-mismatch" | "no-fields" | "needs-password";

/**
 * Fills a login. Without the password (null), it fills a username-only step of a multi-step sign-in,
 * so the password (and its Touch ID) waits for the step that asks for it; on a form with a password
 * field it changes nothing and says so.
 */
export function fillCredentials(
  expectedOrigin: string,
  username: string,
  password: string | null,
  /** The field the inline menu was opened on; otherwise the focused field is used. */
  anchor?: HTMLInputElement,
): FillResult {
  if (window.location.origin !== expectedOrigin) return "origin-mismatch";

  const isVisible = (el: HTMLInputElement) => {
    if (el.disabled || el.readOnly || el.type === "hidden") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    const opacity = Number.parseFloat(style.opacity);
    return style.visibility !== "hidden" && style.display !== "none" && !(opacity <= 0.05);
  };

  const setValue = (el: HTMLInputElement, value: string) => {
    // the native setter keeps frameworks such as React in sync with the DOM value
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const inputs = Array.from(document.querySelectorAll("input")).filter(isVisible);
  const isUsernameField = (el: HTMLInputElement) =>
    ["text", "email", "tel", ""].includes(el.type) &&
    !/one-time-code|new-password|current-password/.test(el.autocomplete);

  const active = anchor ?? (document.activeElement instanceof HTMLInputElement ? document.activeElement : undefined);
  // a field inside a form only pairs with fields of that same form
  const activeForm = active?.form;
  const passwordField =
    (active?.type === "password" && isVisible(active) ? active : undefined) ??
    inputs.find((el) => el.type === "password" && (!activeForm || el.form === activeForm));

  // the username field belongs to the same form as the password field, before it
  const scope = passwordField?.form ?? active?.form ?? document;
  const candidates = inputs.filter((el) => scope.contains(el) && isUsernameField(el));
  const before = passwordField
    ? candidates.filter((el) => el.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING)
    : candidates;
  const usernameField =
    (active && isUsernameField(active) && isVisible(active) ? active : undefined) ??
    before.find((el) => el.autocomplete === "username") ??
    before.at(-1) ??
    candidates[0];

  if (!passwordField && !usernameField) return "no-fields";
  if (passwordField && password === null) return "needs-password";
  if (usernameField && username) setValue(usernameField, username);
  if (passwordField && password !== null) setValue(passwordField, password);
  // leave the filled fields unfocused: the login is ready, and there's nothing left to type
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && (focused === passwordField || focused === usernameField)) focused.blur();
  return "filled";
}

/**
 * Fills a new password into the field the menu was opened on and the form's other new-password
 * fields (the confirmation). Called by the content script only after Apple Passwords saved it.
 */
export function fillNewPassword(expectedOrigin: string, password: string, anchor: HTMLInputElement): FillResult {
  if (window.location.origin !== expectedOrigin) return "origin-mismatch";
  if (!anchor.isConnected || !mayTakeNewPassword(anchor)) return "no-fields";
  const scope = anchor.form ?? document;
  const targets = Array.from(scope.querySelectorAll("input")).filter(
    (el) => el === anchor || (isNewPasswordField(el) && isFillable(el)),
  );
  for (const el of targets) setInputValue(el, password);
  anchor.focus();
  return "filled";
}

/** Fills an email address into the field the menu was opened on (email fields). */
export function fillEmail(expectedOrigin: string, email: string, field: HTMLInputElement): FillResult {
  if (window.location.origin !== expectedOrigin) return "origin-mismatch";
  if (!field.isConnected || !isFillable(field)) return "no-fields";
  setInputValue(field, email);
  return "filled";
}

/**
 * Fills a verification code into the field the menu was opened on, or across its boxes when the
 * code is split into one box per character. Focus stays in the code field, so Enter submits, but
 * nothing is ever submitted for the user.
 */
export function fillOneTimeCode(expectedOrigin: string, code: string, anchor: HTMLInputElement): FillResult {
  if (window.location.origin !== expectedOrigin) return "origin-mismatch";
  if (!anchor.isConnected || !isFillable(anchor) || !isOneTimeCodeField(anchor)) return "no-fields";
  const boxes = oneTimeCodeGroup(anchor).filter(isFillable);
  if (boxes.length > 1) {
    // widgets move focus from box to box themselves; focusing each first keeps them in step
    boxes.forEach((box, i) => {
      box.focus();
      setInputValue(box, "");
      typeInto(box, code[i] ?? "");
    });
    return "filled";
  }
  anchor.focus();
  setInputValue(anchor, code);
  // a framework that keeps its own state may undo a set value (or strip it): type it instead
  if (anchor.value !== code) {
    setInputValue(anchor, "");
    typeInto(anchor, code);
  }
  return "filled";
}

/** Types `text` key by key, with the events a page's own keyboard handling listens for. */
function typeInto(el: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  for (const key of text) {
    const init = { key, bubbles: true, cancelable: true, composed: true };
    if (!el.dispatchEvent(new KeyboardEvent("keydown", init))) continue;
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    const insert = { inputType: "insertText", data: key, bubbles: true, cancelable: true, composed: true };
    if (el.dispatchEvent(new InputEvent("beforeinput", insert))) {
      const next = el.value + key;
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new InputEvent("input", { ...insert, cancelable: false }));
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The username or email typed into the same form as `anchor`, if any. */
export function usernameNear(anchor: HTMLInputElement): string {
  const fields = usernameFieldsNear(anchor).filter((el) => el.value.trim() !== "");
  const best = fields.sort((a, b) => usernameScore(b) - usernameScore(a))[0];
  return best?.value.trim() ?? "";
}

/** Whether `anchor`'s form asks for a username or email, typed or not (a password reset doesn't). */
export function asksForUsername(anchor: HTMLInputElement): boolean {
  return usernameFieldsNear(anchor).length > 0;
}

function usernameFieldsNear(anchor: HTMLInputElement): HTMLInputElement[] {
  const scope = anchor.form ?? document;
  return Array.from(scope.querySelectorAll("input")).filter(
    (el) => ["text", "email", "tel", ""].includes(el.type) && isFillable(el) && usernameScore(el) > 0,
  );
}

function usernameScore(el: HTMLInputElement): number {
  const autocomplete = el.autocomplete.toLowerCase();
  if (/\busername\b/.test(autocomplete)) return 3;
  if (/\bemail\b/.test(autocomplete) || el.type === "email") return 2;
  if (/user|login|e-?mail|account/i.test(`${el.name} ${el.id}`)) return 1;
  return 0;
}

function isFillable(el: HTMLInputElement): boolean {
  if (el.disabled || el.readOnly || el.type === "hidden") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && !(Number.parseFloat(style.opacity) <= 0.05);
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
