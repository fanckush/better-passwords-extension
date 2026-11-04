import type { BrowserContext, Frame } from "@playwright/test";
import { EXTENSION_ID } from "../src/config.ts";
import { choose, expect, menuFrame, test } from "./fixtures.ts";

/** A fake icloud.com for the extension's background, recording what it was asked. */
async function fakeICloud(
  context: BrowserContext,
  {
    signedIn = true,
    existing,
    delayMs = 0,
    icloudPlus = true,
  }: { signedIn?: boolean; existing?: string; delayMs?: number; icloudPlus?: boolean } = {},
) {
  const seen: { path: string; origin: string | undefined; body?: unknown }[] = [];
  let generated = 0;
  await context.route(/https:\/\/[^/]*icloud\.com\//, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    seen.push({ path: pathname, origin: request.headers().origin, body: request.postDataJSON?.() ?? undefined });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/setup/ws/1/validate") {
      if (!signedIn) return json({ success: false }, 421);
      // without iCloud+, the account has no Hide My Email service
      return icloudPlus
        ? json({
            webservices: { premiummailsettings: { url: "https://p1-maildomainws.icloud.com", status: "active" } },
          })
        : json({ webservices: { contacts: { url: "https://p1-contactsws.icloud.com", status: "active" } } });
    }
    if (pathname === "/v2/hme/list") {
      const hmeEmails = existing ? [{ hme: existing, label: "localhost", isActive: true }] : [];
      return json({ success: true, result: { hmeEmails } });
    }
    if (pathname === "/v1/hme/generate")
      return json({ success: true, result: { hme: `fresh${++generated}@icloud.com` } });
    if (pathname === "/v1/hme/reserve") {
      const { hme } = request.postDataJSON() as { hme: string };
      return json({ success: true, result: { hme: { hme } } });
    }
    return route.fulfill({ status: 404 });
  });
  return seen;
}

async function emailMenu(page: import("@playwright/test").Page): Promise<Frame> {
  await page.locator("#email").click();
  return menuFrame(page);
}

test("advertises Hide My Email on sign-up email fields until dismissed", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  const menu = await emailMenu(page);
  await expect(menu.getByText("Use Hide My Email")).toBeVisible();
  // the ✕ dismisses the hint for good, without turning Hide My Email on
  await page.waitForTimeout(500);
  await menu.getByRole("button", { name: "Don't suggest Hide My Email again" }).click();
  await expect.poll(() => page.locator("app-autofill-menu").count()).toBe(0);

  // without the companion app, the other hint remains; dismissed too, the field gets no menu
  await page.locator("#new").click();
  const again = await emailMenu(page);
  await expect(again.getByText("Use Hide My Email")).toHaveCount(0);
  await expect(again.getByText("Suggest Your Email Addresses")).toBeVisible();
  await page.waitForTimeout(500);
  await again.getByRole("button", { name: "Don't suggest the app again" }).click();
  await expect.poll(() => page.locator("app-autofill-menu").count()).toBe(0);
  await page.locator("#new").click();
  await page.locator("#email").click();
  await page.waitForTimeout(800);
  expect(await page.locator("app-autofill-menu").count()).toBe(0);
});

test("never on login forms", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#user").click();
  const menu = await menuFrame(page);
  await expect(menu.getByText("Unlock to fill passwords")).toBeVisible();
  await expect(menu.getByText("Use Hide My Email")).toHaveCount(0);
});

test("on other email fields too, such as a newsletter's", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#newsletter-email").click();
  const menu = await menuFrame(page);
  await expect(menu.getByText("Use Hide My Email")).toBeVisible();
  await expect(menu.getByText("Unlock to fill passwords")).toHaveCount(0);
});

test("turned on from the hint, creates an address for the site and fills it in", async ({ context, siteUrl }) => {
  const seen = await fakeICloud(context);
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  const menu = await emailMenu(page);
  await choose(menu, "Use Hide My Email");
  await choose(menu, "Hide My Email…");
  await expect(menu.getByText("fresh1@icloud.com")).toBeVisible();
  await choose(menu, "Try Another");
  await choose(menu, "fresh2@icloud.com");
  await expect(page.locator("#email")).toHaveValue("fresh2@icloud.com");

  const reserve = seen.find((call) => call.path === "/v1/hme/reserve");
  expect(reserve?.body).toEqual({
    hme: "fresh2@icloud.com",
    label: "localhost",
    note: "Created by Better Passwords",
  });
});

test("offers the address made for this site before", async ({ context, siteUrl }) => {
  const seen = await fakeICloud(context, { existing: "kept@icloud.com" });
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  let menu = await emailMenu(page);
  await choose(menu, "Use Hide My Email");
  await expect(menu.getByText("kept@icloud.com")).toBeVisible();
  await choose(menu, "kept@icloud.com");
  await expect(page.locator("#email")).toHaveValue("kept@icloud.com");
  expect(seen.some((call) => call.path === "/v1/hme/reserve")).toBe(false);

  // on from now on: no hint, straight to the address
  await page.locator("#new").click();
  menu = await emailMenu(page);
  await expect(menu.getByText("kept@icloud.com")).toBeVisible();
});

test("asks to sign in to iCloud when the browser isn't", async ({ context, siteUrl }) => {
  await fakeICloud(context, { signedIn: false });
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  const menu = await emailMenu(page);
  await choose(menu, "Use Hide My Email");
  await expect(menu.getByText("Sign In to iCloud for Hide My Email")).toBeVisible();
});

test("the iCloud header rule exists only while Hide My Email is on", async ({ context, siteUrl, popupUrl }) => {
  await fakeICloud(context);
  const [worker] = context.serviceWorkers();
  const rules = () =>
    (worker ?? context.serviceWorkers()[0])?.evaluate(async () => {
      type DNR = { declarativeNetRequest: { getSessionRules(): Promise<{ condition: unknown }[]> } };
      return (globalThis as unknown as { chrome: DNR }).chrome.declarativeNetRequest.getSessionRules();
    });
  expect(await rules()).toEqual([]);

  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  await choose(await emailMenu(page), "Use Hide My Email");
  await expect.poll(rules).toEqual([
    expect.objectContaining({
      condition: {
        requestDomains: ["icloud.com"],
        initiatorDomains: [EXTENSION_ID],
        tabIds: [-1],
        resourceTypes: ["xmlhttprequest"],
      },
    }),
  ]);

  // turned off (as the popup's toggle does): the rule goes
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await popup.evaluate(() => {
    type Runtime = { runtime: { sendMessage(message: unknown): Promise<unknown> } };
    const { chrome } = globalThis as unknown as { chrome: Runtime };
    return chrome.runtime.sendMessage({ type: "set-settings", settings: { hideMyEmail: false } });
  });
  await expect.poll(rules).toEqual([]);
});

test("shows that it's loading while iCloud answers", async ({ context, siteUrl, popupUrl }) => {
  await fakeICloud(context, { existing: "slow@icloud.com", delayMs: 1_000 });
  // already on (as the popup's toggle does), so nothing is cached yet
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await popup.evaluate(() => {
    type Runtime = { runtime: { sendMessage(message: unknown): Promise<unknown> } };
    const { chrome } = globalThis as unknown as { chrome: Runtime };
    return chrome.runtime.sendMessage({ type: "set-settings", settings: { hideMyEmail: true } });
  });
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  await page.locator("#email").click();
  await expect.poll(() => page.frames().some((f) => f.url().includes("/menu.html#"))).toBe(true);
  const menu = page.frames().find((f) => f.url().includes("/menu.html#")) as Frame;
  await expect(menu.getByText("Loading…")).toBeVisible();
  await expect(menu.getByText("slow@icloud.com")).toBeVisible();
  await expect(menu.getByText("Loading…")).toHaveCount(0);
});

test.describe("with the companion app", () => {
  test.use({ companion: "ok" });

  test("suggests the emails on the contact card, below Hide My Email", async ({ context, siteUrl }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signup.html`);
    const menu = await emailMenu(page);
    await expect(menu.getByText("Use Hide My Email")).toBeVisible();
    await expect(menu.getByText("jane.work@example.com")).toBeVisible();
    await expect(menu.getByText("Suggest Your Email Addresses")).toHaveCount(0);
    await choose(menu, "jane@example.com");
    await expect(page.locator("#email")).toHaveValue("jane@example.com");
  });

  test("fills one into a newsletter's email field", async ({ context, siteUrl }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/login.html`);
    await page.locator("#newsletter-email").click();
    const menu = await menuFrame(page);
    await choose(menu, "jane@example.com");
    await expect(page.locator("#newsletter-email")).toHaveValue("jane@example.com");
    await expect(page.locator("#user")).toHaveValue("");
  });

  test("typing an address narrows them down; the hints step aside", async ({ context, siteUrl }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signup.html`);
    const menu = await emailMenu(page);
    await expect(menu.getByText("Use Hide My Email")).toBeVisible();
    await page.locator("#email").pressSequentially("JANE.");
    await expect(menu.getByText("jane.work@example.com")).toBeVisible();
    await expect(menu.getByText("jane@example.com")).toHaveCount(0);
    await expect(menu.getByText("Use Hide My Email")).toHaveCount(0);

    // nothing starts with it: out of the way; emptied, everything comes back
    await page.locator("#email").press("x");
    await expect(page.locator("app-autofill-menu")).toBeHidden();
    await page.locator("#email").press("Backspace");
    await expect(menu.getByText("jane.work@example.com")).toBeVisible();
    await page.locator("#email").selectText();
    await page.locator("#email").press("Backspace");
    await expect(menu.getByText("Use Hide My Email")).toBeVisible();

    // typed in full: nothing left to suggest; ↓ brings everything back
    await page.locator("#email").pressSequentially("jane@example.com");
    await expect(page.locator("app-autofill-menu")).toBeHidden();
    await page.locator("#email").press("ArrowDown");
    await expect(menu.getByText("Use Hide My Email")).toBeVisible();
    await expect(menu.getByText("jane@example.com")).toBeVisible();
  });

  test("while typing, Hide My Email comes after the addresses left, never on its own", async ({ context, siteUrl }) => {
    await fakeICloud(context, { existing: "kept@icloud.com" });
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signup.html`);
    const menu = await emailMenu(page);
    await choose(menu, "Use Hide My Email");
    await expect(menu.getByText("kept@icloud.com")).toBeVisible();
    await page.locator("#email").click();
    await page.locator("#email").pressSequentially("jane.");
    // the match first, where ↓ lands
    await expect(menu.getByRole("option")).toHaveText([/jane\.work@example\.com/, /kept@icloud\.com/]);

    // no address of one's own left: the menu goes rather than offer Hide My Email alone
    await page.locator("#email").press("x");
    await expect(page.locator("app-autofill-menu")).toBeHidden();

    // the Hide My Email address is an address too
    await page.locator("#email").selectText();
    await page.locator("#email").pressSequentially("kep");
    await expect(menu.getByText("kept@icloud.com")).toBeVisible();
    await expect(menu.getByText("jane@example.com")).toHaveCount(0);
  });
});

test.describe("when the companion may not read Contacts", () => {
  test.use({ companion: "ok", companionEmails: "needs-contacts" });

  test("says how to allow it", async ({ context, siteUrl }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/signup.html`);
    const menu = await emailMenu(page);
    await expect(menu.getByText("allow Contacts in the companion app")).toBeVisible();
  });
});

test("without iCloud+, says so once and stops offering Hide My Email", async ({ context, siteUrl }) => {
  await fakeICloud(context, { icloudPlus: false });
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  const menu = await emailMenu(page);
  await choose(menu, "Use Hide My Email");
  await expect(menu.getByText("Hide My Email needs iCloud+")).toBeVisible();

  // turned off: the email field only offers the companion app now (click away to close the menu)
  await page.mouse.click(5, 5);
  const again = await emailMenu(page);
  await expect(again.getByText("Suggest Your Email Addresses")).toBeVisible();
  await expect(again.getByText(/Hide My Email/)).toHaveCount(0);
});

test("the email field's companion hint opens the extension's page about the app", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signup.html`);
  const menu = await emailMenu(page);
  const opened = context.waitForEvent("page");
  await choose(menu, "Suggest Your Email Addresses");
  const about = await opened;
  await expect(about).toHaveURL(/\/companion\.html$/);
});

test.describe("on a page that signs in or up by email", () => {
  test.use({
    companion: "ok",
    // Playwright reads a bare array here as [value, options], so the list goes in a pair of its own
    vaultEntries: [[{ hostname: "localhost", username: "jane@example.com", password: "none" }], { scope: "test" }],
  });

  test("lists the site's saved login first, then the suggestions", async ({ context, siteUrl }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/continue.html`);
    const menu = await emailMenu(page);
    // locked: unlocking comes first, the suggestions that don't need it below
    await expect(menu.locator(".row").first()).toContainText("Unlock to fill passwords");
    await expect(menu.getByText("Use Hide My Email")).toBeVisible();
    // with the app, Touch ID types the code
    await choose(menu, "Unlock to fill passwords");
    await expect(menu.locator(".row").first()).toContainText("jane@example.com");
    await expect(menu.locator(".row").first()).toContainText("localhost");
    // the contact card's other address is still offered; the saved one isn't listed twice
    await expect(menu.getByText("jane@example.com")).toHaveCount(1);
    await expect(menu.getByText("jane.work@example.com")).toBeVisible();
    await expect(menu.getByText("Use Hide My Email")).toBeVisible();

    await choose(menu, "jane@example.com");
    await expect(page.locator("#email")).toHaveValue("jane@example.com");
  });
});
