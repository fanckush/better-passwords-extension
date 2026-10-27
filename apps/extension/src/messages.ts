// Messages to the background worker, from our extension pages (popup, inline menu) and, for one
// read-only question, from the autofill content script. Web pages never talk to the background.

import type { FieldKind } from "./autofill/fields.ts";
import type { CompanionState, CompanionUpdate } from "./companion.ts";
import type { FieldRules, PasswordStyle } from "./passwords/generate.ts";
import type { SessionStatus } from "./session/session.ts";

export type Request =
  | { type: "get-status" }
  | { type: "request-code"; fresh?: boolean }
  | { type: "verify-code"; code: string }
  /** Shows a code on the Mac, then lets the companion app enter it after Touch ID. */
  | { type: "unlock-with-touch-id" }
  /** `tabId` is required from the popup; the inline menu is always bound to its own tab. */
  | { type: "list-logins"; tabId?: number }
  | { type: "fill"; tabId: number; username: string }
  | { type: "lock" }
  /** Ends the session and restarts the extension, installing the version the browser downloaded. */
  | { type: "install-update" }
  | { type: "get-settings" }
  | { type: "set-settings"; settings: Partial<Settings> }
  // inline menu → background → content script of the same tab
  | { type: "fill-from-menu"; nonce: string; username: string }
  | { type: "menu-resize"; nonce: string; height: number }
  | { type: "menu-close"; nonce: string }
  | { type: "menu-focus-field"; nonce: string }
  /** A strong password and, when allowed, an alphanumeric alternative for the new-password field. */
  | { type: "generate-passwords"; nonce: string }
  /** Fills the chosen password; Apple Passwords is asked to save it when the form is submitted. */
  | { type: "use-generated-password"; nonce: string; style: PasswordStyle }
  // Hide My Email, on sign-up email fields (the menu is bound to its tab)
  | { type: "email-suggestions"; nonce: string }
  /** The user clicked the hint: turn Hide My Email on. */
  | { type: "enable-hide-my-email"; nonce: string }
  | { type: "dismiss-hide-my-email-hint" }
  | { type: "generate-hide-my-email"; nonce: string }
  /** Fills an address in; a new (generated) one is reserved for the site first. */
  | { type: "use-hide-my-email"; nonce: string; address: string; reserve: boolean }
  | { type: "open-icloud" }
  | { type: "open-icloud-plus" }
  /** Fills one of the user's own emails (from their contact card) in. */
  | { type: "fill-email"; nonce: string; email: string }
  | { type: "dismiss-companion-emails-hint" }
  | { type: "open-companion-page" }
  /** Opens the setup page in a tab (from the inline menu, before this browser is set up). */
  | { type: "open-setup-page" }
  /** The user has seen that setup worked; stop saying so. */
  | { type: "setup-seen" }
  /** Opens the Mac app's window (its setup), through its native host. */
  | { type: "open-companion-app" }
  /** Generated passwords for the tab's site whose update Apple Passwords couldn't confirm. */
  | { type: "unconfirmed-passwords"; tabId?: number }

  /** Opens Apple's Passwords app, searching for the tab's site when there is one. */
  | { type: "open-passwords-app"; tabId?: number }
  // content script → background (the only requests content scripts may send)
  | { type: "autofill-status"; kind: FieldKind }
  /** The username next to a password we generated (as it's typed). */
  | { type: "generated-username"; username: string }
  /** The field holding a password we generated went away (a dialog closed, a step moved on). */
  | { type: "generated-form-gone"; username: string }
  /** A form was sent with a password (not a generated one); saved once the page moves on. */
  | { type: "login-sent"; username: string; password: string }
  /** The user changed the password after sending it (the site said it was wrong): forget it. */
  | { type: "login-edited" }
  /** The field of the sent login went away (a dialog closed, a step moved on). */
  | { type: "login-form-gone" };

/** Requests content scripts are allowed to send. */
export const CONTENT_SCRIPT_REQUESTS: ReadonlySet<Request["type"]> = new Set([
  "autofill-status",
  "generated-username",
  "generated-form-gone",
  "login-sent",
  "login-edited",
  "login-form-gone",
]);

export interface Settings {
  /** End the session when the Mac locks or sleeps. */
  lockOnScreenLock: boolean;
  /** Suggestions when signing in: saved logins in login fields. */
  inlineMenu: boolean;
  /** Unlock with Touch ID through the companion app, when it is installed. */
  touchId: boolean;
  /** Suggestions when signing up: strong passwords, and the user's emails in email fields. */
  generatePasswords: boolean;
  /** Offer Hide My Email addresses on sign-up email fields (opt-in: uses icloud.com's web service). */
  hideMyEmail: boolean;
  /** Advertise Hide My Email in sign-up email fields until the user turns it on or dismisses it. */
  hideMyEmailHint: boolean;
  /** Advertise the companion app (for contact-card emails) until it's installed or dismissed. */
  companionEmailsHint: boolean;
  /** With the Mac app: suggest the emails on the user's contact card in sign-up email fields. */
  suggestEmails: boolean;
  /** Mention the companion app under the code box (it skips typing the code) until dismissed. */
  companionCodeHint: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  lockOnScreenLock: false,
  inlineMenu: true,
  touchId: true,
  generatePasswords: true,
  hideMyEmail: false,
  hideMyEmailHint: true,
  companionEmailsHint: true,
  suggestEmails: true,
  companionCodeHint: true,
};

export interface Status extends SessionStatus {
  /** The companion app, checked only while locked (unlocked sessions don't need it). */
  companion?: CompanionState;
  /** A newer companion app is out. */
  companionUpdate?: CompanionUpdate;
  /** A newer version of the extension, downloaded and waiting for the session to end. */
  extensionUpdate?: string;
  /** True when the user wants Touch ID and the companion is ready for it. */
  touchId?: boolean;
  /** This browser was just set up and hasn't been unlocked yet: say it worked, once. */
  justConnected?: boolean;
}

export interface LoginsResult {
  /** Undefined when the tab is not a page we fill (e.g. chrome:// or plain http). */
  hostname?: string;
  logins: { username: string }[];
  /** The login chosen on this sign-in's previous step (a username-only one); listed first. */
  chosen?: string;
}

export interface AutofillStatus {
  /**
   * "logins": saved logins exist for this site; "generate": suggest a new password;
   * "locked": pairing needed; "setup": this browser can't reach Apple Passwords yet;
   * "none": stay out of the way.
   */
  show: "logins" | "generate" | "email" | "locked" | "setup" | "none";
  /** For a menu to show: its nonce, which the background accepts from this tab's menu only. */
  nonce?: string;
}

export interface GeneratedPasswords {
  strong: string;
  alphanumeric?: string;
  /**
   * The account they'd be saved for when the form has no username (a password reset): the login
   * just chosen on this site, or its only one. macOS's save prompt has the final say.
   */
  account?: string;
}

/**
 * Hide My Email for a sign-up email field. "hint": not turned on yet, offer it; "ready": on, with
 * the address made for this site before, if any; "signed-out": no icloud.com sign-in in this browser.
 */
export type HideMyEmailState =
  | { state: "off" }
  | { state: "hint" }
  | { state: "signed-out" }
  /** The account has no Hide My Email; it has just been turned off. */
  | { state: "needs-icloud-plus" }
  | { state: "ready"; address?: string }
  | { state: "error"; message: string };

/**
 * The user's own emails, from their contact card through the companion app. "hint": no app yet,
 * suggest getting it; "needs-contacts": the app may not read Contacts.
 */
export type ContactEmailsState =
  | { state: "off" }
  | { state: "hint" }
  | { state: "needs-contacts" }
  | { state: "ready"; emails: string[] };

export interface EmailSuggestions {
  hideMyEmail: HideMyEmailState;
  contacts: ContactEmailsState;
}

export type NewPasswordResult = "filled" | "menu-hidden" | "no-fields" | "origin-mismatch";

/** What each request answers with. Requests not listed answer with the session status. */
interface Responses {
  "get-status": Status;
  "list-logins": LoginsResult;
  fill: { result: string };
  "fill-from-menu": { result: string };
  "get-settings": Settings;
  "set-settings": Settings;
  "autofill-status": AutofillStatus;
  "generate-passwords": GeneratedPasswords;
  "use-generated-password": { result: NewPasswordResult };
  "unconfirmed-passwords": { username: string; password: string }[];
  "email-suggestions": EmailSuggestions;
  "enable-hide-my-email": EmailSuggestions;
  "dismiss-hide-my-email-hint": null;
  "generate-hide-my-email": { address: string };
  "use-hide-my-email": { result: string };
  "open-icloud": null;
  "open-icloud-plus": null;
  "fill-email": { result: string };
  "dismiss-companion-emails-hint": null;
  "open-companion-page": null;
  "open-companion-app": null;
  "open-setup-page": null;
  "setup-seen": null;
  "menu-resize": null;
  "menu-close": null;
  "menu-focus-field": null;
  "open-passwords-app": null;
  "generated-username": null;
  "generated-form-gone": null;
  "login-sent": null;
  "login-edited": null;
  "login-form-gone": null;
}

export type Response<R extends Request> = R["type"] extends keyof Responses ? Responses[R["type"]] : Status;

/** Messages the background relays to the autofill content script. */
export type ContentMessage =
  /** `password` null: fill a username-only step, or answer "needs-password" (see fillCredentials). */
  | { type: "menu-fill"; nonce: string; origin: string; username: string; password: string | null }
  | { type: "menu-resize"; nonce: string; height: number }
  | { type: "menu-close"; nonce: string }
  /** Moves focus back to the field, keeping the menu open. */
  | { type: "menu-focus-field"; nonce: string }
  /** What the background needs before saving: the field's rules, the username, and whether the menu is visible. */
  | { type: "menu-new-password-context"; nonce: string }
  /** Fills a password that Apple Passwords has saved. */
  | { type: "menu-fill-new-password"; nonce: string; origin: string; password: string }
  /** Fills an email address into the field the menu was opened on. */
  | { type: "menu-fill-email"; nonce: string; origin: string; email: string }
  /** Apple Passwords has the generated password filled into this page. */
  | { type: "generated-password-saved"; password: string }
  /** Whether the sign-in with the login sent in this tab went through. Answered with a SignInState. */
  | { type: "sign-in-state" };

/**
 * "moved-on": the sign-in went through; "watching": the login's field is still shown, so the page
 * hasn't moved on yet; "failed": the page asks for a password again.
 */
export type SignInState = "moved-on" | "watching" | "failed";

/** Messages the inline menu receives without asking for them. */
export type MenuMessage =
  /**
   * Sent by the content script straight to the menu (the background ignores it): what the user
   * typed into the username field, so the menu lists only the logins it starts. Only the text goes
   * this way; usernames never reach the content script.
   */
  | { type: "menu-filter"; nonce: string; query: string }
  /**
   * Also from the content script: the user is typing a password of their own into the sign-in's
   * password field (or emptied it again). Only whether it's empty goes this way, never the text.
   */
  | { type: "menu-typing"; nonce: string; typing: boolean }
  /** Also from the content script: the menu sits above its field, so it lists its items bottom-up. */
  | { type: "menu-placement"; nonce: string; above: boolean }
  /** Sent by the background to every extension page when the session unlocks or locks (say, from the popup). */
  | { type: "session-changed"; unlocked: boolean };

export interface NewPasswordContext {
  rules: FieldRules;
  username: string;
  /** Whether the form has a username or email field, even an empty one (a sign-up does, a reset doesn't). */
  asksForUsername: boolean;
  visible: boolean;
}

/** Wire envelope, so errors cross the message boundary as data instead of being lost. */
export type Envelope<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

// The inline menu's nonce, sent with every request it makes (see bindToMenu).
let menuNonce: string | undefined;

/**
 * Called by the inline menu: its requests carry the nonce from its URL, which the background
 * accepts only if it issued that nonce to the content script of the same tab. A copy of menu.html
 * that a page frames itself has no such nonce, so the background refuses everything it asks.
 */
export function bindToMenu(nonce: string): void {
  menuNonce = nonce;
}

export async function send<R extends Request>(request: R): Promise<Response<R>> {
  const message = menuNonce === undefined ? request : { ...request, menuNonce };
  const reply = (await browser.runtime.sendMessage(message)) as Envelope<Response<R>> | undefined;
  if (!reply) throw new Error("no reply from the background worker");
  if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code });
  return reply.value;
}
