**A banner offers to switch accounts before the limit, and the limit banner offers the account with the most room.** Builds on KERNEL-568. When the account in use is at 90% of its 5-hour window or 95% of its weekly one (`NEAR_LIMIT`, the same line that holds teammates) and another signed-in subscription account of that provider has room, the workspace says "Work is at 90% of its 5-hour limit. Personal has room." with Switch to Personal. Room means no rejected window and no window of its own at `NEAR_LIMIT`, so the offer never bounces between two nearly full accounts. An account never read counts as having room, since it has shown no use.

- It never offers an API key account, which bills per token. The limit banner still does when no subscription account is left (KERNEL-524).
- It is hidden while Settings, Providers has "At a limit, switch to another account" on for that provider, since Kernel moves on its own then.
- It sits after the banners for a limit already hit, and before "Close to your 5-hour limit", which shows in its place once the user closes it. That one says teammates' new work waits, which this one doesn't.
- It closes like the other two information banners (KERNEL-595), by account and window, so it comes at most once per window. Clicking Switch closes it too, so switching back to the same account in the same window doesn't bring it again.
- The limit banner's Switch to picks the subscription account with the lowest 5-hour use, as Kernel does at a limit. A window that has reset counts as unused, and an account never read goes last. Both banners send the `banner` reason. Only a banner shown at a hit limit makes the chat note say "(Work hit its 5-hour limit)", since main finds a rejected window only there.
- The close button stays KERNEL-595's: a small X on the corner, shown on hover or focus. The PNG draws it inline and always visible, and KERNEL-595 chose otherwise for every banner with a close.
- A finished turn's note from its start ("Now on Personal") shows above the folded tool calls it announces, not below them. The note keeps the quiet line with a hairline that KERNEL-274 gave every Kernel note, where the PNG draws it as a box.

KERNEL-569.
