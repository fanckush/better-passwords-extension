import type { Page } from "@playwright/test";
import { choose, expect, menuFrame, saveSettings, test } from "./fixtures.ts";

const ROW = "Use a Passkey";

const autocomplete = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => el.getAttribute("autocomplete"));

/** Whether a Better Passwords menu is open on the page. */
const menuOpen = (page: Page) => page.frames().some((f) => f.url().includes("/menu.html#") && !f.isDetached());

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
  // the click after it is ours again
  await page.locator("#user").click({ position: { x: 20, y: 10 } });
  await expect((await menuFrame(page)).getByText(ROW)).toBeVisible();
  expect(await autocomplete(page, "#user")).toBe("username");

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

test("the passkey icon in the field opens the browser's list with the same click", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/passkey-login.html`);
  await expect.poll(() => autocomplete(page, "#user")).toBe("username");
  const icon = page.locator("app-passkey-icon");
  const field = page.locator("#pass");
  // only on fields whose list we hide, under the mouse or focused
  await field.hover();
  await expect(icon).toHaveCount(0);
  await page.locator("#user").hover();
  await expect(icon).toBeVisible();

  // a click on the field's text opens our menu, as before
  await page.locator("#user").click({ position: { x: 20, y: 10 } });
  await menuFrame(page);
  // a click on the icon (which lets clicks through to the field) closes it and gives the browser its token
  const box = await icon.boundingBox();
  if (!box) throw new Error("no passkey icon");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => menuOpen(page)).toBe(false);
  expect(await autocomplete(page, "#user")).toBe("username webauthn");
  await expect(page.locator("#user")).toBeFocused();

  // a click on the field's text instead (no passkeys, so the browser showed nothing): our menu again
  await page.locator("#user").click({ position: { x: 20, y: 10 } });
  await expect((await menuFrame(page)).getByText(ROW)).toBeVisible();
  expect(await autocomplete(page, "#user")).toBe("username");
  // and the icon still opens the browser's list
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => menuOpen(page)).toBe(false);
  expect(await autocomplete(page, "#user")).toBe("username webauthn");

  // leaving the field hides the browser's list again
  await page.locator("#outside").click();
  expect(await autocomplete(page, "#user")).toBe("username");
});

test.describe("the passkey icon fits each kind of field", () => {
  /** Hovers `id` (no click: an open menu would cover the fields below) and measures icon and field. */
  async function iconOn(page: Page, id: string) {
    await page.locator(`#${id}`).hover({ position: { x: 30, y: 5 } });
    const icon = page.locator("app-passkey-icon");
    const field = await page.locator(`#${id}`).boundingBox();
    const shown = await icon.evaluate(
      (el) => el.matches(":popover-open") && getComputedStyle(el).visibility === "visible",
    );
    const box = shown ? await icon.boundingBox() : null;
    const color = shown ? await icon.evaluate((el) => getComputedStyle(el).color) : "";
    if (!field) throw new Error(`no field #${id}`);
    return { field, box, color };
  }
  /** The red, green and blue of a computed colour, 0 to 1, whatever form the browser gives it in. */
  const rgb = (color: string) => {
    const n = (color.match(/[\d.]+/g) ?? []).map(Number);
    return color.startsWith("color(") ? n.slice(0, 3) : n.slice(0, 3).map((v) => v / 255);
  };

  test.beforeEach(async ({ page, siteUrl }) => {
    await page.goto(`${siteUrl}/passkey-fields.html`);
    await expect.poll(() => autocomplete(page, "#google")).toBe("username");
  });

  for (const id of ["google", "pill", "small", "dark"]) {
    test(`${id}: inside the field, at its end, centred`, async ({ page }) => {
      const { field, box } = await iconOn(page, id);
      if (!box) throw new Error("no icon");
      expect(box.x).toBeGreaterThan(field.x + field.width / 2);
      expect(box.x + box.width).toBeLessThan(field.x + field.width - 4);
      expect(Math.abs(box.y + box.height / 2 - (field.y + field.height / 2))).toBeLessThanOrEqual(0.5);
      expect(box.height).toBeLessThanOrEqual(field.height / 2 + 0.5);
    });
  }

  test("the pill's icon keeps clear of its rounded end", async ({ page }) => {
    const { field, box } = await iconOn(page, "pill");
    // 1px border + 12px padding
    expect(field.x + field.width - ((box?.x ?? 0) + (box?.width ?? 0))).toBeGreaterThanOrEqual(13);
  });

  test("dark text on light, light text on dark", async ({ page }) => {
    const light = rgb((await iconOn(page, "google")).color);
    const dark = rgb((await iconOn(page, "dark")).color);
    expect(Math.max(...light)).toBeLessThan(0.5);
    expect(Math.min(...dark)).toBeGreaterThan(0.5);
  });

  test("at the left end of a right-to-left field", async ({ page }) => {
    const { field, box } = await iconOn(page, "rtl");
    if (!box) throw new Error("no icon");
    expect(box.x).toBeGreaterThan(field.x);
    expect(box.x + box.width).toBeLessThan(field.x + field.width / 2);
  });

  test("none where the page has its own icon at the end, or the field is too small", async ({ page }) => {
    expect((await iconOn(page, "covered")).box).toBeNull();
    expect((await iconOn(page, "tiny")).box).toBeNull();
    // and a click there is the page's, not ours
    await page.locator("#covered").click({ position: { x: 30, y: 5 } });
    expect(await autocomplete(page, "#covered")).toBe("username");
  });
});
