**Every view opens where it was left, and the spot survives a restart.** Amends KERNEL-765, which kept a chat's spot only until Kernel restarted. Spots now live in `ui/keptScroll.ts` and are written to localStorage (`kernel.keptScroll.v1`) a moment after they change. Inbox and Pull requests use it first, and the series applies it to the rest.

The contract every view follows:

- A spot is the item at the top of the view and the offset into it, two items above as fallbacks, then the raw position. Rows carry `data-keep-id`. Leaving and coming back lands on the same pixel.
- A view restores before paint with no animation, only once its data is ready. A view that never restored never saves, and one still correcting doesn't save.
- The reader's wheel, touch, scroll keys or scrollbar stop a restore at once. A view going somewhere on purpose (a notification, a search result, Inbox j and k) skips the saved spot.
- Within 2px of the end counts as the end, and a view left there reopens at its new end. A view shorter than the spot goes to its end and keeps the saved spot until the reader moves.
- Each filter or sort keeps its own spot under its own key (`prs:open`, `issues:<projectId>`, `panel:<workspaceId>:changes`, `chat:<chatId>`), and a key with no spot starts at the top.
- At most 300 spots, least recently used dropped first. Spots of archived or deleted projects, workspaces and chats are dropped at startup and while Kernel runs, by watching the store. A kind the store hasn't loaded yet drops nothing.
- Every localStorage read and write is in try and catch, and a different stored version is ignored.
- Modals, menus, pickers and the command palette open fresh.

A caller that finds its own anchors (the chat transcript, KERNEL-922) saves through `setSpot` and may put its own payload in `data`. The horizontal axis is supported for code and diff views (KERNEL-921).
