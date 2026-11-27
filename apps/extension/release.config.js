// Releases the extension from conventional commits on main. Every commit counts except those
// scoped (companion), which release the Mac app instead (see scripts/release/component-commits.js).
// The version lives in the git tag; package.json is bumped only inside the CI checkout.
// v2 is a beta channel for the next major version: its pushes make GitHub pre-releases
// (2.0.0-beta.N) for testers to load unpacked, and never reach the stores (see release.yml).
export default {
  branches: ["main", { name: "v2", prerelease: "beta" }],
  tagFormat: "extension-v${version}",
  plugins: [
    ["../../scripts/release/component-commits.js", { component: "extension", preset: "conventionalcommits" }],
    [
      "@semantic-release/exec",
      {
        prepareCmd:
          "npm pkg set version=${nextRelease.version} && bun install --lockfile-only --ignore-scripts && bun run zip:all",
        successCmd: 'echo "version=${nextRelease.version}" >> "$GITHUB_OUTPUT"',
      },
    ],
    [
      "../../scripts/release/component-github.js",
      {
        component: "extension",
        assets: [{ path: ".output/*.zip" }],
        // betas don't announce themselves on the issues they fix: the stable release will
        successCommentCondition: "<% return !nextRelease.channel; %>",
      },
    ],
  ],
};
