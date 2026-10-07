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
- `canUseTool` routing every permission through `approvals.ts` (with the always-ask and never-allow rules from settings)
- in-process `hooks` reporting activity, the same shape as the http hooks
- `mcpServers.kernel` for the Lead only (`services/kernelMcp.ts`): list_agents, list_workspaces, request_plan_approval, ask_user, create_workspace, message_agent, say, hire_agent
- `resume` with the stored session id so chats survive restarts
- `rate_limit_event` messages feed usage meters and limit banners

## Hooks

Sessions started outside Kernel (a normal terminal, the big terminal) report through http hooks installed in `~/.claude/settings.json`. See `docs/HOOKS.md`. Sessions Kernel started itself are ignored by the hook server, since in-process hooks already report them.

## Workspaces

- Worktree mode: `git worktree add -b <branch> <root>/<room>/<slug> <base>`, gitignored files copied in, a free port assigned as `$KERNEL_PORT`, setup script run in the login shell.
- Current-branch mode: works in the main checkout; `git stash create` snapshots pre-existing changes so diffs show only the agent's work.
- Archive runs the archive script, stops sessions and scripts, removes the worktree.

## Pull requests

Creating, fixing and resolving PRs is delegated to the agent with instruction files (`create-pr.md`, `resolve-conflicts.md`, fix checks, address review). Kernel reads PR state with `gh pr view` and maps it to one header state (`github.ts`, `prStateOf`).

## Storage

`kernel.db` in the app data folder. Plain SQL with JSON columns for now (see DECISIONS.md). App settings in `settings.json`; per-repo settings in `.kernel/settings.toml` and `.kernel/settings.local.toml`.

## Testing

Vitest. Engine tests use real git repos in temp folders and a real hook server on a random port. The session runner is tested through its helpers; live sessions are covered by KERNEL-6 and the screenshot harness with fixtures (KERNEL-7).
