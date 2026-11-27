import type { Page } from "@playwright/test";
import { choose, expect, menuFrame, PAIRING_CODE, test } from "./fixtures.ts";

/** Unlocks from the menu on the password field, then types a login of the user's own. */
async function typeLogin(page: Page, username: string, password: string, unlock = true) {
  await page.locator("#pass").click();
  if (unlock) {
    const menu = await menuFrame(page);
    await choose(menu, "Unlock to fill passwords");
    await menu.getByRole("textbox", { name: "Verification code" }).fill(PAIRING_CODE);
    await expect(menu.getByText("Open Apple Passwords")).toBeVisible();
  }
  await page.locator("#user").fill(username);
  await page.locator("#pass").fill(password);
  // the menu of saved logins would cover the Sign in button; done with it, as a person would be
  await page.locator("#pass").press("Escape");
}

const signIn = (page: Page) => page.getByRole("button", { name: "Sign in" }).click();

/** Nothing saved, given time for a save. */
async function expectNoSave(page: Page, helperSaves: () => unknown[]) {
  await page.waitForTimeout(2_000);
  expect(helperSaves()).toEqual([]);
}

test("saves a new login once the sign-in goes through", async ({ context, siteUrl, helperSaves }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signin.html`);
  await typeLogin(page, "new@example.com", "typed-pass-1");
  await signIn(page);
  await expect(page.getByText("Welcome!")).toBeVisible();
  await expect
    .poll(helperSaves)
    .toEqual([{ hostname: "localhost", username: "new@example.com", password: "typed-pass-1" }]);
});

test("saves it when a sign-in form goes away without a new page", async ({ context, siteUrl, helperSaves }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signin.html?mode=replace`);
  await typeLogin(page, "spa@example.com", "typed-pass-2");
  await page.locator("#pass").press("Enter");
  await expect
    .poll(helperSaves)
    .toEqual([{ hostname: "localhost", username: "spa@example.com", password: "typed-pass-2" }]);
});

test.describe(() => {
  test.use({ vaultEntries: [{ hostname: "localhost", username: "saved@example.com", password: "saved-pass" }] });

  test("saves a saved account's new password, so macOS offers to update it", async ({
    context,
    siteUrl,
    helperSaves,
  }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signin.html`);
    await typeLogin(page, "Saved@example.com", "a-new-password");
    await signIn(page);
    await expect(page.getByText("Welcome!")).toBeVisible();
    // under the saved account's spelling, so macOS knows it's an update
    await expect
      .poll(helperSaves)
      .toEqual([{ hostname: "localhost", username: "saved@example.com", password: "a-new-password" }]);
  });
});

test.describe("doesn't save it", () => {
  test("when the site rejects the password", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signin.html?mode=error`);
    await typeLogin(page, "wrong@example.com", "not-it");
    await signIn(page);
    await expect(page.getByRole("alert")).toHaveText("Wrong password.");
    await expectNoSave(page, helperSaves);
  });

  test("when the next page asks for the password again", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signin.html?mode=reload`);
    await typeLogin(page, "wrong@example.com", "not-it");
    await signIn(page);
    await page.waitForLoadState("load");
    await expectNoSave(page, helperSaves);
  });

  test.describe(() => {
    test.use({ vaultEntries: [{ hostname: "localhost", username: "saved@example.com", password: "saved-pass" }] });

    test("when Apple Passwords has that password already", async ({ context, siteUrl, helperSaves }) => {
      const page = await context.newPage();
      await page.goto(`${siteUrl}/signin.html`);
      await page.locator("#pass").click();
      const menu = await menuFrame(page);
      await choose(menu, "Unlock to fill passwords");
      await menu.getByRole("textbox", { name: "Verification code" }).fill(PAIRING_CODE);
      await choose(menu, "saved@example.com");
      await expect(page.locator("#pass")).toHaveValue("saved-pass");
      await signIn(page);
      await expect(page.getByText("Welcome!")).toBeVisible();
      await expectNoSave(page, helperSaves);
    });
  });

  test("while locked", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signin.html`);
    await typeLogin(page, "locked@example.com", "typed-pass-3", false);
    await signIn(page);
    await expect(page.getByText("Welcome!")).toBeVisible();
    await expectNoSave(page, helperSaves);
  });
});
