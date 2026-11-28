import type { Page } from "@playwright/test";
import { choose, expect, menuFrame, PAIRING_CODE, saveSettings, test } from "./fixtures.ts";

/** Whether a Better Passwords menu is open on the page. */
const menuOpen = (page: Page) => page.frames().some((f) => f.url().includes("/menu.html#") && !f.isDetached());

/** Clicks the middle of minimal mode's icon (which lets clicks through to its field). */
async function clickIcon(page: Page) {
  const icon = page.locator("app-autofill-icon");
  await expect(icon).toBeVisible();
  const box = await icon.boundingBox();
  if (!box) throw new Error("no icon in the field");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.beforeEach(async ({ context }) => {
  await saveSettings(context, { minimalMode: true });
});

test("the menu opens from the icon only, then fills as usual", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click({ position: { x: 20, y: 10 } });

  // a click in the field puts the icon there, and no menu
  await expect(page.locator("app-autofill-icon")).toBeVisible();
  await page.waitForTimeout(500);
  expect(menuOpen(page)).toBe(false);

  await clickIcon(page);
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByRole("textbox", { name: "Verification code" }).fill(PAIRING_CODE);
  await choose(menu, "e2e-user");
  await expect(page.locator("#user")).toHaveValue("e2e-user");
  await expect(page.locator("#pass")).toHaveValue("e2e-pass");
  // filled and done: the icon goes with the focus
  await expect(page.locator("app-autofill-icon")).toHaveCount(0);
});

test("the icon closes the menu it opened, and ↓ opens it too", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#user").click({ position: { x: 20, y: 10 } });

  await clickIcon(page);
  await menuFrame(page);
  await clickIcon(page);
  await expect.poll(() => menuOpen(page)).toBe(false);
  await expect(page.locator("#user")).toBeFocused();

  // a click on the field's text leaves it closed
  await page.locator("#user").click({ position: { x: 20, y: 10 } });
  await page.waitForTimeout(500);
  expect(menuOpen(page)).toBe(false);

  await page.keyboard.press("ArrowDown");
  await menuFrame(page);

  // leaving for somewhere that isn't a field closes the menu and takes the icon away
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect.poll(() => menuOpen(page)).toBe(false);
  await expect(page.locator("app-autofill-icon")).toHaveCount(0);
});

test("on a passkey field, the icon is ours and the menu offers the passkeys", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/passkey-login.html`);
  await page.locator("#user").click({ position: { x: 20, y: 10 } });

  await expect(page.locator("app-autofill-icon")).toBeVisible();
  await expect(page.locator("app-passkey-icon")).toHaveCount(0);
  await clickIcon(page);
  await expect((await menuFrame(page)).getByText("Use a Passkey")).toBeVisible();
});

test("with minimal mode off, a click in the field opens the menu and shows no icon", async ({ context, siteUrl }) => {
  await saveSettings(context, { minimalMode: false });
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  await menuFrame(page);
  await expect(page.locator("app-autofill-icon")).toHaveCount(0);
});
