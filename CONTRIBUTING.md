# Contributing

Thanks for helping! This page gets you from clone to a tested change.

## Setup

You need [Bun](https://bun.sh) 1.3 or later. A Mac is only needed for live testing against Apple's helper and for the companion app (Xcode 16 or later); everything else runs anywhere.

```sh
bun install          # also installs the git hooks (lefthook)
bun run check        # lint + typecheck + unit tests
bun run test:coverage  # unit tests with a coverage report in coverage/index.html
bun run build        # Chromium + Firefox packages into apps/extension/.output
bun run test:e2e     # Playwright: real Chromium + the fake helper (run `bunx playwright install chromium` once)
```

To use an existing Chromium test binary, set `BETTER_PASSWORDS_CHROMIUM_PATH` to its absolute executable path. Tests still create fresh profiles and use only the fake native helper. Leave it unset to use Playwright's pinned browser.

## Repository layout

| Path | Contents |
|---|---|
| `apps/extension` | The WXT extension: `entrypoints/` (background, popup), `src/` (session, fill, config) |
| `packages/protocol` | The helper protocol: SRP pairing, encrypted channel, queries |
| `apps/companion` | The optional Touch ID companion app (Swift; `swift test`, `scripts/bundle.sh`) |
| `packages/fake-helper` | Test doubles of Apple's helper and of the companion's host |
| `scripts/setup-mac.sh` | One-time browser setup |
| `docs/` | Architecture, protocol, threat model, releasing |

The UI uses no framework: plain TypeScript and DOM via the small `h()` helper in `apps/extension/src/ui/h.ts`. Please keep it that way.

## Trying a change against the real helper

Use a throwaway browser profile, so your everyday profile and Apple's extension stay untouched:

```sh
bun run build
PROFILE=$(mktemp -d)
scripts/setup-mac.sh --user-data-dir "$PROFILE"
open -na "Google Chrome" --args --user-data-dir="$PROFILE" \
  --load-extension="$PWD/apps/extension/.output/chrome-mv3"
```

Use a **new profile directory after every rebuild**, or reload the extension on its extensions page. Relaunching an existing profile can keep running the previous build's background worker, which talks past the new content scripts and fails silently.

Chrome 137+ ignores `--load-extension`. Either load the folder from `chrome://extensions` (Developer mode → Load unpacked), or use Chromium, Helium or another Chromium build.

**Never** paste real passwords, pairing codes, or screenshots showing them into issues, PRs or logs.

## Commits and pull requests

- Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, …). A git hook checks this, and the type decides the next release (see [docs/release.md](docs/release.md)).
- Keep PRs focused, and add tests for behavior changes. Protocol changes need unit tests. Fill logic needs DOM tests.
- Changes to pairing, encryption, filling or the setup script get extra review. Say so in the PR description.

By contributing, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md) and license your work under the [MIT License](LICENSE).
