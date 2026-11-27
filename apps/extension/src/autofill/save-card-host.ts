// The save card's frame on the page: like the inline menu's (see menu-host.ts), a top-layer popover
// holding a closed shadow root with our extension iframe, in the top right corner. It asks whether
// to save a login, for password managers that don't ask themselves (Apple's macOS does).

import { createFrame, HOST_STYLE } from "./menu-host.ts";
import { pageScheme } from "./page-scheme.ts";

const WIDTH = 340;
const MARGIN = 12;

export class SaveCardHost {
  readonly #host: HTMLElement;
  readonly #shadow: ShadowRoot;
  #nonce: string | undefined;

  constructor(private readonly cardUrl: string) {
    this.#host = document.createElement("app-save-card");
    this.#host.setAttribute("popover", "manual");
    this.#shadow = this.#host.attachShadow({ mode: "closed" });
  }

  isCurrent(nonce: unknown): boolean {
    return typeof nonce === "string" && nonce.length > 0 && nonce === this.#nonce;
  }

  /** `nonce` comes from the background, which answers the card only with it. */
  open(nonce: string): void {
    this.#nonce = nonce;
    const scheme = pageScheme(document.body ?? document.documentElement);
    const params = new URLSearchParams({ nonce, scheme });
    this.#shadow.replaceChildren(createFrame(`${this.cardUrl}#${params}`, scheme));
    // hidden until the card reports its size, so an empty frame never shows
    this.#style(0);
    if (!this.#host.isConnected) document.documentElement.append(this.#host);
    if (this.#host.matches(":popover-open")) this.#host.hidePopover();
    this.#host.showPopover();
  }

  resize(nonce: string, height: number): void {
    if (this.isCurrent(nonce)) this.#style(Math.min(Math.max(height, 40), 240));
  }

  close(nonce?: string): void {
    if (nonce !== undefined && !this.isCurrent(nonce)) return;
    this.#nonce = undefined;
    this.#shadow.replaceChildren();
    if (this.#host.matches(":popover-open")) this.#host.hidePopover();
    this.#host.remove();
  }

  #style(height: number) {
    const style: Record<string, string> = {
      ...HOST_STYLE,
      top: `${MARGIN}px`,
      right: `${MARGIN}px`,
      width: `${WIDTH}px`,
      "max-width": `calc(100vw - ${2 * MARGIN}px)`,
      height: `${height}px`,
      visibility: height > 0 ? "visible" : "hidden",
    };
    for (const [key, value] of Object.entries(style)) this.#host.style.setProperty(key, value, "important");
  }
}
