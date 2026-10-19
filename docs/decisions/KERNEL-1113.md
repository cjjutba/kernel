**Kernel adds no guardrails of its own: agents work like Claude Code, limited only by the permission mode and the user's rules.** Replaces the go-ahead gates of KERNEL-678, KERNEL-992 and KERNEL-1079, and feat-lead-files-tracker-issues-only-with. Those made the Lead quote the user's words before it could hand off, build, file an issue or overrule a review, and kept the Lead away from Linear's and GitHub's issue writes in every mode, Bypass included. A Lead that couldn't set an issue's parent or blockers, or that refused work the user had clearly asked for, wasn't acting as a lead. The user's permission mode and the rules in Settings, Permissions already decide what runs without asking.

**Removed.**
- The go-ahead quote checks on `create_workspace`, `file_issue`, `start_build` and `overrule_blockers`, with their refusals and the repeat refusal. `go_ahead` is optional where it is still taken, and only kept as a record.
- `overrule_blockers` needing a turn the user started.
- Build here staying closed until a go-ahead. It now closes only in plan mode, the same as Claude Code's plan mode. `start_build` is optional.
- The Lead's tracker issue writes: hidden from Linear's and GitHub's MCP servers on Claude and Codex, and `gh issue` and `gh api` issue writes denied in Bash. The Lead has the same tools as a teammate. `file_issue` stays as a convenience.

**Kept, because each is the user's rule or a mode's meaning.**
- The permission modes, and Always ask, Never allow, protected branches, network access and Only in worktrees in Settings, Permissions.
- Hand off: the Lead hands work to teammates and doesn't edit files. Build here does the work itself, so `create_workspace` there only starts a review.
- Plan mode: Build here plans and doesn't edit, commit, push or open a pull request until plan mode is off.
- `merge_workspace` needs Settings, Pull requests, Let Kernel merge when you ask, and a turn the user started, which is what that setting says.
- The open-workspace limit from Settings, Models and effort and the project's Agents page.
- Reference folders stay read-only, a review chat stays read-only, and an agent file's `tools:` line still limits that agent.
- The "someone may already be on this issue" check, which the Lead passes with `confirm`.
