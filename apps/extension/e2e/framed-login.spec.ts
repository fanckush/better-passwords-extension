import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Locator } from "@playwright/test";
import { choose, expect, menuFrame, PAIRING_CODE, test } from "./fixtures.ts";

test("fills a sign-in inside an iframe of the page's own origin", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/framed-login.html`);
  const form = page.frameLocator("#widget");
  await form.locator("#user").click();

  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await choose(menu, "e2e-user");

  await expect(form.locator("#user")).toHaveValue("e2e-user");
  await expect(form.locator("#pass")).toHaveValue("e2e-pass");
});

test("closes the menu when focus leaves the iframe for the page around it", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/framed-login.html`);
  await page.frameLocator("#widget").locator("#user").click();
  await menuFrame(page);

  await page.locator("#outside").click();
  await expect.poll(() => page.frames().some((f) => f.url().includes("/menu.html#"))).toBe(false);
});

test("no menu in an iframe of another origin", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/welcome.html`);
  const other = siteUrl.replace("localhost", "127.0.0.1");
  await page.evaluate((src) => {
    const frame = document.createElement("iframe");
    frame.id = "widget";
    frame.src = src;
    document.body.append(frame);
  }, `${other}/framed-login-form.html`);

  const field = page.frameLocator("#widget").locator("#user");
  await field.click();
  await expect(field).toBeFocused();
  await page.waitForTimeout(1_500);
  expect(page.frames().some((f) => f.url().includes("/menu.html#"))).toBe(false);
});

test("no menu in an iframe of the page's origin inside another site's iframe", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/welcome.html`);
  const other = siteUrl.replace("localhost", "127.0.0.1");
  await page.evaluate((src) => {
    const frame = document.createElement("iframe");
    frame.id = "outer";
    frame.src = src;
    document.body.append(frame);
  }, `${other}/welcome.html`);
  await expect.poll(() => page.frames().some((f) => f.url().startsWith(other))).toBe(true);
  const outer = page.frames().find((f) => f.url().startsWith(other));
  await outer?.waitForLoadState();
  await outer?.evaluate((src) => {
    const frame = document.createElement("iframe");
    frame.id = "widget";
    frame.src = src;
    document.body.append(frame);
  }, `${siteUrl}/framed-login-form.html`);

  const field = page.frameLocator("#outer").frameLocator("#widget").locator("#user");
  await field.click();
  await expect(field).toBeFocused();
  await page.waitForTimeout(1_500);
  expect(page.frames().some((f) => f.url().includes("/menu.html#"))).toBe(false);
});

test.describe("a sign-in frame on another host of the page's site", () => {
  test.use({
    // Playwright reads a bare array here as [value, options], so the list goes in a pair of its own
    vaultEntries: [
      [
        { hostname: "sws-gateway-nr.schwab.com", username: "investor", password: "frame-pass" },
        { hostname: "www.schwab.com", username: "page-user", password: "page-pass" },
        { hostname: "idmsa.apple.com", username: "dev@example.com", password: "apple-pass" },
      ],
      { scope: "test" },
    ],
  });

  const form = readFileSync(resolve(import.meta.dirname, "pages/framed-login-form.html"), "utf8");
  const schwabFrame = "https://sws-gateway-nr.schwab.com/ui/host/";

  /** Serves `pageUrl` holding `frameUrl` (and, if asked, a sign-in of its own), without any network. */
  async function serve(context: BrowserContext, pageUrl: string, frameUrl: string, ownSignIn = false) {
    await context.route(frameUrl, (route) => route.fulfill({ contentType: "text/html", body: form }));
    const own = ownSignIn
      ? '<input id="page-user" autocomplete="username"><input id="page-pass" type="password" autocomplete="current-password">'
      : "";
    const body = `<!doctype html>${own}<iframe id="widget" src="${frameUrl}" style="width:100%;height:600px"></iframe>`;
    await context.route(pageUrl, (route) => route.fulfill({ contentType: "text/html", body }));
  }

  /** Unlocks the menu on `field` and picks `username`. */
  async function fill(field: Locator, username: string) {
    await field.click();
    const menu = await menuFrame(field.page());
    await choose(menu, "Unlock to fill passwords");
    await menu.getByLabel("Verification code").fill(PAIRING_CODE);
    await choose(menu, username);
  }

  test("is filled, like Schwab's", async ({ context }) => {
    await serve(context, "https://www.schwab.com/", schwabFrame);
    const page = await context.newPage();
    await page.goto("https://www.schwab.com/");
    const widget = page.frameLocator("#widget");
    await fill(widget.locator("#user"), "investor");

    await expect(widget.locator("#user")).toHaveValue("investor");
    await expect(widget.locator("#pass")).toHaveValue("frame-pass");
  });

  test("is filled, like Apple's on another Apple site", async ({ context }) => {
    const frameUrl = "https://idmsa.apple.com/appleauth/auth/signin";
    await serve(context, "https://appstoreconnect.apple.com/login", frameUrl);
    const page = await context.newPage();
    await page.goto("https://appstoreconnect.apple.com/login");
    const widget = page.frameLocator("#widget");
    await fill(widget.locator("#user"), "dev@example.com");

    await expect(widget.locator("#user")).toHaveValue("dev@example.com");
    await expect(widget.locator("#pass")).toHaveValue("apple-pass");
  });

  test("leaves the page's own sign-in to the page", async ({ context }) => {
    await serve(context, "https://www.schwab.com/", schwabFrame, true);
    const page = await context.newPage();
    await page.goto("https://www.schwab.com/");
    await fill(page.frameLocator("#widget").locator("#user"), "investor");
    await expect(page.frameLocator("#widget").locator("#pass")).toHaveValue("frame-pass");

    await page.locator("#page-user").click();
    await choose(await menuFrame(page), "page-user");
    await expect(page.locator("#page-user")).toHaveValue("page-user");
    await expect(page.locator("#page-pass")).toHaveValue("page-pass");
  });

  test.describe("gets no menu", () => {
    const pairs: [page: string, frame: string][] = [
      ["https://evil.example/", schwabFrame],
      ["https://alice.github.io/", "https://mallory.github.io/login"],
    ];
    for (const [pageUrl, frameUrl] of pairs) {
      test(`for ${new URL(frameUrl).hostname} inside ${new URL(pageUrl).hostname}`, async ({ context }) => {
        await serve(context, pageUrl, frameUrl);
        const page = await context.newPage();
        await page.goto(pageUrl);
        const field = page.frameLocator("#widget").locator("#user");
        await field.click();
        await expect(field).toBeFocused();
        await page.waitForTimeout(1_500);
        expect(page.frames().some((f) => f.url().includes("/menu.html#"))).toBe(false);
      });
    }
  });
});
