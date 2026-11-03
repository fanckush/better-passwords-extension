#!/bin/sh
# Builds, signs and notarizes the companion as a disk image, and writes the signed appcast Sparkle
# reads. Run by semantic-release in CI. Both end up in dist/updates.
#
# Usage: scripts/release.sh VERSION
#
# Env (from repository secrets):
#   MACOS_SIGN_IDENTITY       e.g. "Developer ID Application: Name (TEAMID)", already in the keychain
#   NOTARY_KEY_PATH           App Store Connect API key (.p8) for notarytool
#   NOTARY_KEY_ID, NOTARY_ISSUER
#   SPARKLE_PRIVATE_KEY       Sparkle's EdDSA key (generate_keys -x); signs the update and the appcast

set -eu
cd "$(dirname "$0")/.."

version="${1:?usage: release.sh VERSION}"
: "${MACOS_SIGN_IDENTITY:?Developer ID signing is required for a release}"
: "${NOTARY_KEY_PATH:?notarization is required for a release}"
: "${NOTARY_KEY_ID:?}"
: "${NOTARY_ISSUER:?}"
: "${SPARKLE_PRIVATE_KEY:?updates must be signed}"

repo="https://github.com/fanckush/better-passwords-extension"
app="dist/Better Passwords.app"
updates="dist/updates"
dmg="$updates/better-passwords-$version-mac.dmg"

notarize() {
    xcrun notarytool submit "$1" --key "$NOTARY_KEY_PATH" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait
}

# Stapling downloads the ticket from Apple's CDN, which CI runners sometimes lose the connection to
# (stapler error 68) or ask for before it's published (error 65). Both pass on a retry.
staple() {
    for wait in 10 20 40 80; do
        xcrun stapler staple "$1" && return
        echo "stapling failed, retrying in ${wait}s" >&2
        sleep "$wait"
    done
    xcrun stapler staple "$1"
}

scripts/bundle.sh --version "$version" --sign "$MACOS_SIGN_IDENTITY"

# notarize the app and staple its ticket, so it also opens offline once it's out of the disk image
ditto -c -k --keepParent "$app" dist/notarize.zip
notarize dist/notarize.zip
rm dist/notarize.zip
staple "$app"
spctl --assess --type execute --verbose "$app"

# the disk image: the app next to a link to Applications, to drag it onto
rm -rf "$updates"
mkdir -p "$updates"
staging="$(mktemp -d)"
ditto "$app" "$staging/Better Passwords.app"
ln -s /Applications "$staging/Applications"
hdiutil create -volname "Better Passwords" -srcfolder "$staging" -fs HFS+ -format UDZO "$dmg"
rm -rf "$staging"
codesign --sign "$MACOS_SIGN_IDENTITY" --timestamp "$dmg"
notarize "$dmg"
staple "$dmg"
spctl --assess --type open --context context:primary-signature --verbose "$dmg"

# the appcast, one item: the site serves the newest release's copy (apps/site/worker.js)
printf '%s' "$SPARKLE_PRIVATE_KEY" | .build/artifacts/sparkle/Sparkle/bin/generate_appcast \
    --ed-key-file - \
    --download-url-prefix "$repo/releases/download/companion-v$version/" \
    --full-release-notes-url "$repo/releases/tag/companion-v$version" \
    --link "https://betterpasswords.app/companion" \
    "$updates"
test -f "$updates/appcast.xml"

echo "released $dmg"
