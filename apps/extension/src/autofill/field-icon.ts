// An icon of ours drawn at the end of a field, for one field at a time. Generic: it knows nothing
// of what it's for. Its user (the content script) decides which field gets it and what a click on
// it does. The passkey icon is the first (see "passkeyIcon" in autofill.content.ts).
//
// The icon takes no clicks itself (pointer-events: none). A click on it lands on the field, as a
// real click by the user: focus and caret work as usual, and the browser's own handling of the
// field sees a click there (the passkey icon depends on that: the browser opens its passkey list
// only for a real click in the field, which no script can make). The content script's capture
// mousedown asks hits() whether the click was on the icon, and acts before the browser looks.
// The page has nothing of ours to click, cover or fake clicks on.
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
  /** The glyph's SVG path, from ui/icons.ts. */
  glyph: string;
  /** The element's name on the page (a custom element name: lowercase, with a hyphen). */
  tag: string;
}

export class FieldIcon {
  readonly #host: HTMLElement;
  readonly #shadow: ShadowRoot;
  #glyph = "";
  #field: HTMLInputElement | undefined;
  #followFrame: number | undefined;
  #hovered = false;
  /** Where and how the icon was last drawn (see fieldIconLayout). */
  #layout: IconLayout | undefined;
  /** The field's own inline cursor, while ours (a pointer over the icon) replaces it. */
  #fieldCursor: { value: string; priority: string } | undefined;

  constructor({ glyph, tag }: FieldIconOptions) {
    this.#host = document.createElement(tag);
    this.#host.setAttribute("popover", "manual");
    this.#shadow = this.#host.attachShadow({ mode: "closed" });
    this.setGlyph(glyph);
    this.#applyStyle({ visibility: "hidden" });
  }

  /** Draws another glyph (an SVG path from ui/icons.ts). */
  setGlyph(glyph: string): void {
    if (glyph === this.#glyph) return;
    this.#glyph = glyph;
    const svg = icon(glyph);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.setProperty("display", "block", "important");
    this.#shadow.replaceChildren(svg);
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
    this.#place();
    const tick = () => {
      if (this.#field !== field) return;
      this.#place();
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

  /** Darkens the icon and shows a pointer over it: the field's text cursor would say "type here". */
  hover(on: boolean): void {
    const field = this.#field;
    if (on === this.#hovered || !field) return;
    this.#hovered = on;
    if (this.#layout) this.#host.style.setProperty("color", this.#color(), "important");
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

  /**
   * The icon's layout on its field now, or undefined where it has none: the field is gone, off
   * screen or too small, or something else of the page's covers that spot. A click there wouldn't
   * reach the field, which is the only way the icon works (a page's own icon at the field's end, a
   * header or dialog over it).
   */
  #currentLayout(): IconLayout | undefined {
    const field = this.#field;
    if (!field?.isConnected) return undefined;
    const layout = fieldIconLayout(fieldBox(field), { width: window.innerWidth, height: window.innerHeight });
    if (!layout) return undefined;
    const centre = layout.size / 2;
    if (document.elementFromPoint(layout.left + centre, layout.top + centre) !== field) return undefined;
    return layout;
  }

  #color(): string {
    return (this.#hovered ? this.#layout?.hoverColor : this.#layout?.color) ?? "";
  }

  #place(): void {
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
            color: this.#color(),
            visibility: "visible",
          }
        : { visibility: "hidden" },
    );
  }

  #applyStyle(extra: Record<string, string> = {}): void {
    for (const [key, value] of Object.entries({ ...HOST_STYLE, ...extra })) {
      this.#host.style.setProperty(key, value, "important");
    }
  }
}
