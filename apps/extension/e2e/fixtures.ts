import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, test as base, chromium, expect, type Frame, type Page } from "@playwright/test";
import type { VaultEntry } from "../../../packages/fake-helper/src/fake-helper.ts";
import { BRIDGE_HOST, COMPANION_HOST, EXTENSION_ID } from "../src/config.ts";

// lets tests intercept the extension background's own requests (a fake iCloud for Hide My Email)
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

export const PAIRING_CODE = "246810";
const extensionPath = resolve(import.meta.dirname, "../.output/chrome-mv3");
const fakeHelper = resolve(import.meta.dirname, "../../../packages/fake-helper/src/main.ts");
const fakeCompanion = resolve(import.meta.dirname, "../../../packages/fake-helper/src/companion-main.ts");

/** How the fake Touch ID companion behaves; "none" leaves it uninstalled. */
export type CompanionMode = "none" | "ok" | "cancelled" | "needs-accessibility";

function writeHost(dir: string, name: string, script: string) {
  const path = join(dir, `${name}.sh`);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  writeFileSync(
    join(dir, "profile", "NativeMessagingHosts", `${name}.json`),
    JSON.stringify({
      name,
      description: "test double for e2e tests",
      path,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    }),
  );
}

// browsers start native hosts with a minimal PATH, so call bun by absolute path
const bun = () => execSync("command -v bun", { encoding: "utf8" }).trim();

/** What the setup script does, for the fake helper: registers it in the profile at `dir`. */
export function registerFakeHelper(dir: string, declineSaves = false): void {
  const vault = join(dir, "vault.json");
  const log = join(dir, "helper.log");
  writeHost(
    dir,
    BRIDGE_HOST,
    `#!/bin/sh\nexport FAKE_HELPER_CODE=${PAIRING_CODE} FAKE_HELPER_VAULT="${vault}" FAKE_HELPER_LOG="${log}"${declineSaves ? " FAKE_HELPER_SAVE=decline" : ""}\nexec "${bun()}" "${fakeHelper}"\n`,
  );
}

/**
 * Registers the fake helper (and optionally the fake companion) inside a fresh profile. Without
 * `setUp`, the profile is like a browser before the setup script ran.
 */
export function profileWithFakeHelper(
  companion: CompanionMode,
  declineSaves: boolean,
  companionEmails: string,
  vaultEntries: VaultEntry[] = [{ hostname: "localhost", username: "e2e-user", password: "e2e-pass" }],
  setUp = true,
): string {
  const dir = mkdtempSync(join(tmpdir(), "app-e2e-"));
  writeFileSync(join(dir, "vault.json"), JSON.stringify(vaultEntries));
  mkdirSync(join(dir, "profile", "NativeMessagingHosts"), { recursive: true });
  if (setUp) registerFakeHelper(dir, declineSaves);
  if (companion !== "none") {
    writeHost(
      dir,
      COMPANION_HOST,
      `#!/bin/sh\nexport FAKE_COMPANION_CODE=${PAIRING_CODE} FAKE_COMPANION_RESULT=${companion} FAKE_COMPANION_EMAILS="${companionEmails}"\nexec "${bun()}" "${fakeCompanion}"\n`,
    );
  }
  return dir;
}

/** The inline menu's frame. It sits in a closed shadow root, so find it among the page's frames. */
export async function menuFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 50; i++) {
    const frame = page.frames().find((f) => f.url().includes("/menu.html#") && !f.isDetached());
    // a menu can be replaced right after it appears (the field asked again); then look again
    const rendered = await frame?.waitForSelector("#menu > *", { timeout: 2_000 }).catch(() => undefined);
    if (frame && rendered && !frame.isDetached()) {
      // The menu ignores clicks during its first 300 ms on screen (clickjacking guard); a person
      // never clicks that fast, so neither does the test. The clock starts once it has rendered.
      await page.waitForTimeout(500);
      return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error("the inline menu did not open");
}

const profileDirs = new WeakMap<BrowserContext, string>();

type Fixtures = {
  companion: CompanionMode;
  /** The user answers every "Save password?" prompt with Not Now. */
  declineSaves: boolean;
  /** The emails on the "Me" card the fake companion reports (comma-separated), or "needs-contacts". */
  companionEmails: string;
  /** Extra command-line switches for the browser. */
  browserArgs: string[];
  /** Whether the setup script has run for this browser; see `runSetup`. */
  setUp: boolean;
  /** The logins saved in the fake helper (one for localhost by default). */
  vaultEntries: VaultEntry[] | undefined;
  /** Runs the setup (registers the fake helper) while the browser is open. */
  runSetup: () => void;
  context: BrowserContext;
  popupUrl: string;
  /** Search URLs of the requests to open the Passwords app that reached the fake helper. */
  passwordsAppLaunches: () => string[];
  /** How many codes the fake helper has shown on the "Mac". */
  codesShown: () => number;
  /** How many passwords the fake helper was asked for (each one may cost a Touch ID). */
  passwordReads: () => number;
  /** Logins the fake helper saved (after the simulated "Save password?" prompt). */
  helperSaves: () => { hostname: string; username: string; password: string }[];
};

/**
 * Clicks an item in the menu like a person would. The menu ignores clicks until it has been
 * visibly on screen for 300 ms (clickjacking guard), and that clock restarts when the menu
 * re-renders, e.g. after unlocking.
 */
export async function choose(menu: Frame, text: string): Promise<void> {
  const item = menu.getByText(text);
  await expect(item).toBeVisible();
  await menu.page().waitForTimeout(500);
  await item.click();
}

/** Entries of one type from the fake helper's log. */
function helperLog(context: BrowserContext, type: string): Record<string, unknown>[] {
  let text = "";
  try {
    text = readFileSync(join(profileDirs.get(context) ?? "", "helper.log"), "utf8");
  } catch {
    // nothing logged yet
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.type === type);
}

export const test = base.extend<Fixtures, { siteUrl: string }>({
  // a tiny static server for the test pages, on http://localhost (which the extension allows)
  siteUrl: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
    async ({}, use) => {
      const pages = resolve(import.meta.dirname, "pages");
      const server = createServer((req, res) => {
        const name = (req.url ?? "/").split("?")[0]?.replace(/[^a-z0-9.-]/gi, "") || "login.html";
        let body: Buffer;
        try {
          body = readFileSync(join(pages, name));
        } catch {
          res.writeHead(404).end();
          return;
        }
        const type = name.endsWith(".js") ? "text/javascript" : "text/html";
        res.writeHead(200, { "content-type": type }).end(body);
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      await use(`http://localhost:${(server.address() as AddressInfo).port}`);
      server.close();
    },
    { scope: "worker" },
  ],
  companion: ["none", { option: true }],
  declineSaves: [false, { option: true }],
  companionEmails: ["jane@example.com,jane.work@example.com", { option: true }],
  browserArgs: [[], { option: true }],
  setUp: [true, { option: true }],
  vaultEntries: [undefined, { option: true }],
  context: async ({ companion, declineSaves, companionEmails, browserArgs, setUp, vaultEntries }, use) => {
    const dir = profileWithFakeHelper(companion, declineSaves, companionEmails, vaultEntries, setUp);
    const context = await chromium.launchPersistentContext(join(dir, "profile"), {
      channel: "chromium",
      ...(process.env.BETTER_PASSWORDS_CHROMIUM_PATH
        ? { executablePath: process.env.BETTER_PASSWORDS_CHROMIUM_PATH }
        : {}),
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, ...browserArgs],
    });
    profileDirs.set(context, dir);
    await use(context);
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  },
  runSetup: async ({ context, declineSaves }, use) => {
    await use(() => registerFakeHelper(profileDirs.get(context) ?? "", declineSaves));
  },
  passwordsAppLaunches: async ({ context }, use) => {
    await use(() => helperLog(context, "launch").map((entry) => entry.url as string));
  },
  codesShown: async ({ context }, use) => {
    await use(() => helperLog(context, "code").length);
  },
  passwordReads: async ({ context }, use) => {
    await use(() => helperLog(context, "password-read").length);
  },
  helperSaves: async ({ context }, use) => {
    await use(() =>
      helperLog(context, "save").map(({ hostname, username, password }) => ({
        hostname: hostname as string,
        username: username as string,
        password: password as string,
      })),
    );
  },
  popupUrl: async ({ context }, use) => {
    if (context.serviceWorkers().length === 0) await context.waitForEvent("serviceworker");
    await use(`chrome-extension://${EXTENSION_ID}/popup.html`);
  },
});

export { expect } from "@playwright/test";
