import { choose, expect, menuFrame, test } from "./fixtures.ts";

test("keeps the browser's passkey suggestions out of login fields", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);

  expect(await page.evaluate(() => PublicKeyCredential.isConditionalMediationAvailable())).toBe(false);
  // a conditional request stays open (no suggestions) until the site aborts it
  const outcome = await page.evaluate(async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    return navigator.credentials
      .get({ mediation: "conditional", signal: abort.signal, publicKey: { challenge: new Uint8Array(32) } })
      .then(
        () => "resolved",
        (error: Error) => error.name,
      );
  });
  expect(outcome).toBe("AbortError");
});

test("leaves passkeys alone in an iframe of another origin", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/welcome.html`);
  const other = siteUrl.replace("localhost", "127.0.0.1");
  await page.evaluate((src) => {
    const frame = document.createElement("iframe");
    frame.id = "widget";
    frame.src = src;
    document.body.append(frame);
  }, `${other}/login.html`);
  const frame = await (await page.waitForSelector("#widget")).contentFrame();
  await frame?.waitForLoadState();

  // the page's own copy is guarded, the other site's frame keeps the browser's
  const isNative = () => PublicKeyCredential.isConditionalMediationAvailable.toString().includes("[native code]");
  expect(await page.evaluate(isNative)).toBe(false);
  expect(await frame?.evaluate(isNative)).toBe(true);
});

test("the menu offers to show the browser's passkey list, and stops offering it once shown", async ({
  context,
  siteUrl,
}) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#user").click();

  const menu = await menuFrame(page);
  await expect(menu.getByText("Show browser passkey list")).toBeVisible();

  // choosing it releases the page: the menu closes, and it doesn't offer the list again until a reload
  await choose(menu, "Show browser passkey list");
  await expect.poll(() => page.frames().some((f) => f.url().includes("/menu.html#"))).toBe(false);
  await page.keyboard.press("Escape");
  await page.locator("#user").click();
  const again = await menuFrame(page);
  await expect(again.getByText("Show browser passkey list")).toHaveCount(0);
});
