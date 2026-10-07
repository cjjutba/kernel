# Kernel

Kernel is a Mac app (Electron) where Claude Code agents work as a team in a virtual office. CJ is the only user. He briefs Rowan (the Lead) on the floor, approves a plan, and agents build in their own git worktrees, ask for approvals, open PRs and merge. Read `docs/PRODUCT.md` once per session if you are new to it.

## Commands

- `npm install` installs and rebuilds native modules for Electron
- `npm run dev` runs the app with hot reload
- `npm test` runs vitest on Electron's Node (engine tests use real git repos in temp folders). One file: `npm test -- test/kernel.test.ts`. Plain `npx vitest` fails, see D-013
- `npm run typecheck` checks main, preload and renderer
- `npm run build` builds all three bundles
- `npm run shots -- <Screen> [...]` builds, opens each fixture in Electron at 1440x900 and saves `shots/<Screen>.png`. `--all` captures every fixture with a PNG, `--no-build` reuses the last build
- `npm run shots:compare -- <Screen> [...]` writes `shots/compare/<Screen>.png`, the shot on the left and `design/screens/<Screen>.png` on the right
- `KERNEL_FIXTURES=<Screen> npm run dev` runs the app on one fixture (`fixtures/`), with no kernel, database or sessions

## Where things are

- `src/main/` main process: `kernel.ts` (orchestrator and the IPC handler map), `db.ts` (SQLite), `bus.ts` (events), `services/` (sessions, hooks, approvals, worktrees, scripts, github, agents, settings, preflight, kernelMcp)
- `src/preload/` the `window.kernel` bridge
- `src/shared/` contracts used by every process: `types.ts`, `ipc.ts`, `hookSchemas.ts`
- `src/renderer/src/` React UI: `store.ts`, `App.tsx`, `screens/`, `components/`, `tokens.css`
- `design/screens/` one PNG per canvas screen (the target). `design/canvas/` the canvas markup with exact values
- `docs/` PRODUCT, ARCHITECTURE, HOOKS, DECISIONS, SCREENS (screen to issue map), ROADMAP
- `test/` vitest suites

## How to work an issue

Work is tracked in Linear (team Kernel, project "Kernel v1"). When asked to do an issue, use `/issue KERNEL-N` or follow these steps:

1. Fetch the issue with the Linear MCP, move it to In Progress, and use its `gitBranchName` for the branch.
2. Open every PNG listed under Screens. Open the matching `design/canvas/project/<Screen>.dc.html` when you need an exact value.
3. Plan before editing. Stay inside the files listed under Owns. If you must change a shared contract (`src/shared/*`, `store.ts`, `App.tsx`), do it in a separate first commit and say so in the PR.
4. Implement. Add or update tests for engine behavior. Add a fixture in `fixtures/<lane>.ts`, keyed by PNG name, for each screen the issue builds.
5. Verify: `npm test`, `npm run typecheck`, then `npm run shots -- <Screen> ...` and `npm run shots:compare -- <Screen> ...` for each listed screen. Open the compare images and fix differences that a person would notice.
6. Commit with Conventional Commits (`feat(workspace): ...`), open a PR with `gh pr create` that references `KERNEL-N` and lists what changed and what you checked.
7. Comment a short summary on the issue (what changed, screenshots compared, anything left over) and move it to In Review. Update the status column in `docs/SCREENS.md`.

## Rules

- The PNGs are the spec. Do not invent layouts, copy or colors. When the PNG and DESIGN.md disagree, the PNG wins and you note it in the PR.
- Follow `DESIGN.md`: monochrome, no status dots, purple only for merged, hairlines instead of shadows, one modal shell, tokens only (no hex values in screen code).
- Statuses on the floor come from real events only, never timers. Fixtures are for screenshots and tests.
- Real buttons, inputs and labels; everything reachable by keyboard; icon buttons have `aria-label`.
- UI copy is plain, sentence case, no em dashes.
- Never commit secrets (Apple credentials, tokens). Read them from environment variables.
- Check `docs/DECISIONS.md` before changing a deliberate choice, and add an entry when you make a new one.
- The Claude Agent SDK is pinned (see package.json). Check its `sdk.d.ts` before changing any call to it.
- Before bumping the Claude Agent SDK version, run the live test (`KERNEL_LIVE=1 KERNEL_LIVE_REPO=<a side project> npm test -- test/live.test.ts`) and read the SDK changelog. Usage relies on an undocumented `rate_limit_event` field and an experimental usage API (KERNEL-6), so a bump can break the usage meters silently.
- Keep PRs to one issue. If you find unrelated bugs, file a Linear issue with the Bug label instead of fixing them in place.

## Lanes

Issues carry one lane label: Engine, Workspace, Team, Floor, Platform. During the Build phase each lane runs in its own Conductor workspace, so lanes must not edit each other's files. Phase order: Bring-up (KERNEL-5, 6, 7), Contracts (KERNEL-8, 9), Build (KERNEL-10 to 29), Integrate and ship (KERNEL-30, 31).

## Models

Use Sonnet for UI issues and Opus for engine work, the floor sequence, and anything ambiguous. Keep an eye on usage; the sprint runs several sessions in parallel.
