# KERNEL-1093: setup and worktree failures are toasts

Amends KERNEL-951, KERNEL-1012, KERNEL-1053 and KERNEL-1086.

- A setup run that doesn't pass (`setup.failed`) is a toast: "Setup script failed", "Setup script timed out" or "Setup stopped". It names who keeps working, carries the chat's title as a third line, and offers Rerun setup, plus Open Setup tab unless you stopped it by hand. The banner above the box and the red row in the chat are gone, because setup never holds a message and an error is never an inline row.
- A worktree git can't make (`worktree.failed`) is a toast with git's line and Try again. The message stays in the chat as Not sent. A Lead chat that started on the shared folder also offers Send as Hand off. No inline row.
- The chat's setup block is only for a project's first chat, only before its first message: a right-side bubble, then plain rows for the branch, the worktree and the setup script. Sending the first message clears it. A finished or failed run reads as one quiet row there, and the log is one click away. Later chats show no rows.
- Run again and Send anyway stay only on a message an older Kernel held for setup, as quiet links next to Not sent.
- The Session rail isn't built yet, so its setup stage is left to the part that builds it. `workspace.setupRun` stays on the workspace for it.
