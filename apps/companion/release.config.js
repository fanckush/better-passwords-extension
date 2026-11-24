// Releases the Mac companion app from commits scoped (companion) on main
// (see scripts/release/component-commits.js). CI runs this only once Developer ID signing is set
// up, because Gatekeeper blocks an unsigned download.
export default {
  branches: ["main"],
  tagFormat: "companion-v${version}",
  plugins: [
    ["../../scripts/release/component-commits.js", { component: "companion", preset: "conventionalcommits" }],
    [
      "@semantic-release/exec",
      {
        prepareCmd: "scripts/release.sh ${nextRelease.version}",
        successCmd: 'echo "version=${nextRelease.version}" >> "$GITHUB_OUTPUT"',
      },
    ],
    [
      "../../scripts/release/component-github.js",
      { component: "companion", assets: [{ path: "dist/updates/*.dmg" }, { path: "dist/updates/appcast.xml" }] },
    ],
  ],
};
