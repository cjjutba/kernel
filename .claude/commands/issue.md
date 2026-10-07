---
description: Work a Linear issue end to end, for example /issue KERNEL-14
argument-hint: KERNEL-<number>
---
Work Linear issue $ARGUMENTS from start to finish, following CLAUDE.md.

1. Fetch $ARGUMENTS with the Linear MCP. Move it to In Progress. Check out a branch named with its gitBranchName.
2. Read every screen PNG it lists in design/screens, and the matching design/canvas/project/<Screen>.dc.html where you need exact values.
3. Make a plan and show it to me before editing. Respect the issue's Owns list and the lane rules.
4. Implement. Add tests for engine behavior.
5. Verify: npm test, npm run typecheck, then the screenshot harness for each listed screen compared with its PNG. Fix what a person would notice. Use the ivy subagent for this and the theo subagent to review before the PR.
6. Commit (Conventional Commits), push, and open a PR with gh that references $ARGUMENTS, lists the acceptance criteria with checkmarks, and links the compare images.
7. Comment a short summary on $ARGUMENTS in Linear, move it to In Review, and update its rows in docs/SCREENS.md.
