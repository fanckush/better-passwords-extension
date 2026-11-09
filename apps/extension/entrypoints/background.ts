import type { ScriptPublicPath } from "wxt/utils/inject-script";
import type { FieldKind } from "@/src/autofill/fields.ts";
import { Companion } from "@/src/companion.ts";
import { BRIDGE_HOST } from "@/src/config.ts";
import { fillCredentials } from "@/src/fill.ts";
import { hasHideMyEmailConsent } from "@/src/icloud/consent.ts";
import { HEADER_RULE_ID, HideMyEmail, headerRule, ICloudError } from "@/src/icloud/hide-my-email.ts";
import {
  type AutofillStatus,
  CONTENT_SCRIPT_REQUESTS,
  type ContactEmailsState,
  type ContentMessage,
  defaultSettings,
  type EmailSuggestions,
  type Envelope,
  type GeneratedPasswords,
  type HideMyEmailState,
  type MenuMessage,
  type NewPasswordContext,
  type NewPasswordResult,
  type OneTimeCodesResult,
  type Request,
  type Settings,
  type SignInState,
  type Status,
} from "@/src/messages.ts";
import { PortTransport } from "@/src/native/port-transport.ts";
import {
  allowsSpecialCharacters,
  generatePassword,
  PasswordRulesError,
  type Suggestion,
} from "@/src/passwords/generate.ts";
import { oneTimeCodeId, oneTimeCodeViews } from "@/src/passwords/one-time-codes.ts";
import { withSiteRules } from "@/src/passwords/site-rules.ts";
import { waitForLogin } from "@/src/passwords/wait-for-login.ts";
import { platform } from "@/src/platform.ts";
import { Session } from "@/src/session/session.ts";
import { toolbarAction } from "@/src/toolbar.ts";
import { PendingUpdate } from "@/src/updates.ts";
import { fillableUrl, frameOriginToFill, isAppleSignInFrame, sameFillableOrigin } from "@/src/url-policy.ts";

const KEEP_ALIVE = "keep-alive";

/**
 * A tab id for our own lookups. Around a save the helper sends the real tab unrequested updates
 * that list no logins; replies echo the tab id, so these can't be mistaken for ours.
 */
const PROBE_TAB = { tabId: 2 ** 31 - 1, frameId: 0 };

/** A generated password filled into a tab, until Apple Passwords has it. */
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
  /** Whether Apple Passwords was asked already: once per generated password. */
  asked: boolean;
  /** The frame it was filled in. */
  frameId: number;
}

/** A login sent with a form (not a generated one), until the page moves on and it's saved (or dropped). */
interface SentLogin {
  hostname: string;
  password: string;
  /** The account to save it as: its spelling in Apple Passwords if saved there; undefined when unknown. */
  saveAs: Promise<string | undefined>;
  /** The page is being asked whether the sign-in went through (the field went away while the tab navigated). */
  checking: boolean;
  /** The frame it was sent from. */
  frameId: number;
}

/** How long a sent login waits for the page to move on before it's forgotten. */
const SENT_LOGIN_MS = 60_000;

/**
 * Tabs showing Apple's sign-in frame on another Apple site, with the frame's address. Those tabs are
 * filled for the frame: it's the frame that gets the password, and the frame's site it's saved for.
 */
const appleSignIns = new Map<number, URL>();

export default defineBackground(() => {
  // macOS kills Apple's helper in browsers Apple doesn't allow, and every try leaves a crash report
  // on the Mac. So a blocked browser tries once per launch, plus whenever the user asks (the session
  // refuses otherwise). Workers restart often, so it's remembered for the browser session.
  const HELPER_BLOCKED = "helperBlocked";
  const session = new Session({
    openTransport: () => new PortTransport(BRIDGE_HOST),
    browserName: import.meta.env.FIREFOX ? "Firefox" : "Chrome",
    blockedEarlier: async () => {
      const stored = (await browser.storage.session.get(HELPER_BLOCKED))[HELPER_BLOCKED];
      return typeof stored === "string" ? stored : undefined;
    },
  });
  // the companion app is Mac only; elsewhere it's never asked, nor offered
  const companion = new Companion(undefined, undefined, async () => (await platform()) === "mac");

  // An open native port keeps the worker alive in Chrome 105+; the alarm is a fallback that
  // wakes it if the browser suspends it anyway. Nothing to do on wake: state lives in memory.
  session.onChange(({ state }) => {
    if (state === "unlocked") void browser.alarms.create(KEEP_ALIVE, { periodInMinutes: 0.5 });
    else if (state === "closed" || state === "disconnected") void browser.alarms.clear(KEEP_ALIVE);
  });
  browser.alarms.onAlarm.addListener(() => {});

  // Open menus asked before an unlock (or a lock) elsewhere, e.g. the code typed into the popup:
  // tell them, so they show what they would now
  let unlocked = false;
  session.onChange(({ state }) => {
    if ((state === "unlocked") === unlocked) return;
    unlocked = state === "unlocked";
    const message: MenuMessage = { type: "session-changed", unlocked };
    void browser.runtime.sendMessage(message).catch(() => {});
  });

  // A new verification code (one that just arrived by SMS, say): open menus and the popup list again
  const announcing = new WeakSet<object>();
  session.onChange(async ({ state }) => {
    if (state !== "unlocked") return;
    const client = await session.unlockedClient().catch(() => undefined);
    if (!client || announcing.has(client)) return;
    announcing.add(client);
    client.onOneTimeCodeAvailable(() => {
      const message: MenuMessage = { type: "one-time-codes-changed" };
      void browser.runtime.sendMessage(message).catch(() => {});
    });
  });

  // Remembered while this browser can't reach Apple's helper, so the first connection after setup
  // is announced once (by the popup or the setup page), even if the popup closed in between.
  const SETUP_PENDING = "setupPending";
  session.onChange(({ state }) => {
    if (state === "no-helper") void browser.storage.local.set({ [SETUP_PENDING]: true });
    else if (state === "unlocked") void browser.storage.local.remove(SETUP_PENDING);
  });

  // Told the Mac app this browser is blocked, so it hears once it isn't any more.
  const REPORTED_BLOCKED = "reportedBlocked";
  const action = toolbarAction();
  let blocked = false;
  session.onChange(({ state, error, remembered }) => {
    if (state === "blocked") {
      blocked = true;
      void browser.storage.session.set({ [HELPER_BLOCKED]: error ?? "" }).catch(() => {});
      void action?.setBadgeText({ text: "!" });
      void action?.setBadgeBackgroundColor({ color: "#e8a33d" });
      // a worker that restored it has nothing new to tell
      if (remembered) return;
      void companion.reportHelper(true);
      void browser.storage.local.set({ [REPORTED_BLOCKED]: true });
      return;
    }
    // anything else, even a retry that timed out, isn't macOS blocking the helper
    if (blocked) {
      blocked = false;
      void browser.storage.session.remove(HELPER_BLOCKED).catch(() => {});
      void action?.setBadgeText({ text: "" });
    }
    // only the helper answering shows it isn't blocked any more
    if (state !== "locked" && state !== "awaiting-code" && state !== "unlocked") return;
    void browser.storage.local.get(REPORTED_BLOCKED).then(async (stored) => {
      if (stored[REPORTED_BLOCKED] !== true) return;
      await companion.reportHelper(false);
      await browser.storage.local.remove(REPORTED_BLOCKED);
    });
  });

  /** Apple's helper comes with macOS and with iCloud for Windows; elsewhere there's nothing to set up. */
  const supported = platform().then((os) => os !== "other");

  // A fresh install that can't reach the helper yet opens the setup page, so nobody has to find
  // the toolbar button first; so does one whose helper won't start, which explains it. A computer
  // that is set up already (a reinstall) sees nothing.
  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason !== "install" || !(await supported)) return;
    await session.connect().catch(() => {});
    if (session.status.state === "no-helper" || session.status.state === "blocked") await openSetupPage();
  });

  function openSetupPage() {
    return browser.tabs.create({ url: browser.runtime.getURL("/setup.html") });
  }

  // A downloaded version installs when that loses nothing: right away while locked, else once the
  // session ends, or when the user asks in the popup. One waiting a day takes the user's next break
  // (Firefox on macOS reports no screen lock, so an hour away counts too).
  const updates = new PendingUpdate({
    busy: () => session.status.state === "unlocked" || session.status.state === "awaiting-code",
    restart: () => browser.runtime.reload(),
  });
  browser.runtime.onUpdateAvailable.addListener(({ version }) => updates.available(version));
  session.onChange(() => updates.applyIfHarmless());
  browser.idle.setDetectionInterval(60 * 60);

  browser.idle.onStateChanged.addListener(async (state) => {
    if (state === "active") return;
    if (updates.overdue) session.lock();
    else if (state === "locked" && (await getSettings()).lockOnScreenLock) session.lock();
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
    session.onChange(async ({ state }) => {
      if (state !== "unlocked" || updates.version) return;
      if ((await browser.storage.local.get("simulatedUpdate")).simulatedUpdate) return;
      await browser.storage.local.set({ simulatedUpdate: true });
      updates.available(simulated);
    });
  }

  const status = (): Status => ({ ...session.status });

  /** Status plus whether the companion app can unlock with Touch ID. */
  async function fullStatus(): Promise<Status> {
    const base = status();
    if (base.state === "no-helper" || base.state === "blocked") return base;
    const state = await companion.state();
    const update = await companion.update();
    const connected = base.state === "locked" || base.state === "awaiting-code";
    const justConnected = connected && (await browser.storage.local.get(SETUP_PENDING))[SETUP_PENDING];
    return {
      ...base,
      companion: state,
      touchId: state === "ready" && (await getSettings()).touchId,
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
    | { kind: "page"; tabId?: number }
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
  const menuNonces = new Map<number, { nonce: string; frameId: number }[]>();
  const MENU_NONCES_PER_TAB = 8;

  function issueMenuNonce(tabId: number, frameId: number): string {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const nonces = [...(menuNonces.get(tabId) ?? []), { nonce, frameId }].slice(-MENU_NONCES_PER_TAB);
    menuNonces.set(tabId, nonces);
    return nonce;
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
    const orGenerate = kind === "login" && unsure && (await getSettings()).generatePasswords;
    return { show, nonce: issueMenuNonce(caller.tabId, caller.frameId), ...(orGenerate ? { orGenerate } : {}) };
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
      // Hide My Email works without Apple Passwords, so it's offered even while locked
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
    // "no-helper" too: the user may have just run the setup. Never "blocked": see HELPER_BLOCKED
    if (["disconnected", "closed", "no-helper"].includes(session.status.state)) {
      await session.connect().catch(() => {});
    }
    if (!session.isUnlocked) {
      // an unlock button that can't work helps nobody; the toolbar badge and popup explain it
      if (session.status.state === "blocked") return { show: "none" };
      if (session.status.state !== "no-helper") return { show: "locked" };
      return { show: (await supported) ? "setup" : "none" };
    }
    // saving needs the session, so new passwords are offered only once unlocked
    if (kind === "new-password") return { show: "generate" };
    // many code fields want a code sent by SMS or email: offer only codes Apple Passwords has
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
  // Filled passwords Apple Passwords may not have (not saved yet, declined, or an update that
  // can't be confirmed), kept in memory until the session ends for the popup to show.
  const unconfirmed: { hostname: string; username: string; password: string }[] = [];
  // Logins chosen on a username-only step, by hostname: a sign-in's next step (the password, same
  // tab) lists it alone, and a password reset (any tab: the link opens a new one) saves for it.
  // Only the username is kept, briefly, and forgotten once used: rather no guess than a stale one.
  const chosenLogins = new Map<string, { username: string; tabId: number; at: number }>();
  const CHOSEN_LOGIN_MS = 10 * 60_000;

  /** The login just chosen on `hostname` (in `tabId`, if given), if any. */
  function chosenLogin(hostname: string, tabId?: number): string | undefined {
    const chosen = chosenLogins.get(hostname);
    if (!chosen || Date.now() - chosen.at >= CHOSEN_LOGIN_MS) return undefined;
    return tabId === undefined || chosen.tabId === tabId ? chosen.username : undefined;
  }

  /** Who a new password is for when the form doesn't say: the login just chosen, or the only one. */
  async function accountFor(hostname: string): Promise<string | undefined> {
    const chosen = chosenLogin(hostname);
    if (chosen !== undefined) return chosen;
    const usernames = await usernamesFor(hostname);
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

  // locking forgets every generated and sent password, like the session key
  session.onChange(({ state }) => {
    if (state === "unlocked") return;
    sentLogins.clear();
    chosenLogins.clear();
    signedIn.clear();
    unconfirmed.length = 0;
    generatedByTab.clear();
    generatedForMenu.clear();
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    sentLogins.delete(tabId);
    signedIn.delete(tabId);
    generatedByTab.delete(tabId);
    menuNonces.delete(tabId);
    appleSignIns.delete(tabId);
    for (const key of generatedForMenu.keys()) if (key.startsWith(`${tabId}:`)) generatedForMenu.delete(key);
  });

  async function newPasswordContext(tabId: number, nonce: string): Promise<NewPasswordContext> {
    const context = (await relay(tabId, { type: "menu-new-password-context", nonce })) as
      | NewPasswordContext
      | undefined;
    if (!context) throw new Error("The password field is gone.");
    return context;
  }

  /** The usernames saved for a site, looked up on a tab id of our own (see PROBE_TAB). */
  async function usernamesFor(hostname: string): Promise<string[]> {
    const client = await session.unlockedClient();
    return (await client.getLogins(hostname, PROBE_TAB)).map((login) => login.username);
  }

  /**
   * Fills a generated password right away, like Safari. Apple Passwords is asked to save it when
   * the form is submitted (see saveGenerated); until it has it, the popup keeps it.
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
    unconfirmed.push({ hostname: url.hostname, username: context.username || (account ?? ""), password });
    return result;
  }

  function forget(password: string) {
    const index = unconfirmed.findIndex((entry) => entry.password === password);
    if (index >= 0) unconfirmed.splice(index, 1);
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
    if (change.url) appleSignIns.delete(tabId);
  });

  /**
   * The page moved on with a generated password: ask Apple Passwords, once, to save it with the
   * form's username. A new login confirms the save; an update can't be seen, so it's assumed and
   * the password stays in the popup's list.
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
    const before = await usernamesFor(generated.hostname);
    const client = await session.unlockedClient();
    const { hostname, password } = generated;
    await client.savePassword({ hostname, username, password }, { tabId, frameId: 0 });
    const tab = tabId;
    if (username !== "" && before.includes(username)) return markSaved(tab, generated, username, false);
    const saved = await waitForLogin(() => usernamesFor(hostname), username, before);
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
    if (!url || !password || !session.isUnlocked) return;
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
    username ||= chosenLogin(hostname, tabId) ?? "";
    const saved = await usernamesFor(hostname).catch(() => undefined);
    if (!saved) return undefined;
    // no username: one of the site's saved accounts, unless it has none
    if (!username) return saved.length === 0 ? "" : undefined;
    const lower = username.toLowerCase();
    return saved.find((name) => name.toLowerCase() === lower) ?? username;
  }

  /**
   * Asks Apple Passwords to save the tab's sent login (macOS asks the user first) if the page it
   * shows now went past the sign-in. The content script may not be listening yet right after a
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
          const client = await session.unlockedClient();
          await client.savePassword({ hostname, username, password }, { tabId, frameId: 0 });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } finally {
      login.checking = false;
    }
  }

  // Hide My Email: the header rule exists only while the user has it turned on (session rules
  // don't outlive the browser, so it's set again on every start)
  const hideMyEmail = new HideMyEmail(async (input, init) => {
    if (!(await getSettings()).hideMyEmail || !(await hasHideMyEmailConsent())) {
      throw new Error("Turn on Hide My Email and allow its data permissions first.");
    }
    return fetch(input, init);
  });
  async function syncHideMyEmail(on: boolean) {
    on = on && (await hasHideMyEmailConsent());
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [HEADER_RULE_ID],
      ...(on ? { addRules: [headerRule(new URL(browser.runtime.getURL("/")).host)] } : {}),
    });
    if (!on) {
      hideMyEmail.reset();
      addressCache.clear();
    }
  }
  void getSettings().then((settings) => syncHideMyEmail(settings.hideMyEmail));

  // each site's Hide My Email address, remembered for a minute so reopening the menu is instant
  const addressCache = new Map<string, { address: string | undefined; at: number }>();
  if (import.meta.env.FIREFOX) {
    browser.permissions.onRemoved.addListener(() => {
      void hasHideMyEmailConsent().then((allowed) => {
        if (!allowed) return saveSettings({ hideMyEmail: false });
      });
    });
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

  /** Whether Apple Passwords is unlocked, reconnecting first if the connection was lost. */
  async function connectedUnlocked(): Promise<boolean> {
    if (["disconnected", "closed"].includes(session.status.state)) await session.connect().catch(() => {});
    return session.isUnlocked;
  }

  /**
   * Whether unlocking can work: as for login fields, not when macOS blocks the helper, nor before
   * this browser is set up (an email field doesn't ask for that: its other suggestions work without).
   */
  function canUnlock(): boolean {
    return !["blocked", "no-helper"].includes(session.status.state);
  }

  /** The usernames saved for the tab's site, or "locked" if they can't be listed until unlocked. */
  async function savedLogins(tabId: number): Promise<EmailSuggestions["logins"]> {
    if (!(await connectedUnlocked())) return canUnlock() ? { state: "locked" } : undefined;
    const url = await tabUrl(tabId);
    if (!url) return undefined;
    try {
      const client = await session.unlockedClient();
      const logins = await client.getLogins(url.hostname, { tabId });
      if (logins.length === 0) return undefined;
      return { state: "ready", hostname: url.hostname, usernames: logins.map(({ username }) => username) };
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
    try {
      let cached = addressCache.get(url.hostname);
      if (!cached || Date.now() - cached.at > 60_000) {
        cached = { address: await hideMyEmail.addressFor(url.hostname), at: Date.now() };
        addressCache.set(url.hostname, cached);
      }
      const { address } = cached;
      return address ? { state: "ready", address } : { state: "ready" };
    } catch (error) {
      if (error instanceof ICloudError && error.code === "signed-out") return { state: "signed-out" };
      if (error instanceof ICloudError && error.code === "no-icloud-plus") {
        await withoutICloudPlus();
        return { state: "needs-icloud-plus" };
      }
      return { state: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async function contactEmailsState(settings: Settings): Promise<ContactEmailsState> {
    const app = await companion.state();
    if (app === "unavailable") return { state: "off" };
    if (app === "not-installed") return { state: settings.companionEmailsHint ? "hint" : "off" };
    if (!settings.suggestEmails) return { state: "off" };
    // the app answers only a browser running Apple's helper (anything else could be a program
    // reading Contacts through it), so make sure ours is: connecting starts it, without pairing
    if (session.status.state === "disconnected" || session.status.state === "closed") {
      await session.connect().catch(() => {});
    }
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

  /** Runs a Hide My Email call, turning the feature off if the account turns out to lack iCloud+. */
  async function icloud<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ICloudError && error.code === "no-icloud-plus") await withoutICloudPlus();
      throw error;
    }
  }

  async function saveSettings(changes: Partial<Settings>): Promise<Settings> {
    if (changes.hideMyEmail && !(await hasHideMyEmailConsent())) {
      throw new Error("Allow Hide My Email's data permissions before turning it on.");
    }
    const before = await getSettings();
    const settings = { ...before, ...changes };
    await browser.storage.local.set({ settings });
    if (settings.hideMyEmail !== before.hideMyEmail) await syncHideMyEmail(settings.hideMyEmail);
    return settings;
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
        // retrying "no-helper" is how the popup and setup page notice that setup just finished;
        // "blocked" waits for the user to ask (retry-connection)
        if (session.status.state === "disconnected" || session.status.state === "no-helper") {
          await session.connect().catch(() => {});
        }
        return fullStatus();
      case "unlock-with-touch-id": {
        if (session.isUnlocked) return status();
        // fresh, like typing the code: one asked for earlier may be valid still, but its window closed
        await session.requestNewCode();
        const code = await companion.readCode();
        try {
          await session.verifyCode(code);
        } catch (error) {
          // a wrong code burns the challenge; put a fresh one on screen for typing instead
          await session.requestNewCode().catch(() => {});
          throw error;
        }
        return status();
      }
      case "request-code":
        await (request.fresh ? session.requestNewCode() : session.requestCode());
        return status();
      case "verify-code":
        await session.verifyCode(request.code);
        return status();
      case "lock":
        session.lock();
        return status();
      case "install-update":
        // restarting ends the session with Apple's helper anyway
        updates.apply();
        return status();
      case "list-logins": {
        const tabId = tabOf(caller, request.tabId);
        const url = await tabUrl(tabId);
        if (!url) return { logins: [] };
        const client = await session.unlockedClient();
        const logins = (await client.getLogins(url.hostname, { tabId })).map(({ username }) => ({ username }));
        // the login chosen on this sign-in's previous step comes first
        const current = chosenLogin(url.hostname, tabId);
        const first = logins.filter(({ username }) => username === current);
        return {
          hostname: url.hostname,
          logins: [...first, ...logins.filter((login) => !first.includes(login))],
          ...(first.length > 0 ? { chosen: current } : {}),
        };
      }
      case "fill": {
        const tabId = tabOf(caller, request.tabId);
        const frames = await pageFrames(tabId);
        const result = await fillLogin(tabId, request.username, async (origin, password) => {
          for (const frameId of frames) {
            const [injection] = await browser.scripting.executeScript({
              target: { tabId, frameIds: [frameId] },
              func: fillCredentials,
              args: [origin, request.username, password],
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
        const url = await tabUrl(tabOf(caller, request.tabId));
        return unconfirmed
          .filter((entry) => entry.hostname === url?.hostname)
          .map(({ username, password }) => ({ username, password }));
      }
      case "generated-username":
      case "generated-form-gone":
      case "login-sent":
      case "login-edited":
      case "login-form-gone":
        throw new Error("content scripts only");
      case "fill-from-menu": {
        const tabId = tabOf(caller);
        const result = await fillLogin(tabId, request.username, async (origin, password) => {
          const reply = (await relay(tabId, {
            type: "menu-fill",
            nonce: request.nonce,
            origin,
            username: request.username,
            password,
          })) as { result: string } | undefined;
          return reply?.result ?? "menu-hidden";
        });
        return { result };
      }
      case "open-passwords-app": {
        const tabId = caller.tabId ?? request.tabId;
        const url = tabId === undefined ? undefined : await tabUrl(tabId).catch(() => undefined);
        const client = await session.connect();
        client.openPasswordsApp(url?.origin);
        return null;
      }
      case "menu-resize":
      case "menu-close":
      case "menu-focus-field":
        await relay(tabOf(caller), request).catch(() => {});
        return null;
      case "get-settings":
        return getSettings();
      case "set-settings":
        return saveSettings(request.settings);
      case "email-suggestions":
        return emailSuggestions(tabOf(caller), request.logins);
      case "enable-hide-my-email":
        await saveSettings({ hideMyEmail: true });
        return emailSuggestions(tabOf(caller));
      case "dismiss-hide-my-email-hint":
        await saveSettings({ hideMyEmailHint: false });
        return null;
      case "generate-hide-my-email":
        tabOf(caller);
        return { address: await icloud(() => hideMyEmail.generate()) };
      case "use-hide-my-email": {
        const tabId = tabOf(caller);
        const url = await tabUrl(tabId);
        if (!url) throw new Error("this page can't be filled");
        const email = request.reserve
          ? await icloud(() => hideMyEmail.reserve(request.address, url.hostname))
          : request.address;
        addressCache.set(url.hostname, { address: email, at: Date.now() });
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
      case "retry-connection":
        await session.connect({ retry: true }).catch(() => {});
        return fullStatus();
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
   * Fills `username`'s login with `fill`. A username-only step (a multi-step sign-in) gets just the
   * username, and the choice is remembered for the next step; the password is read (macOS may ask
   * for Touch ID) only for a form with a password field.
   */
  async function fillLogin(
    tabId: number,
    username: string,
    fill: (origin: string, password: string | null) => Promise<string>,
  ): Promise<string> {
    const url = await tabUrl(tabId);
    if (!url) throw new Error("this page can't be filled");
    const result = await fill(url.origin, null);
    if (result === "filled") chosenLogins.set(url.hostname, { username, tabId, at: Date.now() });
    if (result !== "needs-password") return result;
    // the tab may have moved on meanwhile: the password is for the site it's on now, and only fills there
    const { url: now, credential } = await credentialFor(tabId, username);
    const filled = await fill(now.origin, credential.password);
    // signed in: no reset to save for, but maybe a verification code to fill next
    if (filled === "filled") {
      chosenLogins.delete(now.hostname);
      signedIn.set(tabId, { hostname: now.hostname, username, at: Date.now() });
    }
    return filled;
  }

  /** The tab's verification codes, without digits. The page's URL is all the helper is told. */
  async function oneTimeCodesFor(tabId: number): Promise<OneTimeCodesResult> {
    const url = await tabUrl(tabId);
    if (!url) return { codes: [] };
    const client = await session.unlockedClient();
    // asked for a stand-in tab, like logins: an unasked update for the real one can't pass for the answer
    const { codes } = await client.getOneTimeCodes([url.href], PROBE_TAB);
    const current = signedInAs(tabId, url.hostname);
    return {
      hostname: url.hostname,
      codes: oneTimeCodeViews(codes, current),
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
    const client = await session.unlockedClient();
    const { codes } = await client.getOneTimeCodes([url.href], PROBE_TAB);
    const chosen = codes.find((code) => oneTimeCodeId(code) === id);
    if (!chosen) throw new Error("that verification code is no longer saved");
    const code = await client.currentOneTimeCode(chosen, [url.href], { tabId });
    if (!code) throw new Error("Apple Passwords didn't give the code");
    return { origin: url.origin, code };
  }

  async function credentialFor(tabId: number, username: string) {
    const url = await tabUrl(tabId);
    if (!url) throw new Error("this page can't be filled");
    const client = await session.unlockedClient();
    const credential = await client.getPassword(url.hostname, username, { tabId });
    if (!credential) throw new Error("that login is no longer saved");
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
      caller = sender.tab?.id === undefined ? { kind: "page" } : { kind: "page", tabId: sender.tab.id };
    } else if (
      sender.tab?.id !== undefined &&
      sender.frameId !== undefined &&
      sender.url &&
      // the page, one of its own iframes (which also checks every frame around it), or Apple's sign-in
      (sender.frameId === 0 ||
        sameFillableOrigin(sender.url, sender.tab.url) ||
        isAppleSignInFrame(sender.url, sender.tab.url)) &&
      CONTENT_SCRIPT_REQUESTS.has(request.type)
    ) {
      if (sender.frameId !== 0 && isAppleSignInFrame(sender.url, sender.tab.url)) {
        appleSignIns.set(sender.tab.id, new URL(sender.url));
      }
      caller = { kind: "content-script", tabId: sender.tab.id, frameId: sender.frameId, url: sender.url };
    } else {
      return false;
    }
    handle(request, caller).then(
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

async function tabUrl(tabId: number): Promise<URL | undefined> {
  const tab = await browser.tabs.get(tabId);
  return appleSignIns.get(tabId) ?? fillableUrl(tab.url);
}

async function getSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get("settings");
  return { ...defaultSettings(await platform()), ...(settings as Partial<Settings> | undefined) };
}
