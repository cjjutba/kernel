# KERNEL-999: terminal seats get their signals from hooks

Amends D-088 and extends D-089.

- The hook command sends `X-Kernel-Chat: $KERNEL_CHAT_ID`. The hook server maps it to the seat's chat only when that chat is an open terminal in a live workspace. Anything else is treated as before, by cwd.
- `UserPromptSubmit`, `PermissionRequest` and `Stop` drive working, needs and idle for a seat. Kernel pushes `chat.running` and `busyTerminals` counts a working seat, so D-088 no longer treats a connected seat as unknowable. The tab icon and the close confirmation use it once the renderer reads it.
- The user's latest prompt is kept in memory and only while its turn is open (until `Stop` or `SessionEnd`). `go_ahead`, `start_build`, merge and overrule check against it. A restart starts with nothing seen.
- Fail closed: a seat's gated tools refuse with a plain reason when no prompt is open or hooks are off or not installed. Reviews are exempt, as for any chat.
- `session_id` and `transcript_path` are saved on `Chat.terminal`, so D-089 titles work for seats and the next `claude` resumes the session.
- An accepted `ExitPlanMode` (`PostToolUse`) is saved as an allowed plan approval, which `read_plans` and the "after an approved plan" rules already read.
- `ask_user` in a seat tells the agent to use AskUserQuestion. Its `PostToolUse` settles the `about` ids.
