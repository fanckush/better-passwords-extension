// An icon of ours drawn at the end of a field, for one field at a time. Generic: it knows nothing
// of what it's for. Its user (the content script) decides which field gets it and what a click on
// it does. The passkey icon and minimal mode's icons use it (see autofill.content.ts).
//
// By default the icon takes no clicks itself (pointer-events: none). A click on it lands on the
// field, as a real click by the user: focus and caret work as usual, and the browser's own handling
// of the field sees a click there (the passkey icon depends on that: the browser opens its passkey
// list only for a real click in the field, which no script can make). The content script's capture
// mousedown asks hits() whether the click was on the icon, and acts before the browser looks.
// The page has nothing of ours to click, cover or fake clicks on.
//
// `takesClicks` is the other way round, for an icon whose click must not reach the field (minimal
// mode's: a click on the field would show the browser's passkey list too). The click is on the
// icon's own element, and the content script's capture mousedown takes it there (checking
// isTrusted: the page can dispatch events at our element, but not trusted ones).
//
// It lives in the top layer, in a closed shadow root, styled inline with !important (like the
// menu, see menu-host.ts). MenuHost's visibility check must be told about it (its `ours`), or it
// takes the icon for something of the page's covering the menu and refuses to fill.

import { icon } from "../ui/icons.ts";
import { fieldBox, fieldIconLayout, type IconLayout } from "./field-icon-layout.ts";

/** A click this close to the icon counts as one on it. */
const SLOP = 4;

const HOST_STYLE: Record<string, string> = {
  all: "initial",
  position: "fixed",
  inset: "auto",
  margin: "0",
  padding: "0",
  border: "0",
  background: "transparent",
  overflow: "visible",
  display: "block",
  "pointer-events": "none",
  "z-index": "2147483647",
  "color-scheme": "light dark",
};

export interface FieldIconOptions {
  /** The element's name on the page (a custom element name: lowercase, with a hyphen). */
  tag: string;
  /**
   * What it shows: a glyph's SVG path from ui/icons.ts, drawn in the field's text colour, or
   * `{ svg }`, an SVG image in its own colours (markup we ship, never the page's).
   */
  art: string | { svg: string };
  /** The icon takes its own clicks, which never reach the field (see above). */
  takesClicks?: boolean;
  /**
   * Whether the icon follows its field by itself, every frame. Without that, its user calls
   * place() when the page may have moved (many icons on a page shouldn't each run a loop).
   */
  follows?: boolean;
}

export class FieldIcon {
  readonly #host: HTMLElement;
  readonly #image: boolean;
  readonly #takesClicks: boolean;
  readonly #follows: boolean;
  #field: HTMLInputElement | undefined;
  #followFrame: number | undefined;
  #hovered = false;
  /** Where and how the icon was last drawn (see fieldIconLayout). */
  #layout: IconLayout | undefined;
  /** The field's own inline cursor, while ours (a pointer over the icon) replaces it. */
  #fieldCursor: { value: string; priority: string } | undefined;

  constructor({ tag, art, takesClicks = false, follows = true }: FieldIconOptions) {
    this.#host = document.createElement(tag);
    this.#host.setAttribute("popover", "manual");
    this.#image = typeof art !== "string";
    this.#takesClicks = takesClicks;
    this.#follows = follows;
    const shadow = this.#host.attachShadow({ mode: "closed" });
    const svg = typeof art === "string" ? icon(art) : parseSvg(art.svg);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.setProperty("display", "block", "important");
    shadow.append(svg);
    if (takesClicks) {
      this.#host.addEventListener("mouseenter", () => this.hover(true));
      this.#host.addEventListener("mouseleave", () => this.hover(false));
    }
    this.#applyStyle({ visibility: "hidden" });
  }

  /** The icon's own element (in the top layer while it shows). */
  get element(): HTMLElement {
    return this.#host;
  }

  /** The field the icon is on, if it shows. */
  get field(): HTMLInputElement | undefined {
    return this.#field;
  }

  show(field: HTMLInputElement): void {
    if (this.#field === field) return;
    this.hide();
    this.#field = field;
    if (!this.#host.isConnected) document.documentElement.append(this.#host);
    this.#host.showPopover();
    this.place();
    if (!this.#follows) return;
    const tick = () => {
      if (this.#field !== field) return;
      this.place();
      this.#followFrame = requestAnimationFrame(tick);
    };
    this.#followFrame = requestAnimationFrame(tick);
  }

  hide(): void {
    if (this.#followFrame !== undefined) cancelAnimationFrame(this.#followFrame);
    this.#followFrame = undefined;
    this.hover(false);
    this.#field = undefined;
    this.#layout = undefined;
    if (this.#host.matches(":popover-open")) this.#host.hidePopover();
    this.#host.remove();
  }

  /** Whether a point (viewport coordinates) is on the icon. */
  hits(x: number, y: number): boolean {
    const layout = this.#currentLayout();
    if (!layout) return false;
    const { left, top, size } = layout;
    return x >= left - SLOP && x <= left + size + SLOP && y >= top - SLOP && y <= top + size + SLOP;
  }

  /**
   * Darkens the icon (an image: brightens it) and shows a pointer over it: the field's text cursor
   * would say "type here".
   */
  hover(on: boolean): void {
    const field = this.#field;
    if (on === this.#hovered || !field) return;
    this.#hovered = on;
    if (this.#layout) {
      for (const [key, value] of Object.entries(this.#look())) this.#host.style.setProperty(key, value, "important");
    }
    // an icon that takes its clicks has its own pointer (see HOST_STYLE's cursor in #look)
    if (this.#takesClicks) return;
    if (on) {
      this.#fieldCursor = {
        value: field.style.getPropertyValue("cursor"),
        priority: field.style.getPropertyPriority("cursor"),
      };
      field.style.setProperty("cursor", "pointer", "important");
    } else if (this.#fieldCursor) {
      const { value, priority } = this.#fieldCursor;
      if (value) field.style.setProperty("cursor", value, priority);
      else field.style.removeProperty("cursor");
      this.#fieldCursor = undefined;
    }
  }

  /** Moves the icon to its field's end, or hides it where it can't go (see #currentLayout). */
  place(): void {
    this.#layout = this.#currentLayout();
    const layout = this.#layout;
    if (!layout && this.#hovered) this.hover(false);
    this.#applyStyle(
      layout
        ? {
            left: `${layout.left}px`,
            top: `${layout.top}px`,
            width: `${layout.size}px`,
            height: `${layout.size}px`,
            visibility: "visible",
            ...this.#look(),
          }
        : { visibility: "hidden" },
    );
  }

  /**
   * The icon's layout on its field now, or undefined where it has none: the field is gone, off
   * screen or too small, or something else of the page's covers that spot. A click there wouldn't
   * reach the field (or the icon), which is the only way the icon works (a page's own icon at the
   * field's end, a header or dialog over it).
   */
  #currentLayout(): IconLayout | undefined {
    const field = this.#field;
    if (!field?.isConnected) return undefined;
    const layout = fieldIconLayout(fieldBox(field), { width: window.innerWidth, height: window.innerHeight });
    if (!layout) return undefined;
    const centre = layout.size / 2;
    // the first thing there that isn't this icon (which is there itself when it takes clicks)
    const under = document
      .elementsFromPoint(layout.left + centre, layout.top + centre)
      .find((element) => element !== this.#host);
    if (under !== field) return undefined;
    return layout;
  }

  /** Colour, cursor and hover look, as they are now. */
  #look(): Record<string, string> {
    const look: Record<string, string> = {};
    if (this.#image) look.filter = this.#hovered ? "brightness(1.15)" : "none";
    else look.color = (this.#hovered ? this.#layout?.hoverColor : this.#layout?.color) ?? "";
    if (this.#takesClicks) {
      look["pointer-events"] = "auto";
      look.cursor = "pointer";
    }
    return look;
  }

  #applyStyle(extra: Record<string, string> = {}): void {
    for (const [key, value] of Object.entries({ ...HOST_STYLE, ...extra })) {
      this.#host.style.setProperty(key, value, "important");
    }
  }
}

/** An SVG element from markup we ship. Parsed as SVG, never HTML: nothing in it runs. */
function parseSvg(markup: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
  return document.importNode(parsed, true) as unknown as SVGSVGElement;
}
