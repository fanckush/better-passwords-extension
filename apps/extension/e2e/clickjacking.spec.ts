import type { Frame, Page } from "@playwright/test";
import { choose, expect, menuFrame, PAIRING_CODE, test } from "./fixtures.ts";

// DOM-based extension clickjacking (Marek Tóth, DEF CON 33, 2025): a page hides an extension's
// autofill UI, or moves it under the pointer, and lures one click onto it. Each test tries a
// technique twice: with a real click (Chromium, where the menu also checks its own visibility) and
// with the request the menu would send, as in a browser without IntersectionObserver v2 (Firefox),
// where the content script's check is all there is.

async function unlockedMenu(page: Page, siteUrl: string): Promise<Frame> {
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();
  return menu;
}

/** What the menu sends when a login is chosen: as a browser without IntersectionObserver v2 would. */
async function requestFill(menu: Frame) {
  await menu.evaluate(() => {
    type Runtime = { runtime: { sendMessage(message: unknown): Promise<unknown> } };
    const { chrome } = globalThis as unknown as { chrome: Runtime };
    const nonce = new URLSearchParams(location.hash.slice(1)).get("nonce");
    void chrome.runtime.sendMessage({ type: "fill-from-menu", nonce, username: "e2e-user", menuNonce: nonce });
  });
}

const techniques: [string, (page: Page) => Promise<void>][] = [
  [
    "masks the page out",
    (page) =>
      page.evaluate(() => {
        document.documentElement.style.setProperty("mask-image", "linear-gradient(transparent, transparent)");
      }),
  ],
  [
    "masks the menu out",
    (page) =>
      page.evaluate(() => {
        const host = document.querySelector("app-autofill-menu") as HTMLElement;
        host.style.setProperty("-webkit-mask-image", "linear-gradient(transparent, transparent)", "important");
      }),
  ],
  [
    "skips drawing the menu (content-visibility)",
    (page) =>
      page.evaluate(() => {
        const host = document.querySelector("app-autofill-menu") as HTMLElement;
        host.style.setProperty("content-visibility", "hidden", "important");
      }),
  ],
  [
    "hides the menu in a long view transition",
    // the menu gets its own transition group, drawn invisible, while the real one may still take clicks
    (page) =>
      page.evaluate(() => {
        const host = document.querySelector("app-autofill-menu") as HTMLElement;
        host.style.setProperty("view-transition-name", "menu", "important");
        const style = document.createElement("style");
        style.textContent = `
          ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: 600s !important; }
          ::view-transition-old(menu), ::view-transition-new(menu) { opacity: 0 !important; animation: none !important; }`;
        document.head.append(style);
        (document as unknown as { startViewTransition(update: () => void): unknown }).startViewTransition(() => {});
      }),
  ],
  [
    "moves the menu under the pointer",
    // mouse-following: the field jumps around and the menu follows it, so a click anywhere lands on it
    (page) =>
      page.evaluate(() => {
        const field = document.getElementById("pass") as HTMLInputElement;
        field.style.position = "relative";
        let step = 0;
        setInterval(() => {
          step = (step + 1) % 4;
          field.style.left = `${step * 40}px`;
        }, 100);
      }),
  ],
];

for (const [name, apply] of techniques) {
  test(`refuses to fill when the page ${name} (real click)`, async ({ context, siteUrl }) => {
    const page = await context.newPage();
    const menu = await unlockedMenu(page, siteUrl);
    await apply(page);
    await page.waitForTimeout(600);
    await menu.getByText("e2e-user").click({ force: true });
    await page.waitForTimeout(500);
    await expect(page.locator("#pass")).toHaveValue("");
  });

  test(`refuses to fill when the page ${name} (content script alone)`, async ({ context, siteUrl }) => {
    const page = await context.newPage();
    const menu = await unlockedMenu(page, siteUrl);
    await apply(page);
    await page.waitForTimeout(600);
    await requestFill(menu);
    await page.waitForTimeout(500);
    await expect(page.locator("#pass")).toHaveValue("");
  });
}
