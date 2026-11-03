import { expect, test } from "./fixtures.ts";

// A browser macOS doesn't let start Apple's helper (its launch constraints): set up, but the helper
// dies before answering. The extension must say so plainly, never "connected", and must not keep
// launching the helper: on a real Mac each launch leaves a crash report. Each attempt launches it
// twice: a helper that quits once may just have crashed.

test.use({ setUp: false });

test("says the browser is blocked instead of connected", async ({ context, popupUrl, runBlockedSetup }) => {
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await expect(popup.getByRole("heading", { name: "Welcome to Better Passwords" })).toBeVisible();

  runBlockedSetup();
  await expect(popup.getByRole("heading", { name: /can't use Apple Passwords yet/ })).toBeVisible();
  await expect(popup.getByRole("heading", { name: "You're connected" })).toHaveCount(0);
  // the raw error is there for a bug report, but folded away
  const details = popup.locator("details", { hasText: "Native host has exited." });
  await expect(details).toHaveJSProperty("open", false);
});

test("launches the helper once, and again only when asked", async ({
  context,
  popupUrl,
  siteUrl,
  runBlockedSetup,
  blockedLaunches,
}) => {
  runBlockedSetup();
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await expect(popup.getByRole("heading", { name: /can't use Apple Passwords yet/ })).toBeVisible();
  const launched = blockedLaunches();
  expect(launched).toBe(2);

  // reopening the popup and clicking login fields launch nothing more
  await popup.reload();
  await expect(popup.getByRole("heading", { name: /can't use Apple Passwords yet/ })).toBeVisible();
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  await page.waitForTimeout(2_000);
  // no unlock menu that can't work
  expect(page.frames().some((frame) => frame.url().includes("/menu.html"))).toBe(false);
  expect(blockedLaunches()).toBe(launched);

  await popup.bringToFront();
  await popup.getByRole("button", { name: "Try Again" }).click();
  await expect(popup.getByText(/is still blocked by macOS/)).toBeVisible();
  expect(blockedLaunches()).toBe(launched + 2);
});
