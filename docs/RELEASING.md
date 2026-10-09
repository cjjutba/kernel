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

## Release notes

Every PR that changes the app adds a fragment in `.changes/unreleased/`: one sentence about what users will notice, with a type (new, improved, fixed or internal) and an optional Linear key. The Release note check in CI fails a PR that changes app files without one. `.changes/README.md` has the format and the writing rules.

A release compiles the fragments into `site/content/releases/<version>.md` and moves them to `.changes/released/<version>/`. That one file feeds three places (D-058):

- **The website.** `site/content/changelog.ts` reads every release file at build time. A minor version is a titled entry; its patches show inside it as "New in x.y.z", oldest first. The newest version sets the hero pill and the Latest badge.
- **The GitHub release.** `scripts/release.sh` publishes the notes as the release body, then adds GitHub's generated list of merged PRs under "Full list of changes".
- **What's new in the app.** `scripts/release.sh` renders the notes for the app and passes them to electron-builder, which copies them into `latest-mac.yml`. Installed copies read them from there.

## Cutting a release

Run `/release` in Claude Code. It does the steps below, stops for you where a person decides, and checks the result. By hand:

1. On an up-to-date, clean `main` with green CI, run `pnpm release:notes --preview`. It prints the unreleased notes and suggests the version: minor if anything is new, otherwise patch.
2. Make the release PR:

   ```sh
   git checkout -b release/<version>
   pnpm release:notes <version>
   pnpm version <version> --no-git-tag-version --no-git-checks
   ```

   `pnpm version` changes only `package.json`. It needs `--no-git-checks` because the new release file isn't committed yet. For a minor version, replace `TITLE: write me` in `site/content/releases/<version>.md` with a title, and add an `intro:` line if you like. The site build and the release script both refuse the placeholder. Open the PR as `chore(release): <version>`. Release branches skip the Release note check.
3. After it merges, tag the merge commit and publish:

   ```sh
   git checkout main && git pull --ff-only
   git tag -a v<version> -m "Kernel <version>" && git push origin v<version>
   pnpm release
   ```

   The script checks the tag (on HEAD and on origin), the release notes file, the certificate and the notary profile. It builds, signs with the hardened runtime, notarizes and staples the app, and verifies it with `codesign`, `spctl` and `stapler`. Only then does it create the GitHub release with `gh`, uploading `Kernel-arm64.dmg`, `Kernel-arm64.zip`, their blockmaps and `latest-mac.yml`.

`pnpm release --dry` does everything except publish, skips the tag check, and writes the release body to `dist/release-body.md`. `pnpm dist:mac` makes an unsigned local build with no certificate needed.

When the release PR merges, Vercel redeploys the site, because the release file is inside `site/`. The Ignored Build Step compares with the last successful deployment (D-057), so the deploy happens even when later commits skip `site/`.

## When notarization is slow

Notarization usually takes a few minutes, and Apple sometimes takes an hour or more. Keep the Mac awake and on power while it runs. `/release` starts the script under `caffeinate -i` for this. Nothing goes to GitHub Releases until notarization passes. The website is ahead, though: merging the release PR already deployed the changelog entry and the hero pill, while the download link still serves the previous version. So finish a stopped or failed run soon. Check `xcrun notarytool history --keychain-profile kernel-notary`, then run `pnpm release` again on the same tag.

## When a release is broken

Never move or delete a published tag or release. Installed copies, the update feed and the download link already point at it. Fix forward: merge the fix with its own fragment, then release the next patch version with the same routine.

## How updates reach users

`src/main/updater.ts` checks at launch and every 4 hours. A new version downloads in the background, then the footer shows Update ready. The pill opens What's new with the release notes, Later, and Restart to update. After the update installs, What's new opens once on its own. Only packaged builds check; dev runs never do.

What's new shows the notes as the installed copy parses them, and it saves them before the restart. Kernel 0.1.0 joins a section's changes into one paragraph; later versions show each change on its own line. `test/fixtures/parseNotes-v0.1.0.ts` keeps 0.1.0's parser so a test proves the notes read cleanly there.

## Checking a build by hand

```sh
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Kernel.app
spctl --assess --type execute --verbose=2 dist/mac-arm64/Kernel.app   # "Notarized Developer ID"
xcrun stapler validate dist/mac-arm64/Kernel.app
```

For a real first-run check, download the DMG from the release on another macOS user account (so it carries the quarantine flag), install it and open it with Gatekeeper on.
