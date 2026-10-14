---
description: Work a Linear issue end to end, for example /issue KERNEL-14
argument-hint: KERNEL-<number>
---
Work Linear issue $ARGUMENTS from start to finish, following CLAUDE.md.

1. Fetch $ARGUMENTS with the Linear MCP. Move it to In Progress. In a Kernel workspace, stay on the branch Kernel created. Otherwise check out a branch named `<type>/<key>-<a few words>`, with `fix` for the Bug label and `feat` otherwise, 60 characters at most.
2. Read the screenshots or mocks in the issue or brief. They are the spec for the task. Without one, match the current app and DESIGN.md.
3. Make a plan and show it to me before editing. Respect the issue's Owns list and the lane rules.
4. Implement. Add tests for engine behavior.
5. Verify: pnpm test:changed, pnpm typecheck, then `pnpm shots <Screen>` for each changed screen. Look at the shots, fix what a person would notice and share the shot. The PR's Test check runs the full suite, so don't run pnpm test yourself unless you are reproducing a CI failure or changed the test setup.
6. Write the release-note fragment: a file in .changes/unreleased/ named after the change, with `type` and `issue: $ARGUMENTS`, and one sentence about what a user will notice. Follow the rules in .changes/README.md. Use `type: internal` when users won't notice.
7. Commit (Conventional Commits), push, and open a PR with gh that references $ARGUMENTS, lists the acceptance criteria with checkmarks, links the shots, and fills the Release note line of the PR template.
8. Comment a short summary on $ARGUMENTS in Linear and move it to In Review.
