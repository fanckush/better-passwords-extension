// Messages to the background worker, from our extension pages (popup, inline menu) and, for one
// read-only question, from the autofill content script. Web pages never talk to the background.

import type { LoginRef } from "./accounts/registry.ts";
import type { AccountSettings, AccountView } from "./accounts/types.ts";
import type { FieldKind } from "./autofill/fields.ts";
import type { CompanionState, CompanionUpdate } from "./companion.ts";
import type { FieldRules, PasswordStyle, Strength, Suggestion } from "./passwords/generate.ts";

/** The port the popup holds while it's on screen, so the background knows whether it's closed. */
export const POPUP_PORT = "popup";

/** Bitwarden's cloud ("us", "eu"), or a self-hosted server by its address. */
export type BitwardenServer = "us" | "eu" | { url: string };

/** What the save card asks about: a new login, or a new password for a saved one. */
export interface SaveCardDetails {
  hostname: string;
  username: string;
  update: boolean;
  /** The account it would be saved to. */
  account: string;
}

export type SaveCardAnswer = "save" | "not-now" | "never";

export interface BitwardenSignIn {
  server: BitwardenServer;
  email: string;
  password: string;
  twoFactor?: { provider: number; code: string; remember?: boolean };
  newDeviceCode?: string;
}

/** What a Bitwarden sign-in needs next: nothing (signed in, as `account`), or a code. */
export type BitwardenSignInStep =
  | { status: "signed-in"; account: string }
  | { status: "two-factor"; providers: number[]; email?: string }
  | { status: "new-device" };

export type Request =
  | { type: "get-status" }
  // Unlocking an account with a code shown elsewhere (see UnlockMethod). `account`: which one; by
  // default the first account that unlocks this way.
  | { type: "request-code"; fresh?: boolean; account?: string }
  | { type: "verify-code"; code: string; account?: string }
  /** Shows a code on the Mac, then lets the companion app enter it after Touch ID. */
  | { type: "unlock-with-touch-id"; account?: string }
  /** `tabId` is required from the popup; the inline menu is always bound to its own tab. */
  | { type: "list-logins"; tabId?: number }
  /** `ref`: a login from list-logins. */
  | { type: "fill"; tabId: number; ref: string }
  /** Verification codes saved for the tab's site, without digits (see OneTimeCodesResult). */
  | { type: "list-one-time-codes"; tabId?: number }
  /** Fills a code into the tab's code field (from the popup); macOS asks for Touch ID first. */
  | { type: "fill-one-time-code"; tabId: number; id: string }
  /** The code's digits, for the popup to copy; macOS asks for Touch ID first. */
  | { type: "copy-one-time-code"; tabId: number; id: string }
  /** Locks one account, or every account. */
  | { type: "lock"; account?: string }
  /** Unlocks an account that takes a password (see UnlockMethod). Never from the inline menu. */
  | { type: "unlock-with-password"; account: string; password: string }
  /**
   * Signs in to Bitwarden: a new account, or `account` again. Answers with the next step (a code to
   * ask for), or the account signed in. Never from the inline menu.
   */
  | ({ type: "bitwarden-sign-in"; account?: string } & BitwardenSignIn)
  /** The server a Bitwarden account signs in to (null: not known), to sign in there again. */
  | { type: "bitwarden-server"; account: string }
  /** Asks Bitwarden to email a two-step login code. */
  | { type: "bitwarden-send-email-code"; server: BitwardenServer; email: string; password: string }
  /** Removes an account from this browser: it's locked, and signed out if it signs in. */
  | { type: "remove-account"; account: string }
  // the save card (save.html), with the nonce the background gave its tab's content script
  | { type: "save-card"; nonce: string }
  | { type: "save-card-answer"; nonce: string; answer: SaveCardAnswer }
  | { type: "save-card-resize"; nonce: string; height: number }
  /** Adds an account that needs no sign-in here (Apple Passwords, removed earlier). */
  | { type: "add-account"; provider: string }
  /** The accounts and their states, without connecting any (the inline menu asks on every open). */
  | { type: "list-accounts" }
  /**
   * From the inline menu: unlock an account that takes a password, in the popup (or a small window
   * where the popup can't open), never in the menu on the web page.
   */
  | { type: "open-unlock"; account: string }
  /** Ends the session and restarts the extension, installing the version the browser downloaded. */
  | { type: "install-update" }
  | { type: "get-settings" }
  | { type: "set-settings"; settings: Partial<Settings> }
  | { type: "set-account-settings"; account: string; settings: Partial<AccountSettings> }
  // inline menu → background → content script of the same tab
  | { type: "fill-from-menu"; nonce: string; ref: string }
  | { type: "fill-one-time-code-from-menu"; nonce: string; id: string }
  | { type: "menu-resize"; nonce: string; height: number }
  | { type: "menu-close"; nonce: string }
  | { type: "menu-focus-field"; nonce: string }
  /** Fresh passwords for the new-password field the menu was opened on, as strong as its rules allow. */
  | { type: "generate-passwords"; nonce: string }
  /** Fills the chosen password; Apple Passwords is asked to save it when the form is submitted. */
  | { type: "use-generated-password"; nonce: string; style: PasswordStyle }
  // Hide My Email, on email fields (the menu is bound to its tab)
  /** `logins`: the site's saved logins too (an email field that may sign in). */
  | { type: "email-suggestions"; nonce: string; logins?: boolean }
  /**
   * The user clicked the hint: turn Hide My Email on. Firefox first needs the user's OK to send data
   * to iCloud, which the menu can't ask for: the popup opens to ask, and the menu hears back (see
   * MenuMessage "hide-my-email-changed").
   */
  | { type: "enable-hide-my-email"; nonce: string }
  /** The popup, as it opens: whether it was opened to ask for Hide My Email's permissions. */
  | { type: "popup-intent" }
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
  /** Tries an unavailable account again (Apple's helper, after macOS blocked it in this browser). */
  | { type: "retry-connection"; account?: string }
  /** Generated passwords for the tab's site whose update Apple Passwords couldn't confirm. */
  | { type: "unconfirmed-passwords"; tabId: number }
  /** Asks Apple Passwords again to save one of them (from the popup); macOS shows its prompt. */
  | { type: "save-unconfirmed-password"; tabId: number; id: string }

  /** "Show browser passkey list": the field the menu is on shows the browser's list once (see passkey-list.ts). */
  | { type: "menu-show-passkeys"; nonce: string }

  /** Opens the password manager's app (Apple's Passwords), at the tab's site when there is one. */
  /** Opens an account's app or web vault (`account`; by default the first with one), at the tab's site. */
  | { type: "open-passwords-app"; tabId?: number; account?: string }
  // content script → background (the only requests content scripts may send)
  /** `unsure`: a password field that may be a sign-up's (see isUnsurePasswordField). */
  /** `signIn`: an email field that may sign in (see maySignIn), which lists the site's logins. */
  | { type: "autofill-status"; kind: FieldKind; unsure?: boolean; signIn?: boolean }
  /** Minimal mode: which of these fields get its icon (those that would get a menu); none with it off. */
  | { type: "menu-icons"; fields: { kind: FieldKind; signIn: boolean }[] }
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
  "menu-icons",
  "generated-username",
  "generated-form-gone",
  "login-sent",
  "login-edited",
  "login-form-gone",
]);

/** Options for the whole extension. Those of each account are in AccountSettings. */
export interface Settings {
  /** Suggestions when signing in: saved logins in login fields. */
  inlineMenu: boolean;
  /** Suggestions in verification code fields: the codes saved in the password manager. */
  oneTimeCodes: boolean;
  /** Suggestions when signing up: strong passwords, and the user's emails in email fields. */
  generatePasswords: boolean;
  /** Offer Hide My Email addresses on email fields (opt-in: uses icloud.com's web service). */
  hideMyEmail: boolean;
  /** Advertise Hide My Email in email fields until the user turns it on or dismisses it. */
  hideMyEmailHint: boolean;
  /** Advertise the companion app (for contact-card emails) until it's installed or dismissed. */
  companionEmailsHint: boolean;
  /** With the Mac app: suggest the emails on the user's contact card in email fields. */
  suggestEmails: boolean;
  /** Mention the companion app under the code box (it skips typing the code) until dismissed. */
  companionCodeHint: boolean;
  /**
   * Chromium: hide the browser's passkey list on login fields, where the inline menu offers to show
   * it (see passkey-list.ts). Takes effect on the next page load.
   */
  hidePasskeyList: boolean;
  /**
   * Minimal mode: suggestions never open by themselves. An icon at the end of the focused field
   * opens them, or ↓.
   */
  minimalMode: boolean;
  /** The account new logins are saved to (its id); empty: the first unlocked account that saves. */
  saveNewLoginsTo: string;
}

export const DEFAULT_SETTINGS: Settings = {
  inlineMenu: true,
  oneTimeCodes: true,
  generatePasswords: true,
  hideMyEmail: false,
  hideMyEmailHint: true,
  companionEmailsHint: true,
  suggestEmails: true,
  companionCodeHint: true,
  hidePasskeyList: true,
  minimalMode: false,
  saveNewLoginsTo: "",
};

/** Settings keys kept per account now, which older versions kept in Settings (see AccountsStore.legacy). */
export const LEGACY_ACCOUNT_SETTINGS = [
  "lockOnScreenLock",
  "touchId",
] as const satisfies readonly (keyof AccountSettings)[];

export interface Status {
  /** The accounts filled from, in order. Today one: Apple Passwords. */
  accounts: AccountView[];
  /** The companion app, checked only while locked (unlocked sessions don't need it). */
  companion?: CompanionState;
  /** A newer companion app is out. */
  companionUpdate?: CompanionUpdate;
  /** A newer version of the extension, downloaded and waiting for the session to end. */
  extensionUpdate?: string;
  /** This browser was just set up and hasn't been unlocked yet: say it worked, once. */
  justConnected?: boolean;
}

/**
 * The account Apple's setup flow is about: the one set up on the computer, which unlocks with a code
 * it shows (whatever was added before it). None (removed, or no answer) reads as "not set up".
 */
export function appleAccount(status: Status | undefined): AccountView | { state: "needs-setup"; error?: string } {
  return status?.accounts.find((a) => a.unlock.kind === "pairing-code") ?? { state: "needs-setup" };
}

export interface LoginsResult {
  /** Undefined when the tab is not a page we fill (e.g. chrome:// or plain http). */
  hostname?: string;
  logins: LoginRef[];
  /** The ref of the login chosen on this sign-in's previous step (a username-only one); listed first. */
  chosen?: string;
}

/** A verification code as pages of the extension see it: never its digits, which need Touch ID. */
export interface OneTimeCodeView {
  /** Names the code (and its account) in requests to fill or copy it; the background looks it up again then. */
  id: string;
  username: string;
  domain: string;
}

export interface OneTimeCodesResult {
  /** Undefined when the tab is not a page we fill (e.g. chrome:// or plain http). */
  hostname?: string;
  codes: OneTimeCodeView[];
  /** The account just signed in with in this tab, if known; its code is listed first. */
  signedInAs?: string;
}

export interface AutofillStatus {
  /**
   * "logins": saved logins exist for this site; "generate": suggest a new password;
   * "codes": a verification code field; "locked": unlocking needed; "setup": this browser can't
   * reach the password manager yet; "none": stay out of the way.
   */
  show: "logins" | "generate" | "email" | "codes" | "locked" | "setup" | "none";
  /** For a menu to show: its nonce, which the background accepts from this tab's menu only. */
  nonce?: string;
  /** A field that may be a sign-up's: with no saved logins, suggest a strong password instead. */
  orGenerate?: boolean;
}

export interface GeneratedPasswords {
  strong: Suggestion;
  /** Left out when the site's rules need a special character, or the strong one has none anyway. */
  alphanumeric?: Suggestion;
  /**
   * The account they'd be saved for when the form has no username (a password reset): the login
   * just chosen on this site, or its only one. macOS's save prompt has the final say.
   */
  account?: string;
}

/**
 * Hide My Email for an email field. "hint": not turned on yet, offer it; "ready": on, with
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
  /**
   * The logins saved for the site, when unlocked: an email field nothing marks as a sign-in's may
   * still be one (a sign-in by emailed code, or one page for signing in and up), so like Safari
   * they're listed first (none saved: the menu says so, as on a login field). "locked": none can be
   * listed until unlocked, so the menu offers that first.
   */
  logins?: { state: "ready"; hostname: string; logins: LoginRef[] } | { state: "locked" };
}

export type NewPasswordResult = "filled" | "menu-hidden" | "no-fields" | "origin-mismatch";

/** What each request answers with. Requests not listed answer with the session status. */
interface Responses {
  "get-status": Status;
  "list-logins": LoginsResult;
  fill: { result: string };
  "fill-from-menu": { result: string };
  "list-one-time-codes": OneTimeCodesResult;
  "fill-one-time-code": { result: string };
  "copy-one-time-code": { code: string };
  "fill-one-time-code-from-menu": { result: string };
  "get-settings": Settings;
  "set-settings": Settings;
  "set-account-settings": AccountSettings;
  "autofill-status": AutofillStatus;
  "menu-icons": boolean[];
  /** `unavailable`: why the site's rules leave nothing worth suggesting. */
  "generate-passwords": GeneratedPasswords | { unavailable: string };
  "use-generated-password": { result: NewPasswordResult };
  /** Without the passwords: the popup only shows who they're for. */
  "unconfirmed-passwords": { id: string; username: string }[];
  "save-unconfirmed-password": null;
  "email-suggestions": EmailSuggestions;
  /** `asking`: the popup (or, if it can't open, a small window) asks for Firefox's permission. */
  "enable-hide-my-email": EmailSuggestions | { asking: true };
  /** `unlock`: the account the inline menu asked to unlock, which the popup opens to. */
  "popup-intent": { hideMyEmailConsent: boolean; unlock?: string };
  "bitwarden-sign-in": BitwardenSignInStep;
  "bitwarden-server": BitwardenServer | null;
  "bitwarden-send-email-code": null;
  "add-account": Status;
  "list-accounts": AccountView[];
  "open-unlock": null;
  "save-card": SaveCardDetails;
  "save-card-answer": { saved: boolean };
  "save-card-resize": null;
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
  "menu-show-passkeys": null;
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
  | { type: "menu-fill-new-password"; nonce: string; origin: string; password: string; strength: Strength }
  /** Fills an email address into the field the menu was opened on. */
  | { type: "menu-fill-email"; nonce: string; origin: string; email: string }
  /** Whether the menu is (still) visible: asked before Touch ID, so a hidden menu never prompts. */
  | { type: "menu-visible"; nonce: string }
  /** Fills a verification code into the field the menu was opened on. */
  | { type: "menu-fill-one-time-code"; nonce: string; origin: string; code: string }
  /** Fills a verification code chosen in the popup into the page's code field. */
  | { type: "fill-one-time-code"; origin: string; code: string }
  /** Apple Passwords has the generated password filled into this page. */
  | { type: "generated-password-saved"; password: string }
  /** Shows the browser's passkey list once on the field the menu is on (see passkey-list.ts). */
  | { type: "menu-show-passkeys"; nonce: string }
  /** Whether the sign-in with the login sent in this tab went through. Answered with a SignInState. */
  | { type: "sign-in-state" }
  /** Shows the card asking to save a login (top frame only; see SaveCardHost). */
  | { type: "show-save-card"; nonce: string }
  | { type: "save-card-resize"; nonce: string; height: number }
  | { type: "save-card-close"; nonce: string };

/**
 * "moved-on": the sign-in went through; "watching": the login's field is still shown, so the page
 * hasn't moved on yet; "failed": the page asks for a password again.
 */
export type SignInState = "moved-on" | "watching" | "failed";

/** Messages the inline menu receives without asking for them. */
export type MenuMessage =
  /**
   * Sent by the content script straight to the menu (the background ignores it): what the user
   * typed into the username (or email) field, so the menu lists only the logins (or
   * addresses) it starts. Only the text goes this way; usernames never reach the content script.
   * `asked`: the user clicked the field (or its label) or pressed ↓, so the menu shows even with
   * nothing saved (see the `quiet` menu option).
   */
  | { type: "menu-filter"; nonce: string; query: string; asked?: boolean }
  /**
   * Also from the content script: the user is typing a password of their own into the sign-in's
   * password field (or emptied it again). Only whether it's empty goes this way, never the text.
   */
  | { type: "menu-typing"; nonce: string; typing: boolean }
  /** Also from the content script: the menu sits above its field, so it lists its items bottom-up. */
  | { type: "menu-placement"; nonce: string; above: boolean }
  /**
   * Also from the content script: the browser's passkey list was hidden on the menu's field after
   * the menu opened (the page tagged it later, as GitHub does), so the menu offers to show it now.
   */
  | { type: "menu-passkeys"; nonce: string }
  /**
   * Sent by the background to every extension page when an account unlocks or locks (say, from the
   * popup). `unlocked`: whether any account is unlocked now.
   */
  | { type: "accounts-changed"; unlocked: boolean }
  /** Sent by the background when an account has a new verification code: list them again. */
  | { type: "one-time-codes-changed" }
  /** An account's logins changed by themselves (synced from elsewhere): list them again. */
  | { type: "logins-changed" }
  /** Sent by the background to the menu that asked to turn Hide My Email on: it was, or the user said no. */
  | { type: "hide-my-email-changed" };

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
