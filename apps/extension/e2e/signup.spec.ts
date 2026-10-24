import type { Frame, Page } from "@playwright/test";
import { choose, expect, menuFrame, PAIRING_CODE, test } from "./fixtures.ts";

/** A suggested password: hidden but for its start, shown while the eye is hovered. */
async function revealed(menu: Frame, index: number): Promise<string> {
  const detail = menu.locator(".password").nth(index);
  expect(await detail.textContent()).toMatch(/^.{3}[•-]+$/);
  // the menu resizes as it renders; hover once it has settled, as a person would
  await menu.page().waitForTimeout(500);
  await menu.locator(".reveal").nth(index).hover();
  await expect(detail).not.toContainText("•");
  return (await detail.textContent()) ?? "";
}

// These tests are about passwords: keep the email field's hints (Hide My Email, the companion app)
// out of the way, as a user who dismissed them would.
test.beforeEach(async ({ context, popupUrl }) => {
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await popup.evaluate(() => {
    type Runtime = { runtime: { sendMessage(message: unknown): Promise<unknown> } };
    const { chrome } = globalThis as unknown as { chrome: Runtime };
    return chrome.runtime.sendMessage({
      type: "set-settings",
      settings: { hideMyEmailHint: false, companionEmailsHint: false },
    });
  });
  await popup.close();
});

/** Opens the menu on the new password field and unlocks it. */
async function unlockedMenu(page: Page): Promise<Frame> {
  await page.locator("#new").click();
  const menu = await menuFrame(page);
  // still unlocked from earlier in the test: nothing to do
  if (await menu.getByText("Unlock to suggest a strong password").isVisible()) {
    await choose(menu, "Unlock to suggest a strong password");
    await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  }
  return menu;
}

/** Unlocks, picks the strong password and returns it. */
async function fillStrongPassword(page: Page): Promise<string> {
  const menu = await unlockedMenu(page);
  const password = await revealed(menu, 0);
  await choose(menu, "Strong Password");
  await expect(page.locator("#new")).toHaveValue(password);
  return password;
}

/** Nothing gets saved, given time for a save to happen. */
async function expectNoSave(page: Page, helperSaves: () => unknown[]) {
  await page.waitForTimeout(2_000);
  expect(helperSaves()).toEqual([]);
}

const create = (page: Page) => page.getByRole("button", { name: "Create account" }).click();

test("opens native password creation without pairing or exposing a password to the page", async ({
  context,
  siteUrl,
  passwordsAppLaunches,
  codesShown,
  passwordReads,
  helperSaves,
}) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  const codesBefore = codesShown();
  await page.locator("#new").click();
  const menu = await menuFrame(page);
  await page.screenshot({ path: test.info().outputPath("native-creation.png") });
  await choose(menu, "Create in Apple Passwords");
  await expect.poll(passwordsAppLaunches).toEqual([siteUrl]);
  expect(codesShown()).toBe(codesBefore);
  expect(passwordReads()).toBe(0);
  expect(helperSaves()).toEqual([]);
  await expect(page.locator("#new")).toHaveValue("");
});

test("refuses a weak inline suggestion and keeps native creation available", async ({
  context,
  siteUrl,
  helperSaves,
}) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  await page.locator("#new").evaluate((field) => field.setAttribute("maxlength", "1"));
  const menu = await unlockedMenu(page);
  await expect(
    menu.getByText("This site's rules cannot produce a strong password suggestion.", { exact: false }),
  ).toBeVisible();
  await expect(menu.getByText("Create in Apple Passwords")).toBeVisible();
  await expect(menu.getByText("Strong Password", { exact: true })).not.toBeVisible();
  await expect(page.locator("#new")).toHaveValue("");
  expect(helperSaves()).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("restricted-rules.png") });
});

test("keeps a valid strong suggestion when the site requires a special character", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  await page
    .locator("#new")
    .evaluate((field) =>
      field.setAttribute(
        "passwordrules",
        "required: lower; required: upper; required: digit; required: [!#]; minlength: 24",
      ),
    );
  const menu = await unlockedMenu(page);
  await expect(menu.getByText("Strong Password", { exact: true })).toBeVisible();
  await expect(menu.getByText("Without Special Characters", { exact: true })).not.toBeVisible();
  await choose(menu, "Strong Password");
  await expect(page.locator("#new")).toHaveValue(/[!#]/);
});

test("fills a strong password at once and saves it once the sign-up goes through", async ({
  context,
  siteUrl,
  helperSaves,
}) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html?mode=spa`);
  await page.locator("#email").fill("new-user@example.com");
  const password = await fillStrongPassword(page);

  // like Safari: filled right away, nothing saved yet
  await expect(page.locator("#confirm")).toHaveValue(password);
  expect(helperSaves()).toEqual([]);
  await page.locator("#email").click();
  await page.locator("#confirm").click();
  await expect((await menuFrame(page)).getByText("You'll be asked to save it when you continue")).toBeVisible();

  // the site moves on (here: the URL changes): saved with the form's username
  await page.locator("#email").fill("renamed@example.com");
  await create(page);
  await expect.poll(helperSaves).toEqual([{ hostname: "localhost", username: "renamed@example.com", password }]);
  await expect
    .poll(async () => {
      await page.locator("#email").click();
      await page.locator("#new").click();
      return (await menuFrame(page)).getByText("Strong Password Saved").isVisible();
    })
    .toBe(true);
});

test("offers passwords without special characters; the eye chooses like its row", async ({
  context,
  siteUrl,
  helperSaves,
}) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  const menu = await unlockedMenu(page);
  const password = await revealed(menu, 1);
  expect(password).toMatch(/^[a-zA-Z0-9]{20}$/);
  await menu.locator(".reveal").nth(1).click();
  await expect(page.locator("#new")).toHaveValue(password);
  // no username in the form: macOS asks for one in its dialog when saving
  await create(page);
  await expect.poll(helperSaves).toEqual([{ hostname: "localhost", username: "", password }]);
});

test("never offers new passwords on a login form", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await expect(menu.getByText("Unlock to fill passwords")).toBeVisible();
});

test.describe("asks to save once the page moves on with the password", () => {
  test("not while the browser blocks an invalid form", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signup.html`);
    await page.locator("#email").fill("not-an-email");
    const password = await fillStrongPassword(page);
    await create(page);
    await expectNoSave(page, helperSaves);
    // fixed and sent again: saved
    await page.locator("#email").fill("fixed@example.com");
    await create(page);
    await expect.poll(helperSaves).toEqual([{ hostname: "localhost", username: "fixed@example.com", password }]);
  });

  test("not when the site rejects it", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signup.html?mode=error`);
    await page.locator("#email").fill("taken@example.com");
    await fillStrongPassword(page);
    await create(page);
    await expect(page.getByRole("alert")).toHaveText("That email is already taken.");
    await expectNoSave(page, helperSaves);
  });

  test("when the form navigates", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signup.html?mode=navigate`);
    await page.locator("#email").fill("classic@example.com");
    const password = await fillStrongPassword(page);
    await create(page);
    await expect(page.getByText("Welcome!")).toBeVisible();
    await expect.poll(helperSaves).toEqual([{ hostname: "localhost", username: "classic@example.com", password }]);
  });

  test("when Enter sends the form", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signup.html`);
    await page.locator("#email").fill("enter@example.com");
    const password = await fillStrongPassword(page);
    await page.locator("#confirm").press("Enter");
    await expect.poll(helperSaves).toEqual([{ hostname: "localhost", username: "enter@example.com", password }]);
  });

  test("when a sign-up dialog closes after creating the account", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/modal.html`);
    await page.locator("#email").fill("dialog@example.com");
    const password = await fillStrongPassword(page);
    await create(page);
    await expect.poll(helperSaves).toEqual([{ hostname: "localhost", username: "dialog@example.com", password }]);
  });

  test("also when the dialog is dismissed: better to ask, Not Now is one click", async ({
    context,
    siteUrl,
    helperSaves,
  }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/modal.html`);
    await page.locator("#email").fill("dismissed@example.com");
    const password = await fillStrongPassword(page);
    await page.getByRole("button", { name: "Close" }).click();
    await expect.poll(helperSaves).toEqual([{ hostname: "localhost", username: "dismissed@example.com", password }]);
  });

  test("on multi-step sign-ups, with the email from the earlier step", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/multistep.html`);
    await page.locator("#email").fill("steps@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    const password = await fillStrongPassword(page);
    await create(page);
    await expect.poll(helperSaves).toEqual([{ hostname: "localhost", username: "steps@example.com", password }]);
  });

  test("on pages without a form", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/formless.html`);
    await page.locator("#email").fill("formless@example.com");
    const password = await fillStrongPassword(page);
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect.poll(helperSaves).toEqual([{ hostname: "localhost", username: "formless@example.com", password }]);
  });

  test("when the page is left with the password in it, once", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signup.html`);
    await page.locator("#email").fill("left@example.com");
    const password = await fillStrongPassword(page);
    await page.goto(`${siteUrl}/login.html`);
    await expect.poll(helperSaves).toEqual([{ hostname: "localhost", username: "left@example.com", password }]);
    await page.goto(`${siteUrl}/signup.html`);
    await page.waitForTimeout(1_000);
    expect(helperSaves()).toHaveLength(1);
  });
});

test("replacing a saved password is saved on submit and assumed done", async ({ context, siteUrl, helperSaves }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html?mode=spa`);
  // e2e-user already has a saved password for this site
  await page.locator("#email").fill("e2e-user@example.com");
  await page.evaluate(() => {
    (document.getElementById("email") as HTMLInputElement).type = "text";
  });
  await page.locator("#email").fill("e2e-user");
  const password = await fillStrongPassword(page);
  await create(page);
  await expect.poll(helperSaves).toEqual([{ hostname: "localhost", username: "e2e-user", password }]);
  await expect
    .poll(async () => {
      await page.locator("#email").click();
      await page.locator("#new").click();
      return (await menuFrame(page)).getByText("Strong Password Saved").isVisible();
    })
    .toBe(true);
});

test.describe("when the user doesn't save", () => {
  test.use({ declineSaves: true });

  test("the password stays filled, and the field says it isn't saved", async ({ context, siteUrl, helperSaves }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signup.html?mode=spa`);
    await page.locator("#email").fill("no-save@example.com");
    const password = await fillStrongPassword(page);
    await create(page);
    await expectNoSave(page, helperSaves);
    await expect(page.locator("#new")).toHaveValue(password);
    await page.locator("#email").click();
    await page.locator("#new").click();
    await expect((await menuFrame(page)).getByText("You'll be asked to save it when you continue")).toBeVisible();
  });
});

test("typing a password of one's own closes the suggestions", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  const menu = await unlockedMenu(page);
  await expect(menu.getByText("Without Special Characters")).toBeVisible();
  await page.locator("#new").focus();
  await page.keyboard.type("my own password");
  await expect.poll(() => page.locator("app-autofill-menu").count()).toBe(0);
  // and it stays closed for that field
  await page.locator("#email").click();
  await page.locator("#new").click();
  await page.waitForTimeout(500);
  expect(await page.locator("app-autofill-menu").count()).toBe(0);
});
