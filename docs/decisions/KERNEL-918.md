**A chat is left at its end only within 2px of it, and a restore corrects until the reader scrolls.** Amends KERNEL-765 and KERNEL-912.

- A chat whose view was within `PIN_PX` (80px) of its end used to be saved as pinned, so it reopened at the end. A restore also let its own scrolls through the follow rule: the spot, or a frame clamped to a still short thread, landed within 80px of the end, the chat counted as following, and the end pulled it the rest of the way. Each round trip left it lower until it was at the end.
- The saved spot is pinned only within `END_PX` (2px, `chatPlace.ts`). `PIN_PX` still decides following and the Scroll to bottom button (KERNEL-605, KERNEL-803, KERNEL-891), which is unchanged.
- While a spot is put back, its scrolls don't change whether the chat follows. The reader's wheel, touch, keys, scrollbar, Scroll to bottom, a rail jump or a send end the restore at once.
- The restore sets the view every frame until it lands on the same scrollTop for 4 frames, then again whenever the thread changes size (late layout: highlighting, images, rows measured after the first paint), until the reader scrolls. It was 600ms or 4 still thread heights. A chat opening at its end keeps the 600ms hold.
- Leaving while a restore is still correcting keeps the spot saved before, since the view is half restored (`restoreState`).
- The spots of every chat in an archived workspace are dropped when the workspace list changes (`dropArchived`), without touching the store. Saving on leave skips an archived workspace.
- Nothing is persisted: spots last until Kernel restarts (KERNEL-922 adds that).

KERNEL-918.
