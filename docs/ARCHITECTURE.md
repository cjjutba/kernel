# Kernel architecture

## Processes

- **Main** (`src/main`): owns everything stateful. SQLite store, the event bus, agent sessions on Claude Code and Codex, the hook server, git, scripts, GitHub, settings.
- **Preload** (`src/preload`): exposes `window.kernel.invoke(channel, req)` and `window.kernel.on(listener)`. Nothing else crosses the boundary.
- **Renderer** (`src/renderer`): React UI. Reads state from a small store (`store.ts`) that loads once and then stays live from push events.

## Data flow

```
Claude Code (SDK session)   Codex (app-server)          Claude Code outside Kernel
   | messages, hooks            | JSON-RPC                  | http hooks
   v                            v                           v
providers/claude.ts   providers/codex/runner.ts   hookServer.ts (localhost:7420, dev 7430)
          \________ sessions.ts ______/                      |
   \__________________  ____________________/
                      \/
                 bus.ts (events)  -> db.ts (activity, transcript, approvals)
                      |
                 IPC push 'kernel:event'
                      |
                 renderer store -> screens
```

Requests go the other way: screens call `call(channel, req)`, the preload forwards to `ipcMain.handle`, and each feature under `src/main/features/` maps its own channels to its methods. `kernel.ts` joins those maps into one (KERNEL-324).

## Sessions

`services/sessions.ts` keeps what every chat shares, whatever it runs on: queues, pauses and holds, usage limits, the chats a limit or a quit cut off, carry-on, the idle stop, pids and hand-offs. Each chat's process is a `Runner` (`services/providers/types.ts`): `ClaudeRunner` (`providers/claude.ts`) or `CodexRunner` (`providers/codex/runner.ts`), picked by `Chat.provider`. A runner calls back through its `RunnerHost` for rows, the turn's start and end, limits, approvals and plans. Plan approval is one `requestPlan`, which Claude's ExitPlanMode and a Codex plan-mode turn both call (KERNEL-406).

`Sessions.runMode` answers `chats.runMode` with the mode a chat runs in, the mode picked for it and why they differ (`chatMode` in `services/permissions.ts`). `chat.runMode` pushes each change, for chats with no process too (KERNEL-572).

`ClaudeRunner` runs a chat as a Claude Agent SDK `query()` in streaming input mode, with:
- `cwd` set to the workspace path, `settingSources: ['user','project','local']` so CLAUDE.md, agents and skills load
- the agent from the project's resolved team (`features/team.ts`, `services/teamResolve.ts`): the repo's `.claude/agents`, `[team]` in `.kernel/settings.toml`, and Kernel's own Theo where the repo has no reviewer (KERNEL-397), plus the user's `~/.claude/agents` and Claude Code's plugin agents (`services/pluginAgents.ts`, KERNEL-463), with the user's own edits and retires on this Mac laid over them (`features/agentChanges.ts`, KERNEL-466)
- `systemPrompt: { type: 'preset', preset: 'claude_code', append: <agent instructions + workspace context> }`
- `permissionMode` from `effectiveMode` (`services/permissions.ts`): plan mode, then the chat's mode, the project's and the app's, with Auto and Bypass permissions only where `features/permissions.ts` says the chat can run them. `allowDangerouslySkipPermissions` only for a chat in Bypass permissions (KERNEL-447)
- no `sandbox`, Bypass permissions included, so commands run as they would in the user's terminal once Kernel's hooks and `canUseTool` let them through (KERNEL-571)
- `canUseTool` routing whatever Claude Code would prompt for through `approvals.ts`. The user's own allow rules still apply, so with a broad allow list that is mostly what Claude Code insists on asking about (D-016, KERNEL-447)
- in-process `hooks` reporting activity, the same shape as the http hooks, plus a Bash guard that applies Never allow (`deny`), waits for the user's answer on Always ask in every mode but Bypass permissions, and answers `allow` for a command the project's "Always allow" rules cover, a chain included, in Manual, Accept edits and Auto. A second hook does the same for an MCP or web tool the project allows (`Project.allowTools`), which `canUseTool` also checks before it asks (KERNEL-454). A gate refuses tools the agent file's tools line doesn't list. An MCP tool it doesn't list asks the user while the project's `unlisted_tools` is `ask`, and runs without a card when every mode Claude Code might run the step in is Bypass permissions (KERNEL-537, docs/decisions/bypass-allows-unlisted-mcp.md). The built-in tools it leaves out also go in `disallowedTools` (`services/agentTools.ts`, KERNEL-397)
- `thinking: { type: 'adaptive', display: 'summarized' }` so thinking rows have text, a preset `sessionId` for new chats, and an env with an API key only on an API key account the user picked (D-018, D-019, KERNEL-523)
- `mcpServers.kernel` for the Lead only (`services/kernelMcp.ts`): list_agents, list_workspaces, request_plan_approval, ask_user, create_workspace (with `wait_for` for a task that waits for other PRs to merge), wait_for_merge (sets or ends that wait later), message_agent, archive_workspace, merge_workspace (only with Settings, Pull requests' "Let the Lead merge when you ask" on and in a turn the user started, through the same `mergePr` as the Merge button, KERNEL-352), overrule_blockers (on the user's quoted words, records an overrule of the head commit's blockers, KERNEL-732), say (a status line on the Lead's card in the sidebar), hire_agent. Kernel holds a waiting teammate's brief in `Workspace.waitsFor` and releases it when the PRs merge (`services/waits.ts`, KERNEL-259). `LEAD_RULE` (`services/handoff.ts`) is appended to every Lead's prompt: hand off on approval, read Kernel's team updates, answer or route teammates' questions, write for the user
- `mcpServers.kernel` for a review workspace (`services/reviewMcp.ts`): submit_review, which saves the verdict on the reviewed workspace (`Workspace.reviews`), one per kind of review, and tells the Lead. `reviewRule` is appended to the reviewer's prompt. Kernel starts a review workspace itself when a PR passes checks, with one chat per kind of review the base branch's `[review]` asks for (`features/reviews.ts`, KERNEL-549). Each review round, one per head commit, is saved in `Workspace.reviewRound`: after a fix only the kinds that blocked, or whose paths the fix touched, run again, and none after `[review] rounds` rounds with blockers left (KERNEL-552). The Lead still makes one with `create_workspace` and `review_of` when the user asks for a review
- `mcpServers.kernel` for every other teammate (`services/teammateMcp.ts`): wait_for_merge, which records that the teammate waits for another workspace's PR (by `#164`, an issue key or a workspace id) with the same rules and release as the Lead's, and wakes the Lead once with the turn that set it (KERNEL-262). `TEAMMATE_RULE` is appended to the teammate's prompt, and `SHARE_RULE` to every teammate's and reviewer's while sharing is on
- get_issue in every agent's `kernel` server (`services/issueMcp.ts`, KERNEL-473): reads an issue through the project's tracker (`trackerFor`), by default the one the workspace builds or a review's reviewed work builds, so no agent needs a tracker MCP server. `features/tools.ts` builds each server from `toolsFor`, the same list Codex gets as dynamic tools. A hand-off on an issue the tracker read also carries the issue in its brief (`briefParts`)
- `resume` with the stored session id so chats survive restarts
- `rate_limit_event` messages feed usage meters and limit banners; `usage.get` also asks a live session's experimental usage call on demand (D-017)
- `pathToClaudeCodeExecutable` from Settings, Providers: the bundled copy, the one on the PATH, or a path, and `CLAUDE_CODE_OAUTH_TOKEN` for an added Claude account (KERNEL-406)

`CodexRunner` runs one `codex app-server` per chat, the pinned bundled Codex by default, with `CODEX_HOME` set to the active account's home. It speaks JSON-RPC over stdio (`providers/codex/rpc.ts`, types generated by `scripts/codex-protocol.mjs` into `providers/codex/protocol`):
- a thread per chat, started with the agent's prompt as developer instructions and Kernel's tools as dynamic tools named `kernel_<tool>` (`providers/codex/tools.ts`), and resumed by `Chat.sessionId`
- a turn per message, with the chat's model, effort and collaboration mode, approval policy `untrusted`, and a `workspace-write` sandbox that can also write the repo's git folder. Plan mode runs read-only, and a turn that ends with a `plan` item goes to `requestPlan`
- command approvals through Kernel's rules first (Never allow, Network off, project rules), then the user's card in every mode, since an accepted Codex command runs outside its sandbox. File changes, extra permissions and questions use Kernel's cards (docs/decisions/KERNEL-406.md)
- items mapped to the same rows as Claude's: `commandExecution` is Bash, `fileChange` is Edit or Write, MCP and Kernel tool calls are `mcp__<server>__<tool>`
- `account/rateLimits/*` for the usage windows, kept per provider and account (`providers/limits.ts`), and `thread/tokenUsage/updated` for the context meter
- `forProvider` (`services/handoff.ts`) names Kernel's tools the Codex way in every rule and message

`features/providers.ts` holds the executables, the accounts and switching, the model lists and the status table. Added accounts share each CLI's config: a Claude account adds only its token, kept with `safeStorage`, and a Codex account gets a home where only `auth.json` is its own and everything else links to `~/.codex`. A limit holds only its provider's chats on that account, a sign-out holds only its provider's, and a project pauses for a limit only when every provider its agents use is limited.

## Hooks

Sessions started outside Kernel (a normal terminal, the big terminal) report through http hooks installed in `~/.claude/settings.json`. See `docs/HOOKS.md`. Sessions Kernel started itself are ignored by the hook server, since in-process hooks already report them. The installed app and Kernel Dev each have their own token, port and entries, so both run at once, and neither shows a session the other started (KERNEL-675). Claude Code doesn't send http SessionStart hooks, so the hook server treats a session's first event as its start (D-020).

## Workspaces

- Worktree mode: `git worktree add -b <branch> <root>/<project>/<slug> <base>`, gitignored files copied in, a free port assigned as `$KERNEL_PORT`, setup script run in the login shell.
- Current-branch mode: works in the main checkout; `git stash create` snapshots pre-existing changes so diffs show only the agent's work.
- Archive runs the archive script, stops sessions and scripts, removes the worktree.

## Pull requests

Kernel hands creating, fixing and resolving PRs to the agent with instruction files (`create-pr.md`, `resolve-conflicts.md`, `fix-checks.md`, `address-review.md`). The text in each comes from the project, else Settings, Pull requests. When it is Kernel's own default, `prTextFor` (`services/conventions.ts`) fits it to the workspace: the branch, the base, the remote, the PR number, and the repo's PR template, contributing guide, commitlint config and PR skills or commands, each named by path. A text someone wrote goes out as written (KERNEL-468, KERNEL-564). `resolveFile` (`github.ts`) adds what GitHub reported under the text: conflicting files, failing checks, or the review comments of people in the repo with their thread ids and the command that replies in a thread. Kernel reads PR state with `gh pr view` and maps it to one header state (`github.ts`, `prStateOf`).

## Storage

`kernel.db` in the app data folder: `~/Library/Application Support/Kernel` for the installed app, and `Kernel Dev` next to it for `pnpm dev`, which moves the data over on its first launch (KERNEL-408). The two can run at the same time (KERNEL-675). Logs go to `~/Library/Logs/Kernel` and `~/Library/Logs/Kernel Dev`. A `pnpm dev` started inside a Kernel workspace is a third copy, with its data in `Kernel Dev Runs/<workspace id>` and its logs in `~/Library/Logs/Kernel Dev Runs` (KERNEL-679). Plain SQL with JSON columns for now (see DECISIONS.md). App settings in `settings.json`; per-repo settings in `.kernel/settings.toml` and `.kernel/settings.local.toml`.

## Testing

Vitest. Engine tests use real git repos in temp folders and a real hook server on a random port. The session runner is tested through its helpers. `test/live.test.ts` runs the real round trip (project, worktree, approvals, interrupt, usage, an outside `claude -p` through http hooks written to a temp settings file) and only runs with `KERNEL_LIVE=1 KERNEL_LIVE_REPO=<repo with .claude/agents>`. Add `KERNEL_LIVE_CODEX=1` for the Codex teammate and Lead runs. Codex runners are tested against a fake app-server over stdio (`test/helpers/fakeCodexServer.mjs`), whose turns play a script the test sends. Fixture mode (`KERNEL_FIXTURES=<Screen>`) swaps the kernel for `src/main/fixtures.ts`, which answers every IPC channel from one fixture in `fixtures/` and forces the route, modal and other UI state through `system.fixture`. `scripts/shots.ts` launches each fixture through Playwright's `_electron` with `KERNEL_HEADLESS=1`, so the window stays hidden (D-091), and saves a 1440x900 shot, and its compare mode puts the shot beside the PNG. `test/fixtures.test.ts` checks every fixture against its PNG name and its own ids.
