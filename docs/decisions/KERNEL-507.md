**A chat is unread from the moment one of its turns ends until the renderer shows it.** `Chat.unreadAt` holds when that turn ended. Unset means read.

Only a finished turn marks a chat. `onTurnDone` in `features/sessionDeps.ts` calls `markUnread` in `features/chats.ts`, so it comes from a real event and never from a timer. A turn the user stopped doesn't count, since they were watching it. That covers Stop, Send now and Retry now, which all interrupt the turn (`turn.interrupted`). Marking a chat that is already unread moves `unreadAt` to the latest turn's end.

Only the renderer clears it, by calling `chats.markRead` whenever the chat it shows has `unreadAt`. Main doesn't track which chat is on screen, so it marks every finished turn, the one on screen too, and the renderer clears that one right away. That keeps "on screen means read" in one place, and a chat that is open never stays unread, even with Kernel in the background. `markRead` on a chat that is already read changes nothing and pushes nothing, so the renderer can call it freely.

Both go through `saveChat`, so the existing `chat` push carries the change and nothing else needs a new event. Chats are JSON in `chats.data`, so there is no migration, and a chat saved before this has no flag and reads as read. KERNEL-507.
