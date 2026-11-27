// Where an icon of ours goes at the end of a field, and how it looks (see field-icon.ts). Generic:
// nothing here knows what the icon is for. Pure, so every kind of field can be tested without a
// browser: the DOM side (fieldBox) only reads the field's box and style.

/** What decides an icon's layout: the field's border box (viewport coordinates) and computed style. */
export interface FieldBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Computed values, as getComputedStyle gives them ("16px", "50%", "rgb(32, 33, 36)"). */
  paddingLeft: string;
  paddingRight: string;
  borderLeftWidth: string;
  borderRightWidth: string;
  /** The corner on the icon's side: top-right, or top-left in a right-to-left field. */
  borderRadius: string;
  fontSize: string;
  color: string;
  direction: string;
}

export interface IconLayout {
  left: number;
  top: number;
  size: number;
  /** The field's own text colour, faded like a placeholder. */
  color: string;
  hoverColor: string;
}

const MIN_SIZE = 14;
const MAX_SIZE = 20;
/** The least room between the icon and the field's inner edge, even with no padding. */
const MIN_INSET = 6;
/** Room between the icon and a rounded corner's curve. */
const CURVE_GAP = 4;
/** When the field's text colour can't be used (transparent text over a custom overlay). */
const FALLBACK_COLOR = "light-dark(rgb(0 0 0), rgb(255 255 255))";

const px = (value: string): number => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/** A computed radius ("24px", "50%", or "10px 20px" for an elliptical corner) as horizontal px. */
function radiusPx(value: string, width: number, height: number): number {
  const first = value.trim().split(/\s+/)[0] ?? "";
  const r = first.endsWith("%") ? (px(first) / 100) * width : px(first);
  // the browser shrinks radii that don't fit; past half the height the curve is a pill's end
  return Math.min(Math.max(r, 0), height / 2, width / 2);
}

function isTransparent(color: string): boolean {
  const c = color.replace(/\s+/g, "").toLowerCase();
  return c === "" || c === "transparent" || c === "rgba(0,0,0,0)" || /\/0\)$/.test(c) || /,0\)$/.test(c);
}

/**
 * An icon's place and look on `field`, or undefined where it doesn't fit or the field is off
 * screen. It sits at the end where text ends (the right, or the left in a right-to-left field),
 * inside the field's padding and clear of a rounded corner, centred vertically, and sized to the
 * field: about its font, never taller than half the field.
 */
export function fieldIconLayout(field: FieldBox, viewport: { width: number; height: number }): IconLayout | undefined {
  const { left, top, width, height } = field;
  if (top + height <= 0 || top >= viewport.height || left + width <= 0 || left >= viewport.width) return undefined;

  const size = Math.round(Math.min(Math.max(Math.min(height / 2, px(field.fontSize) * 1.25), MIN_SIZE), MAX_SIZE));
  // too small to hold it with some room around, or too narrow to leave room for text
  if (height < size + 4 || width < size * 3) return undefined;

  const rtl = field.direction === "rtl";
  const border = px(rtl ? field.borderLeftWidth : field.borderRightWidth);
  const padding = px(rtl ? field.paddingLeft : field.paddingRight);
  // how far the corner's curve reaches in at the icon's top and bottom edges
  const r = radiusPx(field.borderRadius, width, height);
  const dy = Math.max(r - (height - size) / 2, 0);
  const curve = r - Math.sqrt(Math.max(r * r - dy * dy, 0));
  const inset = Math.min(Math.max(padding, MIN_INSET, curve > 0 ? curve + CURVE_GAP : 0), width / 3);

  const base = isTransparent(field.color) ? FALLBACK_COLOR : field.color;
  return {
    left: rtl ? left + border + inset : left + width - border - inset - size,
    top: top + (height - size) / 2,
    size,
    color: `color-mix(in srgb, ${base} 55%, transparent)`,
    hoverColor: `color-mix(in srgb, ${base} 90%, transparent)`,
  };
}

/** Reads what fieldIconLayout needs from a field on the page. */
export function fieldBox(field: HTMLElement): FieldBox {
  const rect = field.getBoundingClientRect();
  const style = getComputedStyle(field);
  const rtl = style.direction === "rtl";
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight,
    borderLeftWidth: style.borderLeftWidth,
    borderRightWidth: style.borderRightWidth,
    borderRadius: rtl ? style.borderTopLeftRadius : style.borderTopRightRadius,
    fontSize: style.fontSize,
    color: style.color,
    direction: style.direction,
  };
}
