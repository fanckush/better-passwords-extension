import { choose, expect, menuFrame, PAIRING_CODE, test } from "./fixtures.ts";

// A site may serve HTML it doesn't trust (uploads, attachments) from its own address with
// `Content-Security-Policy: sandbox`. The address is the site's; the page is not: it must never
// get the site's logins.

test("no menu on a sandboxed page at the site's address", async ({ context, siteUrl }) => {
  // unlocked first, on the site's real sign-in page, where the login is offered
  const real = await context.newPage();
  await real.goto(`${siteUrl}/login.html`);
  await real.locator("#user").click();
  const menu = await menuFrame(real);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();

  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html?sandbox`);
  expect(await page.evaluate(() => [self.origin, location.origin])).toEqual(["null", siteUrl]);
  const field = page.locator("#user");
  await field.click();
  await expect(field).toBeFocused();
  await page.waitForTimeout(1_500);
  expect(page.frames().some((f) => f.url().includes("/menu.html#"))).toBe(false);
});

test("the extension's own scripts see a sandboxed page as another origin", async ({ context, siteUrl, popupUrl }) => {
  expect(popupUrl).toBeTruthy(); // the background worker is up
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html?sandbox`);
  const [worker] = context.serviceWorkers();
  // what fillCredentials and frameOriginToFill compare, read the way the popup's fill is injected
  const seen = await worker?.evaluate(async (url) => {
    const { chrome } = globalThis as unknown as {
      chrome: {
        tabs: { query(q: unknown): Promise<{ id?: number }[]> };
        scripting: { executeScript(i: unknown): Promise<{ result?: string[] }[]> };
      };
    };
    const [tab] = await chrome.tabs.query({ url });
    if (tab?.id === undefined) return undefined;
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => [self.origin, location.origin],
    });
    return injection?.result;
  }, `${siteUrl}/login.html*`);
  expect(seen).toEqual(["null", siteUrl]);
});
