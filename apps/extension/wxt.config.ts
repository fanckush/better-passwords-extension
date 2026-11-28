import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import { DISPLAY_NAME, EXTENSION_PUBLIC_KEY, FILL_MATCHES, FIREFOX_EXTENSION_ID, STORE_TITLE } from "./src/config.ts";

const EXTENSION_CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; img-src 'self' data:; " +
  "connect-src 'self' https://*.icloud.com; frame-src 'self' betterpasswords:";

export default defineConfig({
  outDirTemplate: "{{browser}}-mv{{manifestVersion}}{{modeSuffix}}",
  hooks: {
    // The GitHub ZIP keeps the identity field so unpacked installs get the store's ID, which
    // native messaging allows. Chrome rejects that field in store uploads, so the store gets a
    // copy without it in .output/store, outside the release's asset glob.
    "zip:extension:done": async (wxt, zipPath) => {
      if (wxt.config.browser !== "chrome") return;
      const path = join(wxt.config.outDir, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      const { key: _, ...storeManifest } = manifest;
      const storeZip = join(dirname(zipPath), "store", basename(zipPath));
      await mkdir(dirname(storeZip), { recursive: true });
      await rm(storeZip, { force: true });
      await writeFile(path, JSON.stringify(storeManifest));
      try {
        execFileSync("zip", ["-qrX", storeZip, "."], { cwd: wxt.config.outDir });
      } finally {
        await writeFile(path, JSON.stringify({ ...manifest, key: EXTENSION_PUBLIC_KEY }));
      }
    },
  },
  zip: {
    artifactTemplate: "better-passwords-{{packageVersion}}-{{browser}}.zip",
    sourcesTemplate: "better-passwords-{{packageVersion}}-sources.zip",
    // Reviewers need the workspace protocol package and root lockfile to reproduce the build.
    sourcesRoot: fileURLToPath(new URL("../../", import.meta.url)),
    includeSources: [
      "package.json",
      "bun.lock",
      "tsconfig.base.json",
      "README.md",
      "CONTRIBUTING.md",
      "LICENSE",
      "NOTICE",
      "PRIVACY.md",
      "SECURITY.md",
      "biome.json",
      "lefthook.yml",
      "commitlint.config.js",
      "vitest.config.ts",
      "apps/extension/**",
      "packages/**",
      "scripts/**",
      "docs/**",
    ],
    excludeSources: [
      "**/.output/**",
      "**/.wxt/**",
      "**/node_modules/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },
  manifest: ({ browser }) => {
    return {
      name: STORE_TITLE,
      short_name: DISPLAY_NAME,
      description: "Fill passwords from Apple Passwords, pairing far less often.",
      permissions: [
        "nativeMessaging",
        "storage",
        "alarms",
        "idle",
        "activeTab",
        "scripting",
        // while Hide My Email is on, sets icloud.com's Origin on our own requests to iCloud
        "declarativeNetRequestWithHostAccess",
      ],
      // Chromium: asked for only when the user turns off the browser's address autofill in the popup
      ...(browser === "firefox" ? {} : { optional_permissions: ["privacy"] }),
      // the inline menu reads the page's URL and runs on login pages
      host_permissions: FILL_MATCHES,
      // Chromium: reachable only at a per-session URL, so pages can't load (or probe for) the menu
      web_accessible_resources: [
        {
          resources: ["menu.html"],
          matches: FILL_MATCHES,
          ...(browser === "firefox" ? {} : { use_dynamic_url: true }),
        },
      ],
      action: { default_title: DISPLAY_NAME },
      // Extension pages and the worker load only our own code and reach only iCloud (Hide My
      // Email), so a future bug or a hijacked dependency can't send data anywhere else.
      content_security_policy: browser === "firefox" ? EXTENSION_CSP : { extension_pages: EXTENSION_CSP },
      ...(browser === "firefox"
        ? {
            browser_specific_settings: {
              gecko: {
                id: FIREFOX_EXTENSION_ID,
                strict_min_version: "142.0",
                // Mozilla's transmission rules include the local native password helper.
                data_collection_permissions: {
                  required: ["authenticationInfo", "browsingActivity"],
                  optional: ["personallyIdentifyingInfo", "websiteContent"],
                },
              },
            },
          }
        : { key: EXTENSION_PUBLIC_KEY }),
    };
  },
});
