**Sending a message puts it at the top of the view, and the reply fills in under it.** This amends KERNEL-605 (the chat follows its end) and KERNEL-629 (following waits for the reader's gesture): a send no longer pins the view to the end.

- On the reader's own send (`followsSend`), the view scrolls smoothly until the message sits 16px from the top. Padding under the thread, set from where the message and the end of the rows are, fills the rest of the view, so a short chat anchors too.
- After that nothing moves the view. The thread stays unpinned, so the reply streams in below the message, and the Scroll to bottom button shows once the end of the rows passes the bottom edge. The padding isn't part of the thread: following and the button measure to the end of the rows.
- The padding shrinks as the reply grows and is removed when the turn ends. A chat that opens has none, since nothing is anchored until a send arrives while it is open. There is never a blank gap at the end of a finished thread.
- Team updates, Lead hand-offs, PR notes and teammate messages aren't a send and never move the view.
- The rules for the reader's own scrolling are unchanged: scrolling up unpins, Scroll to bottom and scrolling back to the end follow again. Scrolling down by hand into the padding follows again, as reaching the end always did.

- The scroll aims again while it glides (KERNEL-825): rows far above the message are measured after the glide passes them and shift it, so the target is retaken each frame until the message has sat 16px from the top for a few frames. The reader's own scrolling ends the aiming.

Rule: `anchorPad` and `anchorSend` in `Transcript.tsx`. KERNEL-803.
