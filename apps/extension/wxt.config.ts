import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import {
  DISPLAY_NAME,
  EXTENSION_PUBLIC_KEY,
  FILL_MATCHES,
  FIREFOX_EXTENSION_ID,
  FIREFOX_STORE_TITLE,
  STORE_SUMMARY,
  STORE_TITLE,
} from "./src/config.ts";

const EXTENSION_CSP =
  // wasm: Argon2id, for Bitwarden accounts that derive their key with it (hash-wasm)
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; img-src 'self' data:; " +
  // iCloud for Hide My Email; Bitwarden's servers, which may be self-hosted anywhere (on a home
  // network, over plain http). `script-src` is what keeps other code out of the extension.
  "connect-src 'self' https: http:; " +
  "frame-src 'self' betterpasswords:";

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
      name: browser === "firefox" ? FIREFOX_STORE_TITLE : STORE_TITLE,
      short_name: DISPLAY_NAME,
      description: STORE_SUMMARY,
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
      // the inline menu reads the page's URL and runs on login pages
      host_permissions: FILL_MATCHES,
      // a self-hosted Bitwarden server on plain http, asked for (that server only) when signing in;
      // Firefox's build is MV2, which lists hosts with the other permissions
      ...(browser === "firefox"
        ? { optional_permissions: ["http://*/*"] }
        : { optional_host_permissions: ["http://*/*"] }),
      // Chromium: reachable only at a per-session URL, so pages can't load (or probe for) the menu
      web_accessible_resources: [
        {
          // the inline menu, and the card asking to save a login
          resources: ["menu.html", "save.html"],
          matches: FILL_MATCHES,
          ...(browser === "firefox" ? {} : { use_dynamic_url: true }),
        },
      ],
      action: { default_title: DISPLAY_NAME },
      // Extension pages and the worker load only our own code: no remote, inline or eval'd scripts.
      content_security_policy: browser === "firefox" ? EXTENSION_CSP : { extension_pages: EXTENSION_CSP },
      ...(browser === "firefox"
        ? {
            browser_specific_settings: {
              gecko: {
                id: FIREFOX_EXTENSION_ID,
                strict_min_version: "142.0",
                // Mozilla's transmission rules include the local native password helper. Bitwarden
                // gets the same two: the account's email and password hash, tokens and the
                // encrypted vault (authentication), and saved logins' site addresses (browsing).
                // The optional ones are Hide My Email's, asked for when it's turned on.
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
