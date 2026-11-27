# Releasing

Releases are automatic. [semantic-release](https://semantic-release.gitbook.io) runs on every push to `main` (`.github/workflows/release.yml`) and reads the [Conventional Commits](https://www.conventionalcommits.org) since the last release of each component:

| Component | Commits | Tags |
|---|---|---|
| Extension (with the shared packages) | everything not scoped `(companion)` | `extension-v*` |
| Companion app | `feat(companion): …`, `fix(companion): …` | `companion-v*` |

`scripts/release/component-commits.js` does the split for the version bump and the release notes. `scripts/release/component-github.js` does the same for the GitHub plugin, so the "included in version X" comments and labels only land on that component's PRs and issues.

| Commit | Release |
|---|---|
| `fix: …` | patch (1.2.3 → 1.2.4) |
| `feat: …` | minor (1.2.3 → 1.3.0) |
| `feat!: …` or a `BREAKING CHANGE:` footer | major |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:` … | no release |

When an extension release is due, CI:
1. sets the version in the checkout,
2. builds and zips the Chromium and Firefox packages, plus reviewer source,
3. creates the `extension-vX.Y.Z` tag and a GitHub release with notes and the zips,
4. attests build provenance for the zips (`gh attestation verify <zip> -R fanckush/better-passwords-extension`),
5. submits to the Chrome Web Store (API v2, service account) and Firefox Add-ons, only once the repository variable `STORE_SUBMIT` is `true` and these secrets exist: `CHROME_PUBLISHER_ID`, `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL`, `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY`, `FIREFOX_JWT_ISSUER`, `FIREFOX_JWT_SECRET`. `bunx wxt submit init` (in `apps/extension`) writes them to the git-ignored `.env.submit`; the non-secret submit settings live in `release.yml`. To upload the secrets from that file:

   ```sh
   for n in CHROME_PUBLISHER_ID CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL CHROME_SERVICE_ACCOUNT_PRIVATE_KEY FIREFOX_JWT_ISSUER FIREFOX_JWT_SECRET; do
     bun --env-file=apps/extension/.env.submit -e "process.stdout.write(process.env.$n)" | gh secret set "$n"
   done
   ```

The Chrome Web Store extension ID is `ocongmkplhijgajnipnhhggfcjfdilgj`. Its public key is in `apps/extension/src/config.ts`; the setup script and companion allow this same ID. The Chrome ZIP attached to GitHub releases keeps the manifest `key` field, so unpacked installs get this ID too; Chrome rejects that field on upload, so the store gets a copy without it from `.output/store/`. If the store identity ever changes, update the extension config, setup script, companion identity and tests, README and website links together.

## Betas (v2)

The `v2` branch is a beta channel for the next major version. Its pushes go through the same job, but:
- the versions are pre-releases (`2.0.0-beta.N`), published only as GitHub pre-releases, which never count as the latest release;
- nothing is sent to the stores, and the companion app isn't released from it;
- linked issues and PRs get no "released" comment (the stable release posts it).

The first beta needs a breaking commit (`feat!: …`) so the channel starts at 2.0.0. Testers download the Chromium ZIP from the pre-release and load it unpacked (Developer mode → Load unpacked). It keeps the store's extension ID, so it uses the same native host registration as the store version. Use it in a separate browser profile from the store version. Firefox needs a signed build, so Firefox testers wait for an unlisted AMO upload, or load it temporarily from `about:debugging`.

When v2 is ready, merge it into `main` to release `2.0.0` the usual way.

## Companion app

The companion job stays off until the repository variable `COMPANION_RELEASE` is `true`. An unsigned app would be blocked by Gatekeeper, so a release needs these secrets:

| Secret | What |
|---|---|
| `MACOS_CERTIFICATE` | Developer ID Application certificate with its private key, as a base64 `.p12` |
| `MACOS_CERTIFICATE_PASSWORD` | Password of that `.p12` |
| `MACOS_SIGN_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `NOTARY_KEY` | App Store Connect API key (`.p8`), base64 |
| `NOTARY_KEY_ID`, `NOTARY_ISSUER` | That key's ID and issuer |
| `SPARKLE_PRIVATE_KEY` | Sparkle's EdDSA private key, as `generate_keys --account better-passwords -x <file>` exports it. Its public half is `SUPublicEDKey` in `apps/companion/Resources/Info.plist` |

`apps/companion/scripts/release.sh`:

1. builds a universal app, signs it with the hardened runtime, notarizes it and staples the ticket,
2. puts it in a disk image next to a link to Applications, then signs, notarizes and staples the disk image,
3. runs Sparkle's `generate_appcast`, which signs the disk image and the appcast with the EdDSA key.

semantic-release attaches the disk image and `appcast.xml` to a `companion-vX.Y.Z` GitHub release, and CI attests the disk image's build provenance.

Everything links to the download as `https://betterpasswords.app/download/mac`: the extension, the landing page and the README. The site's Worker (`apps/site/worker.js`) redirects it to the disk image of the newest `companion-v*` release, or to the release list while there is none. It also serves that release's appcast at `https://betterpasswords.app/companion/appcast.xml`, the feed every installed app checks.

**Keep the Sparkle key.** Installed apps accept only updates and appcasts signed with it. It lives in the maintainer's login keychain under the account `better-passwords`; back it up outside the keychain too. If it's lost, Sparkle still accepts a disk image signed with the same Developer ID, so a release can ship a new public key. Its appcast won't match the key in installed apps, though, so they only see that release once Sparkle's signed-feed fallback expires (20 days).

Signed builds trust their native host by team ID, so the app and the host must be signed with the same Developer ID.

## Landing page

`apps/site` is served as static files by the Cloudflare Worker `better-passwords-site` at [betterpasswords.app](https://betterpasswords.app). There is no build step. `worker.js` answers only the paths that aren't files, such as `/download/mac`. `apps/site/wrangler.jsonc` holds the config, `_headers` the security headers (CSP, HSTS), and `.assetsignore` keeps those files from being served.

Pushes to `main` that touch `apps/site/**` deploy through Workers Builds, Cloudflare's Git integration, so GitHub holds no Cloudflare token. To deploy by hand:

```sh
cd apps/site && bunx wrangler deploy
```

The CSP allows only same-origin scripts, so keep JavaScript in `assets/` rather than inline `<script>` blocks.
