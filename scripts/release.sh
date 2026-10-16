#!/usr/bin/env bash
# Builds, signs, notarizes, verifies and then publishes a Kernel release from the v<version> tag on HEAD (KERNEL-30).
# One-time setup and the full routine (fragments, /release) are in docs/RELEASING.md.
#
#   pnpm release                  publish to GitHub Releases on cjjutba/kernel
#   pnpm release --dry            build, sign, notarize and verify, but don't publish
#   pnpm release --rollout <pct>  offer the update to that share of installs (default 100, KERNEL-712)
#
# After it publishes, it deploys the website from the same commit (scripts/deploy-site.sh), so the changelog, the hero
# pill and the download link move with the release.
# The notes come from site/content/releases/<version>.md, compiled in the release PR (D-058). The same file becomes
# What's new (through latest-mac.yml) and the GitHub release body.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "release: $*" >&2; exit 1; }

dry=false
rollout=100
while (($#)); do
  case "$1" in
    # pnpm passes a `--` through (`pnpm release -- --dry`). Read as anything else, it would turn a dry run into a real release.
    --) ;;
    --dry) dry=true ;;
    --rollout) rollout="${2:-}"; shift ;;
    *) fail "unknown option $1. Use --dry and --rollout <percent>." ;;
  esac
  shift
done
[[ "$rollout" =~ ^([0-9]|[1-9][0-9]|100)$ ]] || fail "the rollout must be a whole percentage from 0 to 100, not \"$rollout\"."

version=$(node -p "require('./package.json').version")
tag="v$version"
notes="site/content/releases/$version.md"
repo=cjjutba/kernel
identity="Developer ID Application"
profile="${APPLE_KEYCHAIN_PROFILE:-kernel-notary}"

[[ -z "$(git status --porcelain)" ]] || fail "the working tree has changes. Commit or stash them first."
[[ -f "$notes" ]] || fail "$notes is missing. Compile it in the release PR first (/release, or pnpm release:notes $version)."
node scripts/release-notes.ts --check "$version" >/dev/null || fail "$notes is not valid. Fix it in a PR first."
security find-identity -v -p codesigning | grep -q "$identity" || fail "no \"$identity\" certificate in the keychain."
xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1 || fail "the notarytool profile \"$profile\" is missing or invalid."
if ! $dry; then
  git tag --points-at HEAD | grep -qx "$tag" || fail "HEAD is not tagged $tag. Run: git tag $tag && git push origin $tag"
  git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null || fail "$tag is not on origin. Run: git push origin $tag"
  gh auth status >/dev/null 2>&1 || fail "gh is not signed in. Run: gh auth login"
  ! gh release view "$tag" --repo "$repo" >/dev/null 2>&1 || fail "a release for $tag already exists on $repo."
  bash scripts/deploy-site.sh --check || fail "the site can't deploy after the release. Sign in to Vercel first."
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# What's new reads the notes from latest-mac.yml, which electron-builder fills from releaseNotesFile.
node scripts/release-notes.ts --app "$version" > "$tmp/app-notes.md"

# Usage data's key is read here, at build time, and never committed (KERNEL-397). A build without it never sends anything.
[[ -n "${KERNEL_TELEMETRY_KEY:-}" ]] || echo "release: KERNEL_TELEMETRY_KEY is not set, so this build won't send usage data, even to users who turn it on."

echo "release: building Kernel $version"
rm -rf dist
pnpm exec electron-vite build
# The same notes ship inside the app, for What's new when no update is ready (KERNEL-154). The file is named after the
# version, so a later local build never shows an older release's notes.
rm -rf out/release-notes && mkdir -p out/release-notes
cp "$tmp/app-notes.md" "out/release-notes/$version.md"
# Other Apple credentials in the shell would win over the keychain profile in electron-builder's notarize step.
env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_KEY -u APPLE_API_KEY_ID -u APPLE_API_ISSUER \
  APPLE_KEYCHAIN_PROFILE="$profile" CSC_IDENTITY_AUTO_DISCOVERY=true \
  pnpm exec electron-builder --mac --publish never -c.releaseInfo.releaseNotesFile="$tmp/app-notes.md"

# Nothing is published until the app passes. The app is what Gatekeeper checks on first launch, so it carries the
# notarization ticket; the DMG is only its box.
app=dist/mac-arm64/Kernel.app
echo "release: verifying"
codesign --verify --deep --strict --verbose=2 "$app"
spctl --assess --type execute --verbose=2 "$app" 2>&1 | tee /dev/stderr | grep -q "Notarized Developer ID" || fail "Gatekeeper does not see a notarized Developer ID app."
xcrun stapler validate "$app"
# The package ships only the build/Release binaries of the native modules (D-052), so a build that skipped the
# Electron rebuild packages cleanly. The app loads both and prints ok when started with --kernel-smoke-test, before it
# opens a window, takes the single-instance lock or touches the database. A broken module shows Electron's error box,
# so the run gets a time limit instead of hanging the release.
smoke() {
  local out
  out=$(KERNEL_HEADLESS=1 perl -e 'alarm 60; exec @ARGV' "$app/Contents/MacOS/Kernel" "$@" --kernel-smoke-test 2>"$tmp/smoke.log") || return 1
  grep -qx ok <<<"$out"
}
smoke || { cat "$tmp/smoke.log" >&2; fail "the packaged app can't load better-sqlite3 or node-pty. Run pnpm install and release again."; }
# The RunAsNode fuse is off (KERNEL-208). If it were on, this would run the -e script and print node instead of ok.
ELECTRON_RUN_AS_NODE=1 smoke -e 'console.log("node")' || fail "the packaged app still runs as Node with ELECTRON_RUN_AS_NODE. Check electronFuses in electron-builder.yml."

# Electron sets the oldest macOS the app opens on. An installed copy skips an update whose minimumSystemVersion is
# above its os.release(), so a Mac too old for this build isn't offered it (KERNEL-223). On a Mac os.release() is the
# Darwin version, not the macOS one, so the feed gets the Darwin version. electron-builder doesn't write the field.
min_macos=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$app/Contents/Info.plist")
case "${min_macos%%.*}" in
  12) min_darwin=21.0.0 ;;
  13) min_darwin=22.0.0 ;;
  14) min_darwin=23.0.0 ;;
  15) min_darwin=24.0.0 ;;
  *) fail "the app needs macOS $min_macos, and release.sh doesn't know its Darwin version. Add it to the list above." ;;
esac
echo "minimumSystemVersion: $min_darwin" >> dist/latest-mac.yml
# electron-updater offers the update only to that share of installs, picked by a random id each install keeps
# (KERNEL-712). The feed shows only the latest release, so below 100 the installs left out stay where they are.
echo "stagingPercentage: $rollout" >> dist/latest-mac.yml

if $dry; then
  node scripts/release-notes.ts --github "$version" > dist/release-body.md
  if [[ "$rollout" == 100 ]]; then
    node scripts/update-cask.ts "$version" --dmg dist/Kernel-arm64.dmg --dry || echo "release: the cask dry run failed, see above." >&2
  else
    echo "release: the Homebrew cask is only updated at 100%, so this run would leave it alone."
  fi
  echo "release: dry run done at $rollout%. Artifacts are in dist/, and the release body (without GitHub's list) in dist/release-body.md."
  exit 0
fi

# The notes, then GitHub's list of the PRs merged since the last release. The list comes from the API and the two
# are joined here, so the body doesn't depend on how gh combines --notes-file with --generate-notes.
gh api "repos/$repo/releases/generate-notes" -f tag_name="$tag" --jq .body > "$tmp/full-list.md" || fail "GitHub couldn't generate the list of changes for $tag."
node scripts/release-notes.ts --github "$version" --full-list "$tmp/full-list.md" > "$tmp/body.md"

# latest-mac.yml and the blockmaps are what installed copies read to find and download the update.
gh release create "$tag" --repo "$repo" --verify-tag --title "Kernel $version" --notes-file "$tmp/body.md" \
  dist/Kernel-arm64.dmg dist/Kernel-arm64.dmg.blockmap dist/Kernel-arm64.zip dist/Kernel-arm64.zip.blockmap dist/latest-mac.yml
echo "release: published $tag at $rollout%. https://github.com/$repo/releases/tag/$tag"
# The release is public now, so a failure here means fixing the feed with pnpm release:rollout, not releasing again.
node scripts/release-rollout.ts --check "$version" "$rollout" || fail "the live feed for $tag doesn't match what was uploaded. Read the error above before anyone updates."
# Homebrew installs the DMG just published, so the cask moves only once every install is offered it (KERNEL-904). The
# release is already public, so a failed push warns instead of failing it.
if [[ "$rollout" == 100 ]]; then
  node scripts/update-cask.ts "$version" || {
    echo "release: WARNING: the Homebrew cask was NOT updated, so brew still installs the previous version." >&2
    echo "release: the release itself is fine. Rerun: node scripts/update-cask.ts $version" >&2
  }
else
  echo "release: the Homebrew cask stays on the previous version until the rollout reaches 100. Then: pnpm release:rollout $version 100"
fi
# The site reads the latest release from GitHub when it builds, so deploying now shows this version at once. The
# release is already public, so a failed deploy warns instead of failing it.
bash scripts/deploy-site.sh || {
  echo "release: WARNING: the website was NOT deployed, so its changelog may not show $version yet." >&2
  echo "release: the release itself is fine. Rerun: pnpm site:deploy" >&2
}
