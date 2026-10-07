# Autopilot

Autopilot works the remaining Kernel v1 issues one at a time, from Linear to a merged PR, without CJ in the loop. It stops the moment something needs him. It ends after KERNEL-29. KERNEL-30 (signing and notarization) and KERNEL-31 (the end-to-end journey) need CJ and are not in the queue.

To start or restart it, open a fresh Claude Code session in this repo on `main` and say "Run the autopilot in docs/AUTOPILOT.md". That session is the coordinator. A restart picks up where the last run stopped, because the coordinator skips issues that are already Done.

## Queue

Work these in order. Never skip ahead: if one stops, the run stops.

| # | Issue | Title | Worker |
|---|---|---|---|
| 1 | KERNEL-8 | Contracts: every IPC channel, type, store slice and route | issue-worker-opus |
| 2 | KERNEL-9 | Design system in code: tokens (dark and light) and shared components | issue-worker |
| 3 | KERNEL-27 | First run: welcome, checks, setup failures, loading | issue-worker |
| 4 | KERNEL-20 | Rooms: new room, connect a repo, room setup, sidebar menus, remove | issue-worker |
| 5 | KERNEL-10 | Workspace layout, transcript, panels and file viewer | issue-worker |
| 6 | KERNEL-11 | Composer: paste and image chips, @ files, / skills, actions, queue, hunks | issue-worker |
| 7 | KERNEL-14 | Agent turn cards: plan, permission, question, interrupted, error, lead and hire | issue-worker |
| 8 | KERNEL-16 | New workspace modal: room, branch, from a PR or Linear issue, model, plan mode | issue-worker |
| 9 | KERNEL-17 | Home and Inbox | issue-worker |
| 10 | KERNEL-15 | Pull request flow, every state | issue-worker-opus |
| 11 | KERNEL-22 | Floor renderer, live statuses and room states | issue-worker |
| 12 | KERNEL-23 | Briefing sequence and walking on the floor | issue-worker-opus |
| 13 | KERNEL-21 | Search, account menu, Ask Rowan, History with restore, footer | issue-worker |
| 14 | KERNEL-18 | Board, tasks and task detail | issue-worker |
| 15 | KERNEL-19 | Team, agent profile, hiring and retiring | issue-worker |
| 16 | KERNEL-24 | Floor moments: questions, talk, overlap warnings, new hires | issue-worker |
| 17 | KERNEL-12 | Chat tabs, forks and the big terminal | issue-worker |
| 18 | KERNEL-13 | Checkpoints engine and drawer | issue-worker-opus |
| 19 | KERNEL-28 | Limits, failure banners and confirmations | issue-worker-opus |
| 20 | KERNEL-25 | Settings: shell and app-wide pages | issue-worker |
| 21 | KERNEL-26 | Settings: project pages and room overrides | issue-worker |
| 22 | KERNEL-29 | Light theme across every screen, floor included | issue-worker |

## Coordinator

The coordinator only coordinates. It does not read code, diffs, screenshots or long command output, so its context stays small for all 22 issues. Workers and theo do the reading and report back in a few lines.

Before the first issue, check once that `git status` is clean and `gh auth status` passes. If either fails, stop.

For each issue in the queue:

1. **Check the issue.** Fetch it from Linear. If it is Done, print `KERNEL-N | no PR | already done` and go to the next one. If it is In Progress or In Review, or `gh pr list --state open --search KERNEL-N` finds a PR, an earlier run left it half done. Stop and report.
2. **Reset to main.** Run `git checkout main && git pull --ff-only`. If the tree is dirty or the pull fails, stop.
3. **Hand it to a worker.** Start a fresh subagent of the type in the queue table with this prompt and nothing more: `Work KERNEL-N. Follow the Worker section of docs/AUTOPILOT.md.` Wait for it to finish. Don't poll.
4. **Read the result block.** Anything other than `RESULT: PR_OPENED` stops the run. Report the block as the worker wrote it.
5. **Review with theo.** Start the theo subagent with: `Review PR #P for KERNEL-N. Fetch the issue from Linear and read the diff with gh pr diff P. Check it against the acceptance criteria, CLAUDE.md and DESIGN.md. A blocker is only one of these: an acceptance criterion not met, a CLAUDE.md or DESIGN.md rule broken, a failing test, or a real bug. Everything else is a nit, however useful. Start your reply with "BLOCKERS: none" or "BLOCKERS: <count>", then list blockers (file, line, what to change, and which of the four kinds it is), then nits.` Only blockers count toward the merge. Keep every nit theo lists, from every review of this PR, for step 7.
6. **Up to two fix rounds.** If theo found blockers, send them to the same worker with SendMessage: `Theo found blockers on PR #P. Fix them following the Worker section of docs/AUTOPILOT.md (fix round):` followed by theo's blocker list. If the worker can't be resumed, start a fresh worker of the same type with that message. Then run theo again on the PR, fresh. If blockers remain, do one more fix round the same way. If any blocker remains after the second round, stop.
7. **File the nits.** If theo listed any nits, post them as one comment on the PR (`gh pr comment P --body-file`), then file one Linear issue for them in team Kernel, project "Kernel v1", with the same lane label as KERNEL-N, titled `Review nits from PR #P (KERNEL-N)`. Nits never block the merge.
8. **Merge.** Run `gh pr merge P --squash --delete-branch`. If it fails for any reason (conflict, checks, anything), stop. Then `git checkout main && git pull --ff-only`.
9. **Confirm Done.** Fetch the issue from Linear. Merging normally moves it to Done. If it hasn't moved, move it to Done yourself and add `(moved by hand)` to the status line.
10. **Print one status line** and go to the next issue:

   ```
   KERNEL-8 | PR #5 | merged
   ```

When the queue is empty, print the status lines for the whole run and say that KERNEL-30 and KERNEL-31 are next and need CJ.

### Stop rules

Stop the whole run and report. Never skip to the next issue. Stop when:

- `npm test`, `npm run typecheck` or `npm run build` still fails after two fix attempts (the worker returns `FAILED`)
- a merge conflicts or `gh pr merge` fails
- theo's blockers survive two fix rounds (the stop report lists each one with file and line)
- an issue needs a decision from CJ (the worker returns `NEEDS_DECISION`)
- a change would touch anything outside this repo (the worker returns `OUTSIDE_REPO`)
- the working tree is dirty, `git pull` fails, or an issue is already half done from an earlier run

A stop report says which issue, which rule, the PR number if there is one, the worker's or theo's detail as written, and what state is left behind: branch name, PR open or not, Linear status. Leave everything as it is so CJ can pick it up.

## Worker

`issue-worker` and `issue-worker-opus` follow this section. You work alone. CJ isn't watching, you can't start subagents, and nobody answers questions mid-run. CLAUDE.md applies in full except where this section says otherwise.

### New issue

The coordinator has already checked out an up to date `main`.

1. Fetch the issue from Linear. Move it to In Progress. Run `git checkout -b <gitBranchName>`.
2. Open every PNG listed under Screens, and the matching `design/canvas/project/<Screen>.dc.html` when you need an exact value. Read `DESIGN.md`, and `docs/DECISIONS.md` before changing anything deliberate. Read `docs/PRODUCT.md` if you haven't.
3. Plan, then post the plan as a Linear comment on the issue that starts with `Plan`. Don't wait for approval. List the files you'll touch, any shared contract change, the tests and fixtures you'll add, and any judgment call you're making.
4. Implement. Stay inside the files listed under Owns. A change to a shared contract (`src/shared/*`, `store.ts`, `App.tsx`) goes in its own first commit and gets called out in the PR. Add tests for engine behavior. Add a fixture in `fixtures/<lane>.ts`, keyed by PNG name, for every screen the issue builds.
5. Verify, in this order: `npm test`, `npm run typecheck`, `npm run build`, then `npm run shots -- <Screen> ...` and `npm run shots:compare -- <Screen> ...` for every listed screen. Open each `shots/compare/<Screen>.png` and fix differences a person would notice.
6. Set the issue's rows in `docs/SCREENS.md` to `done` and fill the Route and Component columns where they apply. Add a `docs/DECISIONS.md` entry for any new deliberate choice.
7. Commit with Conventional Commits, scoped to the lane, ending the subject with the issue: `feat(workspace): composer chips and queue (KERNEL-11)`. Push with `git push -u origin <branch>`.
8. Open the PR with `gh pr create`. The body references KERNEL-N and lists the acceptance criteria with a check or a cross each, what changed, any shared contract commit, the screens compared, and the results of the four commands. Note any place the PNG and DESIGN.md disagreed and which one you followed.
9. Comment a short summary on the Linear issue (what changed, screens compared, anything left over) and move it to In Review.
10. End with the result block.

### Fix round

You get a PR number and theo's blockers. Check out the PR's branch, fix every blocker, run all of step 5 again, commit (`fix(<lane>): address review (KERNEL-N)`) and push. Comment on the PR with what you changed for each blocker. End with the result block, using `PR_FIXED` instead of `PR_OPENED`.

### Fix attempts

If `npm test`, `npm run typecheck` or `npm run build` fails, you get two fix attempts: fix, rerun, and if it still fails, fix and rerun once more. If it fails a third time, stop and return `FAILED` with the command and the last lines of its error. Don't disable, skip or loosen tests to get green.

### When to stop instead of guessing

Return `NEEDS_DECISION` when the issue can't be built without a choice that belongs to CJ: the PNG and the issue contradict each other on behavior, an acceptance criterion is unclear in a way that changes what you build, or the work would reverse an entry in `docs/DECISIONS.md`. Give the question and the options you see. Small calls (naming, which component to reuse, a pixel difference between the PNG and DESIGN.md) are yours. Make them, write them in the PR, and keep going.

Return `OUTSIDE_REPO` when finishing the issue would touch anything outside this repo: another repo, global or user config, `~/.claude`, `~/Library/Application Support/Kernel`, Apple credentials, GitHub repo settings, or a global install. Linear comments and status changes on your own issue are fine. So is filing a Bug issue in Linear for an unrelated bug (CLAUDE.md), which you do instead of fixing it.

### Rules

- Never merge, never push to `main`, never force push. The coordinator merges.
- Never run the live test (`KERNEL_LIVE`). It needs CJ.
- Don't edit `.claude/settings.json` or `.claude/hooks/`.
- Keep temp files inside the repo under `shots/` (gitignored). Edits outside the repo are blocked.
- Write commit messages and PR bodies to a file under `shots/` and pass it with `git commit -F` and `gh pr create --body-file`. The guard checks the whole command text, so a body that quotes a blocked path or setting inline gets the command denied.
- If you start a dev server, start it detached (`nohup npm run dev > shots/dev.log 2>&1 &`) and stop it before you return.
- Give long commands an explicit timeout, up to 600000 ms.

### Result block

Your last message is this block and nothing else, at most 15 lines:

```
RESULT: PR_OPENED | PR_FIXED | FAILED | NEEDS_DECISION | OUTSIDE_REPO
ISSUE: KERNEL-N
PR: #P or none
SUMMARY: one to three lines on what was built or what went wrong
DETAIL: only for FAILED, NEEDS_DECISION and OUTSIDE_REPO. The failing command and its last error lines, the question and options, or what would be touched outside the repo.
```

## Guardrails

`.claude/settings.json` allows the routine commands so a run doesn't stall on a prompt: `npm`, `npx`, `node`, `git`, `gh pr` and the Linear MCP tools. It denies force pushes, pushes to `main`, `gh repo delete`, `gh repo edit`, edits to `~/.claude/settings.json` and `~/Library/Application Support/Kernel`, the `KERNEL_LIVE` test, and `rm -rf` on absolute, home or parent paths.

Permission rules can't say "outside this repo" or catch every spelling of a force push, so `.claude/hooks/guard.mjs` runs before every Bash, Edit and Write call and denies:

- an Edit or Write to any path outside the repo
- `git push` with `-f`, `--force*`, `--mirror`, `--all` or a `+` refspec
- `git push` to `main`, including a bare `git push` while on `main`
- `rm -r` on anything outside the repo, on the repo itself or on `.git`
- any command that sets `KERNEL_LIVE=` or mentions `~/.claude/settings` or `Application Support/Kernel`
- `gh repo delete` and `gh repo edit`

Both apply to the coordinator, the workers and theo, in every permission mode. See D-023.
