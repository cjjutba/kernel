---
description: Release Kernel from main, from the release notes to the published update
argument-hint: (no arguments)
---
Release Kernel, following docs/RELEASING.md. I start it, I read the notes, and I merge the release PR. You do the rest. Stop and tell me whenever a check fails; never work around one.

1. **Check main.** Run `git fetch origin`. I must be on `main`, with a clean working tree, at `origin/main`. CI on that commit must be green: `gh api repos/cjjutba/kernel/commits/main/check-runs --jq '.check_runs[] | [.name, .status, .conclusion] | @tsv'` lists nothing failed or still running. If any of that isn't true, say what and stop.

2. **Preview.** Run `pnpm release:notes --preview`. Show me the notes as it prints them and summarize them in one line, such as "17 changes since 0.1.0: 3 new, 5 improved, 9 fixed". Give the suggested version (minor if anything is new, otherwise patch) and ask me to confirm patch or minor. If a note reads badly, say so now; the fix is a normal PR to its fragment before the release. Wait for my answer.

3. **Release branch.** With the version I confirmed:
   - `git checkout -b release/<version>`
   - `pnpm release:notes <version>`. It refuses a version that isn't above `package.json`, so it runs before the bump.
   - `pnpm version <version> --no-git-tag-version --no-git-checks`. It changes only `package.json`. `--no-git-checks` is needed because the release notes are not committed yet, and pnpm refuses a dirty tree without it.
   - For a minor version, the file's title is `TITLE: write me`, which the site and the release refuse. Draft a short title and a one-paragraph intro from the notes, put them in `site/content/releases/<version>.md`, and show me the file to edit. A patch keeps its "Kernel <version>" title and needs no intro.
   - Check the file: `pnpm --dir site test`.

4. **Release PR.** Commit everything as `chore(release): <version>`, push, and open the PR with `gh pr create --title "chore(release): <version>"`. Put the release file's notes in the body. Then stop until I tell you it's merged.

5. **Tag and publish.** After I confirm the merge:
   - `git checkout main && git pull --ff-only`. Check that `package.json` says `<version>` and that `site/content/releases/<version>.md` exists.
   - `git tag -a v<version> -m "Kernel <version>"` on that merge commit, then `git push origin v<version>`.
   - Remind me to keep the Mac awake and on power: notarization usually takes a few minutes and sometimes much longer.
   - Start the release detached so it outlives this command: `nohup caffeinate -i pnpm release > /tmp/kernel-release-<version>.log 2>&1 &`.
   - Read the log once. If it's still building or notarizing, say so and stop. When I ask, read it again. If it failed, show me the error and stop; docs/RELEASING.md says what to do.

6. **Verify** once the log says `published`:
   - `gh release view v<version> --repo cjjutba/kernel --json body,assets`: the body starts with the notes and ends with "Full list of changes", and the DMG, zip, blockmaps and `latest-mac.yml` are attached.
   - `curl -sL https://github.com/cjjutba/kernel/releases/latest/download/latest-mac.yml`: `version: <version>` and the notes under `releaseNotes`.
   - `curl -sIL https://github.com/cjjutba/kernel/releases/latest/download/Kernel-arm64.dmg`: the redirect points at the `v<version>` asset.
   - `curl -s https://kernel.cjjutba.dev/changelog`: the page shows `<version>`. A patch shows as "New in <version>" inside its minor's entry. If Vercel is still deploying, say so and stop; don't poll.

7. **Update my installed copy.** Walk me through it: open the installed previous version, go to Settings, About and click Check for updates. When the footer shows Update ready, click it: What's new lists the new notes. Click Restart to update. After the restart, What's new opens once, titled "What's new in Kernel <x.y>", with the same notes. Ask me to confirm what I saw.

8. **Never move or delete a published tag or release.** Installed copies and the update feed already point at them. If a release turns out broken, the fix is the next patch version through this same routine.
