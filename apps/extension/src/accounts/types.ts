// What the extension needs from a password manager, whichever it is. Each connected account (an
// instance of a provider: Apple Passwords, later others, maybe two of the same) is one Account. The
// rest of the extension talks to accounts through the registry (registry.ts) and never asks which
// provider one is: adapters handle their provider's quirks, and say what they can do.

/**
 * Where an account is, in words any provider can use. "needs-setup": this browser can't reach it
 * yet; "unavailable": it can't be used here (for Apple, macOS won't start its helper in this
 * browser); "offline": not connected right now; "unlocking": an unlock is under way (a code is on
 * screen, say).
 */
export type AccountState = "needs-setup" | "unavailable" | "offline" | "locked" | "unlocking" | "unlocked";

export interface AccountStatus {
  state: AccountState;
  error?: string;
  /** Unavailable as an earlier background worker found, not by trying just now. */
  remembered?: true;
}

/** A tab and frame the request is for. Adapters that don't need one ignore it. */
export interface Tab {
  tabId: number;
  frameId?: number;
}

/** A saved login, without its password. `id` names it within its account. */
export interface LoginItem {
  id: string;
  username: string;
}

export interface Credential {
  username: string;
  password: string;
}

/** A verification code the account can give for a site, without its digits. */
export interface OneTimeCodeItem {
  id: string;
  username: string;
  domain: string;
}

/**
 * How an account unlocks, as pages see it: they show the matching screen. "pairing-code": the
 * account shows a code elsewhere (Apple's window on the Mac) that is typed in here; `touchId`
 * when the companion app can enter it after Touch ID instead.
 */
export type UnlockMethod = { kind: "pairing-code"; digits: number; touchId?: boolean } | { kind: "password" };

/** Unlocking with a code shown elsewhere (see UnlockMethod). */
export interface PairingCodeUnlock {
  kind: "pairing-code";
  digits: number;
  /** Shows a code, unless one is on screen or the account is unlocked; `fresh` replaces a shown one. */
  requestCode(fresh: boolean): Promise<void>;
  verifyCode(code: string): Promise<void>;
  /** Whether the companion app can enter the code after Touch ID now. */
  touchIdReady?(): Promise<boolean>;
  unlockWithTouchId?(): Promise<void>;
}

/** Unlocking with a password typed into the extension. */
export interface PasswordUnlock {
  kind: "password";
  unlock(password: string): Promise<void>;
}

export type Unlock = PairingCodeUnlock | PasswordUnlock;

/** What an account can do besides listing and filling logins. */
export interface Capabilities {
  oneTimeCodes: boolean;
  savePasswords: boolean;
  /** Opening the provider's own app (or web vault), at the site's logins if given. */
  openApp: boolean;
  /**
   * The provider asks the user before it saves a login (macOS does, for Apple Passwords). Accounts
   * that don't get our own prompt on the page instead: never both.
   */
  asksBeforeSaving: boolean;
}

/** Options that differ per account. Each adapter knows which apply to it. */
export interface AccountSettings {
  /** Lock this account when the computer locks or sleeps. */
  lockOnScreenLock: boolean;
  /** Unlock with Touch ID through the companion app, when the account and app allow it. */
  touchId: boolean;
  /** Lock after this many minutes unused, for accounts the extension unlocks; 0: when the browser quits. */
  lockAfterMinutes: number;
}

/** An account as the extension's pages see it (in Status). */
export interface AccountView extends AccountStatus {
  id: string;
  provider: string;
  label: string;
  detail?: string;
  unlock: UnlockMethod;
  capabilities: Capabilities;
  settings: AccountSettings;
}

export interface Account {
  readonly id: string;
  /** Which adapter this is, for storage and display. Never branched on outside the adapter. */
  readonly provider: string;
  /** How the account is named to the user. */
  readonly label: string;
  /** What tells it apart from others of its provider (the email it signs in with). */
  readonly detail?: string | undefined;
  readonly capabilities: Capabilities;
  readonly unlock: Unlock;
  readonly status: AccountStatus;
  readonly isUnlocked: boolean;
  onChange(listener: (status: AccountStatus) => void): () => void;
  /** Called when the account has a new verification code (one that just arrived by SMS, say). */
  onOneTimeCodesChanged(listener: () => void): () => void;
  /** Called when its logins changed (a sync brought ones added elsewhere), for accounts that sync. */
  onLoginsChanged?(listener: () => void): () => void;

  /** Connects without unlocking. `retry`: the user asked, after the account was unavailable. */
  connect(options?: { retry?: boolean }): Promise<void>;
  lock(): void;
  /** Forgets the account in this browser (signs out), when it's removed. */
  remove?(): Promise<void>;
  /** Locks if it went unused longer than its settings allow (for accounts the extension unlocks). */
  lockIfIdle?(): Promise<void>;

  /**
   * The logins saved for the page at `page`. Most providers match its hostname; some (Bitwarden)
   * let a login match only certain paths, so the whole URL is given.
   */
  logins(page: URL, tab?: Tab): Promise<LoginItem[]>;
  /** One login (no password) by id, if it's still saved for the page. */
  login(page: URL, id: string): Promise<LoginItem | undefined>;
  /** A login's password: the provider may ask the user first (Touch ID). */
  credential(page: URL, id: string, tab: Tab): Promise<Credential | undefined>;
  /** The verification codes it has for a page, without digits. */
  oneTimeCodes(url: URL, tab?: Tab): Promise<OneTimeCodeItem[]>;
  /** A code's digits, current now: the provider may ask the user first. */
  oneTimeCode(url: URL, id: string, tab: Tab): Promise<string | undefined>;
  /** Saves a login: a new one, or a new password for a saved one. The provider may ask first. */
  save(login: { hostname: string; username: string; password: string }, tab: Tab): Promise<void>;
  /** Opens the provider's app or web vault; `url`: a page, to show its site's logins. */
  openApp(url?: string): Promise<void>;
}
