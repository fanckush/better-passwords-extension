#!/bin/sh
# Refreshes apps/extension/src/passwords/site-rules.json from Apple's list of known password rules:
# https://github.com/apple/password-manager-resources (quirks/password-rules.json, MIT license).
# Sites that don't state their rules in HTML get a password that fits them from this list.
#
# Usage: scripts/update-password-rules.sh

set -eu

SOURCE="https://raw.githubusercontent.com/apple/password-manager-resources/main/quirks/password-rules.json"
TARGET="$(dirname "$0")/../apps/extension/src/passwords/site-rules.json"
TEMP="$(mktemp)"
trap 'rm -f "$TEMP"' EXIT

curl -sSfL -o "$TEMP" "$SOURCE"
# a JSON object of domains to { "password-rules": "…" }, or the build would ship something else
bun -e '
  const data = JSON.parse(await Bun.file(process.argv[1]).text());
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not an object");
  for (const [domain, entry] of Object.entries(data)) {
    if (typeof entry?.["password-rules"] !== "string") throw new Error(`no rules for ${domain}`);
  }
  console.log(`${Object.keys(data).length} sites`);
' "$TEMP"
mv "$TEMP" "$TARGET"
trap - EXIT
echo "updated $TARGET"
