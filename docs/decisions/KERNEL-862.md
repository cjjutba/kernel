# KERNEL-862: one scroll engine for the chat

Every scroll Kernel makes on its own goes through one time-based glider (`scrollGlide.ts`): the send aim, Scroll to bottom, the chat rail jump, Approve and a plan revealing itself. It runs on `--ease-glide` with the duration from the distance (`glideMs`), follows a goal that moves without restarting, ends without a snap and places the view at once under reduced motion.

- The WAAPI lift of the thread is gone. It depended on a bottom-aligned short thread, and `.thread` is top-aligned (KERNEL-851), so an anchor in a short chat scrolls into the padding like any other.
- Approve runs in sequence: the strip closes, the card folds, then one glide settles the answer. The transcript holds still from the press (`PLAN_APPROVE_EVENT`) until the strip reports closed (`PLAN_SETTLE_EVENT`) plus `--archive-fold`, and a plan no longer scrolls by itself during that time.
- When the anchored row is dropped (a failed answer), the anchor is released and the space under the rows grows to keep the scroll position (`heldPadding`).
