// Decides which inputs get the inline menu, and which kind. Conservative on purpose: a menu on a
// search box is noise, and suggesting saved logins on a sign-up form, or a new password on a login
// form, would be wrong. Any other email field (a newsletter, a contact form) gets email suggestions.
// A field asking for a sign-in's verification code gets the codes saved in Apple Passwords.

/**
 * "login": fill a saved login. "new-password": suggest a strong password. "email": suggest an email.
 * "one-time-code": fill a verification code.
 */
export type FieldKind = "login" | "new-password" | "email" | "one-time-code";

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

/** Says it wants a sign-in's verification code, whatever the field looks like. */
const CODE_LABEL =
  /one[\s_-]?time|(?<![a-z])(t?otp|2fa|mfa)(?![a-z])|two[\s_-]?(factor|step)|2[\s_-]?step|verification|authenticat(ion|or)|security[\s_-]?code|passcode/i;
/** Might be a verification code, if the field also takes a short number. Names use _ and - too. */
const MAYBE_CODE_LABEL = /(?<![a-z])code(?![a-z])|verify|token/i;
/** Codes of other kinds: payment cards, addresses, phones, offers, captchas, recovery codes. */
const NOT_CODE_LABEL =
  /card|cvc|cvv|csc|post(al)?[\s_-]?code|zip|phone|mobile|promo|coupon|voucher|gift|referral|invit|discount|area[\s_-]?code|country|captcha|recovery|backup/i;

/** Inputs a code goes into: text-like, or typed as a number. */
function takesCode(el: HTMLInputElement): boolean {
  return ["text", "tel", "number", ""].includes(el.type);
}

/** Asks for a short number: what a code field does even when it isn't named for one. */
function asksForShortNumber(el: HTMLInputElement): boolean {
  const pattern = el.getAttribute("pattern") ?? "";
  return (
    el.getAttribute("inputmode")?.toLowerCase() === "numeric" ||
    el.type === "number" ||
    el.type === "tel" ||
    (el.maxLength >= 4 && el.maxLength <= 8) ||
    /^(\\d|\[0-9\])/.test(pattern)
  );
}

/** The page says it's asking for a code: its title or headings, as on a two-factor step. */
function pageAsksForCode(doc: Document): boolean {
  const headings = Array.from(doc.querySelectorAll("h1, h2, h3"), (h) => h.textContent ?? "");
  return CODE_LABEL.test([doc.title, ...headings].join(" "));
}

/** On a payment form any short code is a card's (its CVC), never a sign-in's. */
function inPaymentForm(el: HTMLInputElement): boolean {
  const scope = el.form ?? el.ownerDocument;
  return Array.from(scope.querySelectorAll("input")).some((input) => /\bcc-/.test(input.autocomplete.toLowerCase()));
}

/**
 * The boxes of a code split into one box per digit, in order, when `el` is one of them: 4 to 8
 * one-character inputs under its parent or a close ancestor. Otherwise just `el`.
 */
export function oneTimeCodeGroup(el: HTMLInputElement): HTMLInputElement[] {
  if (el.maxLength !== 1) return [el];
  let scope: HTMLElement | null = el.parentElement;
  for (let depth = 0; scope && depth < 3; depth++, scope = scope.parentElement) {
    const boxes = Array.from(scope.querySelectorAll("input")).filter(
      (input) => input.maxLength === 1 && takesCode(input) && !input.disabled && !input.readOnly,
    );
    if (boxes.length >= 4 && boxes.length <= 8) return boxes;
  }
  return [el];
}

/** A field for a sign-in's verification code (from an authenticator, as Apple Passwords is one). */
export function isOneTimeCodeField(el: HTMLInputElement): boolean {
  if (!takesCode(el)) return false;
  if (tokens(el).includes("one-time-code")) return true;
  if (/cc-|address|tel|postal|email|username|password/.test(el.autocomplete.toLowerCase())) return false;
  if (NOT_CODE_LABEL.test(textOf(el)) || isSearchBox(el) || inPaymentForm(el)) return false;
  if (oneTimeCodeGroup(el).length > 1) return true;
  const text = textOf(el);
  if (CODE_LABEL.test(text)) return true;
  if (!asksForShortNumber(el)) return false;
  return MAYBE_CODE_LABEL.test(text) || pageAsksForCode(el.ownerDocument);
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
  if (isOneTimeCodeField(target)) return "one-time-code";
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
