// A semantic-release plugin that wraps @semantic-release/github for one component of this repo.
//
// The GitHub plugin comments "included in version X" on (and labels) every PR and issue linked
// from the release's commits. Without this wrapper it sees all commits since the component's last
// tag, so a companion release would also comment on extension-only PRs and the other way round.
// This hands it only the component's commits (see component-commits.js).
//
// Usage in release.config.js: ["<path>/component-github.js", { component: "companion", assets: [...] }]

import * as github from "@semantic-release/github";
import { only } from "./component-commits.js";

export function verifyConditions(pluginConfig, context, ...rest) {
  return github.verifyConditions(...only(pluginConfig, context), ...rest);
}

export function publish(pluginConfig, context, ...rest) {
  return github.publish(...only(pluginConfig, context), ...rest);
}

export function addChannel(pluginConfig, context, ...rest) {
  return github.addChannel(...only(pluginConfig, context), ...rest);
}

export function success(pluginConfig, context, ...rest) {
  return github.success(...only(pluginConfig, context), ...rest);
}

export function fail(pluginConfig, context, ...rest) {
  return github.fail(...only(pluginConfig, context), ...rest);
}
