import type { Locator, Page } from "@playwright/test";
import { choose, expect, menuFrame, PAIRING_CODE, saveSettings, test } from "./fixtures.ts";

/** Whether a Better Passwords menu is open on the page. */
const menuOpen = (page: Page) => page.frames().some((f) => f.url().includes("/menu.html#") && !f.isDetached());

const autocomplete = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => el.getAttribute("autocomplete"));

/** Minimal mode's icon on the field `selector`: the one drawn inside its box. */
async function iconOn(page: Page, selector: string): Promise<Locator> {
  const field = await page.locator(selector).boundingBox();
  if (!field) throw new Error(`no field ${selector}`);
  const icons = page.locator("app-autofill-icon");
  await expect(icons.first()).toBeVisible();
  for (const icon of await icons.all()) {
    const box = await icon.boundingBox();
    const inside = box && box.y >= field.y && box.y + box.height <= field.y + field.height + 1;
    if (inside && box.x >= field.x && box.x + box.width <= field.x + field.width + 1) return icon;
  }
  throw new Error(`no icon on ${selector}`);
}

async function clickIcon(page: Page, selector: string) {
  const box = await (await iconOn(page, selector)).boundingBox();
  if (!box) throw new Error(`no icon on ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.beforeEach(async ({ context }) => {
  await saveSettings(context, { minimalMode: true });
});

test("every field that gets a menu shows the icon, and only the icon opens the menu", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  // before anything is clicked: the sign-in's two fields
  await iconOn(page, "#user");
  await iconOn(page, "#pass");

  // a click in the field opens nothing
  await page.locator("#pass").click({ position: { x: 20, y: 10 } });
  await page.waitForTimeout(500);
  expect(menuOpen(page)).toBe(false);

  await clickIcon(page, "#pass");
  const menu = await menuFrame(page);
  await expect(page.locator("#pass")).toBeFocused();
  await choose(menu, "Unlock to fill passwords");
  await menu.getByRole("textbox", { name: "Verification code" }).fill(PAIRING_CODE);
  await choose(menu, "e2e-user");
  await expect(page.locator("#user")).toHaveValue("e2e-user");
  await expect(page.locator("#pass")).toHaveValue("e2e-pass");
  // the icons stay
  await iconOn(page, "#pass");
});

test("the icon opens the menu on a field that isn't focused, closes it, and ↓ opens it too", async ({
  context,
  siteUrl,
}) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);

  await clickIcon(page, "#user");
  await menuFrame(page);
  await expect(page.locator("#user")).toBeFocused();
  await clickIcon(page, "#user");
  await expect.poll(() => menuOpen(page)).toBe(false);
  await expect(page.locator("#user")).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await menuFrame(page);
  await page.keyboard.press("Escape");
  await expect.poll(() => menuOpen(page)).toBe(false);
});

test("a passkey field keeps the browser's list, with our icon and no passkey icon", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/passkey-login.html`);
  await iconOn(page, "#user");
  await page.waitForTimeout(500);
  expect(await autocomplete(page, "#user")).toBe("username webauthn");
  await page.locator("#user").hover();
  await expect(page.locator("app-passkey-icon")).toHaveCount(0);

  // our icon's click never reaches the field: the token stays, and the menu doesn't offer passkeys
  await clickIcon(page, "#user");
  const menu = await menuFrame(page);
  await expect(menu.getByText("Unlock to fill passwords")).toBeVisible();
  await expect(menu.getByText("Use a Passkey")).toHaveCount(0);
  expect(await autocomplete(page, "#user")).toBe("username webauthn");

  // a click in the field is the browser's (its list shows there): our menu makes way
  await page.locator("#user").click({ position: { x: 20, y: 10 } });
  await expect.poll(() => menuOpen(page)).toBe(false);
});

test("turning minimal mode on or off takes effect on open pages", async ({ context, siteUrl }) => {
  await saveSettings(context, { minimalMode: false });
  const page = await context.newPage();
  await page.goto(`${siteUrl}/passkey-login.html`);
  await expect.poll(() => autocomplete(page, "#user")).toBe("username");
  await expect(page.locator("app-autofill-icon")).toHaveCount(0);

  await saveSettings(context, { minimalMode: true });
  await iconOn(page, "#user");
  await expect.poll(() => autocomplete(page, "#user")).toBe("username webauthn");

  await saveSettings(context, { minimalMode: false });
  await expect(page.locator("app-autofill-icon")).toHaveCount(0);
  await expect.poll(() => autocomplete(page, "#user")).toBe("username");
  await page.locator("#pass").click();
  await menuFrame(page);
});
