import { ProtocolError } from "@app/protocol";
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
  DEFAULT_SETTINGS,
  type EmailSuggestions,
  type Envelope,
  type GeneratedPasswords,
  type HideMyEmailState,
  type MenuMessage,
  type NewPasswordContext,
  type NewPasswordResult,
  type Request,
  type Settings,
  type Status,
} from "@/src/messages.ts";
import { PortTransport } from "@/src/native/port-transport.ts";
import { generatePassword, PasswordRulesError } from "@/src/passwords/generate.ts";
import { waitForLogin } from "@/src/passwords/wait-for-login.ts";
import { Session } from "@/src/session/session.ts";
import { PendingUpdate } from "@/src/updates.ts";
import { fillableUrl } from "@/src/url-policy.ts";

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
  cancellation: AbortController;
}

export default defineBackground(() => {
  const session = new Session({
    openTransport: () => new PortTransport(BRIDGE_HOST),
    browserName: import.meta.env.FIREFOX ? "Firefox" : "Chrome",
  });

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

  // Remembered while this browser can't reach Apple's helper, so the first connection after setup
  // is announced once (by the popup or the setup page), even if the popup closed in between.
  const SETUP_PENDING = "setupPending";
  session.onChange(({ state }) => {
    if (state === "no-helper") void browser.storage.local.set({ [SETUP_PENDING]: true });
    else if (state === "unlocked") void browser.storage.local.remove(SETUP_PENDING);
  });

  /** Apple Passwords and its helper exist only on macOS; elsewhere there's nothing to set up. */
  const onMac = browser.runtime
    .getPlatformInfo()
    .then(({ os }) => os === "mac")
    .catch(() => true);

  // A fresh install that can't reach the helper yet opens the setup page, so nobody has to find
  // the toolbar button first. A Mac that is set up already (a reinstall) sees nothing.
  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason !== "install" || !(await onMac)) return;
    await session.connect().catch(() => {});
    if (session.status.state === "no-helper") await openSetupPage();
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
          .executeScript({ target: { tabId: id }, files: (script.js ?? []) as ScriptPublicPath[] })
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

  const companion = new Companion();
  const status = (): Status => ({ ...session.status });

  /** Status plus whether the companion app can unlock with Touch ID. */
  async function fullStatus(): Promise<Status> {
    const base = status();
    if (base.state === "no-helper") return base;
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
  type Caller = { kind: "page"; tabId?: number } | { kind: "content-script"; tabId: number; url: string };

  function tabOf(caller: Caller, requested?: number): number {
    const tabId = caller.tabId ?? requested;
    if (tabId === undefined) throw new Error("no tab to act on");
    return tabId;
  }

  function relay(tabId: number, message: ContentMessage) {
    return browser.tabs.sendMessage(tabId, message, { frameId: 0 });
  }

  // Nonces of the menus each tab's content script may show, newest last. Only our content script
  // learns them; menu.html must present one of its tab's (see the onMessage listener).
  const menuNonces = new Map<number, string[]>();
  const MENU_NONCES_PER_TAB = 8;

  function issueMenuNonce(tabId: number): string {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const nonces = [...(menuNonces.get(tabId) ?? []), nonce].slice(-MENU_NONCES_PER_TAB);
    menuNonces.set(tabId, nonces);
    return nonce;
  }

  function isMenuNonce(tabId: number, nonce: unknown): boolean {
    return typeof nonce === "string" && (menuNonces.get(tabId)?.includes(nonce) ?? false);
  }

  async function autofillStatus(caller: Caller & { kind: "content-script" }, kind: FieldKind): Promise<AutofillStatus> {
    const { show } = await menuToShow(caller, kind);
    return show === "none" ? { show } : { show, nonce: issueMenuNonce(caller.tabId) };
  }

  async function menuToShow(caller: Caller & { kind: "content-script" }, kind: FieldKind): Promise<AutofillStatus> {
    const url = fillableUrl(caller.url);
    const settings = await getSettings();
    if (!url) return { show: "none" };
    // "when signing in" covers login fields, "when signing up" new-password and email fields
    if (kind === "login" ? !settings.inlineMenu : !settings.generatePasswords) return { show: "none" };
    if (kind === "signup-email") {
      // Hide My Email works without Apple Passwords, so no unlocking is needed
      const offered =
        settings.hideMyEmail ||
        settings.hideMyEmailHint ||
        settings.companionEmailsHint ||
        (await companion.state()) !== "not-installed";
      return { show: offered ? "email" : "none" };
    }
    // "no-helper" too: the user may have just run the setup
    if (["disconnected", "closed", "no-helper"].includes(session.status.state)) {
      await session.connect().catch(() => {});
    }
    if (!session.isUnlocked) {
      if (session.status.state !== "no-helper") return { show: "locked" };
      return { show: (await onMac) ? "setup" : "none" };
    }
    // saving needs the session, so new passwords are offered only once unlocked
    if (kind === "new-password") return { show: "generate" };
    // shown even without saved logins: the menu then says so, every time, not only after unlocking
    return { show: "logins" };
  }

  // Passwords generated for open menus (by tab and menu nonce), and the one filled per tab.
  const generatedForMenu = new Map<string, GeneratedPasswords>();
  const generatedByTab = new Map<number, GeneratedLogin>();
  const fillChoices = new Map<number, object>();
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

  // locking forgets every generated password, like the session key
  session.onChange(({ state }) => {
    if (state === "unlocked") return;
    chosenLogins.clear();
    unconfirmed.length = 0;
    for (const generated of generatedByTab.values()) generated.cancellation.abort();
    generatedByTab.clear();
    generatedForMenu.clear();
    fillChoices.clear();
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    generatedByTab.get(tabId)?.cancellation.abort();
    generatedByTab.delete(tabId);
    fillChoices.delete(tabId);
    menuNonces.delete(tabId);
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
    password: string,
    account: string | undefined,
  ): Promise<NewPasswordResult> {
    const client = await session.unlockedClient();
    const context = await newPasswordContext(tabId, nonce);
    if (!context.visible) return "menu-hidden";
    const url = await tabUrl(tabId);
    if (!url) throw new Error("this page can't be filled");
    const fill = { type: "menu-fill-new-password", nonce, origin: url.origin, password } as const;
    session.assertCurrent(client);
    const reply = (await relay(tabId, fill).catch(() => undefined)) as { result: NewPasswordResult } | undefined;
    session.assertCurrent(client);
    const result = reply?.result ?? "no-fields";
    if (result !== "filled") return result;
    const previous = generatedByTab.get(tabId);
    if (previous) {
      previous.cancellation.abort();
      forget(previous.password);
    }
    generatedByTab.set(tabId, {
      hostname: url.hostname,
      password,
      ...(account ? { account } : {}),
      state: "unsaved",
      formUsername: context.username,
      asked: false,
      cancellation: new AbortController(),
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
  browser.tabs.onUpdated.addListener((tabId, change) => {
    const generated = generatedByTab.get(tabId);
    if (generated && (change.url || change.status === "loading")) void saveGenerated(tabId, generated.formUsername);
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
    const { signal } = generated.cancellation;
    try {
      const client = await session.unlockedClient();
      const assertCurrent = () => {
        session.assertCurrent(client);
        if (signal.aborted || generatedByTab.get(tabId) !== generated) {
          throw new ProtocolError("generated password expired", "superseded");
        }
      };
      const lookup = async () => {
        assertCurrent();
        const logins = await client.getLogins(generated.hostname, PROBE_TAB);
        assertCurrent();
        return logins.map((login) => login.username);
      };
      const before = await lookup();
      assertCurrent();
      const { hostname, password } = generated;
      await client.savePassword({ hostname, username, password }, { tabId, frameId: 0 });
      assertCurrent();
      if (username !== "" && before.includes(username)) return markSaved(tabId, generated, username, false);
      const saved = await waitForLogin(lookup, username, before, { signal });
      assertCurrent();
      if (generated.username !== username) return; // a newer submit took over
      if (saved === undefined) generated.state = "unsaved";
      // without a username, it's the one the user typed into macOS's Save dialog
      else markSaved(tabId, generated, saved, true);
    } catch {
      if (!signal.aborted && generatedByTab.get(tabId) === generated) generated.state = "unsaved";
    }
  }

  function markSaved(tabId: number, generated: GeneratedLogin, username: string, confirmed: boolean) {
    generated.state = "saved";
    generated.username = username;
    if (confirmed) forget(generated.password);
    void relay(tabId, { type: "generated-password-saved", password: generated.password }).catch(() => {});
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

  /** What sign-up email fields offer: Hide My Email above, the user's own emails below. */
  async function emailSuggestions(tabId: number): Promise<EmailSuggestions> {
    const settings = await getSettings();
    const [hme, contacts] = await Promise.all([hideMyEmailState(tabId, settings), contactEmailsState(settings)]);
    return { hideMyEmail: hme, contacts };
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
    if ((await companion.state()) === "not-installed") return { state: settings.companionEmailsHint ? "hint" : "off" };
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

  /** No iCloud+: turn Hide My Email and its hint off, so sign-up forms stop offering it. */
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
      if (request.type === "autofill-status") return autofillStatus(caller, request.kind);
      if (request.type === "generated-username") {
        trackUsername(caller, request.username);
        return null;
      }
      if (request.type === "generated-form-gone") {
        trackUsername(caller, request.username);
        void saveGenerated(caller.tabId, request.username);
        return null;
      }
      throw new Error("not allowed");
    }
    switch (request.type) {
      case "get-status":
        // retrying "no-helper" is how the popup and setup page notice that setup just finished
        if (session.status.state === "disconnected" || session.status.state === "no-helper") {
          await session.connect().catch(() => {});
        }
        return fullStatus();
      case "unlock-with-touch-id": {
        await session.requestCode();
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
        const result = await fillLogin(tabId, request.username, async (origin, password) => {
          const [injection] = await browser.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            func: fillCredentials,
            args: [origin, request.username, password],
          });
          return String(injection?.result ?? "no-fields");
        });
        return { result };
      }
      case "generate-passwords": {
        const client = await session.unlockedClient();
        const tabId = tabOf(caller);
        const context = await newPasswordContext(tabId, request.nonce);
        const url = await tabUrl(tabId);
        // only a form that asks for no username at all (a reset, a change of password) gets a guess;
        // a sign-up's empty email field is the user's to fill
        const guess = !context.username && !context.asksForUsername && url;
        const account = guess ? await accountFor(url.hostname).catch(() => undefined) : undefined;
        const passwords: GeneratedPasswords = {
          strong: generatePassword("strong", context.rules),
          ...(account ? { account } : {}),
        };
        try {
          passwords.alphanumeric = generatePassword("alphanumeric", context.rules);
        } catch (error) {
          if (!(error instanceof PasswordRulesError)) throw error;
        }
        session.assertCurrent(client);
        generatedForMenu.set(`${tabId}:${request.nonce}`, passwords);
        return passwords;
      }
      case "use-generated-password": {
        const tabId = tabOf(caller);
        const passwords = generatedForMenu.get(`${tabId}:${request.nonce}`);
        if (!passwords) throw new Error("That password expired. Try again.");
        const password = passwords[request.style];
        if (!password) throw new PasswordRulesError();
        return { result: await fillGenerated(tabId, request.nonce, password, passwords.account) };
      }
      case "unconfirmed-passwords": {
        const url = await tabUrl(tabOf(caller, request.tabId));
        return unconfirmed
          .filter((entry) => entry.hostname === url?.hostname)
          .map(({ username, password }) => ({ username, password }));
      }
      case "generated-username":
      case "generated-form-gone":
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
      case "open-password-creation": {
        const url = await tabUrl(tabOf(caller));
        if (!url) throw new Error("this page can't create a password");
        const client = await session.connect();
        client.openPasswordsApp(url.origin, { create: true });
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
        return emailSuggestions(tabOf(caller));
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
    const choice = {};
    fillChoices.set(tabId, choice);
    const client = await session.unlockedClient();
    const assertCurrent = () => {
      session.assertCurrent(client);
      if (fillChoices.get(tabId) !== choice) throw new ProtocolError("replaced by a newer choice", "superseded");
    };
    const url = await tabUrl(tabId);
    if (!url) throw new Error("this page can't be filled");
    assertCurrent();
    const result = await fill(url.origin, null);
    assertCurrent();
    if (result === "filled") chosenLogins.set(url.hostname, { username, tabId, at: Date.now() });
    if (result !== "needs-password") return result;
    const now = await tabUrl(tabId);
    assertCurrent();
    if (now?.origin !== url.origin) return "origin-mismatch";
    const credential = await client.getPassword(url.hostname, username, { tabId });
    assertCurrent();
    if (!credential) throw new Error("that login is no longer saved");
    const filled = await fill(url.origin, credential.password);
    assertCurrent();
    // signed in: no reset to save for
    if (filled === "filled") chosenLogins.delete(url.hostname);
    return filled;
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
      sender.frameId === 0 &&
      sender.url &&
      CONTENT_SCRIPT_REQUESTS.has(request.type)
    ) {
      caller = { kind: "content-script", tabId: sender.tab.id, url: sender.url };
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
  return fillableUrl(tab.url);
}

async function getSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}
