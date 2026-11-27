import { EXTENSION_ID, REPO_URL } from "../src/config.ts";
import { choose, expect, menuFrame, PAIRING_CODE, test } from "./fixtures.ts";

// A browser the setup script hasn't run for yet. The extension welcomes the user, says what to
// do, and notices by itself once it's done (`runSetup` registers the helper, as the script does).

test.use({ setUp: false });

const setupUrl = `chrome-extension://${EXTENSION_ID}/setup.html`;

test("the popup welcomes, notices the setup, and moves on to the code", async ({ context, popupUrl, runSetup }) => {
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await expect(popup.getByRole("heading", { name: "Welcome to Better Passwords" })).toBeVisible();
  // "not set up" is the normal first state, not an error
  await expect(popup.getByText(/native messaging host/i)).toHaveCount(0);
  await popup.getByRole("button", { name: /^Apple Passwords/ }).click();

  // one route at a time: the Terminal one replaces the app's
  await popup.getByRole("button", { name: "Rather not install an app?" }).click();
  await expect(popup.getByRole("link", { name: "Download the Mac App" })).toHaveCount(0);
  await expect(popup.getByText("Waiting for the connection…")).toBeHidden();
  await popup.getByRole("button", { name: "Copy Terminal Command" }).click();
  await expect(popup.getByText("Waiting for the connection…")).toBeVisible();

  runSetup();
  await expect(popup.getByRole("heading", { name: "You're Connected" })).toBeVisible();
  await popup.getByRole("button", { name: "Continue" }).click();
  await popup.getByRole("textbox", { name: "Verification code" }).fill(PAIRING_CODE);
  await expect(popup.getByText("You're all set.")).toBeVisible();
});

test("a popup reopened after setup says it worked, once", async ({ context, popupUrl, runSetup }) => {
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await popup.getByRole("button", { name: /^Apple Passwords/ }).click();
  await popup.getByRole("button", { name: "Rather not install an app?" }).click();
  await popup.getByRole("button", { name: "Copy Terminal Command" }).click();
  // the popup closes while the user is in Terminal
  await popup.close();
  runSetup();

  const again = await context.newPage();
  await again.goto(popupUrl);
  await expect(again.getByRole("heading", { name: "You're Connected" })).toBeVisible();
  await expect(async () => {
    await again.reload();
    await expect(again.getByText("Enter the code shown on your Mac")).toBeVisible({ timeout: 1_000 });
  }).toPass();
});

test("the inline menu offers the setup on login fields", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  const opened = context.waitForEvent("page", { predicate: (p) => p.url() === setupUrl });
  await choose(menu, "Set Up Better Passwords");
  const setup = await opened;
  await expect(setup.getByRole("heading", { name: "Welcome to Better Passwords" })).toBeVisible();
});

test("the setup page follows along until unlocked", async ({ context, popupUrl, runSetup }) => {
  const setup = await context.newPage();
  await setup.goto(setupUrl);
  await expect(setup.getByRole("heading", { name: "Welcome to Better Passwords" })).toBeVisible();

  runSetup();
  await expect(setup.getByRole("heading", { name: "You're Connected" })).toBeVisible();

  // the page has said it worked, so the popup goes straight to the code
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await popup.getByRole("textbox", { name: "Verification code" }).fill(PAIRING_CODE);
  await expect(setup.getByRole("heading", { name: "Password Managers" })).toBeVisible();
  await expect(setup.getByText("Apple Passwords is ready.")).toBeVisible();
});

test("a fresh install opens the setup page", async ({ context }) => {
  const setup =
    context.pages().find((p) => p.url() === setupUrl) ??
    (await context.waitForEvent("page", { predicate: (p) => p.url() === setupUrl }));
  await expect(setup.getByRole("heading", { name: "Welcome to Better Passwords" })).toBeVisible();
});

test.describe("when this browser is set up already", () => {
  test.use({ setUp: true });

  test("installing opens nothing", async ({ context, popupUrl }) => {
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    await expect(popup.getByText("Enter the code shown on your Mac")).toBeVisible();
    expect(context.pages().map((p) => p.url())).not.toContain(setupUrl);
  });
});

test("the setup is offered on a login form's email field too", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  // like many sites: an email field that isn't marked as the username, next to a password field
  await page.locator("#user").evaluate((el: HTMLInputElement) => {
    el.autocomplete = "email";
  });
  await page.locator("#user").click();
  const menu = await menuFrame(page);
  await expect(menu.getByText("Set Up Better Passwords")).toBeVisible();
});

test("the welcome links to a bug form filled in with this browser's details", async ({ context, popupUrl }) => {
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  const github = popup.getByRole("link", { name: "report it on GitHub" });
  await expect(github).toHaveAttribute("href", new RegExp(`^${REPO_URL}/issues/new\\?template=bug\\.yml&version=`));
  // Chromium reads its own name and version from the client hints
  await expect(github).toHaveAttribute("href", /&browser=/);
});
