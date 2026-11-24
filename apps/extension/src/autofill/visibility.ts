// Clickjacking guard for the inline menu. A hostile page can't read or click inside our iframe, but
// it can try to hide it (transparency, filters, overlays) while tricking the user into clicking it.
// Before filling, the content script checks that the menu is really there and really visible.

const MIN_OPACITY = 0.99;

function styleHidesContent(style: CSSStyleDeclaration): boolean {
  const opacity = Number.parseFloat(style.opacity);
  return (
    style.display === "none" ||
    style.visibility === "hidden" ||
    opacity < MIN_OPACITY ||
    (style.filter !== "" && style.filter !== "none") ||
    (style.clipPath !== "" && style.clipPath !== "none") ||
    (style.mixBlendMode !== "" && style.mixBlendMode !== "normal") ||
    // a mask paints the menu away while it still takes clicks; hidden content takes none, but isn't seen
    masks(style) ||
    style.getPropertyValue("content-visibility") === "hidden"
  );
}

function masks(style: CSSStyleDeclaration): boolean {
  return ["mask-image", "-webkit-mask-image", "mask-border-source", "-webkit-mask-box-image-source"].some((name) => {
    const value = style.getPropertyValue(name);
    return value !== "" && value !== "none";
  });
}

/** True if `host` is open, fully opaque all the way up, and topmost across its whole area. */
export function isMenuGenuinelyVisible(host: HTMLElement, view: Window = window): boolean {
  if (!host.isConnected || !host.matches(":popover-open")) return false;

  for (let el: Element | null = host; el; el = el.parentElement) {
    if (styleHidesContent(view.getComputedStyle(el))) return false;
  }

  const rect = host.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return false;
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= view.innerWidth || rect.top >= view.innerHeight) {
    return false;
  }

  // The menu lives in the top layer, so normal page content can't cover it. Anything else the page
  // put in the top layer after us could, so refuse while any other popover or modal is open.
  // A fullscreen element joins the top layer too; one around the menu (the page itself) is fine.
  const others = view.document.querySelectorAll(":popover-open, :modal, :fullscreen");
  if (Array.from(others).some((el) => el !== host && !el.contains(host))) return false;

  // Hit-test the corners and centre. This catches covering elements that take clicks; overlays
  // with pointer-events: none are invisible to hit-testing, which is why the menu page also tracks
  // its own visibility with IntersectionObserver v2 where the browser supports it.
  const inset = 6;
  const points: [number, number][] = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + inset, rect.top + inset],
    [rect.right - inset, rect.top + inset],
    [rect.left + inset, rect.bottom - inset],
    [rect.right - inset, rect.bottom - inset],
  ];
  return points.every(([x, y]) => view.document.elementsFromPoint(x, y)[0] === host);
}

/**
 * Remembers since when the menu has been genuinely visible, checking every frame while it's open.
 * A page can't see a click inside our frame, but it notices one right after (focus moves to the
 * frame) and could make a hidden menu visible again before the fill is checked. Requiring the
 * menu to have stayed visible for a while beforehand defeats that: a menu hidden until the click
 * never qualifies. Chromium's IntersectionObserver v2 does the same inside the menu page; this
 * covers browsers without it (Firefox).
 */
export class VisibilityWatch {
  #visibleSince: number | undefined;
  #running = false;

  constructor(
    private readonly isVisible: () => boolean,
    private readonly now: () => number = () => performance.now(),
    private readonly nextFrame: (callback: () => void) => void = (callback) => requestAnimationFrame(callback),
  ) {}

  start(): void {
    this.#visibleSince = undefined;
    if (this.#running) return;
    this.#running = true;
    const tick = () => {
      if (!this.#running) return;
      this.#sample();
      this.nextFrame(tick);
    };
    this.nextFrame(tick);
  }

  stop(): void {
    this.#running = false;
    this.#visibleSince = undefined;
  }

  /** Visible now, and without a break for at least the last `ms`. */
  steadilyVisible(ms: number): boolean {
    if (!this.#running) return false;
    this.#sample();
    return this.#visibleSince !== undefined && this.now() - this.#visibleSince >= ms;
  }

  #sample(): void {
    if (!this.isVisible()) this.#visibleSince = undefined;
    else this.#visibleSince ??= this.now();
  }
}
