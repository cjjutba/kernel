#!/usr/bin/env bash
# Deploys the website (site/) to production on Vercel from HEAD, with this Mac's Vercel login.
# `pnpm release` runs it after it publishes, so a release ships the app and the site together. Run it alone to redeploy:
#
#   pnpm site:deploy            deploy HEAD
#   pnpm site:deploy --check    only check that the Vercel CLI is signed in
#
# The Site workflow also deploys pushes to main that change site/, with the VERCEL_TOKEN secret. This script needs no
# secret, so a release still reaches the site when that token is broken.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "site:deploy: $*" >&2; exit 1; }

# Not secrets. They name the Vercel team and the kernel project, the same as in .github/workflows/site.yml.
export VERCEL_ORG_ID=team_3mAiEwDWaFx0otQvMPYeMD3f
export VERCEL_PROJECT_ID=prj_LZ1l9OXIiJh9Vz1Xbzb9trfMdLqf
vercel=(npx --yes vercel@54.21.1)

case "${1:-}" in
  --) shift ;;
esac
if [[ "${1:-}" == --check ]]; then
  "${vercel[@]}" whoami >/dev/null 2>&1 || fail "the Vercel CLI is not signed in. Run: npx vercel login"
  exit 0
fi

# Upload what HEAD holds and nothing else, like the workflow's checkout: no node_modules, dist or uncommitted edits.
# The project's root directory is site/, so Vercel looks for site/ in the upload.
src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
git archive HEAD | tar -x -C "$src"
echo "site:deploy: deploying the site from $(git rev-parse --short HEAD)"
(cd "$src" && "${vercel[@]}" deploy --prod --yes --archive=tgz) || fail "the Vercel deploy failed, see above."
echo "site:deploy: deployed. https://kernel.cjjutba.dev"
