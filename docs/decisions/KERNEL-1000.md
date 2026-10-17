# KERNEL-1000: team updates reach a terminal Lead

## Decision

Kernel never types into a terminal. When the tab that handed work off is a terminal Lead, its updates are queued, not sent as a turn.

- The queue goes through the same grouping, quiet period and "wakes" rules as a chat Lead's updates, so timing and the 8-workspace cap behave the same.
- The queued text is the text a chat Lead gets. It is delivered on that seat's next `UserPromptSubmit` as `additionalContext`, or by the `check_team` tool, which returns and clears it. Both read the same queue, so nothing is delivered twice.
- The `delivered` log note and the open items are written when the terminal reads the update, not when it is queued.
- `check_team` exists only for terminal Lead seats. It is built where `toolsFor` builds seat tools.
- An update that needs the Lead raises an inbox row naming the tab, and a Mac notification. A teammate's question carries `ask`, and `notifications.answer` sends the answer to the teammate. A queued copy of that question is annotated so the Lead does not answer it again.
- The pending count per tab is pushed as `seat.updates`.

## Limits

- Closing a tab drops its queue.
- A terminal Build here seat's own PR news is not routed, because `buildTab` excludes terminal chats.
- The count is pushed on change only.
- The inbox answer field and the tab count are renderer work.
