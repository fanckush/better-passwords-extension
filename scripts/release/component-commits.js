// A semantic-release plugin that releases one component of this repo from its own commits.
//
// Commits scoped `(companion)` belong to the Mac companion app. Every other commit belongs to
// the extension, which bundles the shared packages. This plugin filters the commits, then hands
// them to the standard commit analyzer and release-notes generator, so both the version bump
// and the notes only cover that component. component-github.js does the same for the GitHub
// plugin, so release comments and labels only land on that component's issues and PRs.
//
// Usage in release.config.js: ["<path>/component-commits.js", { component: "companion", preset: "conventionalcommits" }]

import * as analyzer from "@semantic-release/commit-analyzer";
import * as notes from "@semantic-release/release-notes-generator";

const HEADER = /^\w+(?:\(([^)]*)\))?!?:/;

/** The component a commit message belongs to. */
export function componentOf(message) {
  const scope = HEADER.exec(message.split("\n", 1)[0] ?? "")?.[1];
  return scope === "companion" ? "companion" : "extension";
}

/** Splits off the `component` option and narrows the context's commits to that component. */
export function only(pluginConfig, context) {
  const { component, ...rest } = pluginConfig;
  if (component !== "companion" && component !== "extension") {
    throw new Error(`component-commits: unknown component ${JSON.stringify(component)}`);
  }
  const commits = context.commits.filter((commit) => componentOf(commit.message) === component);
  return [rest, { ...context, commits }];
}

export function analyzeCommits(pluginConfig, context) {
  return analyzer.analyzeCommits(...only(pluginConfig, context));
}

export function generateNotes(pluginConfig, context) {
  return notes.generateNotes(...only(pluginConfig, context));
}
