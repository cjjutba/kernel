# Release notes

Every PR that changes the app adds a release note: one small file in `.changes/unreleased/`, written by whoever makes the change, in the same PR. A Linear issue is optional. The note is not.

A release compiles the notes into `site/content/releases/<version>.md`. That file is the website changelog entry, the GitHub release body and the What's new dialog in the app (D-058).

## The file

Name it after the branch or the change, in kebab-case: `.changes/unreleased/pr-refresh.md`.

```md
---
type: fixed
issue: KERNEL-41
---
Fixed a pull request sometimes showing its old status after a quick refresh.
```

`type` is one of:

| Type | When |
| --- | --- |
| `new` | Users can do something they could not before. |
| `improved` | Something existing works better, faster or clearer. |
| `fixed` | Something broken now works. |
| `internal` | Users will not notice: refactors, tests, CI, dependencies, docs. Kept here for the record and left out of the published notes. |

`issue` is the Linear key. Leave the line out when there is no issue.

The body is one sentence. Don't write the PR number: the release finds it from the squash commit on `main`. A PR that makes more than one change users will notice can add more than one file.

## Writing it

- Describe what the user notices, not what the code does.
  Good: "Agents no longer get stuck after the Mac wakes from sleep."
  Bad: "fix(engine): reconcile sessions on resume."
- New and improved notes describe the behavior: "Notifications show the chat's title instead of the branch name." Fixed notes start with "Fixed".
- One sentence, ending in a period. No file names, function names or internal jargon.
- If a setting is involved, say where it lives: "Settings, Hooks".
- No hype, no emojis, no em dashes or en dashes.
- Unsure between improved and internal? Ask whether a user would notice if the change were reverted.

## What checks it

- **CI.** The Release note check fails a PR that changes app files without adding a note: `src/`, `docs/starter-agents/`, `build/`, `electron-builder.yml`, `scripts/`, or the dependencies in `package.json`. An internal note counts. PRs that only touch `site/`, `docs/`, `design/`, `.github/`, `.claude/`, `.changes/` or tests need none, and neither do `release/*` branches. Dependabot PRs carry the `skip-release-note` label; use it yourself only in an emergency.
- **The schema.** `scripts/notes.ts` validates every note on every PR, so a malformed one fails with the reason.

Run the check locally with `node scripts/release-note-check.ts`.

## Releasing

`/release` in Claude Code runs the whole routine, and `docs/RELEASING.md` describes it. The pieces:

- `npm run release:notes -- --preview` prints the unreleased notes by type and suggests the version: minor if anything is new, otherwise patch. It changes nothing.
- `npm run release:notes -- <version>` writes `site/content/releases/<version>.md` (New, Improved, Fixed, with PR numbers) and moves the notes to `.changes/released/<version>/`.
