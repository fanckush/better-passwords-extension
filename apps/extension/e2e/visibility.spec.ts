import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, test } from "./fixtures.ts";

// Runs the content script's clickjacking check in a real browser page. In Chromium the menu also
// tracks its own visibility, but Firefox relies on this check alone.
const source = readFileSync(resolve(import.meta.dirname, "../src/autofill/visibility.ts"), "utf8");
const script = ts
  .transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  .outputText.replace(/^export /gm, "");

test.describe("isMenuGenuinelyVisible", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent("<p>page</p>");
    await page.addScriptTag({ content: `${script}\nwindow.check = () => isMenuGenuinelyVisible(window.host);` });
    await page.evaluate(() => {
      const host = document.createElement("app-autofill-menu");
      host.setAttribute("popover", "manual");
      host.style.cssText = "position:fixed;inset:auto;left:20px;top:20px;width:300px;height:100px;margin:0;border:0;";
      document.documentElement.append(host);
      host.showPopover();
      Object.assign(window, { host });
    });
  });

  const check = (page: import("@playwright/test").Page) =>
    page.evaluate(() => (window as unknown as { check(): boolean }).check());

  test("accepts an open, unobstructed menu", async ({ page }) => {
    expect(await check(page)).toBe(true);
  });

  test("rejects a closed menu", async ({ page }) => {
    await page.evaluate(() => (window as unknown as { host: HTMLElement }).host.hidePopover());
    expect(await check(page)).toBe(false);
  });

  for (const [name, css] of [
    ["opacity", "opacity: 0.5"],
    ["a filter", "filter: blur(2px)"],
    ["a blend mode", "mix-blend-mode: multiply"],
  ]) {
    test(`rejects ${name} on the page root`, async ({ page }) => {
      await page.evaluate((style) => document.documentElement.setAttribute("style", style), css as string);
      expect(await check(page)).toBe(false);
    });
  }

  // DOM-based extension clickjacking (Tóth, 2025) and its variants: ways a page can make the menu
  // invisible while it still takes clicks, on the menu's own element or on the page root
  for (const [name, css] of [
    ["opacity", "opacity: 0"],
    ["a mask", "mask-image: linear-gradient(transparent, transparent)"],
    ["a prefixed mask", "-webkit-mask-image: linear-gradient(transparent, transparent)"],
    ["visibility: collapse", "visibility: collapse"],
    ["content-visibility: hidden", "content-visibility: hidden"],
    ["an opacity filter", "filter: opacity(0)"],
  ]) {
    test(`rejects ${name} on the menu itself`, async ({ page }) => {
      await page.evaluate((style) => {
        (window as unknown as { host: HTMLElement }).host.style.cssText += `;${style}`;
      }, css as string);
      expect(await check(page)).toBe(false);
    });
  }

  test("rejects a legacy clip on the menu", async ({ page }) => {
    await page.evaluate(() => {
      const { host } = window as unknown as { host: HTMLElement };
      host.style.cssText += ";clip: rect(0 0 0 0)";
    });
    expect(await check(page)).toBe(false);
  });

  test("rejects a mask on the page root", async ({ page }) => {
    await page.evaluate(() =>
      document.documentElement.setAttribute("style", "mask-image: linear-gradient(transparent, transparent)"),
    );
    expect(await check(page)).toBe(false);
  });

  test("rejects another top-layer element opened above the menu", async ({ page }) => {
    await page.evaluate(() => {
      const cover = document.createElement("div");
      cover.setAttribute("popover", "manual");
      cover.style.cssText = "position:fixed;inset:0;margin:0;pointer-events:none;background:transparent;";
      document.body.append(cover);
      cover.showPopover();
    });
    expect(await check(page)).toBe(false);
  });

  test("rejects a menu pushed off screen", async ({ page }) => {
    await page.evaluate(() => {
      (window as unknown as { host: HTMLElement }).host.style.left = "-1000px";
    });
    expect(await check(page)).toBe(false);
  });
});
