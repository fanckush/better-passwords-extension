import { describe, expect, it } from "vitest";
import { type FieldBox, fieldIconLayout } from "../src/autofill/field-icon-layout.ts";

const viewport = { width: 1280, height: 800 };

/** A plain 40px field; each case changes what it's about. */
function field(overrides: Partial<FieldBox> = {}): FieldBox {
  return {
    left: 100,
    top: 100,
    width: 300,
    height: 40,
    paddingLeft: "12px",
    paddingRight: "12px",
    borderLeftWidth: "1px",
    borderRightWidth: "1px",
    borderRadius: "4px",
    fontSize: "16px",
    color: "rgb(32, 33, 36)",
    direction: "ltr",
    ...overrides,
  };
}

/** The icon's right edge, as a distance from the field's right edge. */
const fromRight = (box: FieldBox, layout: { left: number; size: number }) =>
  box.left + box.width - (layout.left + layout.size);

describe("fieldIconLayout", () => {
  it("sits at the end, inside the field's padding, centred vertically", () => {
    const box = field();
    const layout = fieldIconLayout(box, viewport);
    expect(layout?.size).toBe(20);
    // 1px border + 12px padding: where the text ends
    expect(layout && fromRight(box, layout)).toBe(13);
    expect(layout && layout.top + layout.size / 2).toBe(box.top + box.height / 2);
  });

  it("is sized to a tall field like Google's, no bigger than 20px", () => {
    const box = field({ height: 56, paddingRight: "16px" });
    const layout = fieldIconLayout(box, viewport);
    expect(layout?.size).toBe(20);
    expect(layout && fromRight(box, layout)).toBe(17);
  });

  it("shrinks in a small field, not below 14px", () => {
    expect(fieldIconLayout(field({ height: 26, fontSize: "11px" }), viewport)?.size).toBe(14);
    expect(fieldIconLayout(field({ height: 30, fontSize: "13px" }), viewport)?.size).toBe(15);
  });

  it("stays clear of a pill's rounded end, like Canva's", () => {
    // little padding, fully rounded: the curve, not the padding, decides
    const box = field({ height: 48, paddingRight: "2px", borderRadius: "24px" });
    const layout = fieldIconLayout(box, viewport);
    expect(layout && fromRight(box, layout)).toBeGreaterThan(1 + 6);
    // a radius bigger than the field (9999px) is a pill too
    const huge = fieldIconLayout({ ...box, borderRadius: "9999px" }, viewport);
    expect(huge?.left).toBe(layout?.left);
    // and a radius in percent
    expect(fieldIconLayout({ ...box, borderRadius: "50%" }, viewport)?.left).toBe(layout?.left);
  });

  it("keeps some room with no padding at all", () => {
    const box = field({ paddingRight: "0px", borderRightWidth: "0px", borderRadius: "0px" });
    const layout = fieldIconLayout(box, viewport);
    expect(layout && fromRight(box, layout)).toBe(6);
  });

  it("goes at the left end of a right-to-left field", () => {
    const box = field({ direction: "rtl", paddingLeft: "10px", borderLeftWidth: "2px" });
    expect(fieldIconLayout(box, viewport)?.left).toBe(box.left + 2 + 10);
  });

  it("takes its colour from the field's text, faded", () => {
    const dark = fieldIconLayout(field({ color: "rgb(232, 234, 237)" }), viewport);
    expect(dark?.color).toBe("color-mix(in srgb, rgb(232, 234, 237) 55%, transparent)");
    expect(dark?.hoverColor).toBe("color-mix(in srgb, rgb(232, 234, 237) 90%, transparent)");
    // transparent text (a custom overlay draws it): the page's colour scheme instead
    for (const color of ["rgba(0, 0, 0, 0)", "transparent", "rgb(0 0 0 / 0)"]) {
      expect(fieldIconLayout(field({ color }), viewport)?.color).toContain("light-dark(");
    }
  });

  it("has none where it doesn't fit", () => {
    // too short for the smallest icon with room around it
    expect(fieldIconLayout(field({ height: 16, fontSize: "12px" }), viewport)).toBeUndefined();
    // too narrow to leave room for text
    expect(fieldIconLayout(field({ width: 40 }), viewport)).toBeUndefined();
  });

  it("has none while the field is off screen", () => {
    expect(fieldIconLayout(field({ top: -60 }), viewport)).toBeUndefined();
    expect(fieldIconLayout(field({ top: 900 }), viewport)).toBeUndefined();
    expect(fieldIconLayout(field({ left: -400 }), viewport)).toBeUndefined();
  });

  it("never pushes in past a third of a narrow field with huge padding", () => {
    const box = field({ width: 90, paddingRight: "60px" });
    const layout = fieldIconLayout(box, viewport);
    expect(layout && fromRight(box, layout)).toBeLessThanOrEqual(1 + 30);
  });
});
