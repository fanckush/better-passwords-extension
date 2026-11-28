import type { ScriptPublicPath } from "wxt/utils/inject-script";
import { APPLE_PROVIDER, appleDefaultSettings } from "@/src/accounts/apple/account.ts";
import { createAppleAccount } from "@/src/accounts/apple/index.ts";
import { BITWARDEN_PROVIDER, BitwardenAccount, createBitwardenAccount } from "@/src/accounts/bitwarden/index.ts";
import { Accounts, type AccountsStore, type Entry, type StoredAccount, siteUrl } from "@/src/accounts/registry.ts";
import type { Account, AccountSettings, AccountState } from "@/src/accounts/types.ts";
import { HME_CONSENT_PORT, hasHideMyEmailConsent } from "@/src/aliases/icloud/consent.ts";
import { ICloudAliases } from "@/src/aliases/icloud/provider.ts";
import type { FieldKind } from "@/src/autofill/fields.ts";
import { Companion } from "@/src/companion.ts";
import { fillCredentials } from "@/src/fill.ts";
import {
  type AutofillStatus,
  type BitwardenSignInStep,
  CONTENT_SCRIPT_REQUESTS,
  type ContactEmailsState,
  type ContentMessage,
  DEFAULT_SETTINGS,
  type EmailSuggestions,
  type Envelope,
  type GeneratedPasswords,
  type HideMyEmailState,
  LEGACY_ACCOUNT_SETTINGS,
  type MenuMessage,
  type NewPasswordContext,
  type NewPasswordResult,
  type OneTimeCodesResult,
  POPUP_PORT,
  type Request,
  type Settings,
  type SignInState,
  type Status,
} from "@/src/messages.ts";
import {
  allowsSpecialCharacters,
  generatePassword,
  PasswordRulesError,
  type Suggestion,
} from "@/src/passwords/generate.ts";
import { oneTimeCodeViews } from "@/src/passwords/one-time-codes.ts";
import { withSiteRules } from "@/src/passwords/site-rules.ts";
import { waitForLogin } from "@/src/passwords/wait-for-login.ts";
import { platform } from "@/src/platform.ts";
import { isSameSiteFrame } from "@/src/same-site-frame.ts";
import { toolbarAction } from "@/src/toolbar.ts";
import { PendingUpdate } from "@/src/updates.ts";
import { fillableUrl, frameOriginToFill, sameFillableOrigin } from "@/src/url-policy.ts";

const KEEP_ALIVE = "keep-alive";

/** Apple Passwords' account, which every install starts with (see Accounts). */
const APPLE_ACCOUNT = "apple";

/**
 * A Bitwarden account's options until the user changes them. It gives out passwords without
 * asking once unlocked, so it locks with the computer; Touch ID isn't for it.
 */
const BITWARDEN_DEFAULTS: AccountSettings = { lockOnScreenLock: true, touchId: false, lockAfterMinutes: 0 };

/** A generated password filled into a tab, until the password manager has it. */
interface GeneratedLogin {
  hostname: string;
  password: string;
  /** Saved with this username when the form has none (see GeneratedPasswords.account). */
  account?: string;
  /** "unsaved": not asked yet, or the user declined; "saving": macOS's prompt is up. */
  state: "unsaved" | "saving" | "saved";
  /** The username it was (or is being) saved with. */
  username?: string;
  /** The username in the form, as the user types it. */
  formUsername: string;
  /** Whether the password manager was asked already: once per generated password. */
  asked: boolean;
  /** The frame it was filled in. */
  frameId: number;
}

/** A login sent with a form (not a generated one), until the page moves on and it's saved (or dropped). */
interface SentLogin {
  hostname: string;
  password: string;
  /** The account to save it as: its spelling in the password manager if saved there; undefined when unknown. */
  saveAs: Promise<string | undefined>;
  /** The page is being asked whether the sign-in went through (the field went away while the tab navigated). */
  checking: boolean;
  /** The frame it was sent from. */
  frameId: number;
}

/** How long a sent login waits for the page to move on before it's forgotten. */
const SENT_LOGIN_MS = 60_000;

/**
 * Tabs whose sign-in is in a frame on another host of the page's site (see isSameSiteFrame), with
 * the frame's address, from when the frame last asked until the page's own fields do. Those tabs are
 * filled for the frame: it's the frame that gets the password, and the frame's host it's saved for.
 */
const signInFrames = new Map<number, URL>();

export default defineBackground(() => {
  // the companion app is Mac only; elsewhere it's never asked, nor offered
  const companion = new Companion(undefined, undefined, async () => (await platform()) === "mac");

  /** Makes the account a stored entry names: each provider's adapter, wired into the browser. */
  function accountEntry({ id, provider }: Pick<StoredAccount, "id" | "provider">): Entry | undefined {
    if (provider === APPLE_PROVIDER) {
      return {
        account: createAppleAccount(id, companion),
        defaults: async () => appleDefaultSettings(await platform()),
      };
    }
    if (provider === BITWARDEN_PROVIDER) {
      const account = createBitwardenAccount(id, async () => (await accounts.settings(id)).lockAfterMinutes);
      // only reads storage: a new worker finds an unlocked vault unlocked still
      void account.connect().catch(() => {});
      return { account, defaults: async () => BITWARDEN_DEFAULTS };
    }
    return undefined;
  }

  const accounts = new Accounts([], accountsStore(), {
    create: accountEntry,
    initial: [{ id: APPLE_ACCOUNT, provider: APPLE_PROVIDER }],
    saveTo: async () => (await getSettings()).saveNewLoginsTo || undefined,
  });
  // moves options kept from before accounts existed to the account now, before anything changes them
  void accounts.views().catch(() => {});

  // An open native port keeps the worker alive in Chrome 105+; the alarm is a fallback that
  // wakes it if the browser suspends it anyway. Nothing to do on wake: state lives in memory.
  accounts.onChange(() => {
    if (accounts.anyUnlocked) void browser.alarms.create(KEEP_ALIVE, { periodInMinutes: 0.5 });
    else if (!accounts.busy) void browser.alarms.clear(KEEP_ALIVE);
  });
  // also when accounts the extension unlocks lock for sitting unused (see AccountSettings.lockAfterMinutes)
  browser.alarms.onAlarm.addListener(() => {
    for (const account of accounts.unlocked) void account.lockIfIdle?.().catch(() => {});
  });

  // An account unlocked or locked. Locking forgets every generated and sent password, like the
  // session key. Open menus asked before an unlock (or a lock) elsewhere, e.g. the code typed into
  // the popup: tell them, so they show what they would now.
  const unlockedAccounts = new Set<string>();
  accounts.onChange((account, { state }) => {
    if (state !== "unlocked") forgetPasswords();
    if ((state === "unlocked") === unlockedAccounts.has(account.id)) return;
    if (state === "unlocked") unlockedAccounts.add(account.id);
    else unlockedAccounts.delete(account.id);
    tellMenus({ type: "accounts-changed", unlocked: accounts.anyUnlocked });
  });

  // A new verification code (one that just arrived by SMS, say): open menus and the popup list again
  accounts.onOneTimeCodesChanged(() => tellMenus({ type: "one-time-codes-changed" }));
  accounts.onLoginsChanged(() => tellMenus({ type: "logins-changed" }));

  // Remembered while this browser can't reach an account, so the first connection after setup is
  // announced once (by the popup or the setup page), even if the popup closed in between.
  const SETUP_PENDING = "setupPending";
  // Only accounts set up on the computer (Apple's helper) count: one that's signed in to (Bitwarden)
  // has no setup to announce.
  accounts.onChange((account, { state }) => {
    if (account.unlock.kind === "password") return;
    if (state === "needs-setup") void browser.storage.local.set({ [SETUP_PENDING]: true });
    else if (state === "unlocked") void browser.storage.local.remove(SETUP_PENDING);
  });

  // An account that can't be used in this browser (for Apple, macOS blocks its helper here) marks
  // the toolbar button; the popup explains
  const action = toolbarAction();
  let badged = false;
  accounts.onChange(() => {
    const unavailable = accounts.all.some(({ status }) => status.state === "unavailable");
    if (unavailable === badged) return;
    badged = unavailable;
    void action?.setBadgeText({ text: unavailable ? "!" : "" });
    if (unavailable) void action?.setBadgeBackgroundColor({ color: "#e8a33d" });
  });

  /** Accounts that can be unlocked here (set up, and not refused by the system). */
  const unlockable = (account: Account) => !CANT_UNLOCK.includes(account.status.state);

  // A fresh install that can't reach an account yet opens the setup page (where the user picks a
  // password manager), so nobody has to find the toolbar button first; so does one that can't be
  // used here, which explains it. A computer that is set up already (a reinstall) sees nothing.
  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason !== "install") return;
    await accounts.connect(["offline", "needs-setup"]);
    if (!accounts.all.every(unlockable)) await openSetupPage();
  });

  function openSetupPage() {
    return browser.tabs.create({ url: browser.runtime.getURL("/setup.html") });
  }

  // A downloaded version installs when that loses nothing: right away while locked, else once the
  // session ends, or when the user asks in the popup. One waiting a day takes the user's next break
  // (Firefox on macOS reports no screen lock, so an hour away counts too).
  const updates = new PendingUpdate({
    busy: () => accounts.busy,
    restart: () => browser.runtime.reload(),
  });
  browser.runtime.onUpdateAvailable.addListener(({ version }) => updates.available(version));
  accounts.onChange(() => updates.applyIfHarmless());
  browser.idle.setDetectionInterval(60 * 60);

  browser.idle.onStateChanged.addListener(async (state) => {
    if (state === "active") return;
    if (updates.overdue) return accounts.lock();
    if (state !== "locked") return;
    for (const account of accounts.all) {
      if ((await accounts.settings(account.id)).lockOnScreenLock) accounts.lock(account.id);
    }
  });

  // Chromium leaves open tabs without the content script after an update; Firefox injects it itself.
  // The old copy notices the new one and gets out of the way (WXT's ContentScriptContext).
  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason !== "update" || import.meta.env.FIREFOX) return;
    for (const script of browser.runtime.getManifest().content_scripts ?? []) {
      const tabs = await browser.tabs.query({ url: script.matches ?? [] });
      for (const { id } of tabs) {
        if (id === undefined) continue;
        void browser.scripting
          .executeScript({ target: { tabId: id, allFrames: true }, files: (script.js ?? []) as ScriptPublicPath[] })
          .catch(() => {});
      }
    }
  });

  // For trying the update flow in a local build: WXT_SIMULATE_UPDATE=9.9.9 announces that version
  // on the first unlock, once per profile; "installing" it restarts the extension as it is.
  const simulated = import.meta.env.WXT_SIMULATE_UPDATE as string | undefined;
  if (simulated) {
    accounts.onChange(async (_, { state }) => {
      if (state !== "unlocked" || updates.version) return;
      if ((await browser.storage.local.get("simulatedUpdate")).simulatedUpdate) return;
      await browser.storage.local.set({ simulatedUpdate: true });
      updates.available(simulated);
    });
  }

  const status = async (): Promise<Status> => ({ accounts: await accounts.views() });

  /** Status plus the companion app's, and what the popup should say about setup and updates. */
  async function fullStatus(): Promise<Status> {
    const base = await status();
    // before setup, the companion isn't asked
    if (!base.accounts.some(unlockableView)) return base;
    const state = await companion.state();
    const update = await companion.update();
    const connected = base.accounts.some(
      (a) => a.unlock.kind !== "password" && (a.state === "locked" || a.state === "unlocking"),
    );
    const justConnected = connected && (await browser.storage.local.get(SETUP_PENDING))[SETUP_PENDING];
    return {
      ...base,
      companion: state,
      ...(update ? { companionUpdate: update } : {}),
      ...(updates.version ? { extensionUpdate: updates.version } : {}),
      ...(justConnected === true ? { justConnected } : {}),
    };
  }

  /**
   * Who sent a request. Extension pages may ask anything; when they live inside a tab (the inline
   * menu iframe), every tab-scoped request is bound to that tab, whatever `tabId` they pass.
   */
  type Caller =
    // `menu`: the inline menu, a frame on a web page, where a master password is never typed
    | { kind: "page"; tabId?: number; frameId?: number; menu?: true }
    | { kind: "content-script"; tabId: number; frameId: number; url: string };

  function tabOf(caller: Caller, requested?: number): number {
    const tabId = caller.tabId ?? requested;
    if (tabId === undefined) throw new Error("no tab to act on");
    return tabId;
  }

  /** Sends a message to one frame: by default the one whose menu it's for, else the page itself. */
  function relay(tabId: number, message: ContentMessage, frameId = menuFrame(tabId, message)) {
    return browser.tabs.sendMessage(tabId, message, { frameId });
  }

  function menuFrame(tabId: number, message: ContentMessage): number {
    const nonce = "nonce" in message ? message.nonce : undefined;
    return menuNonces.get(tabId)?.find((menu) => menu.nonce === nonce)?.frameId ?? 0;
  }

  // Nonces of the menus each tab's content scripts may show, newest last, with the frame showing
  // each. Only our content script learns them; menu.html must present one of its tab's (see the
  // onMessage listener).
  // `menuFrameId`: the menu's own frame, once it has asked something (Firefox needs it, see tellMenus).
  const menuNonces = new Map<number, { nonce: string; frameId: number; menuFrameId?: number }[]>();
  const MENU_NONCES_PER_TAB = 8;

  function issueMenuNonce(tabId: number, frameId: number): string {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const nonces = [...(menuNonces.get(tabId) ?? []), { nonce, frameId }].slice(-MENU_NONCES_PER_TAB);
    menuNonces.set(tabId, nonces);
    return nonce;
  }

  /**
   * Tells every open menu, and the popup. Firefox runs the menu like a content script: it hears
   * only what's sent to its own frame, never a runtime broadcast.
   */
  function tellMenus(message: MenuMessage) {
    void browser.runtime.sendMessage(message).catch(() => {});
    if (!import.meta.env.FIREFOX) return;
    for (const [tabId, menus] of menuNonces) {
      for (const frameId of new Set(menus.map((menu) => menu.menuFrameId))) {
        if (frameId !== undefined) void browser.tabs.sendMessage(tabId, message, { frameId }).catch(() => {});
      }
    }
  }

  function isMenuNonce(tabId: number, nonce: unknown): boolean {
    return typeof nonce === "string" && (menuNonces.get(tabId)?.some((menu) => menu.nonce === nonce) ?? false);
  }

  async function autofillStatus(
    caller: Caller & { kind: "content-script" },
    kind: FieldKind,
    unsure = false,
    signIn = false,
  ): Promise<AutofillStatus> {
    const { show } = await menuToShow(caller, kind, signIn);
    if (show === "none") return { show };
    const settings = await getSettings();
    const orGenerate = kind === "login" && unsure && settings.generatePasswords;
    return {
      show,
      nonce: issueMenuNonce(caller.tabId, caller.frameId),
      ...(orGenerate ? { orGenerate } : {}),
      ...(settings.minimalMode ? { icon: fieldIcon() } : {}),
    };
  }

  /**
   * Minimal mode's icon in fields: the provider's when one account can fill, ours for several. The
   * same on every site, so it doesn't change with which account has logins there.
   */
  function fieldIcon(): string {
    const filling = accounts.all.filter(unlockable);
    const [only] = filling;
    return filling.length === 1 && only ? only.provider : "several";
  }

  async function menuToShow(
    caller: Caller & { kind: "content-script" },
    kind: FieldKind,
    signIn: boolean,
  ): Promise<AutofillStatus> {
    const url = fillableUrl(caller.url);
    const settings = await getSettings();
    if (!url) return { show: "none" };
    // "when signing in" covers login fields, "when signing up" new-password and email fields
    // (an email field that may sign in lists the site's saved logins too, "when signing in")
    const enabled =
      kind === "login"
        ? settings.inlineMenu
        : kind === "one-time-code"
          ? settings.oneTimeCodes
          : kind === "email"
            ? settings.generatePasswords || (signIn && settings.inlineMenu)
            : settings.generatePasswords;
    if (!enabled) return { show: "none" };
    if (kind === "email") {
      // Hide My Email works without a password manager, so it's offered even while locked
      const suggests =
        settings.generatePasswords &&
        (settings.hideMyEmail ||
          settings.hideMyEmailHint ||
          (settings.companionEmailsHint && (await companion.state()) !== "unavailable") ||
          ["ready", "needs-setup"].includes(await companion.state()));
      // a menu with nothing to offer closes itself
      const fills = signIn && settings.inlineMenu && ((await connectedUnlocked()) || canUnlock());
      return { show: suggests || fills ? "email" : "none" };
    }
    // "needs-setup" too: the user may have just run the setup. Never "unavailable": only the user
    // retries those (for Apple, each try leaves a crash report on the Mac)
    await accounts.connect(["offline", "needs-setup"]);
    if (!accounts.anyUnlocked) {
      if (accounts.all.some(unlockable)) return { show: "locked" };
      // an unlock button that can't work helps nobody; the toolbar badge and popup explain it
      if (!accounts.all.some((account) => account.status.state === "needs-setup")) return { show: "none" };
      return { show: "setup" };
    }
    // saving needs the session, so new passwords are offered only once unlocked
    if (kind === "new-password") return { show: "generate" };
    // many code fields want a code sent by SMS or email: offer only codes an account has
    if (kind === "one-time-code") {
      const codes = await oneTimeCodesFor(caller.tabId).catch(() => undefined);
      return { show: codes && codes.codes.length > 0 ? "codes" : "none" };
    }
    // shown even without saved logins: the menu then says so, every time, not only after unlocking
    return { show: "logins" };
  }

  // Passwords generated for open menus (by tab and menu nonce), and the one filled per tab.
  const generatedForMenu = new Map<string, GeneratedPasswords>();
  const generatedByTab = new Map<number, GeneratedLogin>();
  // Filled passwords the password manager may not have (not saved yet, declined, or an update that
  // can't be confirmed), kept in memory until the session ends for the popup to show.
  const unconfirmed: { id: string; hostname: string; username: string; password: string }[] = [];
  // Logins chosen on a username-only step, by hostname: a sign-in's next step (the password, same
  // tab) lists it alone, and a password reset (any tab: the link opens a new one) saves for it.
  // Only the username (and the login's ref) is kept, briefly, and forgotten once used: rather no
  // guess than a stale one.
  const chosenLogins = new Map<string, { username: string; ref: string; tabId: number; at: number }>();
  const CHOSEN_LOGIN_MS = 10 * 60_000;

  /** The login just chosen on `hostname` (in `tabId`, if given), if any. */
  function chosenLogin(hostname: string, tabId?: number): { username: string; ref: string } | undefined {
    const chosen = chosenLogins.get(hostname);
    if (!chosen || Date.now() - chosen.at >= CHOSEN_LOGIN_MS) return undefined;
    return tabId === undefined || chosen.tabId === tabId ? chosen : undefined;
  }

  /** Who a new password is for when the form doesn't say: the login just chosen, or the only one. */
  async function accountFor(hostname: string): Promise<string | undefined> {
    const chosen = chosenLogin(hostname);
    if (chosen !== undefined) return chosen.username;
    const usernames = await accounts.usernames(siteUrl(hostname));
    return usernames.length === 1 ? usernames[0] : undefined;
  }

  // The account just signed in with, by tab: a sign-in's verification step lists its code first.
  // Only the username is kept, briefly, like a chosen login.
  const signedIn = new Map<number, { hostname: string; username: string; at: number }>();

  function signedInAs(tabId: number, hostname: string): string | undefined {
    const entry = signedIn.get(tabId);
    if (!entry || entry.hostname !== hostname || Date.now() - entry.at >= CHOSEN_LOGIN_MS) return undefined;
    return entry.username;
  }

  // Logins sent with a form, by tab, until the page moves on (see saveSentLogin)
  const sentLogins = new Map<number, SentLogin>();

  /** Forgets every generated and sent password (an account locked: see unlockedAccounts). */
  function forgetPasswords() {
    sentLogins.clear();
    chosenLogins.clear();
    signedIn.clear();
    unconfirmed.length = 0;
    generatedByTab.clear();
    generatedForMenu.clear();
  }
  browser.tabs.onRemoved.addListener((tabId) => {
    sentLogins.delete(tabId);
    signedIn.delete(tabId);
    generatedByTab.delete(tabId);
    menuNonces.delete(tabId);
    signInFrames.delete(tabId);
    for (const key of generatedForMenu.keys()) if (key.startsWith(`${tabId}:`)) generatedForMenu.delete(key);
  });

  async function newPasswordContext(tabId: number, nonce: string): Promise<NewPasswordContext> {
    const context = (await relay(tabId, { type: "menu-new-password-context", nonce })) as
      | NewPasswordContext
      | undefined;
    if (!context) throw new Error("The password field is gone.");
    return context;
  }

  /**
   * Fills a generated password right away, like Safari. The password manager is asked to save it
   * when the form is submitted (see saveGenerated); until it has it, the popup keeps it.
   */
  async function fillGenerated(
    tabId: number,
    nonce: string,
    { password, strength }: Suggestion,
    account: string | undefined,
  ): Promise<NewPasswordResult> {
    const context = await newPasswordContext(tabId, nonce);
    if (!context.visible) return "menu-hidden";
    const url = await tabUrl(tabId);
    if (!url) throw new Error("this page can't be filled");
    const fill = { type: "menu-fill-new-password", nonce, origin: url.origin, password, strength } as const;
    const reply = (await relay(tabId, fill).catch(() => undefined)) as { result: NewPasswordResult } | undefined;
    const result = reply?.result ?? "no-fields";
    if (result !== "filled") return result;
    const previous = generatedByTab.get(tabId);
    if (previous) forget(previous.password);
    generatedByTab.set(tabId, {
      hostname: url.hostname,
      password,
      ...(account ? { account } : {}),
      state: "unsaved",
      formUsername: context.username,
      asked: false,
      frameId: menuFrame(tabId, fill),
    });
    unconfirmed.push({
      id: crypto.randomUUID(),
      hostname: url.hostname,
      username: context.username || (account ?? ""),
      password,
    });
    return result;
  }

  function forget(password: string) {
    const index = unconfirmed.findIndex((entry) => entry.password === password);
    if (index >= 0) unconfirmed.splice(index, 1);
  }

  /**
   * Asks the password manager to save a password from the popup's list. A new login confirms the
   * save and leaves the list; an update can't be seen, so it stays, as after the page's own ask.
   */
  async function saveUnconfirmed(tabId: number, entry: (typeof unconfirmed)[number]) {
    const { hostname, username, password } = entry;
    const target = await accounts.saveTarget(siteUrl(hostname), username);
    const before = await accounts.usernames(siteUrl(hostname), target);
    await target.save({ hostname, username, password }, { tabId });
    if (username !== "" && before.includes(username)) return;
    // the popup may close while macOS asks: this carries on without it
    void waitForLogin(() => accounts.usernames(siteUrl(hostname), target), username, before).then((saved) => {
      if (saved !== undefined) forget(password);
    });
  }

  /** The username next to the generated password, as the user types it. */
  function trackUsername(caller: Caller & { kind: "content-script" }, username: string) {
    const generated = generatedByTab.get(caller.tabId);
    if (generated && fillableUrl(caller.url)?.hostname === generated.hostname) generated.formUsername = username;
  }

  // The tab navigated or changed URL while holding a generated password: the page moved on.
  // A sent login is saved once the next page has loaded, unless that page asks for it again.
  browser.tabs.onUpdated.addListener((tabId, change) => {
    const generated = generatedByTab.get(tabId);
    if (generated && (change.url || change.status === "loading")) void saveGenerated(tabId, generated.formUsername);
    if (change.status === "complete" && sentLogins.has(tabId)) void saveSentLogin(tabId);
    if (change.url) signInFrames.delete(tabId);
  });

  /**
   * The page moved on with a generated password: ask the password manager, once, to save it with
   * the form's username. A new login confirms the save; an update can't be seen, so it's assumed
   * and the password stays in the popup's list.
   */
  async function saveGenerated(tabId: number, username: string) {
    const generated = generatedByTab.get(tabId);
    if (!generated || generated.asked) return;
    generated.asked = true;
    generated.state = "saving";
    // a form without a username (a reset): the account the menu said; the login chosen for it is used up
    username ||= generated.account ?? "";
    chosenLogins.delete(generated.hostname);
    generated.username = username;
    const { hostname, password } = generated;
    const target = await accounts.saveTarget(siteUrl(hostname), username);
    const before = await accounts.usernames(siteUrl(hostname), target);
    const outcome = await offerSave(tabId, { hostname, username, password }, target);
    const tab = tabId;
    if (outcome === "declined") {
      generated.state = "unsaved";
      return;
    }
    if (outcome === "saved") return markSaved(tab, generated, username, true);
    if (username !== "" && before.includes(username)) return markSaved(tab, generated, username, false);
    const saved = await waitForLogin(() => accounts.usernames(siteUrl(hostname), target), username, before);
    if (generated.username !== username) return; // a newer submit took over
    if (saved === undefined) generated.state = "unsaved";
    // without a username, it's the one the user typed into macOS's Save dialog
    else markSaved(tab, generated, saved, true);
  }

  function markSaved(tabId: number, generated: GeneratedLogin, username: string, confirmed: boolean) {
    generated.state = "saved";
    generated.username = username;
    if (confirmed) forget(generated.password);
    const saved = { type: "generated-password-saved", password: generated.password } as const;
    void relay(tabId, saved, generated.frameId).catch(() => {});
  }

  /**
   * A form was sent with a password (typed, or filled). It's kept (in memory, until the page
   * moves on) to be saved then, as a new account or a saved account's new password (macOS then
   * offers to update it). Apple's helper doesn't ask about a password it has already, so it isn't
   * compared here, which would take Touch ID. Unlike a generated password, it needn't be kept if
   * the user doesn't save it: they know it.
   */
  function noteSentLogin(caller: Caller & { kind: "content-script" }, username: string, password: string) {
    sentLogins.delete(caller.tabId);
    const url = fillableUrl(caller.url);
    // locked, nothing can be looked up or saved; asking to unlock for this would be a nuisance
    if (!url || !password || !accounts.anyUnlocked) return;
    // a password we generated has its own save
    if (generatedByTab.get(caller.tabId)?.password === password) return;
    const login: SentLogin = {
      hostname: url.hostname,
      password,
      saveAs: accountToSave(url.hostname, username, caller.tabId),
      checking: false,
      frameId: caller.frameId,
    };
    sentLogins.set(caller.tabId, login);
    const drop = () => {
      if (sentLogins.get(caller.tabId) === login) sentLogins.delete(caller.tabId);
    };
    // not worth it: forget the password right away; else once the page has had time to move on
    void login.saveAs.then((account) => {
      if (account) signedIn.set(caller.tabId, { hostname: login.hostname, username: account, at: Date.now() });
      return account ?? drop();
    });
    setTimeout(drop, SENT_LOGIN_MS);
  }

  /**
   * The account to save a sent login as: a new one, or a saved one (spelled as saved, so macOS
   * offers an update). Undefined when it can't be told.
   */
  async function accountToSave(hostname: string, username: string, tabId: number): Promise<string | undefined> {
    // a password-only step: the account chosen on the username step
    username ||= chosenLogin(hostname, tabId)?.username ?? "";
    const saved = await Promise.resolve()
      .then(async () => accounts.usernames(siteUrl(hostname), await accounts.saveTarget(siteUrl(hostname), username)))
      .catch(() => undefined);
    if (!saved) return undefined;
    // no username: one of the site's saved accounts, unless it has none
    if (!username) return saved.length === 0 ? "" : undefined;
    const lower = username.toLowerCase();
    return saved.find((name) => name.toLowerCase() === lower) ?? username;
  }

  /**
   * Asks the password manager to save the tab's sent login (macOS asks the user first) if the page
   * it shows now went past the sign-in. The content script may not be listening yet right after a
   * page loads, so it's asked a few times.
   */
  async function saveSentLogin(tabId: number) {
    const login = sentLogins.get(tabId);
    if (!login || login.checking) return;
    login.checking = true;
    try {
      const username = await login.saveAs;
      if (username === undefined) return;
      for (let attempt = 0; attempt < 5 && sentLogins.get(tabId) === login; attempt++) {
        const ask = { type: "sign-in-state" } as const;
        // the frame that sent it may have gone with its page: then the page that loaded answers
        const state = (await relay(tabId, ask, login.frameId)
          .catch(() => relay(tabId, ask, 0))
          .catch(() => undefined)) as SignInState | undefined;
        if (state === "watching") return;
        if (state) {
          sentLogins.delete(tabId);
          if (state === "failed") return;
          const { hostname, password } = login;
          const target = await accounts.saveTarget(siteUrl(hostname), username);
          await offerSave(tabId, { hostname, username, password }, target);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } finally {
      login.checking = false;
    }
  }

  // Email aliases: iCloud's Hide My Email, set up only while the user has it turned on
  const aliases = new ICloudAliases({
    allowed: async () => (await getSettings()).hideMyEmail && (await hasHideMyEmailConsent()),
    withoutICloudPlus,
  });
  async function syncHideMyEmail(on: boolean) {
    await aliases.setEnabled(on && (await hasHideMyEmailConsent()));
  }
  void getSettings().then((settings) => syncHideMyEmail(settings.hideMyEmail));

  if (import.meta.env.FIREFOX) {
    browser.permissions.onRemoved.addListener(() => {
      void hasHideMyEmailConsent().then((allowed) => {
        if (!allowed) return saveSettings({ hideMyEmail: false });
      });
    });
    // These permissions are only for Hide My Email, so allowing them turns it on: from our popup
    // (which Firefox may close as its prompt opens, before it hears the answer) or about:addons
    browser.permissions.onAdded.addListener(() => {
      void hasHideMyEmailConsent().then(async (allowed) => {
        if (!allowed) return;
        await saveSettings({ hideMyEmail: true });
        if (consentAsk) tellConsentMenu(consentAsk);
      });
    });
    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== HME_CONSENT_PORT || port.sender?.url !== browser.runtime.getURL("/popup.html")) return;
      const ask = consentAsk;
      // closed: allowed, declined or dismissed, the menu shows what it now can
      port.onDisconnect.addListener(() => {
        if (!ask) return;
        if (consentAsk === ask) consentAsk = undefined;
        tellConsentMenu(ask);
      });
    });
  }

  /**
   * Firefox: the inline menu that asked to turn Hide My Email on, while the popup asks for the
   * permissions (a page's frame can't ask itself). Kept a minute for the popup to pick up.
   */
  let consentAsk: { tabId: number; frameId: number; at: number } | undefined;
  const CONSENT_ASK_MS = 60_000;

  function tellConsentMenu({ tabId, frameId }: { tabId: number; frameId: number }) {
    const message: MenuMessage = { type: "hide-my-email-changed" };
    // the menu runs like a content script in Firefox, so it hears only messages sent to its tab
    void browser.tabs.sendMessage(tabId, message, { frameId }).catch(() => {});
  }

  /** Opens the popup to ask for Hide My Email's permissions, or a small window if it can't open. */
  // The save card (save.html): asks before saving to accounts that don't ask themselves. Keyed by
  // the nonce given to the tab's content script, which frames the card with it.
  const saveCards = new Map<
    string,
    {
      tabId: number;
      login: { hostname: string; username: string; password: string };
      target: Account;
      update: boolean;
      done: (saved: boolean) => void;
    }
  >();
  const NEVER_SAVE = "neverSaveSites";
  const SAVE_CARD_MS = 2 * 60_000;

  /**
   * Saves a login to `target`, asking first where the provider doesn't (Bitwarden): "asked" when the
   * provider asks (macOS for Apple; whether it saved shows later), else whether the user saved it.
   */
  async function offerSave(
    tabId: number,
    login: { hostname: string; username: string; password: string },
    target: Account,
  ): Promise<"asked" | "saved" | "declined"> {
    if (target.capabilities.asksBeforeSaving) {
      await target.save(login, { tabId });
      return "asked";
    }
    const never = ((await browser.storage.local.get(NEVER_SAVE))[NEVER_SAVE] as string[] | undefined) ?? [];
    if (never.includes(login.hostname)) return "declined";
    const update =
      login.username !== "" && (await accounts.usernames(siteUrl(login.hostname), target)).includes(login.username);
    const nonce = crypto.randomUUID();
    const answered = new Promise<boolean>((resolve) => {
      saveCards.set(nonce, { tabId, login, target, update, done: resolve });
    });
    const forget = (saved: boolean) => {
      const card = saveCards.get(nonce);
      if (!card) return;
      saveCards.delete(nonce);
      card.done(saved);
    };
    setTimeout(() => {
      forget(false);
      void relay(tabId, { type: "save-card-close", nonce }, 0).catch(() => {});
    }, SAVE_CARD_MS);
    try {
      await relay(tabId, { type: "show-save-card", nonce }, 0);
    } catch {
      forget(false);
    }
    return (await answered) ? "saved" : "declined";
  }

  function saveCard(caller: Caller, nonce: string) {
    const card = saveCards.get(nonce);
    if (!card || caller.kind !== "page" || caller.tabId !== card.tabId) throw new Error("not allowed");
    return { nonce, ...card };
  }

  /** The account the inline menu asked to unlock, for the popup to open to (see popup-intent). */
  let unlockAsk: { account: string; at: number } | undefined;

  /** Opens the popup to unlock `account`; where it can't open (Firefox, no click), a small window. */
  async function askToUnlock(account: string) {
    unlockAsk = { account, at: Date.now() };
    try {
      const action = toolbarAction() as { openPopup?: () => Promise<void> } | undefined;
      if (!action?.openPopup) throw new Error("no openPopup");
      await action.openPopup();
    } catch {
      unlockAsk = undefined;
      await browser.windows.create({
        type: "popup",
        url: browser.runtime.getURL(`/popup.html?unlock=${encodeURIComponent(account)}`),
        width: 360,
        height: 280,
      });
    }
  }

  let openPopups = 0;
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== POPUP_PORT || port.sender?.id !== browser.runtime.id) return;
    openPopups++;
    port.onDisconnect.addListener(() => openPopups--);
  });

  /**
   * The Touch ID dialog closes the popup that asked for it, so dismissing it ("Type the Code
   * Instead", Esc) would leave a code on screen and nowhere to type it: the popup comes back.
   */
  async function reopenToType(account: Account) {
    // the browser gets the keyboard back a moment after the dialog goes
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (openPopups === 0 && account.status.state === "unlocking") await askToUnlock(account.id);
  }

  async function askHideMyEmailConsent(tabId: number, frameId: number) {
    consentAsk = { tabId, frameId, at: Date.now() };
    try {
      // Firefox's browserAction has openPopup; WXT's (Chrome's) types don't list it
      await (browser.browserAction as unknown as { openPopup(): Promise<void> }).openPopup();
    } catch {
      // another panel is open, or the window lost focus meanwhile
      await browser.windows.create({
        type: "popup",
        url: browser.runtime.getURL("/popup.html"),
        width: 360,
        height: 260,
      });
    }
  }

  /** What email fields offer: the site's saved logins first, then Hide My Email, the user's own emails below. */
  async function emailSuggestions(tabId: number, withLogins = false): Promise<EmailSuggestions> {
    const settings = await getSettings();
    const off = { state: "off" } as const;
    const [hme, contacts, logins] = await Promise.all([
      settings.generatePasswords ? hideMyEmailState(tabId, settings) : off,
      settings.generatePasswords ? contactEmailsState(settings) : off,
      withLogins && settings.inlineMenu ? savedLogins(tabId) : undefined,
    ]);
    return { hideMyEmail: hme, contacts, ...(logins ? { logins } : {}) };
  }

  /** Whether an account is unlocked, reconnecting first those whose connection was lost. */
  async function connectedUnlocked(): Promise<boolean> {
    await accounts.connect();
    return accounts.anyUnlocked;
  }

  /**
   * Whether unlocking can work: as for login fields, not for an account the system won't let us
   * use, nor before this browser is set up (an email field doesn't ask for that: its other
   * suggestions work without).
   */
  function canUnlock(): boolean {
    return accounts.all.some(unlockable);
  }

  /**
   * The usernames saved for the tab's site (none, too: the menu then says so), or "locked" if they
   * can't be listed until unlocked.
   */
  async function savedLogins(tabId: number): Promise<EmailSuggestions["logins"]> {
    if (!(await connectedUnlocked())) return canUnlock() ? { state: "locked" } : undefined;
    const url = await tabUrl(tabId);
    if (!url) return undefined;
    try {
      return { state: "ready", hostname: url.hostname, logins: await accounts.logins(url, { tabId }) };
    } catch {
      return undefined;
    }
  }

  async function hideMyEmailState(tabId: number, settings: Settings): Promise<HideMyEmailState> {
    if (!settings.hideMyEmail || !(await hasHideMyEmailConsent())) {
      return { state: settings.hideMyEmailHint ? "hint" : "off" };
    }
    const url = await tabUrl(tabId);
    if (!url) return { state: "off" };
    const alias = await aliases.state(url.hostname);
    return alias.state === "needs-upgrade" ? { state: "needs-icloud-plus" } : alias;
  }

  async function contactEmailsState(settings: Settings): Promise<ContactEmailsState> {
    const app = await companion.state();
    if (app === "unavailable") return { state: "off" };
    if (app === "not-installed") return { state: settings.companionEmailsHint ? "hint" : "off" };
    if (!settings.suggestEmails) return { state: "off" };
    // the app answers only a browser running Apple's helper (anything else could be a program
    // reading Contacts through it), so make sure ours is: connecting starts it, without pairing
    await accounts.connect();
    try {
      return { state: "ready", emails: await companion.myEmails() };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "needs-contacts") return { state: "needs-contacts" };
      // an older app, or the agent isn't running: offer nothing rather than an error
      return { state: "off" };
    }
  }

  /** No iCloud+: turn Hide My Email and its hint off, so email fields stop offering it. */
  async function withoutICloudPlus() {
    await saveSettings({ hideMyEmail: false, hideMyEmailHint: false });
  }

  async function saveSettings(changes: Partial<Settings>): Promise<Settings> {
    if (changes.hideMyEmail && !(await hasHideMyEmailConsent())) {
      throw new Error("Allow Hide My Email's data permissions before turning it on.");
    }
    const before = await getSettings();
    const settings = { ...before, ...changes };
    // what older versions kept here stays, for the accounts to start from (see accountsStore)
    const { settings: stored } = await browser.storage.local.get("settings");
    await browser.storage.local.set({ settings: { ...(stored as object | undefined), ...settings } });
    if (settings.hideMyEmail !== before.hideMyEmail) await syncHideMyEmail(settings.hideMyEmail);
    return settings;
  }

  /** Refuses the inline menu: what the request carries (a master password) never goes into a web page. */
  function notFromMenu(caller: Caller) {
    if (caller.kind !== "page" || caller.menu) throw new Error("not allowed");
  }

  /**
   * Signs in to Bitwarden, as a new account or `request.account` again. Each step is the same
   * request plus a code; nothing is kept between steps, so an account is added only once signed in.
   */
  async function bitwardenSignIn(
    request: Extract<Request, { type: "bitwarden-sign-in" }>,
  ): Promise<BitwardenSignInStep> {
    const { type: _, account: existing, ...signIn } = request;
    const id = existing ?? `bitwarden-${crypto.randomUUID().slice(0, 8)}`;
    const entry = existing ? undefined : accountEntry({ id, provider: BITWARDEN_PROVIDER });
    const account = existing ? accounts.get(existing) : entry?.account;
    if (!(account instanceof BitwardenAccount)) throw new Error("That isn't a Bitwarden account.");
    const step = await account.signIn(signIn);
    if (step.status !== "signed-in") {
      // a new account that didn't finish keeps nothing (signing in stored its record only at the end)
      return step;
    }
    if (entry) await accounts.add(entry);
    return { status: "signed-in", account: id };
  }

  async function handle(request: Request, caller: Caller): Promise<unknown> {
    if (caller.kind === "content-script") {
      if (request.type === "autofill-status")
        return autofillStatus(caller, request.kind, request.unsure, request.signIn);
      if (request.type === "generated-username") {
        trackUsername(caller, request.username);
        return null;
      }
      if (request.type === "generated-form-gone") {
        trackUsername(caller, request.username);
        void saveGenerated(caller.tabId, request.username);
        return null;
      }
      if (request.type === "login-sent") {
        noteSentLogin(caller, request.username, request.password);
        return null;
      }
      if (request.type === "login-edited") {
        sentLogins.delete(caller.tabId);
        return null;
      }
      if (request.type === "login-form-gone") {
        void saveSentLogin(caller.tabId);
        return null;
      }
      throw new Error("not allowed");
    }
    switch (request.type) {
      case "get-status":
        // retrying "needs-setup" is how the popup and setup page notice that setup just finished;
        // "unavailable" waits for the user to ask (retry-connection)
        await accounts.connect(["offline", "needs-setup"]);
        return fullStatus();
      case "unlock-with-touch-id": {
        const account = accounts.pairingCode(request.account);
        const { unlock } = account;
        if (!unlock.unlockWithTouchId) throw new Error("This account can't unlock with Touch ID.");
        try {
          await unlock.unlockWithTouchId();
        } catch (error) {
          // asked from the popup (or its small window); the inline menu shows its own code box
          if (caller.kind === "page" && !caller.menu) void reopenToType(account);
          throw error;
        }
        return status();
      }
      case "request-code":
        await accounts.pairingCode(request.account).unlock.requestCode(request.fresh ?? false);
        return status();
      case "verify-code":
        await accounts.pairingCode(request.account).unlock.verifyCode(request.code);
        return status();
      case "lock":
        accounts.lock(request.account);
        return status();
      case "unlock-with-password": {
        notFromMenu(caller);
        const account = accounts.get(request.account);
        if (account.unlock.kind !== "password") throw new Error("This account doesn't unlock with a password.");
        await account.unlock.unlock(request.password);
        return status();
      }
      case "bitwarden-sign-in":
        notFromMenu(caller);
        return bitwardenSignIn(request);
      case "bitwarden-server": {
        notFromMenu(caller);
        const account = accounts.get(request.account);
        if (!(account instanceof BitwardenAccount)) throw new Error("That isn't a Bitwarden account.");
        return (await account.server()) ?? null;
      }
      case "bitwarden-send-email-code": {
        notFromMenu(caller);
        const account = createBitwardenAccount("sign-in", async () => 0);
        await account.sendEmailCode(request);
        return null;
      }
      case "remove-account":
        notFromMenu(caller);
        await accounts.remove(request.account);
        if ((await getSettings()).saveNewLoginsTo === request.account) await saveSettings({ saveNewLoginsTo: "" });
        return status();
      case "install-update":
        // restarting locks every account anyway
        updates.apply();
        return status();
      case "list-logins": {
        const tabId = tabOf(caller, request.tabId);
        const url = await tabUrl(tabId);
        if (!url) return { logins: [] };
        const logins = await accounts.logins(url, { tabId });
        // the login chosen on this sign-in's previous step comes first
        const current = chosenLogin(url.hostname, tabId);
        const first = logins.filter(({ ref }) => ref === current?.ref);
        return {
          hostname: url.hostname,
          logins: [...first, ...logins.filter((login) => !first.includes(login))],
          ...(first.length > 0 && current ? { chosen: current.ref } : {}),
        };
      }
      case "fill": {
        const tabId = tabOf(caller, request.tabId);
        const frames = await pageFrames(tabId);
        const result = await fillLogin(tabId, request.ref, async (origin, username, password) => {
          for (const frameId of frames) {
            const [injection] = await browser.scripting.executeScript({
              target: { tabId, frameIds: [frameId] },
              func: fillCredentials,
              args: [origin, username, password],
            });
            const filled = String(injection?.result ?? "no-fields");
            if (filled !== "no-fields") return filled;
          }
          return "no-fields";
        });
        return { result };
      }
      case "list-one-time-codes":
        return oneTimeCodesFor(tabOf(caller, request.tabId));
      case "fill-one-time-code": {
        const tabId = tabOf(caller, request.tabId);
        const { origin, code } = await oneTimeCodeDigits(tabId, request.id);
        for (const frameId of await pageFrames(tabId)) {
          const reply = (await relay(tabId, { type: "fill-one-time-code", origin, code }, frameId).catch(
            () => undefined,
          )) as { result: string } | undefined;
          if (reply && reply.result !== "no-fields") return { result: reply.result };
        }
        return { result: "no-fields" };
      }
      case "copy-one-time-code": {
        // the popup only: the inline menu lives inside the page, which needn't see the code
        if (caller.tabId !== undefined) throw new Error("not allowed");
        return { code: (await oneTimeCodeDigits(request.tabId, request.id)).code };
      }
      case "fill-one-time-code-from-menu": {
        const tabId = tabOf(caller);
        // a hidden or covered menu was never really chosen from: no Touch ID for it
        const visible = (await relay(tabId, { type: "menu-visible", nonce: request.nonce }).catch(
          () => false,
        )) as boolean;
        if (!visible) return { result: "menu-hidden" };
        const { origin, code } = await oneTimeCodeDigits(tabId, request.id);
        const reply = (await relay(tabId, {
          type: "menu-fill-one-time-code",
          nonce: request.nonce,
          origin,
          code,
        })) as { result: string } | undefined;
        return { result: reply?.result ?? "menu-hidden" };
      }
      case "generate-passwords": {
        const tabId = tabOf(caller);
        const context = await newPasswordContext(tabId, request.nonce);
        const url = await tabUrl(tabId);
        // only a form that asks for no username at all (a reset, a change of password) gets a guess;
        // a sign-up's empty email field is the user's to fill
        const guess = !context.username && !context.asksForUsername && url;
        const account = guess ? await accountFor(url.hostname).catch(() => undefined) : undefined;
        // sites that don't state their rules in HTML: Apple's list of known ones
        const rules = url ? withSiteRules(context.rules, url.hostname) : context.rules;
        let strong: Suggestion;
        try {
          strong = generatePassword("strong", rules);
        } catch (error) {
          if (error instanceof PasswordRulesError) return { unavailable: error.message };
          throw error;
        }
        const passwords: GeneratedPasswords = { strong, ...(account ? { account } : {}) };
        // an alternative only when it can differ: a site's digits-only PIN is offered once
        if (allowsSpecialCharacters(rules)) {
          try {
            passwords.alphanumeric = generatePassword("alphanumeric", rules);
          } catch (error) {
            // the site needs a special character: an alternative without would be turned down
            if (!(error instanceof PasswordRulesError)) throw error;
          }
        }
        generatedForMenu.set(`${tabId}:${request.nonce}`, passwords);
        return passwords;
      }
      case "use-generated-password": {
        const tabId = tabOf(caller);
        const passwords = generatedForMenu.get(`${tabId}:${request.nonce}`);
        const chosen = passwords?.[request.style];
        if (!passwords || !chosen) throw new Error("That password expired. Try again.");
        return { result: await fillGenerated(tabId, request.nonce, chosen, passwords.account) };
      }
      case "unconfirmed-passwords": {
        if (caller.tabId !== undefined) throw new Error("not allowed");
        const url = await tabUrl(request.tabId);
        return unconfirmed
          .filter((entry) => entry.hostname === url?.hostname)
          .map(({ id, username }) => ({ id, username }));
      }
      case "save-unconfirmed-password": {
        // the popup only, like copying a code: the page never asks to save on the user's behalf
        if (caller.tabId !== undefined) throw new Error("not allowed");
        const url = await tabUrl(request.tabId);
        const entry = unconfirmed.find((e) => e.id === request.id && e.hostname === url?.hostname);
        if (!entry) throw new Error("That password is gone. It was saved, or the extension locked.");
        await saveUnconfirmed(request.tabId, entry);
        return null;
      }
      case "generated-username":
      case "generated-form-gone":
      case "login-sent":
      case "login-edited":
      case "login-form-gone":
        throw new Error("content scripts only");
      case "fill-from-menu": {
        const tabId = tabOf(caller);
        const result = await fillLogin(tabId, request.ref, async (origin, username, password) => {
          const reply = (await relay(tabId, {
            type: "menu-fill",
            nonce: request.nonce,
            origin,
            username,
            password,
          })) as { result: string } | undefined;
          return reply?.result ?? "menu-hidden";
        });
        return { result };
      }
      case "open-passwords-app": {
        const tabId = caller.tabId ?? request.tabId;
        const url = tabId === undefined ? undefined : await tabUrl(tabId).catch(() => undefined);
        const account = request.account === undefined ? accounts.appAccount() : accounts.get(request.account);
        if (!account?.capabilities.openApp) throw new Error("No password manager app to open.");
        await account.openApp(url?.origin);
        return null;
      }
      case "menu-resize":
      case "menu-close":
      case "menu-focus-field":
      case "menu-show-passkeys":
        await relay(tabOf(caller), request).catch(() => {});
        return null;
      case "get-settings":
        return getSettings();
      case "set-settings":
        return saveSettings(request.settings);
      case "set-account-settings":
        return accounts.setSettings(request.account, request.settings);
      case "email-suggestions":
        return emailSuggestions(tabOf(caller), request.logins);
      case "enable-hide-my-email": {
        const tabId = tabOf(caller);
        if (!(await hasHideMyEmailConsent())) {
          if (caller.kind !== "page" || caller.frameId === undefined) throw new Error("no menu to answer");
          await askHideMyEmailConsent(tabId, caller.frameId);
          return { asking: true };
        }
        await saveSettings({ hideMyEmail: true });
        return emailSuggestions(tabId);
      }
      case "popup-intent": {
        const ask = consentAsk;
        const hideMyEmailConsent = ask !== undefined && Date.now() - ask.at < CONSENT_ASK_MS;
        // asked once: opened again later, the popup is its usual self
        if (ask) ask.at = 0;
        const unlock = unlockAsk && Date.now() - unlockAsk.at < CONSENT_ASK_MS ? unlockAsk.account : undefined;
        unlockAsk = undefined;
        return { hideMyEmailConsent, ...(unlock ? { unlock } : {}) };
      }
      case "save-card": {
        const { login, target, update } = saveCard(caller, request.nonce);
        return { hostname: login.hostname, username: login.username, update, account: target.label };
      }
      case "save-card-resize": {
        const { tabId } = saveCard(caller, request.nonce);
        await relay(tabId, { type: "save-card-resize", nonce: request.nonce, height: request.height }, 0);
        return null;
      }
      case "save-card-answer": {
        const card = saveCard(caller, request.nonce);
        let saved = false;
        if (request.answer === "save") {
          await card.target.save(card.login, { tabId: card.tabId });
          saved = true;
        } else if (request.answer === "never") {
          const stored = (await browser.storage.local.get(NEVER_SAVE))[NEVER_SAVE] as string[] | undefined;
          await browser.storage.local.set({ [NEVER_SAVE]: [...new Set([...(stored ?? []), card.login.hostname])] });
        }
        saveCards.delete(request.nonce);
        card.done(saved);
        // saved: the card says so for a moment first
        setTimeout(
          () => void relay(card.tabId, { type: "save-card-close", nonce: request.nonce }, 0).catch(() => {}),
          saved ? 1_500 : 0,
        );
        return { saved };
      }
      case "open-unlock":
        await askToUnlock(accounts.get(request.account).id);
        return null;
      case "list-accounts":
        return accounts.views();
      case "add-account": {
        notFromMenu(caller);
        if (request.provider !== APPLE_PROVIDER) throw new Error("That password manager is added by signing in.");
        const entry = accountEntry({ id: APPLE_ACCOUNT, provider: APPLE_PROVIDER });
        if (entry && !accounts.all.some((a) => a.id === APPLE_ACCOUNT)) await accounts.add(entry);
        await accounts.connect(["offline", "needs-setup"]);
        return fullStatus();
      }
      case "dismiss-hide-my-email-hint":
        await saveSettings({ hideMyEmailHint: false });
        return null;
      case "generate-hide-my-email":
        tabOf(caller);
        return { address: await aliases.generate() };
      case "use-hide-my-email": {
        const tabId = tabOf(caller);
        const url = await tabUrl(tabId);
        if (!url) throw new Error("this page can't be filled");
        let email = request.address;
        if (request.reserve) email = await aliases.reserve(request.address, url.hostname);
        else aliases.used(email, url.hostname);
        const reply = (await relay(tabId, {
          type: "menu-fill-email",
          nonce: request.nonce,
          origin: url.origin,
          email,
        })) as { result: string } | undefined;
        return { result: reply?.result ?? "no-fields" };
      }
      case "fill-email": {
        const tabId = tabOf(caller);
        const url = await tabUrl(tabId);
        if (!url) throw new Error("this page can't be filled");
        const fill = {
          type: "menu-fill-email",
          nonce: request.nonce,
          origin: url.origin,
          email: request.email,
        } as const;
        const reply = (await relay(tabId, fill)) as { result: string } | undefined;
        return { result: reply?.result ?? "no-fields" };
      }
      case "dismiss-companion-emails-hint":
        await saveSettings({ companionEmailsHint: false });
        return null;
      case "open-companion-app":
        await companion.openApp();
        return null;
      case "retry-connection": {
        const retrying = request.account === undefined ? accounts.all : [accounts.get(request.account)];
        await Promise.all(retrying.map((account) => account.connect({ retry: true }).catch(() => {})));
        return fullStatus();
      }
      case "open-companion-page":
        // our own page about the app, which links to its download
        await browser.tabs.create({ url: browser.runtime.getURL("/companion.html") });
        return null;
      case "open-setup-page":
        await openSetupPage();
        return null;
      case "setup-seen":
        await browser.storage.local.remove(SETUP_PENDING);
        return null;
      case "open-icloud-plus":
        await browser.tabs.create({ url: "https://www.apple.com/icloud/" });
        return null;
      case "open-icloud":
        await browser.tabs.create({ url: "https://www.icloud.com/" });
        return null;
      case "autofill-status":
        throw new Error("content scripts only");
    }
  }

  /** The frames that may be filled for the tab, the page's own first. */
  async function pageFrames(tabId: number): Promise<number[]> {
    const url = await tabUrl(tabId);
    const frames = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: frameOriginToFill,
    });
    return frames
      .filter((frame) => url !== undefined && frame.result === url.origin)
      .map((frame) => frame.frameId)
      .sort((a, b) => a - b);
  }

  /**
   * Fills the login `ref` names with `fill`. A username-only step (a multi-step sign-in) gets just
   * the username, and the choice is remembered for the next step; the password is read (macOS may
   * ask for Touch ID) only for a form with a password field.
   */
  async function fillLogin(
    tabId: number,
    ref: string,
    fill: (origin: string, username: string, password: string | null) => Promise<string>,
  ): Promise<string> {
    const url = await tabUrl(tabId);
    if (!url) throw new Error("this page can't be filled");
    const { username } = await accounts.login(url, ref);
    const result = await fill(url.origin, username, null);
    if (result === "filled") chosenLogins.set(url.hostname, { username, ref, tabId, at: Date.now() });
    if (result !== "needs-password") return result;
    // the tab may have moved on meanwhile: the password is for the site it's on now, and only fills there
    const { url: now, credential } = await credentialFor(tabId, ref);
    const filled = await fill(now.origin, username, credential.password);
    // signed in: no reset to save for, but maybe a verification code to fill next
    if (filled === "filled") {
      chosenLogins.delete(now.hostname);
      signedIn.set(tabId, { hostname: now.hostname, username, at: Date.now() });
    }
    return filled;
  }

  /** The tab's verification codes, without digits. */
  async function oneTimeCodesFor(tabId: number): Promise<OneTimeCodesResult> {
    const url = await tabUrl(tabId);
    if (!url) return { codes: [] };
    const codes = await accounts.oneTimeCodes(url);
    const current = signedInAs(tabId, url.hostname);
    return {
      hostname: url.hostname,
      codes: oneTimeCodeViews(
        codes.map(({ ref, username, domain }) => ({ id: ref, username, domain })),
        current,
      ),
      ...(current ? { signedInAs: current } : {}),
    };
  }

  /**
   * The digits of the tab's code `id`, current now: macOS asks for Touch ID first, so there's no
   * timeout. Returned with the origin they're for, which a fill must still be on.
   */
  async function oneTimeCodeDigits(tabId: number, id: string): Promise<{ origin: string; code: string }> {
    const url = await tabUrl(tabId);
    if (!url) throw new Error("this page can't be filled");
    const code = await accounts.oneTimeCode(url, id, { tabId });
    if (!code) throw new Error("Couldn't get the code. Try again.");
    return { origin: url.origin, code };
  }

  async function credentialFor(tabId: number, ref: string) {
    const url = await tabUrl(tabId);
    if (!url) throw new Error("this page can't be filled");
    const credential = await accounts.credential(url, ref, { tabId });
    return { url, credential };
  }

  browser.runtime.onMessage.addListener((request: Request & { menuNonce?: unknown }, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;
    let caller: Caller;
    if (sender.url?.startsWith(browser.runtime.getURL("/"))) {
      // menu.html is web-accessible, so a page can frame a copy of its own: only a menu our
      // content script opened, with a nonce we issued to that tab, may ask anything
      const isMenu = new URL(sender.url).pathname === "/menu.html";
      if (isMenu && (sender.tab?.id === undefined || !isMenuNonce(sender.tab.id, request.menuNonce))) {
        sendResponse({
          ok: false,
          error: "This menu wasn't opened by Better Passwords.",
        } satisfies Envelope<never>);
        return false;
      }
      if (isMenu && sender.tab?.id !== undefined && sender.frameId !== undefined) {
        const menu = menuNonces.get(sender.tab.id)?.find((m) => m.nonce === request.menuNonce);
        if (menu) menu.menuFrameId = sender.frameId;
      }
      caller =
        sender.tab?.id === undefined
          ? { kind: "page" }
          : {
              kind: "page",
              tabId: sender.tab.id,
              ...(sender.frameId === undefined ? {} : { frameId: sender.frameId }),
              ...(isMenu ? { menu: true as const } : {}),
            };
    } else if (
      import.meta.env.FIREFOX &&
      CONTENT_TO_MENU.has((request as { type: string }).type) &&
      sender.tab?.id !== undefined
    ) {
      // Firefox: what our content script tells its menu (see tellMenu) comes here instead, and
      // goes on to the menu whose nonce that same frame was issued
      const { nonce } = request as unknown as MenuMessage & { nonce: string };
      const menu = menuNonces.get(sender.tab.id)?.find((m) => m.nonce === nonce && m.frameId === sender.frameId);
      if (menu?.menuFrameId !== undefined) {
        void browser.tabs.sendMessage(sender.tab.id, request, { frameId: menu.menuFrameId }).catch(() => {});
      }
      return false;
    } else if (
      sender.tab?.id !== undefined &&
      sender.frameId !== undefined &&
      sender.url &&
      // the page, one of its own iframes (which also checks every frame around it), or a sign-in
      // frame of the page's site right inside it
      (sender.frameId === 0 ||
        sameFillableOrigin(sender.url, sender.tab.url) ||
        isSameSiteFrame(sender.url, sender.tab.url)) &&
      CONTENT_SCRIPT_REQUESTS.has(request.type)
    ) {
      if (sender.frameId !== 0 && isSameSiteFrame(sender.url, sender.tab.url)) {
        signInFrames.set(sender.tab.id, new URL(sender.url));
      } else if (request.type === "autofill-status") {
        // a field of the page's own origin has focus now
        signInFrames.delete(sender.tab.id);
      }
      caller = { kind: "content-script", tabId: sender.tab.id, frameId: sender.frameId, url: sender.url };
    } else {
      return false;
    }
    // the stored accounts are made first (a worker that just started is reading them)
    accounts.ready
      .then(() => handle(request, caller))
      .then(
        (value) => sendResponse({ ok: true, value } satisfies Envelope<unknown>),
        (error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            code: (error as { code?: string })?.code,
          } as Envelope<unknown>),
      );
    return true;
  });
});

/** What the content script sends its menu straight (see MenuMessage); Firefox relays it (see tellMenus). */
const CONTENT_TO_MENU: ReadonlySet<string> = new Set(["menu-filter", "menu-typing", "menu-placement"]);

async function tabUrl(tabId: number): Promise<URL | undefined> {
  const tab = await browser.tabs.get(tabId);
  return signInFrames.get(tabId) ?? fillableUrl(tab.url);
}

/** States in which an account can't be unlocked: not set up, or not allowed here. */
const CANT_UNLOCK: readonly AccountState[] = ["needs-setup", "unavailable"];

const unlockableView = ({ state }: { state: AccountState }) => !CANT_UNLOCK.includes(state);

async function getSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get("settings");
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
  // kept per account now (see accountsStore)
  for (const key of LEGACY_ACCOUNT_SETTINGS) delete merged[key];
  return merged as unknown as Settings;
}

/** Accounts are kept in local storage; their settings start from what older versions kept in Settings. */
function accountsStore(): AccountsStore {
  return {
    load: async () => (await browser.storage.local.get("accounts")).accounts as StoredAccount[] | undefined,
    save: (list) => browser.storage.local.set({ accounts: list }),
    legacy: async () => {
      const { settings } = await browser.storage.local.get("settings");
      const legacy: Partial<AccountSettings> = {};
      for (const key of LEGACY_ACCOUNT_SETTINGS) {
        const value = (settings as Record<string, unknown> | undefined)?.[key];
        if (typeof value === "boolean") legacy[key] = value;
      }
      return legacy;
    },
  };
}
