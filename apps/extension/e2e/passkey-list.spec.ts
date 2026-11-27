import type { BrowserContext, Page } from "@playwright/test";
import { choose, expect, menuFrame, test } from "./fixtures.ts";

const ROW = "Show browser passkey list";

const autocomplete = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => el.getAttribute("autocomplete"));

/** Whether a Better Passwords menu is open on the page. */
const menuOpen = (page: Page) => page.frames().some((f) => f.url().includes("/menu.html#") && !f.isDetached());

async function saveSettings(context: BrowserContext, settings: Record<string, boolean>) {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  type Storage = { storage: { local: { set(items: object): Promise<void>; get(key: string): Promise<object> } } };
  const saved = await worker.evaluate(async (settings) => {
    const { chrome } = globalThis as unknown as { chrome: Storage };
    await chrome.storage.local.set({ settings });
    return chrome.storage.local.get("settings");
  }, settings);
  expect(saved).toEqual({ settings });
}

test("hides the browser's passkey list on a field that asks for it, and shows it once from the menu", async ({
  context,
  siteUrl,
}) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/passkey-login.html`);
  // the browser lists passkeys only on fields with the "webauthn" token
  await expect.poll(() => autocomplete(page, "#user")).toBe("username");
  // also when the page tags a field later, as GitHub does from a script
  await page.locator("#pass").evaluate((el) => el.setAttribute("autocomplete", "current-password webauthn"));
  await expect.poll(() => autocomplete(page, "#pass")).toBe("current-password");

  await page.locator("#user").click();
  const menu = await menuFrame(page);
  await choose(menu, ROW);
  // the menu closes, and the field has its token back for the user's next click
  await expect.poll(() => menuOpen(page)).toBe(false);
  expect(await autocomplete(page, "#user")).toBe("username webauthn");

  // that click is the browser's: our menu stays out of its way
  await page.locator("#user").click();
  await page.waitForTimeout(1000);
  expect(menuOpen(page)).toBe(false);
  expect(await autocomplete(page, "#user")).toBe("username webauthn");

  // leaving the field hides the browser's list again, and the menu is back
  await page.locator("#outside").click();
  expect(await autocomplete(page, "#user")).toBe("username");
  await page.locator("#user").click();
  await expect((await menuFrame(page)).getByText(ROW)).toBeVisible();
});

test("an open menu offers the browser's passkey list once the page tags its field", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/passkey-autofocus.html`);
  // the menu opens on the autofocused field before the page tags it
  const menu = await menuFrame(page);
  await expect(menu.getByText("Unlock to fill passwords")).toBeVisible();
  await expect(menu.getByText(ROW)).toHaveCount(0);
  // the page tags it: the token comes out, and the open menu gets the row
  await expect.poll(() => autocomplete(page, "#user"), { timeout: 5000 }).toBe("username");
  await expect(menu.getByText(ROW)).toBeVisible();
});

test("doesn't offer the browser's passkey list on fields that don't ask for it", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#user").click();
  const menu = await menuFrame(page);
  await expect(menu.getByText("Unlock to fill passwords")).toBeVisible();
  await expect(menu.getByText(ROW)).toHaveCount(0);
});

test("with the setting off, the page keeps its token", async ({ context, siteUrl }) => {
  await saveSettings(context, { hidePasskeyList: false });
  const page = await context.newPage();
  await page.goto(`${siteUrl}/passkey-login.html`);
  await page.waitForTimeout(500);
  expect(await autocomplete(page, "#user")).toBe("username webauthn");
  await page.locator("#user").click();
  await expect((await menuFrame(page)).getByText(ROW)).toHaveCount(0);
});
