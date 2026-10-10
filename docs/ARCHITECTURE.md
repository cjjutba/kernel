# Kernel architecture

## Processes

- **Main** (`src/main`): owns everything stateful. SQLite store, the event bus, Claude Code sessions, the hook server, git, scripts, GitHub, settings.
- **Preload** (`src/preload`): exposes `window.kernel.invoke(channel, req)` and `window.kernel.on(listener)`. Nothing else crosses the boundary.
- **Renderer** (`src/renderer`): React UI. Reads state from a small store (`store.ts`) that loads once and then stays live from push events.

## Data flow

```
Claude Code (SDK session or outside terminal)
   | messages, in-process hooks          | http hooks (outside sessions)
   v                                     v
sessions.ts                         hookServer.ts (localhost:7420)
   \__________________  ____________________/
                      \/
                 bus.ts (events)  -> db.ts (activity, transcript, approvals)
                      |
                 IPC push 'kernel:event'
                      |
                 renderer store -> screens
```

Requests go the other way: screens call `call(channel, req)`, the preload forwards to `ipcMain.handle`, and `kernel.ts` maps each channel to a method.

## Sessions

`services/sessions.ts` runs each chat as a Claude Agent SDK `query()` in streaming input mode, with:
- `cwd` set to the workspace path, `settingSources: ['user','project','local']` so CLAUDE.md, agents and skills load
- `systemPrompt: { type: 'preset', preset: 'claude_code', append: <agent instructions + workspace context> }`
- `canUseTool` routing whatever Claude Code would prompt for through `approvals.ts`. The user's own allow rules still apply, so with a broad allow list that is mostly Always ask commands (D-016)
- in-process `hooks` reporting activity, the same shape as the http hooks, plus a Bash guard that applies Never allow (`deny`) and Always ask (`ask`) and lets room "Always allow" rules through
- `thinking: { type: 'adaptive', display: 'summarized' }` so thinking rows have text, a preset `sessionId` for new chats, and an env without API keys (D-018, D-019)
- `mcpServers.kernel` for the Lead only (`services/kernelMcp.ts`): list_agents, list_workspaces, request_plan_approval, ask_user, create_workspace (with `wait_for` for a task that waits for other PRs to merge), wait_for_merge (sets or ends that wait later), message_agent, archive_workspace, say (a status line on the Lead's card in the sidebar), hire_agent. Kernel holds a waiting teammate's brief in `Workspace.waitsFor` and releases it when the PRs merge (`services/waits.ts`, KERNEL-259). `LEAD_RULE` (`services/handoff.ts`) is appended to every Lead's prompt: hand off on approval, read Kernel's team updates, answer or route teammates' questions, write for the user
- `mcpServers.kernel` for a review workspace (`services/reviewMcp.ts`, made by `create_workspace` with `review_of`): submit_review, which saves the verdict on the reviewed workspace (`Workspace.reviews`) and tells the Lead. `reviewRule` is appended to the reviewer's prompt
- `mcpServers.kernel` for every other teammate (`services/teammateMcp.ts`): wait_for_merge, which records that the teammate waits for another workspace's PR (by `#164`, a Linear key or a workspace id) with the same rules and release as the Lead's, and wakes the Lead once with the turn that set it (KERNEL-262). `TEAMMATE_RULE` is appended to the teammate's prompt
- `resume` with the stored session id so chats survive restarts
- `rate_limit_event` messages feed usage meters and limit banners; `usage.get` also asks a live session's experimental usage call on demand (D-017)

## Hooks

Sessions started outside Kernel (a normal terminal, the big terminal) report through http hooks installed in `~/.claude/settings.json`. See `docs/HOOKS.md`. Sessions Kernel started itself are ignored by the hook server, since in-process hooks already report them. Claude Code doesn't send http SessionStart hooks, so the hook server treats a session's first event as its start (D-020).

## Workspaces

- Worktree mode: `git worktree add -b <branch> <root>/<room>/<slug> <base>`, gitignored files copied in, a free port assigned as `$KERNEL_PORT`, setup script run in the login shell.
- Current-branch mode: works in the main checkout; `git stash create` snapshots pre-existing changes so diffs show only the agent's work.
- Archive runs the archive script, stops sessions and scripts, removes the worktree.

## Pull requests

Creating, fixing and resolving PRs is delegated to the agent with instruction files (`create-pr.md`, `resolve-conflicts.md`, fix checks, address review). Kernel reads PR state with `gh pr view` and maps it to one header state (`github.ts`, `prStateOf`).

## Storage

`kernel.db` in the app data folder. Plain SQL with JSON columns for now (see DECISIONS.md). App settings in `settings.json`; per-repo settings in `.kernel/settings.toml` and `.kernel/settings.local.toml`.

## Testing

Vitest. Engine tests use real git repos in temp folders and a real hook server on a random port. The session runner is tested through its helpers. `test/live.test.ts` runs the real round trip (room, worktree, approvals, interrupt, usage, an outside `claude -p` through http hooks written to a temp settings file) and only runs with `KERNEL_LIVE=1 KERNEL_LIVE_REPO=<repo with .claude/agents>`. Fixture mode (`KERNEL_FIXTURES=<Screen>`) swaps the kernel for `src/main/fixtures.ts`, which answers every IPC channel from one fixture in `fixtures/` and forces the route, modal and other UI state through `system.fixture`. `scripts/shots.ts` launches each fixture through Playwright's `_electron` with `KERNEL_HEADLESS=1`, so the window stays hidden (D-091), and saves a 1440x900 shot, and its compare mode puts the shot beside the PNG. `test/fixtures.test.ts` checks every fixture against its PNG name and its own ids.
