import type { Page } from "@playwright/test";
import { EXTENSION_ID } from "../src/config.ts";
import { choose, expect, menuFrame, PAIRING_CODE, test } from "./fixtures.ts";

test("unlocks from the inline menu and fills the form", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();

  // locked: the menu offers to unlock, and the code is typed inside the extension's own frame
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  // the code box and "Show code again" fit: nothing to scroll
  await expect(menu.getByText("Show code again")).toBeVisible();
  await page.waitForTimeout(300);
  expect(
    await menu.evaluate(() => {
      const panel = document.getElementById("menu") as HTMLElement;
      return panel.scrollHeight - panel.clientHeight;
    }),
  ).toBeLessThanOrEqual(0);
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);

  await choose(menu, "e2e-user");
  await expect(page.locator("#user")).toHaveValue("e2e-user");
  await expect(page.locator("#pass")).toHaveValue("e2e-pass");
  await expect(page.locator("#newsletter-email")).toHaveValue("");
  // filled and done: no field is left focused
  await expect(page.locator("#pass")).not.toBeFocused();
  await expect(page.locator("#user")).not.toBeFocused();
});

test("moving to the next field opens a fresh menu that still fills", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#user").click();
  let menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();

  // Tab to the password field: the old frame is replaced, so the menu gets its full height back
  // and a new nonce that the content script accepts
  const first = menu;
  await page.locator("#user").focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => page.frames().some((f) => f.url().includes("/menu.html#") && f !== first)).toBe(true);
  menu = await menuFrame(page);
  await expect(menu.getByText("Open Passwords App")).toBeVisible();
  const height = await page.locator("app-autofill-menu").evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(70);

  await choose(menu, "e2e-user");
  await expect(page.locator("#pass")).toHaveValue("e2e-pass");
});

test("a site without saved logins says so on every focus, not only after unlocking", async ({ context, siteUrl }) => {
  // the vault has logins for localhost only; 127.0.0.1 is the same page with none
  const page = await context.newPage();
  await page.goto(`${siteUrl.replace("localhost", "127.0.0.1")}/login.html`);
  await page.locator("#pass").click();
  let menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("No saved passwords for 127.0.0.1.")).toBeVisible();

  await page.keyboard.press("Escape");
  await page.locator("#user").click();
  menu = await menuFrame(page);
  await expect(menu.getByText("No saved passwords for 127.0.0.1.")).toBeVisible();
});

test("clicking the field's label keeps its menu open", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();

  await page.locator("label", { hasText: "Password" }).click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(500);
  // the same menu, not one closed and opened again
  await expect(page.locator("#pass")).toBeFocused();
  expect(menu.isDetached()).toBe(false);
  expect(page.frames().filter((f) => f.url().includes("/menu.html#"))).toEqual([menu]);
  await expect(menu.getByText("e2e-user")).toBeVisible();
});

test("arrow keys move between the field and the menu", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();

  await page.locator("#pass").focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("option", { name: /e2e-user/ })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#pass")).toBeFocused();
  // the menu stays open, and ↓ goes back into it
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("option", { name: /e2e-user/ })).toBeFocused();
});

test("opens the Passwords app for the current site", async ({ context, siteUrl, passwordsAppLaunches }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);

  await choose(menu, "Open Passwords App");
  await expect.poll(passwordsAppLaunches).toEqual([siteUrl]);
  await expect.poll(() => page.locator("app-autofill-menu").count()).toBe(0);
});

test("Escape closes the menu and keeps it closed until the user asks again", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();

  await page.locator("#pass").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.locator("#pass")).toBeFocused();
  await page.waitForTimeout(300);
  expect(await page.locator("app-autofill-menu").count()).toBe(0);

  // ↓ in the field brings it back
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.locator("app-autofill-menu").count()).toBe(1);
});

test("offers no logins in fields that aren't for logging in", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  // a newsletter's email field gets email suggestions instead (see hide-my-email.spec.ts)
  await page.locator("#newsletter-email").click();
  const menu = await menuFrame(page);
  await expect(menu.getByText("Use Hide My Email")).toBeVisible();
  await expect(menu.getByText("Unlock to fill passwords")).toHaveCount(0);
});

test("refuses to fill when the page makes the menu transparent", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();

  // a clickjacking page fades everything out, hoping the user clicks blindly
  await page.evaluate(() => {
    document.documentElement.style.opacity = "0.1";
  });
  await menu.getByText("e2e-user").click({ force: true });
  await page.waitForTimeout(500);
  await expect(page.locator("#pass")).toHaveValue("");
});

test("refuses to fill when the page reveals a hidden menu only as the click lands", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();

  // the page keeps the menu invisible, then shows it again the moment focus moves into it
  await page.evaluate(() => {
    document.documentElement.style.opacity = "0";
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    document.documentElement.style.opacity = "1";
  });
  // Where the menu page can't track its own visibility (Firefox), the click itself would count,
  // so send the request it would send. The content script saw the menu hidden moments ago, so it
  // refuses, and closes the menu.
  await menu.evaluate(() => {
    type Runtime = { runtime: { sendMessage(message: unknown): Promise<unknown> } };
    const { chrome } = globalThis as unknown as { chrome: Runtime };
    const nonce = new URLSearchParams(location.hash.slice(1)).get("nonce");
    void chrome.runtime.sendMessage({ type: "fill-from-menu", nonce, username: "e2e-user", menuNonce: nonce });
  });
  await expect.poll(() => page.locator("app-autofill-menu").count()).toBe(0);
  await expect(page.locator("#pass")).toHaveValue("");
});

test("a page can't frame the menu at its well-known address", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  // Chromium serves menu.html only at a per-session address, which pages never learn
  await page.evaluate((url) => {
    const frame = document.createElement("iframe");
    frame.src = `${url}#nonce=forged&mode=logins`;
    frame.id = "forged";
    document.body.append(frame);
  }, `chrome-extension://${EXTENSION_ID}/menu.html`);
  await page.waitForTimeout(1_000);
  await expect(page.frameLocator("#forged").locator("#menu")).toHaveCount(0);
});

test("refuses everything a copy of the menu without our nonce asks", async ({ context, siteUrl, popupUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  // unlock through the real menu first, so a fill would otherwise succeed
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();

  // a copy of menu.html with a made-up nonce, as a page that found its address could frame it
  // (Firefox has no per-session address): it lists nothing
  const forged = await context.newPage();
  await forged.goto(`chrome-extension://${EXTENSION_ID}/menu.html#nonce=forged&mode=logins`);
  await expect(forged.getByText("wasn't opened by Better Passwords")).toBeVisible();
  await expect(forged.getByText("e2e-user")).toHaveCount(0);

  // Nor does anything it asks get through, as an accepted click would ask it: no password is
  // fetched, and no setting changes (turning on Hide My Email would reserve addresses later).
  const replies = await forged.evaluate(async () => {
    type Runtime = { runtime: { sendMessage(message: unknown): Promise<unknown> } };
    const { chrome } = globalThis as unknown as { chrome: Runtime };
    const ask = (message: object) => chrome.runtime.sendMessage({ ...message, menuNonce: "forged" });
    return [
      await ask({ type: "fill-from-menu", nonce: "forged", username: "e2e-user" }),
      await ask({ type: "enable-hide-my-email", nonce: "forged" }),
      await ask({ type: "list-logins" }),
    ];
  });
  for (const reply of replies) {
    expect(reply).toEqual({ ok: false, error: "This menu wasn't opened by Better Passwords." });
  }
  await expect(page.locator("#pass")).toHaveValue("");

  const popup = await context.newPage();
  await popup.goto(popupUrl);
  const settings = await popup.evaluate(() => {
    type Runtime = { runtime: { sendMessage(message: unknown): Promise<{ value: { hideMyEmail: boolean } }> } };
    const { chrome } = globalThis as unknown as { chrome: Runtime };
    return chrome.runtime.sendMessage({ type: "get-settings" });
  });
  expect(settings.value.hideMyEmail).toBe(false);
});

test("a long list of logins scrolls inside the menu", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();
  // make the list longer than the menu's cap, as on a site with many saved logins
  await menu.evaluate(() => {
    const panel = document.getElementById("menu") as HTMLElement;
    const row = panel.querySelector(".row") as HTMLElement;
    for (let i = 0; i < 15; i++) panel.prepend(row.cloneNode(true));
  });
  const scrolled = await menu.evaluate(async () => {
    const panel = document.getElementById("menu") as HTMLElement;
    panel.scrollTop = 200;
    return { scrollTop: panel.scrollTop, overflows: panel.scrollHeight > panel.clientHeight };
  });
  expect(scrolled.overflows).toBe(true);
  expect(scrolled.scrollTop).toBeGreaterThan(0);
});

test("offers to unlock on a login form's email field too", async ({ context, siteUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  // like many sites: an email field that isn't marked as the username, next to a password field
  await page.locator("#user").evaluate((el: HTMLInputElement) => {
    el.autocomplete = "email";
  });
  await page.locator("#user").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
});

test("an open menu follows an unlock and a lock done in the popup", async ({ context, siteUrl, popupUrl }) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await expect(menu.getByText("Unlock to fill passwords")).toBeVisible();

  // the code typed into the popup instead of the menu
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await popup.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();

  await popup.getByRole("button", { name: "Lock" }).click();
  await expect(menu.getByText("Unlock to fill passwords")).toBeVisible();
});

test("the menu's Unlock shows a fresh code after the popup asked for one", async ({
  context,
  siteUrl,
  popupUrl,
  codesShown,
}) => {
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await expect.poll(codesShown).toBe(1);
  await popup.close();

  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await expect.poll(codesShown).toBe(2);
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  await expect(menu.getByText("e2e-user")).toBeVisible();
});

test("without room under the field, opens above it, listed bottom-up and entered with ↑", async ({
  context,
  siteUrl,
}) => {
  const page = await context.newPage();
  await page.goto(`${siteUrl}/low.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await choose(menu, "Unlock to fill passwords");
  await menu.getByLabel("Verification code").fill(PAIRING_CODE);
  const login = menu.getByRole("option", { name: /e2e-user/ });
  const openApp = menu.getByRole("option", { name: /Open Passwords App/ });
  await expect(login).toBeVisible();
  const [field, host] = await Promise.all([
    page.locator("#pass").boundingBox(),
    page.locator("app-autofill-menu").boundingBox(),
  ]);
  expect(field && host && host.y + host.height <= field.y).toBe(true);
  // the login sits nearest the field, at the bottom
  const [loginBox, openAppBox] = await Promise.all([login.boundingBox(), openApp.boundingBox()]);
  expect(loginBox && openAppBox && loginBox.y > openAppBox.y).toBe(true);

  await page.locator("#pass").click();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#pass")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(login).toBeFocused();
  // ↓ heads back toward the field
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#pass")).toBeFocused();
});

test.describe("typing a username", () => {
  test.use({
    // Playwright reads a bare array here as [value, options], so the list goes in a pair of its own
    vaultEntries: [
      [
        { hostname: "localhost", username: "alice@example.com", password: "alice-pass" },
        { hostname: "localhost", username: "alex@example.com", password: "alex-pass" },
        { hostname: "localhost", username: "bob@example.com", password: "bob-pass" },
      ],
      { scope: "test" },
    ],
  });

  async function unlockedMenu(page: Page, siteUrl: string) {
    await page.goto(`${siteUrl}/login.html`);
    await page.locator("#user").click();
    const menu = await menuFrame(page);
    await choose(menu, "Unlock to fill passwords");
    await menu.getByLabel("Verification code").fill(PAIRING_CODE);
    await expect(menu.getByText("bob@example.com")).toBeVisible();
    await page.locator("#user").click();
    return menu;
  }

  test("narrows the menu to the logins it starts", async ({ context, siteUrl }) => {
    const page = await context.newPage();
    const menu = await unlockedMenu(page, siteUrl);
    await page.locator("#user").pressSequentially("AL");
    await expect(menu.getByText("alice@example.com")).toBeVisible();
    await expect(menu.getByText("alex@example.com")).toBeVisible();
    await expect(menu.getByText("bob@example.com")).toHaveCount(0);

    // nothing starts with "alx": the menu gets out of the way, and comes back on Backspace
    await page.locator("#user").press("x");
    await expect(page.locator("app-autofill-menu")).toBeHidden();
    await page.locator("#user").press("Backspace");
    await expect(page.locator("app-autofill-menu")).toBeVisible();
    await choose(menu, "alex@example.com");
    await expect(page.locator("#user")).toHaveValue("alex@example.com");
    await expect(page.locator("#pass")).toHaveValue("alex-pass");
  });

  test("↓ brings every login back when nothing matches", async ({ context, siteUrl }) => {
    const page = await context.newPage();
    const menu = await unlockedMenu(page, siteUrl);
    await page.locator("#user").pressSequentially("new-user");
    await expect(page.locator("app-autofill-menu")).toBeHidden();
    await page.locator("#user").press("ArrowDown");
    await expect(page.locator("app-autofill-menu")).toBeVisible();
    await expect(menu.getByText("alice@example.com")).toBeVisible();
    await expect(menu.getByText("bob@example.com")).toBeVisible();
    await expect(menu.getByRole("option", { name: /alice@example.com/ })).toBeFocused();
  });

  test("ignores text the page puts in the field", async ({ context, siteUrl }) => {
    const page = await context.newPage();
    const menu = await unlockedMenu(page, siteUrl);
    await page.locator("#user").evaluate((field: HTMLInputElement) => {
      field.value = "zzz";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(300);
    await expect(page.locator("app-autofill-menu")).toBeVisible();
    await expect(menu.getByText("alice@example.com")).toBeVisible();
    await expect(menu.getByText("bob@example.com")).toBeVisible();
  });

  test("typing a password of one's own hides the logins until asked for again", async ({ context, siteUrl }) => {
    const page = await context.newPage();
    const first = await unlockedMenu(page, siteUrl);
    // Tab, not a click: the email field's menu covers the password field
    await page.keyboard.press("Tab");
    await expect.poll(() => page.frames().some((f) => f.url().includes("/menu.html#") && f !== first)).toBe(true);
    const menu = await menuFrame(page);
    await expect(menu.getByText("alice@example.com")).toBeVisible();

    await page.locator("#pass").pressSequentially("hunter2");
    await expect(page.locator("app-autofill-menu")).toBeHidden();
    // emptied: back by itself
    await page.locator("#pass").press("ControlOrMeta+a");
    await page.locator("#pass").press("Backspace");
    await expect(page.locator("app-autofill-menu")).toBeVisible();

    // a click brings it back over the typed password, and the next key hides it again
    await page.locator("#pass").pressSequentially("hunter2");
    await expect(page.locator("app-autofill-menu")).toBeHidden();
    await page.locator("#pass").click();
    await expect(page.locator("app-autofill-menu")).toBeVisible();
    await expect(menu.getByText("bob@example.com")).toBeVisible();
    await page.locator("#pass").press("x");
    await expect(page.locator("app-autofill-menu")).toBeHidden();
    await page.locator("#pass").press("ArrowDown");
    await expect(page.locator("app-autofill-menu")).toBeVisible();
    await expect(menu.getByRole("option", { name: /alice@example.com/ })).toBeFocused();
  });
});

test.describe("a sign-in in two steps", () => {
  test.use({
    vaultEntries: [
      [
        { hostname: "localhost", username: "alice@example.com", password: "alice-pass" },
        { hostname: "localhost", username: "bob@example.com", password: "bob-pass" },
      ],
      { scope: "test" },
    ],
  });

  test("fills the email without reading the password, then offers just that login for the password", async ({
    context,
    siteUrl,
    passwordReads,
  }) => {
    const page = await context.newPage();
    await page.goto(`${siteUrl}/two-step.html`);
    await page.locator("#email").click();
    let menu = await menuFrame(page);
    await choose(menu, "Unlock to fill passwords");
    await menu.getByLabel("Verification code").fill(PAIRING_CODE);
    await choose(menu, "bob@example.com");
    await expect(page.locator("#email")).toHaveValue("bob@example.com");
    // no password field yet: no password read, so no Touch ID
    expect(passwordReads()).toBe(0);

    // back in the email field, every account is offered (the user may want another one)
    await page.locator("#email").click();
    menu = await menuFrame(page);
    await expect(menu.getByText("alice@example.com")).toBeVisible();
    await expect(menu.getByText("bob@example.com")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.locator("#next").click();
    await page.locator("#password").click();
    menu = await menuFrame(page);
    await expect(menu.getByText("bob@example.com")).toBeVisible();
    await expect(menu.getByText("alice@example.com")).toHaveCount(0);
    // the others are a click away
    await choose(menu, "1 other account");
    await expect(menu.getByText("alice@example.com")).toBeVisible();
    await choose(menu, "bob@example.com");
    await expect(page.locator("#password")).toHaveValue("bob-pass");
    expect(passwordReads()).toBe(1);
  });
});
