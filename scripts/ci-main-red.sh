#!/usr/bin/env bash
# Opens, updates or closes the ci-main-red issue. Shared by test.yml (Main status) and test-mac.yml (the full macOS run),
# so there is one copy of the logic. Needs gh, with GH_TOKEN and GH_REPO set.
#
# Environment:
#   RESULT     success, or anything else for a red run
#   FAILED     comma-separated test files that failed (may be empty)
#   SHA        the commit the run tested
#   RUN_URL    the run's URL
#   SERVER_URL the GitHub server URL, for the commit link
#   REPO       owner/name, for the commit link
#   SOURCE     optional: names the run in the issue text, e.g. "The full macOS run". Empty for the push-to-main run.
#   CLOSE      "true" to close the open issue on a green run. The nightly macOS run leaves it false: closing stays with
#              the next green push to main.
set -euo pipefail

short=${SHA:0:7}
commit="[$short]($SERVER_URL/$REPO/commit/$SHA)"
open=$(gh issue list --label ci-main-red --state open --json number --jq '.[0].number // empty')

if [ "$RESULT" = "success" ]; then
  if [ "${CLOSE:-false}" = "true" ] && [ -n "$open" ]; then
    gh issue close "$open" --comment "Main is green again at $commit ([run]($RUN_URL))."
  fi
  exit 0
fi

FAILED=$(printf '%s' "${FAILED:-}" | tr ',' '\n' | { grep . || true; } | paste -sd, -)
tests=${FAILED:-"none named: typecheck failed, or the tests did not finish"}
if [ -n "${SOURCE:-}" ]; then
  lead="$SOURCE is red at $commit ([run]($RUN_URL))."
  title="Main is red: $SOURCE fails on $short"
else
  lead="Main is red at $commit ([run]($RUN_URL))."
  title="Main is red: tests fail on $short"
fi
body="$lead

Failing test files: $tests"

if [ -n "$open" ]; then
  gh issue comment "$open" --body "$body"
else
  gh label create ci-main-red --color B60205 --description "The test run on main is failing" --force
  gh issue create --label ci-main-red --title "$title" --body "$body"
fi
