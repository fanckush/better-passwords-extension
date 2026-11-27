// Whether the page around a field is light or dark, so the inline menu matches the site rather than
// the system: a light site (Wikipedia) on a Mac in dark mode gets a light menu, and the other way
// round. Going by the colour actually painted catches sites that are always dark, or that switch
// with a class or a toggle of their own, which prefers-color-scheme alone would miss.
//
// A heuristic, kept behind one function: pageScheme() is all the rest of the extension sees, so how
// it decides (backgrounds today, perhaps text colour later) can change here alone.

export type Scheme = "light" | "dark";

type Rgba = [number, number, number, number];

/** Below this opacity a background lets what's under it decide. */
const OPAQUE = 0.5;

/** Light or dark for a background colour, by its perceived brightness. */
function schemeFor([r, g, b]: Rgba): Scheme {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5 ? "dark" : "light";
}

/** A computed colour as rgba; modern colour spaces (oklch, color(…)) go through a canvas. */
function parseColor(color: string, doc: Document = document): Rgba | undefined {
  const c = color.trim().toLowerCase();
  if (c === "" || c === "transparent") return [0, 0, 0, 0];
  const legacy = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(c);
  if (legacy) {
    const alpha =
      legacy[4] === undefined ? 1 : legacy[4].endsWith("%") ? Number.parseFloat(legacy[4]) / 100 : Number(legacy[4]);
    return [Number(legacy[1]), Number(legacy[2]), Number(legacy[3]), alpha];
  }
  const context = doc.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  context.fillStyle = c;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}

/** The element's parent, stepping out of a shadow root to its host. */
function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** With nothing painted, the canvas shows: dark only when the page opted into dark and it applies. */
function canvasScheme(doc: Document): Scheme {
  const declared = `${getComputedStyle(doc.documentElement).colorScheme} ${
    doc.querySelector('meta[name="color-scheme"]')?.getAttribute("content") ?? ""
  }`;
  if (!/\bdark\b/.test(declared)) return "light";
  if (!/\blight\b/.test(declared)) return "dark";
  return doc.defaultView?.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * The scheme of what's around `field`: the first mostly opaque background from its parent up. Not
 * the field's own, as a site may set light fields on a dark page; the menu sits on the page.
 */
export function pageScheme(field: Element): Scheme {
  const doc = field.ownerDocument;
  for (let el = parentOf(field); el; el = parentOf(el)) {
    const color = parseColor(getComputedStyle(el).backgroundColor, doc);
    if (color && color[3] >= OPAQUE) return schemeFor(color);
  }
  return canvasScheme(doc);
}
