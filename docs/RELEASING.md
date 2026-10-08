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

## Cutting a release

1. Bump `version` in `package.json` and write `build/release-notes.md` for users. Each `### Title` and the paragraph under it becomes one item in What's new; text before the first heading shows only on GitHub.
2. Merge that to `main` through a PR.
3. On an up-to-date, clean `main`:

   ```sh
   git tag v<version> && git push origin v<version>
   npm run release
   ```

   The script checks the tag (on HEAD and on origin), the certificate and the notary profile. It builds, signs with the hardened runtime, notarizes and staples the app, and verifies it with `codesign`, `spctl` and `stapler`. Only then does it create the GitHub release with `gh`, uploading `Kernel-arm64.dmg`, `Kernel-arm64.zip`, their blockmaps and `latest-mac.yml`.

`npm run release -- --dry` does everything except publish, and skips the tag check. `npm run dist:mac` makes an unsigned local build with no certificate needed.

## How updates reach users

`src/main/updater.ts` checks at launch and every 4 hours. A new version downloads in the background, then the footer shows Update ready. The pill opens What's new with the release notes, Later, and Restart to update. After the update installs, What's new opens once on its own. Only packaged builds check; dev runs never do.

While the repo is private an installed copy can't read its releases, so checks fail quietly and Kernel reports no update.

## Checking a build by hand

```sh
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Kernel.app
spctl --assess --type execute --verbose=2 dist/mac-arm64/Kernel.app   # "Notarized Developer ID"
xcrun stapler validate dist/mac-arm64/Kernel.app
```

For a real first-run check, download the DMG from the release on another macOS user account (so it carries the quarantine flag), install it and open it with Gatekeeper on.
