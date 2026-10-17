# Releasing Kernel

Kernel ships as a signed, notarized arm64 app. Releases go to GitHub Releases on `cjjutba/kernel`, and installed copies update from there (D-049).

## One-time setup

You need an active Apple Developer Program membership, Xcode command line tools, and `gh` signed in.

1. **Developer ID Application certificate.** Create it in Xcode (Settings, Accounts, Manage Certificates, +, Developer ID Application) or on developer.apple.com under Certificates with a certificate signing request. It has to be in your login keychain with its private key. Check:

   ```sh
   security find-identity -v -p codesigning
   ```

   The list should include `Developer ID Application: <your name> (<team id>)`. Export a `.p12` backup from Keychain Access; losing the private key means making a new certificate.

2. **Notarization credentials.** Create an app-specific password at account.apple.com, then save it as the `kernel-notary` keychain profile:

   ```sh
   xcrun notarytool store-credentials kernel-notary --apple-id <apple id> --team-id <team id>
   ```

   Paste the app-specific password when it asks. The release script only ever reads the profile name, so no Apple ID or password lives in the repo. To use a different profile, set `APPLE_KEYCHAIN_PROFILE`.

3. **GitHub.** `gh auth login`. The release script publishes with `gh`; there's no token to configure.

4. **Usage data (KERNEL-397).** Usage data is opt-in and goes to a PostHog project. In that project, turn on "Discard client IP data" under Project settings. Then put its project API key in your shell before releasing:

   ```sh
   export KERNEL_TELEMETRY_KEY=phc_...
   ```

   `KERNEL_TELEMETRY_HOST` picks the PostHog region, and the default is `https://us.i.posthog.com`. The build reads both and never commits them. Without the key the release still builds, the script warns, and the build sends nothing even when a user turns sharing on. Dev builds, fixture runs, headless runs and the smoke test never send, and neither does a Mac with `DO_NOT_TRACK=1` or `KERNEL_TELEMETRY=0`.

5. **Homebrew tap (KERNEL-904).** `brew install --cask cjjutba/tap/kernel` installs from the public repo `cjjutba/homebrew-tap`, whose `Casks/kernel.rb` points at the release's `Kernel-arm64.dmg`. The repo exists, so there is nothing to create. The release script updates the cask with the `gh` login from step 3, which needs write access to that repo. Nothing else to configure. If the macOS minimum of a build changes (`LSMinimumSystemVersion`), edit `depends_on macos:` in the cask by hand.

## Release notes

Every PR that changes the app adds a fragment in `.changes/unreleased/`: one sentence about what users will notice, with a type (new, improved, fixed or internal) and an optional Linear key. The Release note check in CI fails a PR that changes app files without one. `.changes/README.md` has the format and the writing rules.

A release compiles the fragments into `site/content/releases/<version>.md` and moves them to `.changes/released/<version>/`. That one file feeds three places (D-058):

- **The website.** `site/content/changelog.ts` reads every release file at build time. Every release is its own entry, newest first. Merging the release PR deploys the file through the Site workflow, but the site hides it until GitHub has published the release (KERNEL-412). `pnpm release` deploys the site again right after it publishes, so the entry shows as soon as the script finishes. The newest published version gets the Latest badge and sets the hero pill.
- **The GitHub release.** `scripts/release.sh` publishes the notes as the release body, then adds GitHub's generated list of merged PRs under "Full list of changes".
- **What's new in the app.** `scripts/release.sh` renders the notes for the app and passes them to electron-builder, which copies them into `latest-mac.yml`. Installed copies read a new version's notes from there. The script also writes them into the build as `out/release-notes/<version>.md`, so the app can show its own version's notes (KERNEL-154).

## Cutting a release

Run `/release` in Claude Code. It does the steps below, stops for you where a person decides, and checks the result. By hand:

1. On an up-to-date, clean `main` with green CI, run `pnpm release:notes --preview`. It prints the unreleased notes and suggests the version: minor if anything is new, otherwise patch.
2. Make the release PR:

   ```sh
   git checkout -b release/<version>
   pnpm release:notes <version>
   pnpm version <version> --no-git-tag-version --no-git-checks
   ```

   Then run `pnpm demo:refresh` on the release branch and commit what it writes with the release. It rebuilds the landing page demo (`site/public/demo`) and retakes the fallback image (`site/public/images/lead-plan.png`), so the site shows what the release ships. It also lists the clips in `site/public/clips` older than a change to what they show, with the `pnpm demo:clips <name>` command for each. Re-recording takes minutes and needs ffmpeg, so it is the releaser's call. The demo is not rebuilt on deploy (Vercel deploys `site/` alone) or on every push (hashed bundle names would conflict between PRs, and the site would show unreleased features). `pnpm typecheck` covers `demo/`, so a renderer change that breaks it fails its own PR (KERNEL-900).

   `pnpm version` changes only `package.json`. It needs `--no-git-checks` because the new release file isn't committed yet. For a minor version, replace `TITLE: write me` in `site/content/releases/<version>.md` with a title, and add an `intro:` line if you like. The site build and the release script both refuse the placeholder. Open the PR as `chore(release): <version>`. Release branches skip the Release note check. The release PR runs the full suite on macOS ("Test on macOS") and must be green before it merges, because Kernel ships for Mac only.
3. After it merges, tag the merge commit and publish:

   ```sh
   git checkout main && git pull --ff-only
   git tag -a v<version> -m "Kernel <version>" && git push origin v<version>
   pnpm release
   ```

   The script checks the tag (on HEAD and on origin), the release notes file, the certificate and the notary profile. It builds, signs with the hardened runtime, notarizes and staples the app, and verifies it with `codesign`, `spctl` and `stapler`. It adds `minimumSystemVersion` to `latest-mac.yml`, so a Mac older than the build needs isn't offered the update (KERNEL-223). It also writes `stagingPercentage`, 100 unless you pass `--rollout` (see Staged rollout). Only then does it create the GitHub release with `gh`, uploading `Kernel-arm64.dmg`, `Kernel-arm64.zip`, their blockmaps and `latest-mac.yml`. Then it checks the live feed against the zip (see Checking the live feed). At a rollout of 100 it updates the Homebrew cask (see Homebrew). Last, it deploys the website from the same commit (see Deploying the site).

`pnpm release --dry` does everything except publish, skips the tag check, writes the release body to `dist/release-body.md`, and prints the cask change it would push. `pnpm dist:mac` makes an unsigned local build with no certificate needed.

### Deploying the site

The site reaches production two ways. The Site workflow deploys every push to main that changes `site/`, with the `VERCEL_TOKEN` repo secret, so merging the release PR deploys it. `pnpm release` then deploys it again with `scripts/deploy-site.sh`, once the GitHub release is public. That script uses this Mac's Vercel login (`npx vercel login`), uploads only what the tagged commit holds, and needs no secret, so a release still reaches the site when the workflow's token is broken. The release checks the login before it builds. A failed deploy after publishing warns instead of failing the release; rerun it with `pnpm site:deploy`.

## Testing an update between two signed builds

`pnpm update:e2e` proves that one signed Kernel build updates to the next, which no unit test can (KERNEL-715). Run it before tagging a release, and after any change to `src/main/updater.ts`, the signing setup in `electron-builder.yml` or the update feed.

It builds HEAD twice with Developer ID signing and no notarization, at `<version>-e2e.1` and `<version>-e2e.2`, into `dist/e2e-1` and `dist/e2e-2`. Each build takes a few minutes, mostly signing. It copies build 1 into a temp folder under `~/Applications` (so the outside-Applications block doesn't apply) and serves build 2's zip, blockmap and `latest-mac.yml` on `$KERNEL_PORT` (4560 when unset). Then it runs build 1 with `--kernel-update-test <feed> <temp data folder>` and expects `ready <version>-e2e.2`, and runs the same app again with `--kernel-update-test` and no feed and expects `version <version>-e2e.2`. Each launch is limited to 120 seconds. The temp app, the data folder and the server are removed when the script ends, pass or fail. `/Applications/Kernel.app` and `~/Library/Application Support/Kernel` are never touched.

- `pnpm update:e2e --no-build` reuses the builds from the last run.
- `pnpm update:e2e --bad-sha512` serves a feed with a wrong sha512. The update must be refused, so a working check exits 1 with a message that the update did not finish. Exit 0 would mean the update check is not verifying downloads.

It needs the Developer ID certificate in the keychain, the same as `pnpm release`, and is not part of CI.

## When notarization is slow

Notarization usually takes a few minutes, and Apple sometimes takes an hour or more. Keep the Mac awake and on power while it runs. `/release` starts the script under `caffeinate -i` for this. Nothing goes to GitHub Releases until notarization passes. The website is ahead, though: merging the release PR already deployed the changelog entry and the hero pill, while the download link still serves the previous version. So finish a stopped or failed run soon. Check `xcrun notarytool history --keychain-profile kernel-notary`, then run `pnpm release` again on the same tag.

## Staged rollout

A release can reach a share of installs instead of all of them (KERNEL-712). `latest-mac.yml` carries a `stagingPercentage`, and electron-updater offers the update only to installs whose random id falls under it. An install keeps its id, so one that got 10% still gets 50%.

```sh
pnpm release --rollout 10          # publish to 10% of installs
pnpm release:rollout 0.6.0 50      # raise a published release to 50%
pnpm release:rollout 0.6.0 0       # pause it
```

`release:rollout` downloads the release's `latest-mac.yml`, sets the one line, and re-uploads only that file with `gh release upload --clobber`. The tag, the release and the other assets don't change. It refuses a version that isn't the latest release, because installs read only the latest one's feed.

Until 1.0 every release goes out at 100, the default. After 1.0 the plan is 10, then 50, then 100.

Two things to know before going below 100:

- The feed shows only the latest release. Publish 0.6.0 at 10% and an install on 0.4.0 outside that 10% gets nothing at all, not 0.5.0. So a partial rollout also holds back the previous release from everyone it leaves out. Don't leave one partial for long.
- Pausing at 0 stops new downloads. It can't undo an update already installed, so a broken release still needs a patch.

Your own copy is one of the installs, and a partial rollout may leave it out. So step 7 of `/release`, updating your installed copy, happens at 100, or through the end-to-end update test (KERNEL-715) instead.

## Homebrew

`Casks/kernel.rb` in `cjjutba/homebrew-tap` carries the `version` and the `sha256` of that release's DMG. Everything else in it (arm64 only, the macOS minimum, `auto_updates true`, the `zap` paths) is edited by hand.

- `scripts/update-cask.ts` does the update: it hashes the published DMG, changes the two lines and commits the file to the tap through the contents API with `gh`. Run it alone with `node scripts/update-cask.ts <version> [--dry]`.
- `pnpm release` runs it after the live feed check passes, only at a rollout of 100. Below 100 the script says the cask stays put, because `brew install` fetches the latest DMG whatever the rollout is, and a partial rollout means not everyone should get it yet.
- `pnpm release:rollout <version> 100` runs it after raising a release to 100, so a release published at 10% reaches Homebrew when it reaches everyone. It also fixes a cask that an earlier run skipped. It does nothing for other percentages.
- A failed push prints a loud warning with the command to rerun and doesn't fail a release that is already public. Until it is rerun, brew installs the previous version, and the app updates itself either way.

After a release, check with `brew update && brew info --cask cjjutba/tap/kernel`. To try an install without touching your own copy, use `brew install --cask cjjutba/tap/kernel --appdir=<temp folder>`, never `/Applications`, then `brew uninstall --cask cjjutba/tap/kernel`.

## Checking the live feed

After `pnpm release` publishes, and after every `release:rollout` change, the script reads `https://github.com/cjjutba/kernel/releases/latest/download/latest-mac.yml`. It checks the version and the rollout percentage, downloads the zip the feed names and compares its sha512 and size with the feed. A wrong version or percentage gets about a minute for GitHub to catch up before it fails. A zip that doesn't match fails at once, because installs would download it and reject it.

Run the same check on its own at any time. It changes nothing:

```sh
pnpm release:rollout --check                 # whatever the feed says now
pnpm release:rollout --check 0.6.0 100       # and expect this version and percentage
```

## When a release is broken

Never move or delete a published tag or release. Installed copies, the update feed and the download link already point at it. Re-uploading `latest-mac.yml` to change the rollout is the one exception. Pause a bad release with `pnpm release:rollout <version> 0` so no more installs download it, then fix forward: merge the fix with its own fragment and release the next patch version with the same routine.

## How updates reach users

`src/main/updater.ts` checks at launch and every 4 hours. A new version downloads in the background, then the footer shows Update ready. The pill opens What's new with the release notes, Later, and Restart to update. After the update installs, What's new opens once on its own. Opened from the sidebar, the account menu or the command palette with no update ready, What's new shows the running version's notes with Done. Only packaged builds check; dev runs never do, and they have no notes of their own.

What's new shows the notes as the installed copy parses them, and it saves them before the restart. Kernel 0.1.0 joins a section's changes into one paragraph; later versions show each change on its own line. `test/fixtures/parseNotes-v0.1.0.ts` keeps 0.1.0's parser so a test proves the notes read cleanly there.

## Checking a build by hand

```sh
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Kernel.app
spctl --assess --type execute --verbose=2 dist/mac-arm64/Kernel.app   # "Notarized Developer ID"
xcrun stapler validate dist/mac-arm64/Kernel.app
```

For a real first-run check, download the DMG from the release on another macOS user account (so it carries the quarantine flag), install it and open it with Gatekeeper on.
