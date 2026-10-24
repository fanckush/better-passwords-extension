import "./style.css";
import { DISPLAY_NAME } from "@/src/config.ts";
import { requestHideMyEmailConsent } from "@/src/icloud/consent.ts";
import type { EmailSuggestions, GeneratedPasswords, MenuMessage } from "@/src/messages.ts";
import { bindToMenu, send } from "@/src/messages.ts";
import { applySystemAccent } from "@/src/ui/accent.ts";
import { bindCodeInput } from "@/src/ui/code-input.ts";
import { companionPitch } from "@/src/ui/companion-pitch.ts";
import { h } from "@/src/ui/h.ts";
import { CANCEL, CHECK, ENVELOPE, EYE, icon, KEY, LOCK, OPEN, PERSON, REFRESH } from "@/src/ui/icons.ts";

// The inline menu, shown in an iframe under a login field. It is an extension page, so the web
// page can't read the usernames shown here or listen to keys typed into the code field.

applySystemAccent();

const params = new URLSearchParams(window.location.hash.slice(1));
const nonce = params.get("nonce") ?? "";
bindToMenu(nonce);
/** The field the menu belongs to: "login", or "new-password" for sign-up and change-password forms. */
const kind = params.get("kind") ?? "login";
/** Whether the menu is on a password field, rather than a username one. */
const onPasswordField = params.get("field") === "password";
const panel = document.getElementById("menu") as HTMLElement;

// --- clickjacking guard ------------------------------------------------------------------------
// Where the browser supports IntersectionObserver v2, it reports whether this frame is actually
// visible on screen (not covered, not transparent). Clicks count only after 300 ms of visibility.

let visibleSince: number | undefined;
const tracksVisibility = "IntersectionObserverEntry" in window && "isVisible" in IntersectionObserverEntry.prototype;
if (tracksVisibility) {
  const options = { trackVisibility: true, delay: 100 } as IntersectionObserverInit;
  new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const visible = (entry as IntersectionObserverEntry & { isVisible: boolean }).isVisible;
      visibleSince = visible ? (visibleSince ?? performance.now()) : undefined;
    }
  }, options).observe(panel);
}

function deliberate(event: Event): boolean {
  if (!event.isTrusted) return false;
  if (!tracksVisibility) return true;
  return visibleSince !== undefined && performance.now() - visibleSince >= 300;
}

// --- rendering ---------------------------------------------------------------------------------

/** Asks for room for the whole list (the host caps it; beyond that the list scrolls). */
function reportSize() {
  const borders = panel.offsetHeight - panel.clientHeight;
  // scrollHeight is rounded, the content may be a fraction taller: one spare pixel keeps a list
  // that fits from scrolling by that fraction
  void send({ type: "menu-resize", nonce, height: panel.scrollHeight + borders + 1 }).catch(() => {});
}

function close() {
  void send({ type: "menu-close", nonce }).catch(() => {});
}

function render(...children: (Node | null)[]) {
  panel.replaceChildren(...children.filter((c): c is Node => c !== null));
  // right away: the frame stays hidden until the first report, and a hidden frame gets no
  // animation frames (reading the size lays the panel out synchronously)
  reportSize();
}

function row(
  svgPath: string,
  title: string,
  detail: string,
  onChoose: () => void,
  detailClass = "detail",
): HTMLButtonElement {
  const button = h(
    "button",
    { class: "row", attrs: { role: "option" } },
    icon(svgPath),
    h(
      "span",
      { class: "text" },
      h("span", { class: "title", textContent: title }),
      detail ? h("span", { class: detailClass, textContent: detail }) : null,
    ),
  );
  button.addEventListener("click", (event) => {
    if (deliberate(event)) onChoose();
  });
  return button;
}

function message(text: string, isError = false) {
  return h("div", { class: isError ? "message error" : "message", textContent: text });
}

/** What the menu shows: what needs an unlocked session ("unlocked"), the way to unlock, or neither. */
let view: "unlocked" | "locked" | "other" = "other";

// the logins shown, so typing in the field can narrow them down without asking again
let loginsView: { logins: { username: string }[]; hostname: string; chosen?: string; error?: string } | undefined;
/** What the user typed into the username field: only logins starting with it are listed. */
let query = "";
/** Whether the user asked for the logins besides the one chosen on the sign-in's previous step. */
let showOthers = false;

async function showLogins(error?: string) {
  view = "unlocked";
  let result: Awaited<ReturnType<typeof send<{ type: "list-logins" }>>>;
  try {
    result = await send({ type: "list-logins" });
  } catch (e) {
    return render(message(messageOf(e), true));
  }
  if (result.logins.length === 0) {
    loginsView = undefined;
    return render(message(`No saved passwords for ${result.hostname ?? "this site"}.`), openPasswordsRow(true));
  }
  loginsView = {
    logins: result.logins,
    hostname: result.hostname ?? "",
    ...(result.chosen !== undefined ? { chosen: result.chosen } : {}),
    ...(error ? { error } : {}),
  };
  renderLogins();
}

function renderLogins() {
  if (!loginsView) return;
  const { logins, hostname, chosen, error } = loginsView;
  const prefix = query.trim().toLowerCase();
  const matches = logins.filter(({ username }) => username.toLowerCase().startsWith(prefix));
  // nothing starts with what's typed (a new username, probably): out of the way, like Safari
  if (matches.length === 0) {
    panel.replaceChildren();
    void send({ type: "menu-resize", nonce, height: 0 }).catch(() => {});
    return;
  }
  // the password step after one where a login was chosen: just that one (listed first), the others
  // a click away. Back on the username step, the user may well be after another one: all of them.
  const focused = onPasswordField && chosen !== undefined && !prefix && !showOthers && matches.length > 1;
  const shown = focused ? matches.slice(0, 1) : matches;
  render(
    ...shown.map(({ username }) => row(KEY, username || "(no username)", hostname, () => void fill(username))),
    focused ? othersRow(matches.length - 1) : null,
    error ? message(error, true) : null,
    h("hr", { class: "separator" }),
    openPasswordsRow(false),
  );
}

function othersRow(count: number) {
  const button = h("button", {
    class: "row others",
    textContent: count === 1 ? "1 other account" : `${count} other accounts`,
    attrs: { role: "option" },
  });
  button.addEventListener("click", () => {
    showOthers = true;
    renderLogins();
    // keyboard users carry on at the first account that just appeared
    panel.querySelectorAll<HTMLElement>(".row")[1]?.focus();
  });
  return button;
}

browser.runtime.onMessage.addListener((request: MenuMessage, sender) => {
  if (sender.id !== browser.runtime.id) return false;
  // sent straight here by our content script as the user types in the field
  if (request.type === "menu-filter" && nonce && request.nonce === nonce) {
    query = request.query;
    renderLogins();
  }
  // the menu sits above its field: listed bottom-up, the first item nearest the field
  if (request.type === "menu-placement" && nonce && request.nonce === nonce) {
    document.documentElement.classList.toggle("above", request.above);
  }
  // unlocked or locked elsewhere, like the popup
  if (request.type === "session-changed") {
    if (request.unlocked) void unlocked();
    else if (view === "unlocked") void showLocked();
  }
  return false;
});

async function showGenerate(error?: string) {
  view = "unlocked";
  let passwords: GeneratedPasswords;
  try {
    passwords = await send({ type: "generate-passwords", nonce });
  } catch (e) {
    return render(message(messageOf(e), true), createPasswordRow());
  }
  render(
    // a form that doesn't say whose password this is (a reset): say who we'll save it for
    passwords.account ? message(`For ${passwords.account}`) : null,
    createPasswordRow(),
    passwordRow("Strong Password", passwords.strong, () => void useGenerated("strong")),
    passwords.alphanumeric
      ? passwordRow("Without Special Characters", passwords.alphanumeric, () => void useGenerated("alphanumeric"))
      : null,
    error ? message(error, true) : null,
    h("hr", { class: "separator" }),
    openPasswordsRow(false),
  );
}

/** Shows the first characters only (and the hyphens), so a shared screen doesn't give it away. */
function masked(password: string): string {
  return [...password].map((c, i) => (i < 3 || c === "-" ? c : "•")).join("");
}

/**
 * A generated password, partly hidden. Hovering the eye shows it. The eye sits inside the row,
 * so a click on it is a click on the row.
 */
function passwordRow(title: string, password: string, onChoose: () => void): HTMLElement {
  const choice = row(KEY, title, masked(password), onChoose, "detail password");
  const detail = choice.querySelector(".password") as HTMLElement;
  const eye = h("span", { class: "reveal", title: "Show password" }, icon(EYE));
  // every move over the eye shows it (sturdier than relying on a single enter event)
  eye.addEventListener("pointermove", () => {
    if (detail.textContent !== password) detail.textContent = password;
  });
  eye.addEventListener("pointerleave", () => {
    detail.textContent = masked(password);
  });
  choice.append(eye);
  return choice;
}

/** Fills the password in now; Apple Passwords asks to save it when the form is submitted. */
async function useGenerated(style: "strong" | "alphanumeric") {
  try {
    const { result } = await send({ type: "use-generated-password", nonce, style });
    // when filled, the content script closes the menu
    if (result === "filled") return;
    await showGenerate(
      result === "menu-hidden"
        ? "The page tried to hide this menu, so nothing was filled in."
        : "Couldn't fill in this page.",
    );
  } catch (e) {
    await showGenerate(messageOf(e));
  }
}

/** The field already holds a strong password we generated. */
function showGeneratedDone(saved: boolean) {
  render(
    saved
      ? row(CHECK, "Strong Password Saved", "In Apple Passwords", () => close())
      : row(KEY, "Strong Password", "You'll be asked to save it when you continue", () => close()),
    row(KEY, "Choose a Different Password", "", () => void showGenerate()),
    h("hr", { class: "separator" }),
    openPasswordsRow(false),
  );
}

// --- sign-up email fields: Hide My Email ---------------------------------------------------------

async function showEmail() {
  // asking iCloud can take a second or two: show that something is happening, unless it's quick
  const loading = setTimeout(() => render(loadingRow(ENVELOPE, "Hide My Email")), 150);
  try {
    renderEmail(await send({ type: "email-suggestions", nonce }));
  } catch (e) {
    render(message(messageOf(e), true));
  } finally {
    clearTimeout(loading);
  }
}

/** A row that can't be chosen yet, with a spinner. */
function loadingRow(svgPath: string, title: string): HTMLElement {
  return h(
    "div",
    { class: "row loading", attrs: { "aria-busy": "true" } },
    icon(svgPath),
    h(
      "span",
      { class: "text" },
      h("span", { class: "title", textContent: title }),
      h("span", { class: "detail", textContent: "Loading…" }),
    ),
    h("span", { class: "spinner", attrs: { "aria-hidden": "true" } }),
  );
}

// the menu's last answer, so one part can be redrawn without asking again
let lastSuggestions: EmailSuggestions = { hideMyEmail: { state: "off" }, contacts: { state: "off" } };

function renderEmail(suggestions: EmailSuggestions, error?: string) {
  lastSuggestions = suggestions;
  const { hideMyEmail: hme, contacts } = suggestions;
  const rows: (Node | null)[] = [];
  if (hme.state === "hint") {
    rows.push(hintRow());
  } else if (hme.state === "ready") {
    const { address } = hme;
    rows.push(
      address
        ? row(ENVELOPE, address, "Hide My Email for this site", () => void useAddress(address, false))
        : row(
            ENVELOPE,
            "Hide My Email…",
            "Create a unique, random address that forwards to your inbox",
            () => void showProposal(),
          ),
    );
  } else if (hme.state === "signed-out") {
    rows.push(
      row(ENVELOPE, "Sign In to iCloud for Hide My Email", "Opens icloud.com in a new tab", async () => {
        await send({ type: "open-icloud" }).catch(() => {});
        close();
      }),
    );
  } else if (hme.state === "needs-icloud-plus") {
    rows.push(
      row(ENVELOPE, "Hide My Email needs iCloud+", "Learn about iCloud+", async () => {
        await send({ type: "open-icloud-plus" }).catch(() => {});
        close();
      }),
    );
  } else if (hme.state === "error") {
    rows.push(message(hme.message, true));
  }
  if (error) rows.push(message(error, true));

  // below Hide My Email: the user's own emails, from their contact card
  const own: Node[] = [];
  if (contacts.state === "ready") {
    for (const email of contacts.emails) {
      own.push(row(PERSON, email, "From your contact card", () => void fillOwnEmail(email)));
    }
  } else if (contacts.state === "hint") {
    own.push(companionHintRow());
  } else if (contacts.state === "needs-contacts") {
    own.push(message("To suggest your email addresses, allow Contacts in the companion app."));
  }
  if (rows.length > 0 && own.length > 0) rows.push(h("hr", { class: "separator" }));
  rows.push(...own);

  if (rows.length === 0) return close();
  render(...rows);
}

/** A row with a ✕ that dismisses it for good (without choosing the row). */
function dismissible(hint: HTMLButtonElement, label: string, onDismiss: () => Promise<unknown>): HTMLButtonElement {
  const dismiss = h("span", { class: "dismiss", title: "Don't show again" }, icon(CANCEL));
  dismiss.setAttribute("role", "button");
  dismiss.setAttribute("aria-label", label);
  dismiss.addEventListener("click", (event) => {
    // the ✕ sits inside the row: don't let the click choose the row
    event.stopPropagation();
    if (deliberate(event))
      void onDismiss()
        .catch(() => {})
        .finally(close);
  });
  hint.append(dismiss);
  return hint;
}

/** Advertises the companion app, which lets the menu suggest the emails on the user's contact card. */
function companionHintRow(): HTMLButtonElement {
  const hint = row(PERSON, "Suggest Your Email Addresses", "With the free companion app for Mac", async () => {
    await send({ type: "open-companion-page" }).catch(() => {});
    close();
  });
  return dismissible(hint, "Don't suggest the app again", () => send({ type: "dismiss-companion-emails-hint" }));
}

async function fillOwnEmail(email: string) {
  try {
    const { result } = await send({ type: "fill-email", nonce, email });
    if (result !== "filled") renderEmail(lastSuggestions, fillError(result));
  } catch (e) {
    renderEmail(lastSuggestions, messageOf(e));
  }
}

function fillError(result: string): string {
  return result === "menu-hidden"
    ? "The page tried to hide this menu, so nothing was filled in."
    : "Couldn't fill in this page.";
}

/** Advertises Hide My Email until the user turns it on, or dismisses it for good with the ✕. */
function hintRow(): HTMLButtonElement {
  const hint = row(
    ENVELOPE,
    "Use Hide My Email",
    "A unique iCloud+ address for each site, labeled with its name",
    () => void enableHideMyEmail(),
  );
  return dismissible(hint, "Don't suggest Hide My Email again", () => send({ type: "dismiss-hide-my-email-hint" }));
}

async function enableHideMyEmail() {
  render(message("Turning on Hide My Email…"));
  try {
    if (!(await requestHideMyEmailConsent())) {
      renderEmail(lastSuggestions);
      return;
    }
    renderEmail(await send({ type: "enable-hide-my-email", nonce }));
  } catch (e) {
    render(message(messageOf(e), true));
  }
}

async function showProposal() {
  render(message("Creating an address…"));
  try {
    const { address } = await send({ type: "generate-hide-my-email", nonce });
    render(
      row(ENVELOPE, address, "Use This Address", () => void useAddress(address, true)),
      row(REFRESH, "Try Another", "", () => void showProposal()),
    );
  } catch (e) {
    renderEmail(...afterICloudError(e));
  }
}

/** What the email menu shows after a Hide My Email call failed. */
function afterICloudError(error: unknown): [EmailSuggestions, string?] {
  if ((error as { code?: string }).code === "no-icloud-plus") {
    return [{ ...lastSuggestions, hideMyEmail: { state: "needs-icloud-plus" } }];
  }
  return [{ ...lastSuggestions, hideMyEmail: { state: "ready" } }, messageOf(error)];
}

async function useAddress(address: string, reserve: boolean) {
  render(message(reserve ? "Setting up the address…" : "Filling it in…"));
  try {
    const { result } = await send({ type: "use-hide-my-email", nonce, address, reserve });
    // when filled, the content script closes the menu
    if (result !== "filled") {
      renderEmail({ ...lastSuggestions, hideMyEmail: { state: "ready", address } }, fillError(result));
    }
  } catch (e) {
    renderEmail(...afterICloudError(e));
  }
}

/** After unlocking, here or elsewhere: the menu's real content, if it was waiting for that. */
async function unlocked() {
  if (view !== "locked") return;
  await (kind === "new-password" ? showGenerate() : showLogins());
}

function openPasswordsRow(withDetail: boolean) {
  return row(OPEN, "Open Passwords App", withDetail ? "Look up or add a password" : "", async () => {
    await send({ type: "open-passwords-app" }).catch(() => {});
    close();
  });
}

function createPasswordRow() {
  return row(OPEN, "Create in Apple Passwords", "Choose and save in Apple's app", async () => {
    try {
      await send({ type: "open-password-creation", nonce });
      close();
    } catch (error) {
      render(message(messageOf(error), true), createPasswordRow());
    }
  });
}

async function fill(username: string) {
  try {
    const { result } = await send({ type: "fill-from-menu", nonce, username });
    if (result !== "filled") {
      await showLogins(
        result === "menu-hidden"
          ? "The page tried to hide this menu, so nothing was filled."
          : "Couldn't fill this page.",
      );
    }
  } catch (e) {
    // chosen again (say, after dismissing Touch ID): that newer choice carries on
    if ((e as { code?: string }).code === "superseded") return;
    await showLogins(messageOf(e));
  }
}

async function showLocked(error?: string) {
  view = "locked";
  const status = await send({ type: "get-status" }).catch(() => undefined);
  const touchId = status?.touchId === true;
  render(
    kind === "new-password" ? createPasswordRow() : null,
    // with the companion app, Touch ID replaces typing the code; the row says so underneath
    row(LOCK, unlockTitle(), touchId ? "Touch ID enters the code for you" : DISPLAY_NAME, () =>
      touchId ? void unlockWithTouchId() : void startPairing(),
    ),
    error ? message(error, true) : null,
  );
}

/** Before this browser can reach Apple Passwords: one row that opens the setup page. */
function showSetup() {
  // set up and unlocked from the popup or the setup page: this menu shows the logins then
  view = "locked";
  render(
    row(KEY, "Set Up Better Passwords", "One quick step to reach Apple Passwords", async () => {
      await send({ type: "open-setup-page" }).catch(() => {});
      close();
    }),
  );
}

function unlockTitle() {
  return kind === "new-password" ? "Unlock to suggest a strong password" : "Unlock to fill passwords";
}

async function startPairing() {
  try {
    // fresh, like the popup: a code asked for earlier may be valid still, but its window closed
    await send({ type: "request-code", fresh: true });
  } catch (e) {
    return showLocked(messageOf(e));
  }
  showCodeEntry();
}

async function unlockWithTouchId() {
  render(message("Confirm with Touch ID…"));
  try {
    await send({ type: "unlock-with-touch-id" });
    await unlocked();
  } catch (e) {
    // the code is on screen either way, so typing it still works
    showCodeEntry(messageOf(e));
  }
}

function showCodeEntry(error?: string) {
  const input = h("input", {
    class: "code",
    inputMode: "numeric",
    autocomplete: "one-time-code",
    ariaLabel: "Verification code",
  });
  bindCodeInput(input, async (code) => {
    input.disabled = true;
    try {
      await send({ type: "verify-code", code });
      await unlocked();
    } catch (e) {
      // a wrong code burns the challenge; ask the Mac for a fresh one
      await send({ type: "request-code", fresh: true }).catch(() => {});
      showCodeEntry(messageOf(e));
    }
  });
  // closed Apple's code window? this brings a fresh one up
  const again = h("button", { class: "link", type: "button", textContent: "Show code again" });
  again.addEventListener("click", async () => {
    input.value = "";
    await send({ type: "request-code", fresh: true }).catch((e) => showCodeEntry(messageOf(e)));
    input.focus();
  });
  render(message("Enter the code shown on your Mac"), input, error ? message(error, true) : null, again);
  void companionPitch(() => {
    void send({ type: "open-companion-page" }).catch(() => {});
    close();
  }).then((pitch) => {
    if (!pitch || !input.isConnected) return;
    panel.append(pitch);
    reportSize();
  });
  input.focus();
}

// --- keyboard ----------------------------------------------------------------------------------

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") return close();
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = Array.from(panel.querySelectorAll<HTMLElement>(".row, .code"));
  if (items.length === 0) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLElement);
  // above its field, the list runs bottom-up: ↑ moves on, ↓ goes back
  const onward = document.documentElement.classList.contains("above") ? "ArrowUp" : "ArrowDown";
  if (event.key === onward) return items[Math.min(index + 1, items.length - 1)]?.focus();
  // back from the first item goes to the field on the page, keeping the menu open
  if (index <= 0) return returnToField();
  items[index - 1]?.focus();
});

function returnToField() {
  (document.activeElement as HTMLElement | null)?.blur();
  void send({ type: "menu-focus-field", nonce }).catch(() => {});
}

// focus arrives here when the user presses ↓ in the field
window.addEventListener("focus", () => {
  if (!panel.contains(document.activeElement)) panel.querySelector<HTMLElement>(".row, .code")?.focus();
});

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text || "Something went wrong.";
}

const mode = params.get("mode");
if (mode === "locked") void showLocked();
else if (mode === "setup") showSetup();
else if (mode === "generate") void showGenerate();
else if (mode === "email") void showEmail();
else if (mode === "generated" || mode === "generated-unsaved") showGeneratedDone(mode === "generated");
else void showLogins();
