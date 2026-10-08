#!/usr/bin/env bash
# Builds, signs, notarizes, verifies and then publishes a Kernel release from the v<version> tag on HEAD (KERNEL-30).
# One-time setup and the full steps are in docs/RELEASING.md.
#
#   npm run release           publish to GitHub Releases on cjjutba/kernel
#   npm run release -- --dry  build, sign, notarize and verify, but don't publish
set -euo pipefail
cd "$(dirname "$0")/.."

dry=false
[[ "${1:-}" == "--dry" ]] && dry=true

version=$(node -p "require('./package.json').version")
tag="v$version"
repo=cjjutba/kernel
identity="Developer ID Application"
profile="${APPLE_KEYCHAIN_PROFILE:-kernel-notary}"

fail() { echo "release: $*" >&2; exit 1; }

[[ -z "$(git status --porcelain)" ]] || fail "the working tree has changes. Commit or stash them first."
[[ -s build/release-notes.md ]] || fail "build/release-notes.md is empty. Write the notes for $tag first."
security find-identity -v -p codesigning | grep -q "$identity" || fail "no \"$identity\" certificate in the keychain."
xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1 || fail "the notarytool profile \"$profile\" is missing or invalid."
if ! $dry; then
  git tag --points-at HEAD | grep -qx "$tag" || fail "HEAD is not tagged $tag. Run: git tag $tag && git push origin $tag"
  git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null || fail "$tag is not on origin. Run: git push origin $tag"
  gh auth status >/dev/null 2>&1 || fail "gh is not signed in. Run: gh auth login"
  ! gh release view "$tag" --repo "$repo" >/dev/null 2>&1 || fail "a release for $tag already exists on $repo."
fi

echo "release: building Kernel $version"
rm -rf dist
npx electron-vite build
# Other Apple credentials in the shell would win over the keychain profile in electron-builder's notarize step.
env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_KEY -u APPLE_API_KEY_ID -u APPLE_API_ISSUER \
  APPLE_KEYCHAIN_PROFILE="$profile" CSC_IDENTITY_AUTO_DISCOVERY=true \
  npx electron-builder --mac --publish never

# Nothing is published until the app passes. The app is what Gatekeeper checks on first launch, so it carries the
# notarization ticket; the DMG is only its box.
app=dist/mac-arm64/Kernel.app
echo "release: verifying"
codesign --verify --deep --strict --verbose=2 "$app"
spctl --assess --type execute --verbose=2 "$app" 2>&1 | tee /dev/stderr | grep -q "Notarized Developer ID" || fail "Gatekeeper does not see a notarized Developer ID app."
xcrun stapler validate "$app"
# The package ships only the build/Release binaries of the native modules (D-052), so a build that skipped the
# Electron rebuild packages cleanly. Load both with the app's own Electron, the way the app does, before anything ships.
ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/Kernel" -e '
  const modules = process.argv[1] + "/Contents/Resources/app.asar/node_modules/";
  new (require(modules + "better-sqlite3"))(":memory:").close();
  require(modules + "node-pty");
' "$PWD/$app" || fail "the packaged app can't load better-sqlite3 or node-pty. Run npm install and release again."

if $dry; then
  echo "release: dry run done. Artifacts are in dist/."
  exit 0
fi

# latest-mac.yml and the blockmaps are what installed copies read to find and download the update.
gh release create "$tag" --repo "$repo" --verify-tag --title "Kernel $version" --notes-file build/release-notes.md \
  dist/Kernel-arm64.dmg dist/Kernel-arm64.dmg.blockmap dist/Kernel-arm64.zip dist/Kernel-arm64.zip.blockmap dist/latest-mac.yml
echo "release: published $tag. https://github.com/$repo/releases/tag/$tag"
