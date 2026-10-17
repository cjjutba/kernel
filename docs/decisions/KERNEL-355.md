**Each room's Lead works in its own worktree, detached at the latest main, instead of the main checkout.** The maintainer runs `pnpm dev` from the checkout, so anything Kernel ran there reloaded the app. The Lead's Changes tab also listed whatever was untracked in the checkout (KERNEL-350). There is one worktree per room, not one per Lead chat: Ask Kernel opens a new Lead chat for every question (D-133), and a worktree per chat would mean a checkout and a link step per question.

The worktree lives at `<worktreeRoot>/<room slug>/lead`, or `lead-2` when another room with the same name has that folder. It is `git worktree add --detach` at `<remote>/<default>` as last fetched, or at the local default branch when the remote doesn't have it. The record is `mode: 'worktree'`, `lead: true` (KERNEL-353), `branch: 'HEAD'`, that `baseRef` and a port. It gets the `node_modules` link when the room asks for it, and no setup script, no copied files and no trust prompt. A room that isn't a git repo or has no commit yet keeps its Lead on the checkout, as before. One creation promise per room means a brief, Ask Kernel and the sidebar's Lead row arriving together make one worktree. KERNEL-181 keeps the worktree on the latest main; this issue only places it.

Existing rooms move once, at startup, after the agents load and before any chat carries on, without fetching. Kernel makes the worktree, or uses the one a move cut short already made. It copies `.kernel/plans/` into it, without overwriting, since current-branch teammates write plans there too. It deletes the Lead's checkpoint refs, which were snapshots of the checkout, and clears `baselineRef`. Then it saves the record. A room whose move fails logs a warning, stays on the checkout and tries again at the next start. A retry uses the worktree a cut-short move left, at `lead` or `lead-2`, instead of making another.

A Lead worktree whose folder was deleted outside Kernel is made again at the same path, from the latest base as last fetched, the next time the Lead is needed or at the next start. git still lists such a folder until a prune, so Kernel doesn't count a listed path with no folder as a worktree, and prunes before it adds the worktree again. Without this, every Kernel chat would fail until the room was removed, since archive refuses the Lead.

Lead chats need nothing. KERNEL-348 found that the SDK finds a session from the worktree by its id, so a Lead chat started before the move resumes there and remembers its earlier turns. A resumed session keeps appending to its transcript in the checkout's project folder, and new Lead chats save theirs in the worktree's. `listSessions` and `getSessionInfo` see both folders from either path, so chat names and History keep working. Kernel moves and copies no `.jsonl`.

Lead sessions pass `projectConfigRoot: room.path`. KERNEL-348 confirmed that with it the session takes `.claude/settings.local.json`, `.claude/agents`, `.mcp.json` and `CLAUDE_PROJECT_DIR` from the checkout, and the per-project state in `~/.claude.json` follows either way. Without it, the CLI loads both the checkout's and the worktree's `settings.local.json` in a worktree session and runs hooks twice. Teammates don't get it: their worktree's own config is the branch they work on. The Lead's prompt gets its own line ("your own git worktree ..., detached at origin/main, not on a branch") instead of the main-checkout line. The Lead reads the room's `[env]` files from the checkout, since nothing is copied into its worktree.

The Lead's workspace can't be archived except by removing its room, and archive never runs `git branch -D` for it: its branch is `HEAD`. Fork into new workspace refuses it too.

What changes once the Lead is off the checkout:

- `oneCurrentBranchPerRoom` no longer counts the Lead, so one current-branch teammate can use the checkout.
- The maintainer's own `claude` sessions in the checkout no longer resolve to the Lead in `resolveCwd`. They count as the room's, with no agent.
- Lead terminals get the skip-permissions flag of presets marked `onlyInWorktrees`, and the "Bypass in worktrees" permission mode now covers the Lead.
- The checkout's untracked files no longer show in the Lead's Changes.
- The workspace header reads `lead` and "latest main". The Team screen, the floor card and the agent profile show the Lead's workspace as `lead` instead of "main checkout". The Team canvas still says "main checkout"; KERNEL-356 redrew only the Lead screens.

Amends KERNEL-336 and D-139: the Lead's workspace those place in the sidebar is now this worktree. KERNEL-355.
