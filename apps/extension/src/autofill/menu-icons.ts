// Minimal mode's icons: the extension's own icon at the end of every field on the page that would
// get a menu. The menu never opens by itself in that mode; a click on an icon opens it (see
// autofill.content.ts). The background says which fields get one (`ask`): the same answer as for a
// menu on focus, so an icon shows only where there's something to offer.
//
// An icon takes its own clicks (see FieldIcon's `takesClicks`): a click on the field itself is the
// page's and the browser's, which shows its passkey list on a click in a passkey field.
//
// Icons show only for fields in view. They move with their fields while anything changes (a scroll,
// a resize, the page changing, an animation, the user's input) and for a second after, then check
// once a second: a loop every frame on every page with a login form would never let it idle.

import appIcon from "@/assets/icon.svg?raw";
import { FieldIcon } from "./field-icon.ts";
import { type FieldKind, fieldKind, maySignIn } from "./fields.ts";

export type FieldToAsk = { kind: FieldKind; signIn: boolean };

/** How long a page's changes settle before its fields are looked at again. */
const SCAN_DELAY = 300;
/** How long icons follow their fields every frame after something changed. */
const FOLLOW_FOR = 1000;
/** How often icons are checked while nothing seems to change. */
const CHECK_EVERY = 1000;

export class MenuIcons {
  readonly #icons = new Map<HTMLInputElement, FieldIcon>();
  #on: AbortController | undefined;
  #inView: IntersectionObserver | undefined;
  #changes: MutationObserver | undefined;
  #scanTimer: ReturnType<typeof setTimeout> | undefined;
  #checkTimer: ReturnType<typeof setInterval> | undefined;
  #ticket = 0;
  /** The fields last asked about and their kinds, to ask again only when they change. */
  #asked = "";
  #askedFields: HTMLInputElement[] = [];
  #frame: number | undefined;
  #followUntil = 0;

  constructor(private readonly ask: (fields: FieldToAsk[]) => Promise<boolean[]>) {}

  get isOn(): boolean {
    return this.#on !== undefined;
  }

  /** Icons on the page's fields, now and as it changes, until stop(). */
  start(): void {
    if (this.#on) return;
    const on = new AbortController();
    this.#on = on;
    this.#inView = new IntersectionObserver((entries) => {
      for (const { target, isIntersecting } of entries) {
        const icon = this.#icons.get(target as HTMLInputElement);
        if (isIntersecting) icon?.show(target as HTMLInputElement);
        else icon?.hide();
      }
    });
    this.#changes = new MutationObserver(() => {
      this.#follow();
      this.#scanSoon();
    });
    this.#changes.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["type", "autocomplete", "disabled", "readonly", "name", "id"],
    });
    const options = { capture: true, passive: true, signal: on.signal };
    for (const type of ["scroll", "transitionrun", "animationstart", "input", "focusin", "pointerdown"]) {
      document.addEventListener(type, this.#follow, options);
    }
    window.addEventListener("resize", this.#follow, { passive: true, signal: on.signal });
    this.#checkTimer = setInterval(() => this.#place(), CHECK_EVERY);
    this.refresh();
  }

  stop(): void {
    this.#on?.abort();
    this.#on = undefined;
    this.#inView?.disconnect();
    this.#changes?.disconnect();
    clearTimeout(this.#scanTimer);
    clearInterval(this.#checkTimer);
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#ticket++;
    this.#asked = "";
    this.#askedFields = [];
    for (const icon of this.#icons.values()) icon.hide();
    this.#icons.clear();
  }

  /** Asks again which fields get an icon, even if they're the same (the settings changed). */
  refresh(): void {
    this.#asked = "";
    void this.#scan();
  }

  /** The field whose icon `target` is, if it's one of ours. */
  fieldOf(target: EventTarget | null): HTMLInputElement | undefined {
    for (const [field, icon] of this.#icons) if (icon.element === target) return field;
    return undefined;
  }

  has(field: EventTarget | null): field is HTMLInputElement {
    return this.#icons.has(field as HTMLInputElement);
  }

  /** The icons' own elements, for the menu's visibility check (see MenuHost's `ours`). */
  elements(): HTMLElement[] {
    return Array.from(this.#icons.values(), (icon) => icon.element);
  }

  #scanSoon(): void {
    clearTimeout(this.#scanTimer);
    this.#scanTimer = setTimeout(() => void this.#scan(), SCAN_DELAY);
  }

  async #scan(): Promise<void> {
    if (!this.#on) return;
    const ticket = ++this.#ticket;
    const fields: HTMLInputElement[] = [];
    const asks: FieldToAsk[] = [];
    for (const field of document.querySelectorAll("input")) {
      const kind = fieldKind(field);
      if (!kind) continue;
      fields.push(field);
      asks.push({ kind, signIn: kind === "email" && maySignIn(field) });
    }
    // the same fields as last time: nothing to ask
    const key = asks.map(({ kind, signIn }) => `${kind}:${signIn}`).join(",");
    if (key === this.#asked && fields.every((field, i) => field === this.#askedFields[i])) return;
    const answers = fields.length > 0 ? await this.ask(asks).catch(() => [] as boolean[]) : [];
    if (ticket !== this.#ticket || !this.#on) return;
    this.#asked = key;
    this.#askedFields = fields;
    const wanted = new Set(fields.filter((_, i) => answers[i]));
    for (const [field, icon] of this.#icons) {
      if (wanted.has(field)) continue;
      icon.hide();
      this.#inView?.unobserve(field);
      this.#icons.delete(field);
    }
    for (const field of wanted) {
      if (this.#icons.has(field)) continue;
      this.#icons.set(
        field,
        new FieldIcon({ tag: "app-autofill-icon", art: { svg: appIcon }, takesClicks: true, follows: false }),
      );
      // shows the icon once the field is in view (see the observer in start)
      this.#inView?.observe(field);
    }
  }

  /** Icons follow their fields every frame for a while: something on the page changed. */
  readonly #follow = (): void => {
    this.#followUntil = performance.now() + FOLLOW_FOR;
    if (this.#frame !== undefined) return;
    const tick = () => {
      this.#place();
      this.#frame = performance.now() < this.#followUntil ? requestAnimationFrame(tick) : undefined;
    };
    this.#frame = requestAnimationFrame(tick);
  };

  #place(): void {
    for (const icon of this.#icons.values()) if (icon.field) icon.place();
  }
}
