**A task that spans two repos runs as linked rooms: one workspace in each repo's room, built by that room's agent, paired by a wait that holds the second PR's merge until the first one merges.** The maintainer put tasks across two repos in scope for the Linear project "Kernel for other users", and its Implementation plan made this spike F1. This spike compared two shapes against origin/main da63e1db, the pinned Agent SDK 0.3.292 and Codex 0.153.4:

1. Linked rooms. Each repo stays its own room. The user links the two rooms, a chat with Kernel in one of them hands off a workspace in each, and a wait pairs the two workspaces.
2. One workspace spanning two worktrees. The workspace keeps its worktree in its own repo and gets a second one in the other repo. Claude reaches the second through `additionalDirectories`, and Codex through an extra writable root.

Linked rooms wins because Kernel keys everything it knows about a repo to a room, and everything it knows about a PR to a workspace with one worktree. A room holds the checkout (`Room.path`), the remote and default branch, the team in `.claude/agents`, the chats with Kernel, the scripts and `files.copy` list the user trusted (KERNEL-209), `[env]`, the branch pattern, `[pr]` settings, the worktree folder and the room's Always allow rules. The plan adds a permission mode (A6), a tracker (C1b) and a code host (E1) per room. A workspace holds one `path`, `branch`, `baseRef`, `prNumber` and `prState`, and the PR poll, the PR band, Merge, Merge all, reviews, waits, auto-archive and checkpoints all read those fields.

Linked rooms reuses all of that unchanged, because each half is an ordinary workspace in an ordinary room. Shape 2 has to answer "which room's?" for every room setting and "which PR?" for every PR read. At da63e1db, `src/main` reads `path`, `branch`, `baseRef`, `prNumber` and `prState` off a workspace about 300 times across 27 files, and the renderer about 100 times. The second repo also needs its remote, scripts, trust and env from somewhere, which means it has to be a room anyway.

Shape 2 has one real advantage. One agent holds both sides in one context, so an API change and its client land as one piece of work with no hand-over between agents. Linked rooms gets part of that back. Kernel writes the contract between the halves (the endpoint, the type names) into both briefs, and F6 lets a paired teammate read its partner's worktree. If pairs turn out too chatty, shape 2 can come later on top of linked rooms. The partner workspace would still own its branch, PR, setup and archive, and only who edits it would change.

Out of scope: two branches of one repo, packages inside a monorepo, and more than two repos. Links and waits both take lists, so three linked rooms should work the same way, but nothing here tests it. KERNEL-442.

**How each shape handles the parts of a two-repo task.** The comparison below reads the code at da63e1db. Where it says "today", `test/waits.test.ts` ("a wait on work in another room") pins the behavior.

**Branch names.**
- Linked rooms. Each half is a normal hand-off, so each room names its branch with its own pattern from the same issue key and title (`taskBranch`). With the same pattern, both read `feat/kernel-500-invoice-export`. A name already taken in one repo gets a suffix in that repo only (`freeBranch`). Nothing depends on the two names matching, because the pair is a wait on workspace ids. Kernel can still pass `branch` to both hand-offs.
- One workspace. Two branches made in one step, one per repo, from one name. `Workspace.branch` holds one of them, so the other needs a new field. `syncBranch`, which reads the branch an agent actually has checked out (KERNEL-68), has to run in both worktrees.

**Two PRs and how they reference each other.**
- Linked rooms. Each workspace opens its own PR from its room's `create-pr.md`, and Kernel polls and shows it as it does today. The PR opened second names the first in its body ("Pairs with acme/api#12 for KERNEL-500"), because Kernel adds the partner's PR to the create-PR instructions once it exists. GitHub shows that mention in the first PR's timeline. Once both PRs exist, Kernel appends the same line to the first PR's body, so each body links the other. That body edit is a new GitHub write, and it goes through E1's `hostFor(room)`.
- One workspace. The same two PRs, owned by one record with one `prNumber` and one `prState`. Every PR path needs a second slot or a list: `refreshPr`, `nextState`, the poll's backoff, `guardOnReady`, `mergePr`, `mergeBlock`, `createPr`, `resolvePr`, ready and reopen, `prNote`, the PR band, the Lead's PRs tab (KERNEL-354) and Merge all (KERNEL-411). The band shows one state, and there is no state for "api ready, web failing checks".

**Merge order, and what happens when one PR merges and the other doesn't.** A wait today either holds the brief (`held: true`) or tells a teammate that already started to rebase once its target merges (`held: false`). Neither holds a merge. `mergeBlock` never reads `waitsFor`, so a started teammate that waits can merge before its target.
- Linked rooms. The repo the other depends on merges first: the API before its client, the library before its consumer. Kernel hands off the second half with `merge_after` the first. That half gets its brief now and builds against the first half's branch, and `mergeBlock` refuses its merge with "Merges after PR #12 in api" until #12 has merged. The Merge button, Merge all and `merge_workspace` all go through `mergePr`, so all three hold. Kernel can't stop a merge made on GitHub, so a merge out of order gets a note on both halves and a Lead update.
  - First merged, second still open. This is the expected state between the two merges. The second hears "PR #12 in api merged", with no fetch or rebase, since the merge landed in another repo. When its repo pins the other one (a package version, a submodule, generated types), the brief already said what to bump.
  - First merged, second closed or archived without merging. The first repo's main now holds a change nothing uses. Kernel tells the Lead, and the Lead asks the user whether to revert it with a new hand-off in the first room or keep it. Kernel never reverts on its own. Kernel's instructions ask for a first half that doesn't break the other repo's main by itself, so keeping it is safe.
  - First closed or archived without merging. The second half's wait breaks and Kernel hears it, as a wait inside one room does today. `breakWait` already reaches a waiter in another room. The merge stays held until Kernel or the user ends the wait with `wait_for_merge` and an empty list.
  - A second half that can't even start before the first merges, such as one that installs a published package, uses today's `wait_for`, which holds the brief, across rooms.
- One workspace. One Merge merges both PRs, the first and then the second, and stops when the second can't merge. That stop is common: the first merge moves nothing in the second repo, but the second's checks may still be running or failing. The workspace is then half merged. `isMerged` (`prState === 'merged'`), auto-archive (`archiveMerged`, which runs on a `merged` event), waits and the archive guard all need a meaning for that state. A second PR that closes leaves one record both merged and closed.

**How Kernel plans and hands off.** Kernel's tools see one room today. `leadToolDeps(roomId)` builds `agents`, `workspaces`, `createWorkspace`, approvals and plans from that room, and `waitRefusal` resolves wait targets among that room's workspaces only.
- Linked rooms. The chat with Kernel lives in the room the user started it in.
  - `create_workspace` takes `room`, a linked room's name, and picks the agent from that room's team. The workspace opens there with this chat as its `leadChatId`, under that room's trust, setup and agent cap.
  - `list_agents` and `list_workspaces` show linked rooms' agents and workspaces under their room's name. `wait_for` and `wait_for_merge` take a room-qualified ref like `api#12`.
  - The plan's steps name agents from both teams ("Add the invoices endpoint · Ivy (api)").
  - Kernel adds a pair section to each brief: the partner's room, repo, branch and worktree, who builds it, and the merge order.
  - Updates from the other room's half already reach the chat that handed it off, because `leadUpdateTarget` finds that chat by its id in any room. The Team update reads one room's workspaces for its list of handed-off work, and has to read linked rooms too.
  - The duplicate-issue guard (KERNEL-287) stays per room, so one issue can have one open workspace in each room of a pair. C5's "someone else is already on it" check has to count the partner as the same task.
- One workspace. One `create_workspace` names the second repo, with one agent and one brief that names both paths. It's the simpler hand-off of the two. The agent comes from the first room's team, though, and the second repo's own instructions never reach it (see the runners below).

**What the workspace panel shows.**
- Linked rooms. Each half keeps its panel as it is: Changes, All files, Checks, Run and the PR band. The panel gains a pair row with the partner's room, branch and PR state, which opens the partner's workspace. The Merge button's reason reads "Merges after PR #12 in api". Wait labels name the room ("PR #12 in api by Ivy"). The Lead's PRs tab lists one room's PRs and has to show a linked room's half under its room's name. None of this has a PNG, so Lumi draws it first (F7).
- One workspace. Every tab needs a repo switch or two sections. Changes, the diff, hunks and commit (`workspaces.changes`, `diff`, `hunks`, `commit`), All files and the file search read `ws.path`. The Checks tab reads one PR. Run and Setup run one room's scripts on one port block. The terminal and Open in (KERNEL-427) open one folder. A checkpoint snapshots one worktree (`worktreeTree(ws.path)`), so Revert would roll back one repo and leave the other. The PR band needs two capsules.

**Archive and cleanup.**
- Linked rooms. Each half archives on its own merge (`archiveMerged`), with its room's archive script, branch rules and trash. Archiving one half while the other is open already breaks the other's wait and tells Kernel (`breakWait` with `archived`). Delete in History already skips a workspace that another one waits on, in any room, because `planDelete` reads `waitersOn` across all rooms. The only new rule is that unlinking two rooms refuses while a pair between them is open.
- One workspace. Archive removes two worktrees in two repos, runs two archive scripts under two rooms' trust, and deletes or keeps two branches with two unpushed counts. The archive confirmation shows two git statuses. Restore and Delete in History do the same in reverse. Auto-archive has to wait for both PRs.

**Which of today's code paths each shape touches.**

Linked rooms:
- worktrees. Nothing. Each half is one worktree in its own repo.
- waits. `settleWait` reads each target by id instead of from the waiter's room. Today it checks `waitMet` against the waiter's room only, so a target in another room never counts as merged, even though `onTargetPr` finds the waiter across rooms. `resolveTarget`, `waitRefusal` and `waitTargets` take linked rooms' workspaces and room-qualified refs. A release for a target in another room skips the fetch and fast-forward and says so in its own words. A teammate's own `wait_for_merge` (`teammateToolDeps`) reads linked rooms too. New: `WaitsFor.merge`, a wait that holds the merge and not the brief.
- prs. `mergeBlock` reads the merge wait. `createPr` adds the partner's PR to the instructions. Kernel edits the first PR's body through the code host once both exist, and notes a merge out of order.
- kernelMcp. `create_workspace` takes `room` and `merge_after`. `list_agents`, `list_workspaces`, `wait_for` and `wait_for_merge` cover linked rooms. `LEAD_INSTRUCTIONS` gains a sentence on pairs.
- lead. `leadToolDeps` reads the chat's room and its linked rooms. Plan steps parse both teams.
- leadUpdates. The Team update's handed-off list covers linked rooms. Two new events: one half merged while the other closed, and a merge out of order.
- runners. Nothing for the pair itself. F6 lets a paired teammate read its partner's worktree without a card, if live checks 1 and 2 show it gets one now.
- rooms. `Room.links`, and channels to link and unlink.

One workspace:
- worktrees. `createWorktree`, `freeBranch` and `detachWorktree` run twice, in two repos, under one of the two rooms' worktree folders.
- workspaces and setup. `cutWorkspace` and `setUpWorkspace` cover two repos, with two rooms' trust, scripts, `files.copy` and `[env]`. `changes`, `diff`, `hunks`, `tree`, `files` and `commit` run per repo.
- prs. A second PR slot through every function listed under Two PRs.
- waits. `isMerged` needs a meaning for a half-merged workspace.
- kernelMcp and lead. `create_workspace` names the second repo.
- runners. Claude gets `additionalDirectories: [second worktree]`. Codex's `writableRoots` gets the second worktree and the second repo's git common dir. Under KERNEL-436's draft, that common dir would be a second writable `.git/hooks`, and A10's Claude sandbox would need both paths in `allowWrite`. `agentPrompt` tells the agent to stay inside one path.
- checkpoints, autoArchive, archive, history, baseWatch, overlaps and reviews each read one worktree or one PR.
- renderer. The PR band, the panel tabs, the Lead's PRs tab, the archive confirmation and the sidebar's diff totals.

**The runners under shape 2 drop the second repo's own instructions.** The pinned SDK has `Options.additionalDirectories?: string[]`, "Additional directories Claude can access beyond the current working directory". It adds a working directory, not a project. Settings, hooks, agents, skills and `.mcp.json` still come from `cwd`, or from `projectConfigRoot` in a Lead worktree. So the second repo's `CLAUDE.md`, `.claude/agents` and hooks wouldn't govern work inside it, which breaks the project's rule 4 (an agent file behaves the same in Kernel as in Claude Code). Codex reads the `AGENTS.md` files between the project root and its `cwd`, so it would miss the second repo's file as well. Live check 4 covers this, and none of it blocks linked rooms. KERNEL-442.

**Live checks.** Agents can't run live tests (D-023), so these wait for the maintainer's run, before the ticket named:
1. Before F6, Claude. Does the pinned CLI (2.1.292) call `canUseTool` for Read, Grep and Glob on a file outside `cwd`? If it does, a paired teammate reading its partner's worktree gets a card on every read today.
2. Before F6, Codex. Does a file read outside `cwd` under `workspace-write` go through without a request? KERNEL-436's draft says both sandboxes let commands read everywhere. Codex reading through its own file tools is the case to check.
3. Before F4, GitHub. Does a mention of `owner/repo#n` in one PR's body show in the other PR's timeline, both when the two repos share an owner and when they don't? Does `gh pr edit --body-file`, run from the first half's worktree, work with the scopes `gh pr create` already needs?
4. Only if shape 2 comes back. Does `additionalDirectories` load the added directory's `CLAUDE.md` (Claude Code documents an environment variable for that) and skills? Does Accept edits accept an edit there without asking? Does Codex accept a second repo's git common dir as a writable root and commit there?

**Implementation tickets to file.** F tickets follow the plan's rules: one lane each, contract fields as a first commit in the ticket that needs them, and a Lumi design ticket before UI with no PNG.

**F2. Link two rooms** (Engine, new)
- **Contract, first commit.** `Room.links?: string[]` (room ids, kept the same on both rooms), and `rooms.link` and `rooms.unlink` in `ipc.ts`.
- **Rules,** in `features/rooms.ts`. Linking refuses the room itself, an archived room, and a folder with no commit. Unlinking refuses while a pair between the two rooms is open. Archiving a room unlinks it.
- **Tests:** `test/rooms.test.ts`, with two temp repos.

**F3. Wait for a PR in a linked room** (Engine, new)
- `settleWait` reads each target by id. `resolveTarget`, `waitRefusal` and `waitTargets` take linked rooms' workspaces, and `api#12` names PR #12 in the linked room `api`. A room with no link stays refused.
- A release for a target in another room skips the fetch and fast-forward, and says "PR #12 in api merged." instead of asking for a rebase. Labels name the room.
- A teammate's own `wait_for_merge` (KERNEL-262) covers linked rooms.
- **Tests:** flip the first two cross-room tests in `test/waits.test.ts`, and add to `test/teammateWait.test.ts`.

**F4. Hold a paired PR's merge until its partner merges, and link the two PRs** (Engine, new)
- **Contract, first commit.** `WaitsFor.merge?: true`, a wait that holds the merge and not the brief.
- `mergeBlock` refuses while a merge wait's target hasn't merged: "Merges after PR #12 in api." The Merge button, Merge all and `merge_workspace` go through it.
- A half seen merged on GitHub while its merge wait is open gets a note on both halves and a Lead update. A half that merged while the other closed or was archived gets a Lead update asking Kernel to offer a revert or keep it.
- `createPr` adds the partner's PR or branch to the instructions. Once both PRs exist, Kernel appends "Pairs with acme/api#12" to the first PR's body through `hostFor(room)`.
- **Tests:** `test/merge.test.ts`, `test/waits.test.ts`, `test/leadUpdates.test.ts`.

**F5. Hand off into a linked room** (Engine, new)
- `create_workspace` takes `room` and `merge_after`. The agent comes from that room's team, and the workspace opens there with the handing-off chat as its `leadChatId`.
- `list_agents`, `list_workspaces`, `wait_for` and `wait_for_merge` cover linked rooms, each line naming its room. Plan steps parse agents from both teams.
- Kernel adds the pair section to both briefs.
- The duplicate-issue guard allows one open workspace per room for the same issue, and C5's check counts the partner as the same task.
- The Team update lists handed-off work in linked rooms.
- `LEAD_INSTRUCTIONS` says a task across linked rooms is two hand-offs, the first half must not break the other repo's main by itself, and the second half takes `merge_after`.
- **Tests:** `test/handoff.test.ts`, `test/waits.test.ts`, `test/leadUpdates.test.ts`.

**F6. Let a paired teammate read its partner's worktree** (Engine, improved)
- On Claude, Read, Grep and Glob under the partner's worktree pass without a card. Edit and Write there still ask.
- On Codex, the same for its file reads, if live check 2 shows a request.
- `agentPrompt` names the partner's worktree as read-only.
- If live checks 1 and 2 show no card on either provider, close F6 and move the prompt line into F5, as the plan does with A2.
- **Tests:** `test/sessionRunner.test.ts`, `test/codexRunner.test.ts`.

**F7. Draw linked rooms and a paired workspace** (Lumi)

PNGs for:
- the linked rooms row on the room page, and its picker
- the pair row in the workspace panel, with the partner open, merged and closed
- the Merge button held by "Merges after PR #12 in api"
- a wait note and the Lead's PRs tab with a linked room's half
- the Lead update for a pair where one half merged and the other closed

**F8. Link rooms on the room page** (Platform, new). F7's row and picker on `Room.tsx`.

**F9. Show the pair in the workspace panel and the Lead's PRs tab** (Workspace, new). F7's pair row, the held Merge button's reason, and the PRs tab rows.

| Id | Title | Lane | Type | Blocked by |
|---|---|---|---|---|
| F2 | Link two rooms so one task can span both | Engine | Feature | P0 (KERNEL-432) |
| F3 | Wait for a pull request in a linked room | Engine | Feature | F2, C1c (KERNEL-470) |
| F4 | Hold a paired pull request until its partner merges, and link the two | Engine | Feature | F3, B6 (KERNEL-468) |
| F5 | Hand off into a linked room from a chat with Kernel | Engine | Feature | F3, F4, D4 (KERNEL-487) |
| F6 | Let a paired teammate read its partner's worktree | Engine | Improvement | F5, A10 (KERNEL-458), D5 (KERNEL-475) |
| F7 | Draw linked rooms, the pair row and a merge held for its partner | Workspace | Feature | none |
| F8 | Link rooms on the room page | Platform | Feature | F2, F7, B8 (KERNEL-485) |
| F9 | Show a paired workspace in its panel and the Lead's PRs tab | Workspace | Feature | F3, F4, F7 |

The non-F blockers come from the plan's shared-file order, which these tickets join at the end:

| File | Tickets, in order |
|---|---|
| `services/waits.ts`, `features/waits.ts` | C1c, F3, F4 |
| `features/prs.ts` | E1, B6, F4 |
| `services/kernelMcp.ts` | C4, C5, D4, F5 |
| `services/providers/claude.ts` | A1, A3, A4, D5, D6, A10, F6 |
| `services/providers/codex/runner.ts` | A1, A3, A4, D5, F6 |
| `Room.tsx` and room setup (Platform) | C3b, E5, B8, F8 |

`merge_after` would also help two workspaces in one room where one has to land first. None of these tickets builds toward that, but F4 allows it.

**Verify F.** Use two side projects, `api` and `web`, linked. Kernel plans one task across both and hands off a half in each room. web's Merge button says it merges after api's PR, and merging api frees it. In a second run, web's PR closes after api merged, and Kernel reports the half-merged pair and offers a revert. KERNEL-442.
