# Decisions

Add an entry when you make a choice someone might later "fix". Newest at the bottom.

**D-001 Sessions run on the Claude Agent SDK, not a wrapped terminal.** Structured messages give a real transcript, `canUseTool` gives approvals, `rate_limit_event` gives usage. The big terminal (KERNEL-12) is the exception, for people who want the TUI.

**D-002 The Lead orchestrates through Kernel's own MCP tools, not the experimental agent teams flag.** Kernel owns worktrees, branches and approvals, and the flow works on any Claude Code version that runs the SDK. Agent teams hooks (TaskCreated, TeammateIdle) are still consumed when present. KERNEL-27 decides whether the agent teams check on first run stays a requirement.

**D-003 Retired agents move to `.claude/retired-agents/`, not `.claude/agents/retired/`.** A subfolder inside `.claude/agents` might still be loaded by Claude Code; moving it out guarantees the agent stops loading.

**D-004 Current-branch workspaces baseline with `git stash create`.** It records pre-existing changes without touching the working tree, so diffs and checkpoints show only the agent's work.

**D-005 SQLite with JSON columns for v1, Drizzle later.** Shapes are still moving. Swap to Drizzle with drizzle-kit migrations once the contracts settle after v1.

**D-006 GitHub through the `gh` CLI.** It already holds CJ's auth and handles PRs, checks and review comments.

**D-007 One approvals queue for everything.** Tool permissions (SDK and hooks), plans and questions share one model, so the Inbox, floor cards and inline chat cards stay in sync.

**D-008 PR actions are delegated to the agent with instruction files.** Create, fix checks, address review and resolve conflicts are messages to the agent, editable in Settings > PRs. Kernel only reads state and merges.

**D-009 Scripts run in the user's login shell, falling back to /bin/sh.** So nvm, pnpm and PATH tweaks apply.

**D-010 Linear holds the work, the repo holds the knowledge.** Issues and status live in Linear (team Kernel). Docs, design PNGs and decisions live in git so every session reads them locally.

**D-011 Contracts first, then parallel lanes.** KERNEL-8 and KERNEL-9 define every shared channel, type, route and component before the Build lanes start, so lanes rarely edit shared files.

**D-012 v1 includes the light theme, code signing, notarization and auto-update.** CJ's call, October 7, 2026. CJ has an active Apple Developer Program membership, so KERNEL-30 signs and notarizes for real.

**D-013 Tests run on Electron's Node.** postinstall builds better-sqlite3 for Electron's ABI, so `npm test` runs vitest with `ELECTRON_RUN_AS_NODE=1 electron`. Plain `npx vitest` fails with `NODE_MODULE_VERSION`. Run one file with `npm test -- test/kernel.test.ts`. KERNEL-5.

**D-014 Dependency install scripts are allowlisted in `package.json`.** `allowScripts` approves electron and better-sqlite3, pinned to their versions, and denies esbuild, fsevents and electron-winstaller, which the app doesn't need on macOS. After bumping a pinned package, run `npm install-scripts approve <pkg>` or npm skips its script. A new native module (node-pty in KERNEL-12) needs an approval too. KERNEL-5.

**D-015 The window opens before the kernel finishes booting.** IPC handlers wait for `kernel.start()`, so the renderer can show a loading state (KERNEL-27). A failed boot shows a native error box and quits. Keep `createWindow()` ahead of `start()`. KERNEL-5.

**D-016 Kernel only steps in for risky Bash.** Sessions load CJ's user settings, and his allow list covers every Bash command, so `canUseTool` never sees Bash on his machine. An in-process PreToolUse hook applies Kernel's lists on top: Never allow returns `deny`, Always ask returns `ask` (which reaches `canUseTool` and the Inbox even past an allow rule or another hook's allow), and everything else is left to CJ's own settings. "Always allow in this room" saves the command, or Claude Code's suggestion when it is a single `prefix:*` Bash rule it allows saving, on the room (`Room.allow`). A room rule beats Always ask, but a prefix rule never covers a chained command (`&&`, `;`, `|`, a newline, `$(`), so `npm run build:*` can't wave through `npm run build && pnpm db:reset`. Other hooks can rewrite the command before `canUseTool` sees it (rtk adds a prefix), so rules and the Inbox use the command the PreToolUse hook saw, keyed by tool use id. CJ's call, KERNEL-6.

**D-017 Usage comes from the experimental usage call, on demand, with rate_limit_event as the fallback.** `rate_limit_event` arrives once per session start and when limits change. Besides the named window it carries `unifiedWindows` (not in `sdk.d.ts`) with the 5-hour and weekly numbers as 0 to 1 and epoch seconds. `usage.get` asks a live session's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`, which reports 0 to 100 and ISO times, converts it to the event units, and keeps the event data when no session is live or the call fails. Nothing polls. Recheck the method name when the SDK pin moves. KERNEL-6.

**D-018 Sessions never get an API key.** The session env drops `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, so Claude Code bills the Claude plan through its own login. If the init message still reports an `apiKeySource` other than `none` (an `apiKeyHelper` in settings, say), the chat gets a note and the room log a line. Verified live: `none` on CJ's Max plan. KERNEL-6.

**D-019 What the real transcript looks like.** Thinking comes back with empty text unless the session asks for `thinking: { type: 'adaptive', display: 'summarized' }`, so Kernel always does. Checked on Sonnet 5.5 and Haiku 4.5. The CLI sends a `system/init` at the start of every turn, and Kernel marks the chat running from it. An interrupt ends the turn with a `result` of `error_during_execution`, which Kernel hides behind the interrupted row. A follow-up sent mid-turn can join the running turn or run right after it. New chats pass their own `sessionId`, so Kernel knows the id before the first hook fires. KERNEL-6.

**D-020 Outside sessions start on their first hook.** Claude Code skips http hooks for SessionStart ("HTTP hooks are not supported for SessionStart", CLI 2.1.292). The hook server logs `session.start` when it first hears from a session id, and forgets the id on SessionEnd. The installer still writes a SessionStart entry, which does nothing. KERNEL-6.

**D-021 Fixture mode replaces the kernel, not the data.** With `KERNEL_FIXTURES=<Screen>` set, `src/main/index.ts` never constructs `Kernel`. `fixtureHandlers` answers every channel from an in-memory fixture, typed as the same `Handlers` map, so a new channel fails typecheck until fixtures answer it. Writes return a value and change nothing, so a shot is the same every run. userData moves to a temp folder, so Electron's cache never touches the real profile and a fixture run can sit beside a running Kernel. The harness makes one folder per launch and deletes it after the app exits; Kernel can't delete its own, because Chromium writes to it until the process ends. Manual `KERNEL_FIXTURES` runs reuse one `kernel-fixtures` temp folder. The harness launches Electron once per screen with `--force-device-scale-factor=1`, which matches the 1x canvas PNGs and keeps states from leaking between shots. A fixture exists only for a screen today's UI can show; the issue that builds a screen adds its fixture. KERNEL-7.

**D-022 useStore keeps shallow-equal results.** Selectors like `s.agents[roomId] ?? []` and `.filter(...)` return a new array on every read, and useSyncExternalStore re-renders whenever the snapshot changes identity, so every screen with data looped until React error #185. `useStore` now returns the previous result while the new one is shallow-equal. Found by the first fixture shots. KERNEL-7.
