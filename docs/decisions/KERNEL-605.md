**The chat follows the size of its thread while the reader is at the end, and a few of the reader's own actions stop it.** Following ran only when the row count changed, so text streaming into the last row left the view behind (up to 693px in a 150-row chat) and a turn folding into its summary row snapped it back. A ResizeObserver on `.thread` now calls `follow()` whenever the thread changes height, unless a smooth scroll the page started (the Scroll to bottom button, a chat rail jump) is still running. What stops following:

- The reader moving the view up, by any amount, after their own input (wheel, touch, keys, the scrollbar). A small move up used to stay "pinned" within 80px, and the next streamed line pulled the reader back, so a slow scroll could never leave the end.
- Any scroll that lands the view more than 80px from the end and moved it up, whoever caused it. The plan card opening a long plan at its top relies on this.
- A click on a row or group that opens and makes the thread taller. Following would scroll the row out from under the click. Closing a row, or opening a menu, leaves following alone.
- A jump from the chat rail, which counts as the reader's own scrolling.

What never stops it: a scroll that only moves the view toward the end, and the browser clamping or anchoring the view after rows resize. The rule is `followsAfterScroll` in `Transcript.tsx`. Following starts again when the reader scrolls back within 80px of the end, presses Scroll to bottom, or sends a message.

The Scroll to bottom arrow shows only when the reader is not following and the end is more than 80px away, so a small nudge up stops following without showing it. Rows far above the end keep `content-visibility: auto` (KERNEL-375). Their measuring changes the thread's height, which the observer now follows. KERNEL-605.
