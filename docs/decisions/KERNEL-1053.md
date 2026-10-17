**A shared chat's working copy is made when its first message is sent in Build here, not when the mode is picked.** Clicking Build here is cheap to undo and easy to do by accident, and a worktree, its setup and its ports are not. `lead.setMode` is synchronous again and only records `leadMode`. Going back to Hand off leaves nothing to clean up.

`setMode` still checks that a copy could be made, so the user hears the reason at the click: with Workspace type Current branch and "One current-branch workspace per project" on, another chat holding the checkout makes it throw, and the chat stays in Hand off. The send checks again, since the checkout may have been taken in between.

The user's send (`Lead.send`, called by `chats.send`) in a shared chat that is in Build here holds the message in the chat's queue, marks the record `worktreePending: { fromShared: true }` and runs the same cut as before (`ownFolder`, `Workspaces.cutOwnWorktree`, the spare claim). A send while a turn runs is held the same way, and the copy starts when that turn ends. Once the copy is ready the held message goes in whatever mode the chat is in by then, so switching back to Hand off mid-creation keeps the copy and doesn't abort. A Build here turn never runs on the shared folder.

A failed copy no longer falls back to the shared folder with a note. The message stays held, the record is `failed` and carries the reason in `worktreePending.error` (with `fromShared`). `lead.retryCopy` makes the copy again. `lead.sendAsHandoff` returns the chat to the shared folder in Hand off and sends the held message. A failed setup after the copy exists behaves as for a new chat, with Run again.

A quit in the middle resumes at the next start: the held messages come back (`Lead.resumeCopies`, before `recoverSetups`, which would otherwise fail the record), the copy is finished and the message goes, or the failure is recorded.

`firstInProject` is stamped on every new record: true only for the first chat of a project that had no other chat or workspace, open or archived (`Workspaces.isFirstInProject`), false otherwise. A shared chat's copy keeps the stamp it started with. A record without it, from before, reads as not first.

Amends KERNEL-1051. KERNEL-1053.
