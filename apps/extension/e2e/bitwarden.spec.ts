import type { BrowserContext, Page } from "@playwright/test";
import { FakeBitwarden } from "../../../packages/fake-bitwarden/src/index.ts";
import { totp } from "../../../packages/otp/src/totp.ts";
import { EXTENSION_ID } from "../src/config.ts";
import { choose, expect, menuFrame, PAIRING_CODE, test } from "./fixtures.ts";

// Bitwarden as a second password manager, against a fake of its servers (packages/fake-bitwarden):
// the extension's requests to bitwarden.com are answered by it. Apple Passwords isn't set up here.

const SECRET = "JBSWY3DPEHPK3PXP";
const setupUrl = `chrome-extension://${EXTENSION_ID}/setup.html`;

test.use({ setUp: false });

/** Answers the extension's requests to Bitwarden's servers with `server`. */
async function routeBitwarden(context: BrowserContext, server: FakeBitwarden) {
  await context.route(/^https:\/\/(identity|api)\.bitwarden\.com\//, async (route) => {
    const request = route.request();
    const body = request.method() === "GET" ? null : request.postDataBuffer();
    const answer = await server.handle(
      new Request(request.url(), {
        method: request.method(),
        headers: request.headers(),
        ...(body ? { body: new Uint8Array(body) } : {}),
      }),
    );
    await route.fulfill({
      status: answer.status,
      headers: Object.fromEntries(answer.headers),
      body: Buffer.from(await answer.arrayBuffer()),
    });
  });
}

async function fakeBitwarden(context: BrowserContext, siteUrl: string, twoFactor = false) {
  const server = await FakeBitwarden.create({
    ...(twoFactor ? { twoFactorSecret: SECRET } : {}),
    logins: [{ name: "Test site", username: "bw-alice", password: "bw-pass", uris: [siteUrl] }],
  });
  await routeBitwarden(context, server);
  return server;
}

/** Sends a request as the popup does. */
async function extensionPage(context: BrowserContext, popupUrl: string) {
  const page = await context.newPage();
  await page.goto(popupUrl);
  const send = (message: unknown): Promise<unknown> =>
    page.evaluate(async (m) => {
      type Runtime = { runtime: { sendMessage(message: unknown): Promise<unknown> } };
      const { chrome } = globalThis as unknown as { chrome: Runtime };
      const reply = (await chrome.runtime.sendMessage(m)) as { ok: boolean; value?: unknown; error?: string };
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    }, message);
  return { page, send };
}

async function signedIn(context: BrowserContext, siteUrl: string, popupUrl: string) {
  const server = await fakeBitwarden(context, siteUrl);
  const { page, send } = await extensionPage(context, popupUrl);
  const step = await send({ type: "bitwarden-sign-in", region: "us", email: server.email, password: server.password });
  expect(step).toMatchObject({ status: "signed-in" });
  return { server, popup: page, send, account: (step as { account: string }).account };
}

async function fillFromMenu(page: Page, username: string) {
  await page.locator("#pass").click();
  await choose(await menuFrame(page), username);
}

test("signs in on the setup page, with a two-step code, and fills from the inline menu", async ({
  context,
  siteUrl,
}) => {
  const server = await fakeBitwarden(context, siteUrl, true);
  const setup = await context.newPage();
  await setup.goto(setupUrl);
  await setup.getByRole("button", { name: /^Bitwarden/ }).click();
  await setup.getByLabel("Email").fill(server.email);
  await setup.getByLabel("Master password").fill(server.password);
  await setup.getByRole("button", { name: "Sign In" }).click();
  await expect(setup.getByRole("heading", { name: "Enter Your Verification Code" })).toBeVisible();
  await setup.getByRole("textbox", { name: "Verification code" }).fill(await totp(SECRET, Date.now()));
  await expect(setup.getByRole("heading", { name: "Password Managers" })).toBeVisible();
  await expect(setup.getByText("Bitwarden is ready.")).toBeVisible();
  await expect(setup.getByText(server.email)).toBeVisible();

  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await fillFromMenu(page, "bw-alice");
  await expect(page.locator("#user")).toHaveValue("bw-alice");
  await expect(page.locator("#pass")).toHaveValue("bw-pass");
});

test("goes back to choosing a password manager the same way from each", async ({ context }) => {
  const setup = await context.newPage();
  await setup.goto(setupUrl);
  const picker = setup.getByText("Which password manager do you use?");
  for (const name of [/^Apple Passwords/, /^Bitwarden/]) {
    await setup.getByRole("button", { name }).click();
    await expect(picker).toHaveCount(0);
    await setup.getByRole("button", { name: "Back", exact: true }).click();
    await expect(picker).toBeVisible();
  }
});

test("goes back from a code to the sign-in form, as filled in", async ({ context, siteUrl }) => {
  const server = await fakeBitwarden(context, siteUrl, true);
  const setup = await context.newPage();
  await setup.goto(setupUrl);
  await setup.getByRole("button", { name: /^Bitwarden/ }).click();
  await setup.getByLabel("Email").fill(server.email);
  await setup.getByLabel("Master password").fill(server.password);
  await setup.getByRole("button", { name: "Sign In" }).click();
  await expect(setup.getByRole("textbox", { name: "Verification code" })).toBeVisible();
  await setup.getByRole("button", { name: "Back", exact: true }).click();
  await expect(setup.getByLabel("Email")).toHaveValue(server.email);
  await setup.getByRole("button", { name: "Back", exact: true }).click();
  await expect(setup.getByText("Which password manager do you use?")).toBeVisible();
});

test("asks which password manager in the popup, before anything is set up", async ({ context, popupUrl }) => {
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await expect(popup.getByText("Which password manager do you use?")).toBeVisible();
  await popup.getByRole("button", { name: /^Apple Passwords/ }).click();
  await expect(popup.getByRole("heading", { name: "Set Up Apple Passwords" })).toBeVisible();
  await popup.getByRole("button", { name: "Back", exact: true }).click();
  await expect(popup.getByText("Which password manager do you use?")).toBeVisible();
});

test("refuses a wrong master password, and self-hosted servers", async ({ context, siteUrl }) => {
  const server = await fakeBitwarden(context, siteUrl);
  const setup = await context.newPage();
  await setup.goto(`${setupUrl}#bitwarden`);
  await setup.getByLabel("Email").fill(server.email);
  await setup.getByLabel("Master password").fill("not it");
  await setup.getByRole("button", { name: "Sign In" }).click();
  await expect(setup.getByText("Wrong email or master password.")).toBeVisible();
  await setup.getByLabel("Server").selectOption("self-hosted");
  await expect(setup.getByText("Self-hosted servers aren't supported yet.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Sign In" })).toBeDisabled();
});

test("asks on the page before saving a new login to Bitwarden", async ({ context, siteUrl, popupUrl }) => {
  const { server } = await signedIn(context, siteUrl, popupUrl);
  const page = await context.newPage();
  await page.goto(`${siteUrl}/signin.html`);
  await page.locator("#user").fill("bw-new@example.com");
  await page.locator("#pass").fill("typed-pass");
  await page.locator("#pass").press("Escape");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Welcome!")).toBeVisible();

  const card = await expect
    .poll(() => page.frames().find((f) => f.url().includes("/save.html")) ?? null)
    .not.toBeNull()
    .then(() => page.frames().find((f) => f.url().includes("/save.html")));
  if (!card) throw new Error("no card");
  await expect(card.getByText("Save Login to Bitwarden?")).toBeVisible();
  await expect(card.getByText("bw-new@example.com · localhost")).toBeVisible();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Saved")).toBeVisible();
  await expect.poll(() => server.ciphers.length).toBe(2);
});

test("unlocks from the inline menu in the popup, never in the menu", async ({ context, siteUrl, popupUrl }) => {
  const { server, send, account } = await signedIn(context, siteUrl, popupUrl);
  await send({ type: "lock", account });
  const page = await context.newPage();
  await page.goto(`${siteUrl}/login.html`);
  await page.locator("#pass").click();
  const menu = await menuFrame(page);
  await expect(menu.getByText(`Bitwarden · ${server.email}`)).toBeVisible();
  await expect(menu.getByLabel("Master password")).toHaveCount(0);

  // Chromium opens the toolbar popup for it, which Playwright can't see: the popup opened just
  // after asks what it's for, as that one does, and goes to the account's master password
  await choose(menu, "Unlock to fill passwords");
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  await expect(popup.getByText("Unlock Bitwarden")).toBeVisible();
  await popup.getByLabel("Master password").fill("not it");
  await popup.getByRole("button", { name: "Unlock" }).click();
  await expect(popup.getByText("Wrong master password.")).toBeVisible();
  await popup.getByLabel("Master password").fill(server.password);
  await popup.getByRole("button", { name: "Unlock" }).click();
  await expect(popup.getByText("Open a website to see its saved passwords.")).toBeVisible();

  await page.bringToFront();
  await page.reload();
  await fillFromMenu(page, "bw-alice");
  await expect(page.locator("#pass")).toHaveValue("bw-pass");
});

test("lists the account, and removes it only once confirmed", async ({ context, siteUrl, popupUrl }) => {
  const { popup, server } = await signedIn(context, siteUrl, popupUrl);
  await popup.reload();
  await expect(popup.getByText(server.email)).toBeVisible();
  await expect(popup.getByRole("button", { name: /^Remove/ })).toHaveCount(0);

  await popup.goto(`${setupUrl}#accounts`);
  const remove = popup.getByRole("button", { name: `Remove Bitwarden ${server.email}` });
  // asked again, and backed out of: with Cancel, Escape, or a click elsewhere
  for (const backOut of [
    () => popup.getByRole("button", { name: "Cancel" }).click(),
    () => popup.keyboard.press("Escape"),
    () => popup.getByRole("heading", { name: "Password Managers" }).click(),
  ]) {
    await remove.click();
    await expect(popup.getByText("Passwords stay saved.")).toBeVisible();
    await backOut();
    await expect(remove).toBeVisible();
  }
  await remove.click();
  await popup.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(popup.getByText(server.email)).toHaveCount(0);
});

test("opens the web vault from the account in the popup", async ({ context, siteUrl, popupUrl }) => {
  const { popup } = await signedIn(context, siteUrl, popupUrl);
  await context.route("https://vault.bitwarden.com/**", (route) => route.fulfill({ body: "vault" }));
  await popup.reload();
  const opened = context.waitForEvent("page");
  await popup.getByRole("button", { name: "Open Bitwarden" }).click();
  // the popup's own tab is no website: the vault, with nothing searched for
  await expect.poll(async () => (await opened).url()).toBe("https://vault.bitwarden.com/#/vault");
});

test.describe("next to Apple Passwords", () => {
  test.use({ setUp: true });

  test("keeps both locked accounts in one card, and the one being unlocked open", async ({
    context,
    siteUrl,
    popupUrl,
  }) => {
    const { server, send, account } = await signedIn(context, siteUrl, popupUrl);
    await send({ type: "lock", account });
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    // two locked: a row each, neither asking for anything yet
    await expect(popup.getByRole("button", { name: /Unlock Apple Passwords/ })).toBeVisible();
    await popup.getByRole("button", { name: /Unlock Bitwarden/ }).click();
    await expect(popup.getByRole("textbox", { name: "Master password" })).toBeVisible();
    // the popup closes (the user went to look the password up): back where they were
    await popup.reload();
    await expect(popup.getByRole("textbox", { name: "Master password" })).toBeVisible();
    await popup.getByRole("textbox", { name: "Master password" }).fill(server.password);
    await popup.getByRole("button", { name: "Unlock", exact: true }).click();
    // Bitwarden's logins now, Apple's row where it was
    await expect(popup.getByRole("textbox", { name: "Master password" })).toHaveCount(0);
    await expect(popup.getByRole("button", { name: /Unlock Apple Passwords/ })).toBeVisible();
  });

  test("removes an account while it's locked", async ({ context }) => {
    const setup = await context.newPage();
    await setup.goto(`${setupUrl}#accounts`);
    await setup.getByRole("button", { name: "Remove Apple Passwords" }).click();
    await setup.getByRole("button", { name: "Remove", exact: true }).click();
    // nothing left: which password manager, again
    await expect(setup.getByText("Which password manager do you use?")).toBeVisible();
  });

  test("drops a locked account's logins from an open menu, and an open popup notices", async ({
    context,
    siteUrl,
    popupUrl,
  }) => {
    const { send } = await signedIn(context, siteUrl, popupUrl);
    const page = await context.newPage();
    await page.goto(`${siteUrl}/login.html`);
    await page.locator("#pass").click();
    const menu = await menuFrame(page);
    await choose(menu, "Unlock Apple Passwords");
    await menu.getByRole("textbox", { name: "Verification code" }).fill(PAIRING_CODE);
    await expect(menu.getByText("e2e-user")).toBeVisible();
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    await expect(popup.getByRole("button", { name: "Lock", exact: true })).toHaveCount(2);

    // locked from somewhere else, with one account still unlocked
    await send({ type: "lock", account: "apple" });
    await expect(menu.getByText("e2e-user")).toHaveCount(0);
    await expect(menu.getByText("bw-alice")).toBeVisible();
    await expect(popup.getByRole("button", { name: /Unlock Apple Passwords/ })).toBeVisible();
  });

  test("says which manager each login is from, and unlocks the other from the menu", async ({
    context,
    siteUrl,
    popupUrl,
  }) => {
    await signedIn(context, siteUrl, popupUrl);
    const page = await context.newPage();
    await page.goto(`${siteUrl}/login.html`);
    await page.locator("#pass").click();
    const menu = await menuFrame(page);
    // Apple is still locked: Bitwarden's login, and a way to unlock Apple's
    await expect(menu.getByText("bw-alice")).toBeVisible();
    await choose(menu, "Unlock Apple Passwords");
    await menu.getByRole("textbox", { name: "Verification code" }).fill(PAIRING_CODE);
    await expect(menu.getByText("e2e-user")).toBeVisible();
    await expect(menu.getByRole("option", { name: /Apple Passwords e2e-user/ })).toBeVisible();
    await expect(menu.getByRole("option", { name: /Bitwarden bw-alice/ })).toBeVisible();
    await expect(menu.getByText("Unlock Apple Passwords")).toHaveCount(0);
    // each manager opens at the site, named
    await expect(menu.getByRole("option", { name: "Open Apple Passwords" })).toBeVisible();
    await expect(menu.getByRole("option", { name: "Open Bitwarden" })).toBeVisible();
  });
});
