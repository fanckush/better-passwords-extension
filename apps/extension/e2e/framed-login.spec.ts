import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext } from "@playwright/test";
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

test.describe("Apple's sign-in frame", () => {
  test.use({ vaultEntries: [{ hostname: "idmsa.apple.com", username: "dev@example.com", password: "apple-pass" }] });

  const form = readFileSync(resolve(import.meta.dirname, "pages/framed-login-form.html"), "utf8");
  const frameUrl = "https://idmsa.apple.com/appleauth/auth/signin";

  /** Serves `pageUrl` holding Apple's frame, without any network. */
  async function serve(context: BrowserContext, pageUrl: string) {
    await context.route(frameUrl, (route) => route.fulfill({ contentType: "text/html", body: form }));
    const body = `<!doctype html><iframe id="widget" src="${frameUrl}" style="width:100%;height:600px"></iframe>`;
    await context.route(pageUrl, (route) => route.fulfill({ contentType: "text/html", body }));
  }

  test("is filled on another Apple site", async ({ context }) => {
    await serve(context, "https://appstoreconnect.apple.com/login");
    const page = await context.newPage();
    await page.goto("https://appstoreconnect.apple.com/login");
    const widget = page.frameLocator("#widget");
    await widget.locator("#user").click();

    const menu = await menuFrame(page);
    await choose(menu, "Unlock to fill passwords");
    await menu.getByLabel("Verification code").fill(PAIRING_CODE);
    await choose(menu, "dev@example.com");

    await expect(widget.locator("#user")).toHaveValue("dev@example.com");
    await expect(widget.locator("#pass")).toHaveValue("apple-pass");
  });

  test("gets no menu on another site", async ({ context }) => {
    await serve(context, "https://evil.example/");
    const page = await context.newPage();
    await page.goto("https://evil.example/");
    const field = page.frameLocator("#widget").locator("#user");
    await field.click();
    await expect(field).toBeFocused();
    await page.waitForTimeout(1_500);
    expect(page.frames().some((f) => f.url().includes("/menu.html#"))).toBe(false);
  });
});
