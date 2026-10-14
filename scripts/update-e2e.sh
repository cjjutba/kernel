#!/usr/bin/env bash
# Proves a real update from one signed Kernel build to the next (KERNEL-715). Run it before tagging a release.
#
#   pnpm update:e2e                 build two signed, unnotarized builds, update the first to the second, check the result
#   pnpm update:e2e --no-build      reuse the builds in dist/e2e-1 and dist/e2e-2 from the last run
#   pnpm update:e2e --bad-sha512    serve a feed with a wrong sha512. The run must fail, so exit 1 means it works
#
# The app under test is a copy in a temp folder under ~/Applications, started with --kernel-update-test (KERNEL-713)
# on a temp data folder. /Applications/Kernel.app and ~/Library/Application Support/Kernel are never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

build=true
bad=false
[[ "${1:-}" == "--" ]] && shift
for arg in "$@"; do
  case "$arg" in
    --no-build) build=false ;;
    --bad-sha512) bad=true ;;
    *) echo "update-e2e: unknown option $arg" >&2; exit 2 ;;
  esac
done

fail() { echo "update-e2e: $*" >&2; exit 1; }

port="${KERNEL_PORT:-4560}"
base=$(node -p "require('./package.json').version")
v1="$base-e2e.1"
v2="$base-e2e.2"
identity="Developer ID Application"

security find-identity -v -p codesigning | grep -q "$identity" || fail "no \"$identity\" certificate in the keychain."

mkdir -p "$HOME/Applications"
work=$(mktemp -d "$HOME/Applications/kernel-update-e2e.XXXXXX")
server=""
cleanup() {
  [[ -z "$server" ]] || kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

if $build; then
  echo "update-e2e: building $v1 and $v2"
  rm -rf dist/e2e-1 dist/e2e-2
  pnpm exec electron-vite build
  for n in 1 2; do
    # No APPLE_KEYCHAIN_PROFILE, so electron-builder signs with the Developer ID and skips notarization.
    env -u APPLE_KEYCHAIN_PROFILE -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_KEY -u APPLE_API_KEY_ID -u APPLE_API_ISSUER \
      CSC_IDENTITY_AUTO_DISCOVERY=true \
      pnpm exec electron-builder --mac zip --publish never -c.extraMetadata.version="$base-e2e.$n" -c.directories.output="dist/e2e-$n"
  done
fi

for n in 1 2; do
  plist="dist/e2e-$n/mac-arm64/Kernel.app/Contents/Info.plist"
  [[ -f "$plist" ]] || fail "dist/e2e-$n has no build. Run without --no-build."
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" == "$base-e2e.$n" ]] || fail "dist/e2e-$n is not $base-e2e.$n. Run without --no-build."
done
codesign --verify --deep --strict dist/e2e-1/mac-arm64/Kernel.app || fail "build 1 is not validly signed."

feed="$work/feed"
mkdir -p "$feed" "$work/data"
cp dist/e2e-2/Kernel-arm64.zip dist/e2e-2/Kernel-arm64.zip.blockmap dist/e2e-2/latest-mac.yml "$feed/"
if $bad; then
  echo "update-e2e: serving a feed with a wrong sha512"
  sed -E "s|(sha512: ).+|\1$(printf 'A%.0s' {1..86})==|" "$feed/latest-mac.yml" > "$feed/latest-mac.yml.new"
  mv "$feed/latest-mac.yml.new" "$feed/latest-mac.yml"
fi

(cd "$feed" && exec python3 -I -m http.server "$port" --bind 127.0.0.1 >"$work/server.log" 2>&1) &
server=$!
for _ in {1..50}; do
  curl -sf "http://127.0.0.1:$port/latest-mac.yml" >/dev/null && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:$port/latest-mac.yml" >/dev/null || fail "the local feed didn't start on port $port."

ditto dist/e2e-1/mac-arm64/Kernel.app "$work/Kernel.app"
bin="$work/Kernel.app/Contents/MacOS/Kernel"
# Each launch gets a time limit, since a broken app can sit on Electron's error box.
run() { KERNEL_HEADLESS=1 perl -e 'alarm 120; exec @ARGV' "$bin" "$@" 2>"$work/launch.log"; }

echo "update-e2e: updating $v1 to $v2 from http://127.0.0.1:$port/"
out=$(run --kernel-update-test "http://127.0.0.1:$port/" "$work/data") || { cat "$work/launch.log" >&2; fail "the update did not finish (got: ${out:-nothing})."; }
[[ "$out" == "ready $v2" ]] || fail "expected \"ready $v2\", got \"$out\"."

# Squirrel's installer swaps the app after Kernel has quit, so give it a minute to finish.
plist="$work/Kernel.app/Contents/Info.plist"
for _ in {1..60}; do
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null)" == "$v2" ]] && break
  sleep 1
done
echo "update-e2e: starting the installed app"
out=$(run --kernel-update-test) || { cat "$work/launch.log" >&2; fail "the updated app did not start."; }
[[ "$out" == "version $v2" ]] || fail "expected \"version $v2\", got \"$out\"."
echo "update-e2e: passed. $v1 updated to $v2."
