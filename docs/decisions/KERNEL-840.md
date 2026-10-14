**An agent's in-between messages are rows in the turn's fold, in their own kind of row. Amends KERNEL-800 and KERNEL-828.** KERNEL-800 kept messages out of folds because they had become "Message" rows that hid their content. They now fold again, labelled with their own first line (Markdown stripped, cut to one line), so a finished turn reads as the user's message, one fold of work and one reply. A message row has the chat icon and thinking keeps its bulb, so the two never read as one thing. Opened, a message shows its full text as Markdown in muted ink, like thinking, with Copy on hover and focus. KERNEL-840

| Turn state | In-between messages |
|---|---|
| Finished | steps in the one fold; only the final reply stays outside, in full ink, with its time and actions |
| Running | steps in the running folds; the newest one is the live line next to the clock once the turn has a call |
| Stopped, failed, or cut off by a restart | unchanged from KERNEL-828: every item shows, in-between lines keep their Copy overlay |
| A turn with messages and no call | not folded |

**The summary stays tool-only.** "Read 4 files, edited 2 files, ran 6 commands" doesn't count messages or thinking. Notes, approvals, question cards and user bubbles still break a fold and stay visible (KERNEL-800). KERNEL-840

**A turn's first message streams in full.** Before the turn has made a call, a message isn't a live line, so a reply that is the first thing a turn says still reads as it arrives. KERNEL-840
