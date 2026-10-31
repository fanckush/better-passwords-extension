// Decides which inputs get the inline menu, and which kind. Conservative on purpose: a menu on a
// search box is noise, and suggesting saved logins on a sign-up form, or a new password on a login
// form, would be wrong. Any other email field (a newsletter, a contact form) gets email suggestions.

/** "login": fill a saved login. "new-password": suggest a strong password. "email": suggest an email. */
export type FieldKind = "login" | "new-password" | "email";

const USERNAME_HINT = /user|login|e-?mail|account|identifier|signin/i;
/** A whole name or id for the account, not just an email (a forgot-password form's `name="username"`). */
const ACCOUNT_NAME = /^(user([_-]?(name|id))?|login([_-]?(name|id))?|identifier|sign[_-]?in)$/i;
const EMAIL_HINT = /e-?mail/i;
const SIGNUP_HINT = /sign[\s_-]?up|regist|create[\s_-]?(an[\s_-]?)?account|join|enrol/i;
const LOGIN_HINT = /sign[\s_-]?in|log[\s_-]?in/i;

function textOf(el: HTMLInputElement): string {
  // the label too: some fields say what they are nowhere else (no name, a generated id)
  const labels = Array.from(el.labels ?? [], (label) => label.textContent ?? "");
  return [el.name, el.id, el.getAttribute("aria-label") ?? "", el.placeholder, ...labels].join(" ");
}

/** Typed as an email, or asking for the email keyboard (a text field that takes an email). */
function asksForEmail(el: HTMLInputElement): boolean {
  return el.type === "email" || el.getAttribute("inputmode")?.toLowerCase() === "email";
}

/**
 * A search box that isn't typed as one: Outlook's says "Search for email, meetings, files and more",
 * which would otherwise pass for an email field.
 */
function isSearchBox(el: HTMLInputElement): boolean {
  if (/search/.test(el.autocomplete.toLowerCase()) || el.getAttribute("role") === "searchbox") return true;
  return el.closest("search, [role=search]") !== null || /search/i.test(textOf(el));
}

function isTextLike(el: HTMLInputElement): boolean {
  return ["text", "email", "tel", ""].includes(el.type);
}

function tokens(el: HTMLInputElement): string[] {
  return el.autocomplete.toLowerCase().split(/\s+/);
}

function passwordFields(scope: ParentNode): HTMLInputElement[] {
  return Array.from(scope.querySelectorAll("input")).filter((input) => input.type === "password");
}

function ownText(form: HTMLFormElement): string {
  return [form.id, form.name, form.getAttribute("action") ?? "", form.className].join(" ");
}

function buttonText(form: HTMLFormElement): string {
  return Array.from(form.querySelectorAll<HTMLElement>("button, input[type=submit]"))
    .map((b) => (b instanceof HTMLInputElement ? b.value : (b.textContent ?? "")))
    .join(" ");
}

/** A form that creates an account, judged by its own attributes and its submit buttons. */
function looksLikeSignup(form: HTMLFormElement | null): boolean {
  if (!form) return false;
  const buttons = buttonText(form);
  return SIGNUP_HINT.test(`${ownText(form)} ${buttons}`) && !LOGIN_HINT.test(buttons);
}

/** A form that signs in, judged the same way (a sign-in's first step, before the password). */
function looksLikeLogin(form: HTMLFormElement | null): boolean {
  if (!form) return false;
  return LOGIN_HINT.test(`${ownText(form)} ${buttonText(form)}`);
}

/** A password field that should get a new password: sign-up, confirmation or change-password. */
export function isNewPasswordField(el: HTMLInputElement): boolean {
  if (el.type !== "password") return false;
  const autocomplete = tokens(el);
  if (autocomplete.includes("new-password")) return true;
  if (autocomplete.includes("current-password")) return false;
  const scope = el.form ?? el.ownerDocument;
  const all = passwordFields(scope);
  const marked = all.some((input) => tokens(input).includes("current-password"));
  // two password fields: password and confirmation; three: current, new and confirmation
  if (all.length === 2 && !marked) return true;
  if (all.length >= 3) return all.indexOf(el) > 0;
  return looksLikeSignup(el.form);
}

export function isPasswordField(el: HTMLInputElement): boolean {
  return el.type === "password" && !isNewPasswordField(el);
}

function inSignupForm(el: HTMLInputElement): boolean {
  const scope = el.form ?? el.ownerDocument;
  return passwordFields(scope).some(isNewPasswordField) || looksLikeSignup(el.form);
}

function hasPasswordFieldNearby(el: HTMLInputElement): boolean {
  const scope = el.form ?? el.ownerDocument;
  return passwordFields(scope).some((input) => isPasswordField(input));
}

function isEmailLike(el: HTMLInputElement): boolean {
  const autocomplete = tokens(el);
  return asksForEmail(el) || autocomplete.includes("email") || EMAIL_HINT.test(textOf(el));
}

/**
 * A username field: explicitly marked, username-like and next to a password field, or on its own
 * (a sign-in's first step, a forgot-password form) when it's named for the account or its form signs in.
 */
export function isUsernameField(el: HTMLInputElement): boolean {
  if (!isTextLike(el)) return false;
  const autocomplete = el.autocomplete.toLowerCase();
  if (/one-time-code|new-password|cc-|address|search/.test(autocomplete)) return false;
  if (tokens(el).includes("username")) return true;
  if (!hasPasswordFieldNearby(el)) {
    // the whole name or id only: "user[first_name]" or a label saying "Username" is no account field
    if (ACCOUNT_NAME.test(el.name) || ACCOUNT_NAME.test(el.id)) return true;
    return isEmailLike(el) && looksLikeLogin(el.form);
  }
  return autocomplete.includes("email") || asksForEmail(el) || USERNAME_HINT.test(textOf(el));
}

export function fieldKind(target: EventTarget | null): FieldKind | undefined {
  if (!(target instanceof HTMLInputElement) || target.disabled || target.readOnly) return undefined;
  if (target.type === "password") return isNewPasswordField(target) ? "new-password" : "login";
  if (!isTextLike(target)) return undefined;
  if (/one-time-code|cc-|address/.test(target.autocomplete.toLowerCase()) || isSearchBox(target)) return undefined;
  // on a sign-up form, the email field gets email suggestions instead of saved logins
  if (inSignupForm(target)) return isEmailLike(target) ? "email" : undefined;
  if (isUsernameField(target)) return "login";
  // any other email field (a newsletter, a contact form): the user's own emails, or Hide My Email
  return isEmailLike(target) ? "email" : undefined;
}

export function isLoginField(target: EventTarget | null): target is HTMLInputElement {
  return fieldKind(target) === "login";
}
