**Only the end of a turn offers Retry and Fork, and every other agent line offers Copy alone.** An agent line that isn't the end of its turn shows a Copy button that floats in the gap under it on hover and keyboard focus, so it takes no height. Retry resends the message that started the turn, so pressed mid-turn it queued a second copy of the whole task, and Fork into new workspace copies files that are half edited. A running turn therefore has no Retry or Fork anywhere. This amends KERNEL-346. KERNEL-828

| Turn state | In-between lines | Last agent line | Time line |
|---|---|---|---|
| Running | Copy | Copy | none |
| Finished, ends on text | Copy | time, Copy, Retry, "..." | part of the reply |
| Finished, ends on a step or has no text | Copy | Copy | time, Copy, Retry, "..." |
| Stopped, or cut off by an app restart | Copy | Copy, Retry, "..." | as before |
| Failed | Copy | Copy | the error card keeps its Retry |

**A finished turn that ends on a step puts the actions on its time line.** Before, such a turn had no Copy or Retry at all once in-between lines lost theirs. The Copy there copies the turn's last message and is left out when the turn has none. Revert files to here moves to that line's "..." menu, and Retry and the forks start from the turn's result row. KERNEL-828
