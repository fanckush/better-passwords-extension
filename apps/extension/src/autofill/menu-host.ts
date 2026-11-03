// The inline menu's frame on the page: a top-layer popover holding a closed shadow root with our
// extension iframe. The page can see that the element exists, but can't see into the iframe
// (cross-origin) or the shadow root (closed), and can't style it (inline !important styles).

import type { FieldKind } from "./fields.ts";
import { isMenuGenuinelyVisible, VisibilityWatch } from "./visibility.ts";

/** "generated": the field holds a strong password we filled in (and saved, unless "-unsaved"). */
export type MenuMode =
  | "logins"
  | "generate"
  | "generated"
  | "generated-unsaved"
  | "email"
  | "codes"
  | "locked"
  | "setup";

const WIDTH = 300;
const GAP = 4;
const MAX_HEIGHT = 320;
/** How long the menu must have been visible, without a break, before it may fill anything. */
const STEADY_MS = 300;

const HOST_STYLE: Record<string, string> = {
  all: "initial",
  position: "fixed",
  inset: "auto",
  margin: "0",
  padding: "0",
  border: "0",
  background: "transparent",
  overflow: "hidden",
  display: "block",
  opacity: "1",
  "z-index": "2147483647",
  "color-scheme": "light dark",
  // the shadow sits outside the iframe, which would clip it; the radius matches the menu panel
  "border-radius": "10px",
  "box-shadow": "0 8px 28px light-dark(rgb(0 0 0 / 0.18), rgb(0 0 0 / 0.5)), 0 1px 4px rgb(0 0 0 / 0.12)",
};

function createFrame(src: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.setAttribute("title", "Better Passwords");
  frame.setAttribute("allow", "");
  for (const [key, value] of Object.entries({
    border: "0",
    width: "100%",
    height: "100%",
    display: "block",
    "color-scheme": "light dark",
  })) {
    frame.style.setProperty(key, value, "important");
  }
  frame.src = src;
  return frame;
}

export class MenuHost {
  readonly #host: HTMLElement;
  readonly #shadow: ShadowRoot;
  #frame: HTMLIFrameElement | undefined;
  #anchor: HTMLInputElement | undefined;
  #nonce: string | undefined;
  #height = 48;
  /** Hidden until the menu page reports its size, so an empty frame never shows. */
  #rendered = false;
  /** Hidden while the menu has nothing to show (no login starts with what was typed). */
  #empty = false;
  /** Focus asked for while hidden: a hidden frame can't take it, so it's given once the menu shows. */
  #focusWhenShown = false;
  /** Whether the menu sits above its field. */
  #above = false;
  /** What the menu page was last told of that (see onPlacement); it can't hear before it has loaded. */
  #toldAbove: boolean | undefined;
  readonly #watch = new VisibilityWatch(() => isMenuGenuinelyVisible(this.#host));
  /** The pending frame of the loop that keeps the menu on its field (see #follow). */
  #followFrame: number | undefined;
  /** Where the field and viewport were when the menu was last placed. */
  #placedFor = "";

  /** `onPlacement` tells the menu page when it moves above its field, or back under it. */
  constructor(
    private readonly menuUrl: string,
    private readonly onPlacement: (above: boolean) => void = () => {},
  ) {
    this.#host = document.createElement("app-autofill-menu");
    this.#host.setAttribute("popover", "manual");
    this.#shadow = this.#host.attachShadow({ mode: "closed" });
    this.#applyStyle();
  }

  get anchor(): HTMLInputElement | undefined {
    return this.#nonce ? this.#anchor : undefined;
  }

  /** The open menu's nonce, which the menu page checks on messages sent straight to it. */
  get nonce(): string | undefined {
    return this.#nonce;
  }

  get element(): HTMLElement {
    return this.#host;
  }

  isCurrent(nonce: unknown): boolean {
    return typeof nonce === "string" && nonce.length > 0 && nonce === this.#nonce;
  }

  get isOpen(): boolean {
    return this.#nonce !== undefined;
  }

  /** Whether the menu sits above its field (then ↑ leads into it, not ↓). */
  get isAbove(): boolean {
    return this.#above;
  }

  /** Open and on screen: not waiting for its first size, nor hidden for having nothing to show. */
  get isShowing(): boolean {
    return this.isOpen && this.#rendered && !this.#empty;
  }

  /**
   * `nonce` comes from the background, which accepts requests from this menu only with it.
   * `orGenerate`: with no saved logins, suggest a strong password instead (a field that may be a sign-up's).
   */
  open(anchor: HTMLInputElement, mode: MenuMode, kind: FieldKind, nonce: string, orGenerate = false): void {
    this.#anchor = anchor;
    this.#nonce = nonce;
    this.#height = 48;
    this.#rendered = false;
    this.#empty = false;
    this.#focusWhenShown = false;
    this.#above = false;
    this.#toldAbove = undefined;
    // A new iframe every time: changing only the URL fragment of an existing one would not reload
    // the menu page, which would keep the previous menu's nonce and size.
    // The nonce ties requests to this menu; a copy of menu.html framed by the page itself has none.
    // "password": the menu is on a password field, e.g. the step after the username in a multi-step sign-in
    const field = anchor.type === "password" ? "password" : "username";
    const params = new URLSearchParams({ nonce: this.#nonce, mode, kind, field });
    if (orGenerate) params.set("orGenerate", "1");
    this.#frame = createFrame(`${this.menuUrl}#${params}`);
    this.#shadow.replaceChildren(this.#frame);
    if (!this.#host.isConnected) document.documentElement.append(this.#host);
    // re-entering the top layer puts us above anything the page opened before
    if (this.#host.matches(":popover-open")) this.#host.hidePopover();
    this.#host.showPopover();
    this.position();
    this.#watch.start();
    this.#follow();
  }

  /**
   * Re-places the menu whenever its field moves without a scroll or resize: a dialog sliding or
   * fading in, an error message pushing the form down, a step of the form animating away.
   */
  #follow(): void {
    if (this.#followFrame !== undefined) cancelAnimationFrame(this.#followFrame);
    const tick = () => {
      if (!this.isOpen) {
        this.#followFrame = undefined;
        return;
      }
      if (this.#placement() !== this.#placedFor) this.position();
      this.#followFrame = requestAnimationFrame(tick);
    };
    this.#followFrame = requestAnimationFrame(tick);
  }

  #placement(): string {
    const rect = this.#anchor?.getBoundingClientRect();
    return rect
      ? `${rect.left},${rect.top},${rect.width},${rect.height},${window.innerWidth},${window.innerHeight}`
      : "";
  }

  /**
   * Whether a choice made in the menu may be acted on: it is genuinely visible now and has been
   * for a while, so the user saw what they clicked (see VisibilityWatch).
   */
  isTrustworthy(): boolean {
    return this.#watch.steadilyVisible(STEADY_MS);
  }

  /** A height of 0 hides the menu, keeping it open so it can show again. */
  resize(height: number): void {
    this.#rendered = true;
    this.#empty = height === 0;
    if (!this.#empty) this.#height = Math.max(24, Math.min(MAX_HEIGHT, Math.ceil(height)));
    this.position();
    if (this.#focusWhenShown && this.isShowing) this.focusMenu();
  }

  /** Places the menu under the field, or above it when there is no room below. */
  position(): void {
    const anchor = this.#anchor;
    if (!this.isOpen || !anchor) return;
    if (!anchor.isConnected) {
      this.close();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    this.#placedFor = this.#placement();
    const width = Math.min(Math.max(rect.width, WIDTH), window.innerWidth - 2 * GAP);
    const left = Math.min(Math.max(GAP, rect.left), window.innerWidth - width - GAP);
    const below = rect.bottom + GAP;
    const above = rect.top - GAP - this.#height;
    const fitsAbove = above >= GAP;
    const isAbove = below + this.#height > window.innerHeight && fitsAbove;
    const top = isAbove ? above : below;
    this.#above = isAbove;
    // once rendered, the page is listening
    if (this.#rendered && isAbove !== (this.#toldAbove ?? false)) {
      this.#toldAbove = isAbove;
      this.onPlacement(isAbove);
    }
    this.#applyStyle({
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${this.#height}px`,
      visibility: this.isShowing ? "visible" : "hidden",
    });
  }

  focusMenu(): void {
    this.#focusWhenShown = !this.isShowing;
    if (!this.#focusWhenShown) this.#frame?.focus();
  }

  close(): void {
    this.#watch.stop();
    if (this.#followFrame !== undefined) cancelAnimationFrame(this.#followFrame);
    this.#followFrame = undefined;
    this.#nonce = undefined;
    this.#anchor = undefined;
    if (this.#host.matches(":popover-open")) this.#host.hidePopover();
    this.#frame = undefined;
    this.#shadow.replaceChildren();
    this.#host.remove();
  }

  #applyStyle(extra: Record<string, string> = {}): void {
    for (const [key, value] of Object.entries({ ...HOST_STYLE, ...extra })) {
      this.#host.style.setProperty(key, value, "important");
    }
  }
}
