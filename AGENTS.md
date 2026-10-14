# Kernel

Kernel is a Mac app (Electron) where Claude Code and Codex agents work as a team. The user briefs Kernel in Kernel's chat, approves a plan, and agents build in their own git worktrees, ask for approvals, open PRs and merge. The floor and the Board were removed (KERNEL-606), so don't build toward them, and don't describe Kernel as an office or a place where agents sit at desks in docs, release notes, the website or the repo description. Read `docs/PRODUCT.md` once per session if you are new to it.

## Commands

- `pnpm install` installs, downloads Electron and rebuilds native modules for it
- `pnpm dev` runs the app with hot reload
- `pnpm test:changed` runs only the test files your changes (committed or not) affect, compared with `origin/main`. Use this one while you work. It runs everything if you touched `package.json` or the vitest config
- `pnpm test` runs the full suite on plain Node (engine tests use real git repos in temp folders). CI runs it on every PR, so run it locally only to reproduce a CI failure or after changing the test setup. One file: `pnpm test test/kernel.test.ts` or `pnpm exec vitest run test/kernel.test.ts`. Tests open SQLite with a Node build of better-sqlite3, see KERNEL-735
- Test runs queue across the Mac: `pnpm test` and `pnpm test:changed` wait for a free slot, so at most 2 run at once (`KERNEL_TEST_SLOTS` changes the number, CI takes no slot)
- `pnpm typecheck` checks main, preload and renderer
- `pnpm build` builds all three bundles
- `pnpm shots <Screen> [...]` builds, renders each fixture in a hidden Electron window at 1440x900 and saves `shots/<Screen>.png`. `--all` captures every fixture, `--no-build` reuses the last build
- `KERNEL_FIXTURES=<Screen> pnpm dev` runs the app on one fixture (`fixtures/`), with no kernel, database or sessions
- `KERNEL_HEADLESS=1` keeps the window hidden, with no Dock icon and no focus. Set it whenever a script launches the app (Playwright's `_electron`, `electron .`). Check your work with `pnpm shots`, not `pnpm dev` or computer use: a visible window steals keyboard focus from whatever CJ is typing in

## Where things are

- `src/main/` main process: `kernel.ts` (wiring: builds the services and features, starts and stops them, joins their IPC handler maps), `features/` (one file per feature: its state, logic and IPC channels, KERNEL-324), `db.ts` (SQLite), `bus.ts` (events), `services/` (sessions, hooks, approvals, worktrees, scripts, github, agents, settings, preflight, kernelMcp)
- `src/preload/` the `window.kernel` bridge
- `src/shared/` contracts used by every process: `types/` (one file per area, all exported from `types/index.ts`, so `@shared/types` imports everything), `ipc.ts`, `hookSchemas.ts`
- `src/renderer/src/` React UI: `store.ts`, `App.tsx`, `screens/`, `components/`, `tokens.css`
- `docs/` PRODUCT, ARCHITECTURE, HOOKS, DECISIONS (D-001 to D-140), ROADMAP. `docs/decisions/` holds newer decisions, one file each
- `test/` vitest suites

## How to work an issue

Work is tracked in Linear (team Kernel, project "Kernel v1"). When asked to do an issue, use `/issue KERNEL-N` or follow these steps:

1. Fetch the issue with the Linear MCP and move it to In Progress. In a Kernel workspace, stay on the branch Kernel created. Otherwise name the branch `<type>/<key>-<a few words>`, with `fix` for the Bug label and `feat` otherwise, 60 characters at most (`fix/kernel-267-review-cant-start-reviewed-branch`).
2. Read the screenshots or mocks in the issue or brief. They are the spec for the task.
3. Plan before editing. Stay inside the files listed under Owns. If you must change a shared contract (`src/shared/*`, `store.ts`, `App.tsx`), do it in a separate first commit and say so in the PR.
4. Implement. Add or update tests for engine behavior. Add a fixture in `fixtures/<lane>.ts`, keyed by screen name, for each screen the issue builds, next to its related screens and not at the end of the file.
5. Verify: `pnpm test:changed`, `pnpm typecheck`, then `pnpm shots <Screen> ...` for each changed screen. Look at the shots, fix differences that a person would notice, and share the shot. The PR's Test check runs the full suite, so don't run `pnpm test` yourself unless you are reproducing a CI failure or changed the test setup.
6. Write the release-note fragment (see Release notes below).
7. Commit with Conventional Commits (`feat(workspace): ...`), open a PR with `gh pr create` that references `KERNEL-N` and lists what changed and what you checked.
8. Comment a short summary on the issue (what changed, screenshots shared, anything left over) and move it to In Review.

## Release notes

Every PR that changes app files (`src/`, `docs/starter-agents/`, `build/`, `electron-builder.yml`, `scripts/`, dependencies in `package.json`) adds a fragment in `.changes/unreleased/`. The agent making the change writes it in the same PR, with or without a Linear issue, and CI fails the PR without one. Format and examples: `.changes/README.md`.

```md
---
type: fixed
issue: KERNEL-41
---
Fixed a pull request sometimes showing its old status after a quick refresh.
```

- `type` is `new` (users can do something they couldn't), `improved` (works better, faster or clearer), `fixed` (something broken now works) or `internal` (users won't notice: refactors, tests, CI, dependencies, docs). Leave `issue` out when there is none. Never write the PR number, except as `pr: 44` on a note written after the fact, in a later PR than the change.
- Describe what the user notices, not what the code does. Good: "Agents no longer get stuck after the Mac wakes from sleep." Bad: "fix(engine): reconcile sessions on resume."
- New and improved notes describe the behavior ("Notifications show the chat's title instead of the branch name"). Fixed notes start with "Fixed".
- One sentence. No file names, function names or internal jargon. If a setting is involved, say where it lives ("Settings, Hooks"). In a fixed note, name the location after the problem: "Fixed a rule in Settings, Hooks being forgotten after a restart", not "Fixed Settings, Hooks forgetting a rule".
- No hype, no emojis, no em dashes or en dashes.
- Unsure between improved and internal? Ask whether a user would notice if the change were reverted.

Releases go through `/release` (`docs/RELEASING.md`).

## Writing tests

- Extend the feature's existing test file. Reuse its setup instead of starting a new Kernel, room and worktree for each test, unless the test needs a clean one. Tests that don't change shared state can share one built in `beforeAll`.
- Test each behavior once, at the level where it lives. Don't repeat an engine rule in a screen or IPC test.
- `tempRepo` copies a repo built once per worker, so call it freely. End a test's Kernel with `k.stop({ budgetMs: 0 })`: the default waits up to 3 seconds for a scripted turn that never ends.
- A fake that reads `process.env` starts each test from none: clear what the test set, or the next test, and any read still running, sees it.

## Rules

- A screenshot or mock in the brief is the spec for that task. Without one, match the current app and `DESIGN.md`. Check your work with `pnpm shots` and share the shot.
- Follow `DESIGN.md`: monochrome, no status dots, purple only for merged, hairlines instead of shadows, one modal shell, tokens only (no hex values in screen code).
- Statuses come from real events only, never timers. Fixtures are for screenshots and tests.
- Real buttons, inputs and labels; everything reachable by keyboard; icon buttons have `aria-label`.
- UI copy is plain, sentence case, no em dashes.
- A button that waits on the main process spins, says what it is doing ("Archiving") and can't be pressed twice. Use `useBusy` and the `busy` and `busyLabel` props on `Button` (DESIGN.md, Busy buttons).
- Never commit secrets (Apple credentials, tokens). Read them from environment variables.
- Check `docs/DECISIONS.md` and `docs/decisions/` before changing a deliberate choice. When you make a new one, add a file in `docs/decisions/` named after the issue (`docs/decisions/README.md`).
- Don't add code to `src/main/kernel.ts`. A feature's state, logic and IPC channels go in its file under `src/main/features/`, a reaction to a finished turn in `features/sessionDeps.ts`, and a reaction to a push event in `listen` in `features/wiring.ts`. A feature imports `kernel.ts` and other features only as types and reaches them through its `k`, as `this.k.prs.mergePr(...)` (KERNEL-324). New code and new tests call the feature, not a Kernel method, and Kernel gets no new forwarding methods (KERNEL-331). `test/featureBoundaries.test.ts` fails when `kernel.ts` passes 450 lines.
- The Claude Agent SDK is pinned (see package.json). Check its `sdk.d.ts` before changing any call to it.
- Before bumping the Claude Agent SDK version, run the live test (`KERNEL_LIVE=1 KERNEL_LIVE_REPO=<path to a side project> pnpm test test/live.test.ts`) and read the SDK changelog. Usage relies on an undocumented `rate_limit_event` field and an experimental usage API (KERNEL-6), so a bump can break the usage meters silently.
- Lists that several PRs add to (fixtures) keep one entry per line. No doc states a count that every PR would have to change, and tests derive counts from the files.
- Never run `git pull` in the main checkout, the folder where `main` is checked out (the first line of `git worktree list`). That goes for Kernel and every chat. CJ runs Kernel from that folder with `pnpm dev`. A pull reloads the window onto code the running app doesn't have, and the restart that fixes it interrupts every agent. Anything else that rewrites its files does the same, so don't run `git checkout`, `git switch`, `git merge` or `git reset` there either. To see what landed on main, run `git fetch origin` and read `origin/main`. To bring a branch up to date, rebase it onto `origin/main` in its own worktree. CJ pulls main when no agent is running.
- Keep PRs to one issue. If you find unrelated bugs, file a Linear issue with the Bug label instead of fixing them in place.

## Lanes

Issues carry one lane label: Engine, Workspace, Team, Platform. During the Build phase each lane runs in its own Conductor workspace, so lanes must not edit each other's files. Phase order: Bring-up (KERNEL-5, 6, 7), Contracts (KERNEL-8, 9), Build (KERNEL-10 to 29), Integrate and ship (KERNEL-30, 31).

## Models

Use Sonnet for UI issues and Opus for engine work and anything ambiguous. Keep an eye on usage; the sprint runs several sessions in parallel.
