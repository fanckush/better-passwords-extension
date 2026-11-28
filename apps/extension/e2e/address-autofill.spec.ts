import { expect, test } from "./fixtures.ts";

// the companion unlocks the popup by itself, so its settings show
test.use({ companion: "ok" });

type Chrome = { runtime: { getManifest(): { optional_permissions?: string[] } } };

// ponytail: stops before the click; Playwright can't answer Chromium's permission prompt, so the
// Allow path (the popup's, or the background's after the prompt closes the popup) is tested by hand
test("the popup can ask for the permission to turn off the browser's addresses", async ({ context, popupUrl }) => {
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  const manifest = await popup.evaluate(() =>
    (globalThis as unknown as { chrome: Chrome }).chrome.runtime.getManifest(),
  );
  // permissions.request fails with "Only permissions specified in the manifest may be requested" otherwise
  expect(manifest.optional_permissions).toEqual(["privacy"]);
  await expect(popup.getByLabel("Turn off browser addresses")).not.toBeChecked();
});
