**A Lead chat holds tabs, and its tabs share its workspaces and approved plans.** CJ wants one conversation with Rowan to span several tabs: a side question, a fork, a second plan. Each tab was its own chat, so a workspace handed off in one tab was "from another Lead chat" in the next, and a plan approved in one tab couldn't link a step from another. A `threads` table now holds Lead chats. The code calls one a thread so it doesn't clash with `Chat`, which stays one tab. Every Lead tab (kind `chat` in the Lead's workspace) has `threadId`. Big terminals and teammate chats have none. The upgrade (migration 4) gives every existing Lead tab, open or closed, a Lead chat of its own, titled like the tab and closed if the tab is. Nothing moves on upgrade, and an old fork stays apart from its source. The renderer sends no `threadId` until KERNEL-338 turns grouping on, so until then every new tab starts its own Lead chat and the app behaves as before.

A Lead chat's title follows its first tab's auto name until the user renames it with `threads.rename`, which sets `renamed`. Closing tabs never changes it. Closing the last open tab sets `closedAt` and pushes the chat. Closing one of two tabs doesn't. A new tab in a closed Lead chat opens it again.

Where a new Lead tab goes:

- `lead.start`: a new Lead chat.
- `chats.create` in the Lead's workspace: the Lead chat `threadId`, or a new one when none is given. A big terminal joins none.
- `forkChat` of a Lead tab: the source tab's Lead chat.
- `lead.ask`: the Lead chat `threadId`, or a new one.
- `linear.plan`: a new Lead chat.
- `leadChat` when the Lead has no open tab: a new Lead chat. The tab is "Lead", as before.
- Closing the last tab in the Lead's workspace: the replacement tab starts a new Lead chat.
- `sortOverlap`: unchanged. It still goes through `leadUpdateTarget`.

A new Lead tab is titled "New tab", and auto naming treats "New chat" and "New tab" as placeholders. /clear puts a Lead tab back to "New tab". A `threadId` that is gone or belongs to another room fails with "That chat no longer exists."

Ownership moves from the tab to the Lead chat. `w.leadChatId` stays the tab that handed the work off, so no saved row changes. `list_workspaces` says "yours" for work handed off in any tab of the caller's Lead chat, and `from Lead chat "<title>"` with the Lead chat's title for the rest. The same check covers `create_workspace`'s duplicate refusal and the note `message_agent` adds. `linkPlanStep` and Board tasks link from plans approved in any tab of the Lead chat, newest first. "Every task handed off in this chat has merged" counts the tasks of every tab.

`leadUpdateTarget` tries, in order: the owner tab while it's open, the newest open tab of its Lead chat, the owner's newest open fork from before tabs, and the room's first open Lead tab. The fork step only matters for forks the upgrade split from their source. New forks share the source's Lead chat, so the second step finds them first. When the work moves inside the Lead chat, the Team update says `From "<tab>", a tab you closed`. When it moves to another Lead chat, it says `From "<Lead chat>", a Lead chat that is now closed`. The card's row carries `fromTab` for the first form, and the renderer reads both forms back from an update's lines. The loop guard reset in `userSpoke` follows the same target, so writing in the tab that took the work over resets it, and writing in another Lead chat doesn't.

`read_plans` is a new Lead tool. It returns the plans approved in every tab of the caller's Lead chat with the tab's title, the approval time and the plan text, newest first. `LEAD_RULE` tells Rowan to call it before answering about the chat's work, and names both "From" lines.

Amends D-101 (ownership and routing by Lead chat, not by tab), D-133 (Ask Rowan's tab starts a new Lead chat unless `lead.ask` names one) and D-139 (a workspace belongs to a Lead chat, not a tab, so the sidebar groups by Lead chat once KERNEL-338 draws it). KERNEL-337.
