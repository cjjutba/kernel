# KERNEL-891: sending follows the end, it no longer anchors or glides

**Sending a message puts it at the end at once, with no glide, lift or jump to the top, and the view stays at the end while the reply streams.** This replaces the send anchoring of KERNEL-803, KERNEL-825, KERNEL-837, KERNEL-860 and KERNEL-862.

- A send in an existing chat pins the view and follows the end. A reader scrolled up jumps straight to the end. Scrolling up while a reply streams stops following, as before. A queued message posting later follows only while the reader is still at the end.
- A new chat has no saved place, so it opens at its end. Its first message sits at the top because the short thread is top-aligned, later messages stack below it, and once the thread fills the view it follows the end.
- A plan approve or a question answer shows its answer row in place. Approve no longer holds the thread or glides after the strip closes.
- Scroll to bottom and the chat rail jump keep one glide (`scrollGlide.ts`) on `--ease-glide`. Reopening a chat where it was left, the rail's ring, the loading state of KERNEL-860 and the interrupted-glide cleanup of KERNEL-881 are unchanged.
- Removed: `anchorSend`, `aim`, `hold`, `padReply`, `anchorPad`, `anchorGoal`, `aimOver`, `letGoAnchor`, `heldPadding`, the padding under the thread, `sendAnchor` (now `sendFollow`), the just-sent mark (`markJustSent` and its callers), `anchoredId` and `anchoredTop` in saved places, `keptAnchor`, and `PLAN_APPROVE_EVENT` and `PLAN_SETTLE_EVENT`.
