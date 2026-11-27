import { describe, expect, it } from "vitest";
import { VisibilityWatch } from "../src/autofill/visibility.ts";

/** A watch driven by hand: `frame()` runs one animation frame, `at` is the clock. */
function watch() {
  const clock = { at: 0, visible: true, where: "0,0" };
  let pending: (() => void) | undefined;
  const w = new VisibilityWatch(
    () => clock.visible,
    () => clock.at,
    (callback) => {
      pending = callback;
    },
    () => clock.where,
  );
  const frame = (ms = 16) => {
    clock.at += ms;
    const run = pending;
    pending = undefined;
    run?.();
  };
  return { w, clock, frame };
}

describe("VisibilityWatch", () => {
  it("trusts a menu only once it has been visible for a while", () => {
    const { w, frame } = watch();
    w.start();
    frame();
    expect(w.steadilyVisible(300)).toBe(false);
    for (let i = 0; i < 20; i++) frame();
    expect(w.steadilyVisible(300)).toBe(true);
  });

  it("distrusts a menu the page revealed only after the click", () => {
    const { w, clock, frame } = watch();
    w.start();
    clock.visible = false;
    for (let i = 0; i < 40; i++) frame();
    // the page notices the click and makes the menu visible just before the fill is checked
    clock.visible = true;
    frame();
    expect(w.steadilyVisible(300)).toBe(false);
  });

  it("restarts the clock after any frame the menu was hidden", () => {
    const { w, clock, frame } = watch();
    w.start();
    for (let i = 0; i < 40; i++) frame();
    clock.visible = false;
    frame();
    clock.visible = true;
    for (let i = 0; i < 5; i++) frame();
    expect(w.steadilyVisible(300)).toBe(false);
  });

  it("restarts the clock whenever the menu moves (a menu made to follow the pointer)", () => {
    const { w, clock, frame } = watch();
    w.start();
    for (let i = 0; i < 40; i++) {
      // the page moves the field every few frames, and the menu follows it
      if (i % 6 === 0) clock.where = `${i},0`;
      frame();
    }
    expect(w.steadilyVisible(300)).toBe(false);
    // once it stays put, it's trusted again after the wait
    for (let i = 0; i < 20; i++) frame();
    expect(w.steadilyVisible(300)).toBe(true);
  });

  it("trusts nothing once stopped", () => {
    const { w, frame } = watch();
    w.start();
    for (let i = 0; i < 40; i++) frame();
    w.stop();
    expect(w.steadilyVisible(300)).toBe(false);
  });
});
