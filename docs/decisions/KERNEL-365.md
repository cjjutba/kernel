**Only the user starts a chat with the Lead, and a Team update with no open Lead tab opens the chat that handed off the work.** KERNEL-336 says only ⌘N and the + on a room start a chat with Rowan. The engine still started one in two places. Closing the last tab in the Lead's workspace added a "New tab" in a new Lead chat, and `lead.open` called `leadChat`, which added a "Lead" chat to any room with no open tab. Home, the Inbox, the agent page's room crumb, room setup, ⌘⇧L and the sidebar all go through `lead.open`.

This changes KERNEL-337's list of where a new Lead tab goes:

- Closing the last tab in the Lead's workspace: no new tab. The Lead chat closes as before. A teammate's workspace still gets a "New chat" in place of its last tab.
- `lead.open`: no tab. It returns the Lead's workspace and still creates the workspace the first time.
- A Team update that needs the Lead when no Lead tab is open: a new tab in the Lead chat that handed off the work, which opens that chat again, so its sidebar row comes back. When the owner tab has no Lead chat, or no tab handed the work off, a new Lead chat. The update says `From "<tab>", a tab you closed` (or names the closed Lead chat), like any update that moves to another tab.

`leadChat` still opens a Lead chat when none is open. Kernel's own sends use it and need somewhere to land: `rooms.brief`, `sortOverlap` and a comment on a file shared in the Lead's workspace.

Before, an update with no open Lead tab was dropped. CJ decided it should bring back the chat it belongs to. `leadUpdateTarget` still never creates a tab, because `userSpoke` calls it. LeadUpdates gets a separate `open` dep (`Lead.openUpdateTab`). It calls `open` only for a batch that is quiet and would wake the Lead on its own, right before posting. If the tab opened earlier, while `target` runs, the room would get chats with nothing in them. Work no Lead tab handed off never wakes the Lead by itself, and neither does a shared file, so either one alone would open an empty chat on every flush. A batch that doesn't need the Lead yet waits for the next one that does, as it would with a tab open, and a batch with nothing left to say is dropped. Once the new tab exists, `leadUpdateTarget` finds it, so a second batch for the same Lead chat in the same flush goes into the same tab and the same message.

Amends KERNEL-337. KERNEL-365.
