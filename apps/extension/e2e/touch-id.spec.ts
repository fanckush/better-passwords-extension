import { choose, expect, menuFrame, PAIRING_CODE, test } from "./fixtures.ts";

// The Touch ID companion is replaced by a fake native host that answers as the real one does
// after the user confirmed (or cancelled) Touch ID.

test.describe("with the companion app", () => {
  test.use({ companion: "ok" });

  test("the popup unlocks with Touch ID, without typing", async ({ context, popupUrl }) => {
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    await expect(popup.getByText("Open a website to see its saved passwords.")).toBeVisible();
    await expect(popup.getByLabel("Enter the 6-digit code for me")).toBeChecked();
  });

  test("the inline menu unlocks with Touch ID and fills", async ({ context, siteUrl }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/login.html`);
    await page.locator("#pass").click();
    const menu = await menuFrame(page);
    await expect(menu.getByText("Touch ID enters the code for you")).toBeVisible();
    await choose(menu, "Unlock to fill passwords");
    await choose(menu, "e2e-user");
    await expect(page.locator("#pass")).toHaveValue("e2e-pass");
  });

  test("Touch ID shows a fresh code, in case an earlier one was closed", async ({
    context,
    popupUrl,
    siteUrl,
    codesShown,
  }) => {
    // a code asked for earlier (say, to type it) whose window the user then closed
    const page = await context.newPage();
    await page.goto(popupUrl.replace("popup.html", "companion.html"));
    await page.evaluate(() => {
      type Runtime = { runtime: { sendMessage(message: unknown): Promise<unknown> } };
      const { chrome } = globalThis as unknown as { chrome: Runtime };
      return chrome.runtime.sendMessage({ type: "request-code" });
    });
    await expect.poll(codesShown).toBe(1);

    await page.goto(`${siteUrl}/login.html`);
    await page.locator("#pass").click();
    const menu = await menuFrame(page);
    await choose(menu, "Unlock to fill passwords");
    await choose(menu, "e2e-user");
    expect(codesShown()).toBe(2);
  });

  test("turning Touch ID off goes back to typing the code", async ({ context, popupUrl }) => {
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    await popup.getByLabel("Enter the 6-digit code for me").uncheck();
    await popup.getByRole("button", { name: "Lock" }).click();

    const again = await context.newPage();
    await again.goto(popupUrl);
    await expect(again.getByText("Enter the code shown on your Mac")).toBeVisible();
    await expect(again.getByRole("button", { name: "Enter It for Me" })).toHaveCount(0);
  });
});

test.describe("when Touch ID is cancelled", () => {
  test.use({ companion: "cancelled" });

  test("the code can still be typed", async ({ context, popupUrl }) => {
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    await expect(popup.getByText("Touch ID was cancelled.")).toBeVisible();
    await expect(popup.getByRole("button", { name: "Enter It for Me" })).toBeVisible();
    await popup.getByRole("textbox", { name: "Verification code" }).fill(PAIRING_CODE);
    await expect(popup.getByText("Open a website to see its saved passwords.")).toBeVisible();
  });
});

test.describe("when the companion still needs setup", () => {
  test.use({ companion: "needs-accessibility" });

  test("the popup asks for the code and says how to finish setup", async ({ context, popupUrl }) => {
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    await expect(popup.getByText("Enter the code shown on your Mac")).toBeVisible();
    await expect(popup.getByText("finish setting up the companion app")).toBeVisible();
    await popup.getByRole("textbox", { name: "Verification code" }).fill(PAIRING_CODE);
    await expect(popup.getByRole("button", { name: "Finish Setting Up" })).toBeVisible();
  });
});
