import type { Frame, Page } from "@playwright/test";
import { totp } from "../../../packages/fake-helper/src/totp.ts";
import { choose, expect, menuFrame, PAIRING_CODE, test } from "./fixtures.ts";

const ALICE = "JBSWY3DPEHPK3PXP";
const BOB = "GEZDGNBVGY3TQOJQ";

test.use({
  vaultEntries: [
    [
      { hostname: "localhost", username: "alice", password: "alice-pass", totp: { secret: ALICE } },
      { hostname: "localhost", username: "bob", password: "bob-pass", totp: { secret: BOB } },
    ],
    { scope: "test" },
  ],
});

/** The code for `secret` now, or the one just before (the test may straddle a 30 s step). */
async function codesFor(secret: string): Promise<string[]> {
  const now = Date.now();
  return [await totp(secret, now), await totp(secret, now - 30_000)];
}

/** Unlocks and signs in as `username` from the inline menu, up to the verification step. */
async function signIn(page: Page, url: string, username: string) {
  await page.goto(url);
  await page.locator("#user").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await choose(menu, username);
  await expect(page.locator("#pass")).toHaveValue(`${username}-pass`);
  await page.locator("#sign-in-button").click();
}

async function expectNoMenu(page: Page) {
  await page.waitForTimeout(1_500);
  expect(page.frames().some((f) => f.url().includes("/menu.html#") && !f.isDetached())).toBe(false);
}

test("offers the code of the account just signed in with, and fills it without submitting", async ({
  context,
  siteUrl,
}) => {
  const page = await context.newPage();
  await signIn(page, `${siteUrl}/two-factor.html`, "bob");
  await page.locator("#code").click();

  const menu: Frame = await menuFrame(page);
  await expect(menu.getByText("bob · localhost")).toBeVisible();
  await expect(menu.getByText("alice · localhost")).toHaveCount(0);
  // no digits before Touch ID: Apple Passwords doesn't give them out
  expect(await menu.locator("#menu").textContent()).not.toMatch(/\d{6}/);
  await choose(menu, "1 other account");
  await expect(menu.getByText("alice · localhost")).toBeVisible();

  await choose(menu, "bob · localhost");
  await expect(page.locator("#code")).toHaveValue(/^\d{6}$/);
  expect(await codesFor(BOB)).toContain(await page.locator("#code").inputValue());
  // ready for Enter, but never sent for the user
  await expect(page.locator("#code")).toBeFocused();
  await expect(page.locator("#submitted")).toHaveText("0");
  // filled: the menu doesn't come back over the code
  await expectNoMenu(page);
});

test("spreads the code over one box per digit", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await signIn(page, `${siteUrl}/two-factor.html?variant=split`, "alice");
  await page.locator("#d0").click();
  const menu = await menuFrame(page);
  await choose(menu, "alice · localhost");
  await expect(page.locator("#d5")).not.toHaveValue("");
  const digits = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => page.locator(`#d${i}`).inputValue()));
  expect(await codesFor(ALICE)).toContain(digits.join(""));
  await expect(page.locator("#submitted")).toHaveText("0");
  await expectNoMenu(page);
});

test("finds an unmarked code field, and fills it from the keyboard", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await signIn(page, `${siteUrl}/two-factor.html?variant=heuristic`, "alice");
  await page.locator("#code").click();
  const menu = await menuFrame(page);
  await expect(menu.getByText("alice · localhost")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("option", { name: /alice · localhost/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#code")).toHaveValue(/^\d{6}$/);
  expect(await codesFor(ALICE)).toContain(await page.locator("#code").inputValue());
});

test("stays out of the way of a code typed by hand", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await signIn(page, `${siteUrl}/two-factor.html`, "alice");
  await page.locator("#code").click();
  await menuFrame(page);
  await page.keyboard.type("1");
  await expectNoMenu(page);
});

test.describe("without saved verification codes", () => {
  test.use({
    vaultEntries: [[{ hostname: "localhost", username: "alice", password: "alice-pass" }], { scope: "test" }],
  });

  test("shows no menu in a code field (it may want an SMS code)", async ({ context, siteUrl }) => {
    const page = await context.newPage();
    await signIn(page, `${siteUrl}/two-factor.html`, "alice");
    await page.locator("#code").click();
    await expectNoMenu(page);
  });
});

test("the setting turns code suggestions off", async ({ context, siteUrl, popupUrl }) => {
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await popup.evaluate(() =>
    (
      globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } } }
    ).chrome.runtime.sendMessage({ type: "set-settings", settings: { oneTimeCodes: false } }),
  );
  const page = await context.newPage();
  await signIn(page, `${siteUrl}/two-factor.html`, "alice");
  await page.locator("#code").click();
  await expectNoMenu(page);
});

test("an extension page inside a tab can't read a code's digits", async ({ context, siteUrl, popupUrl }) => {
  const page = await context.newPage();
  await signIn(page, `${siteUrl}/two-factor.html`, "alice");
  await expect(page.locator("#code")).toBeVisible();
  // like the inline menu, a page in a tab is bound to its own tab, and Copy is the popup's alone
  const inTab = await context.newPage();
  await inTab.goto(popupUrl);
  const reply = await inTab.evaluate(async () => {
    const { chrome } = globalThis as unknown as {
      chrome: {
        runtime: { sendMessage(m: unknown): Promise<{ ok: boolean; error?: string }> };
        tabs: { query(q: unknown): Promise<{ id: number }[]> };
      };
    };
    const [site] = await chrome.tabs.query({ url: "http://localhost/*" });
    return chrome.runtime.sendMessage({ type: "copy-one-time-code", tabId: site?.id, id: "x" });
  });
  expect(reply).toMatchObject({ ok: false, error: "not allowed" });
});
