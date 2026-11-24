// Releases the extension from conventional commits on main. Every commit counts except those
// scoped (companion), which release the Mac app instead (see scripts/release/component-commits.js).
// The version lives in the git tag; package.json is bumped only inside the CI checkout.
export default {
  branches: ["main"],
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
    ["../../scripts/release/component-github.js", { component: "extension", assets: [{ path: ".output/*.zip" }] }],
  ],
};
