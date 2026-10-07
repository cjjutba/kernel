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
