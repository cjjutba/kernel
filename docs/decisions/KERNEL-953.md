# KERNEL-953: one scroll owner for the chat transcript

Amends KERNEL-605, KERNEL-862, KERNEL-891, KERNEL-912 and KERNEL-918.

The transcript's scroll position had three writers (the open restore, following the end, the glider) coordinated by refs in `Transcript.tsx`. `chatScroll.ts` is now the only place that moves it. `Transcript.tsx` forwards events (scroll, scrollend, wheel, touch, keys, pointer, resize, items) and keeps no movement flags.

- **One current intent**, highest first: `reader` (wheel, touch, scrolling keys, scrollbar, until the gesture lapses after 200ms), `glide` (Scroll to bottom, the rail jump, the plan reveal; KERNEL-862), `place` (opening at a spot or the end; KERNEL-912, KERNEL-918), `follow` (keeping the end in view; KERNEL-605, KERNEL-891).
- **Priority:** a request below the current intent is dropped. One at the same or higher priority replaces it and ends it. A click or send by the reader (Scroll to bottom, a rail jump, sending) takes over from everything.
- **Limits:** a `place` ends once settled (4 still frames) or after 1500ms; a spot may resume within that window when the thread changes size, so it no longer corrects forever. A `glide` keeps `GLIDE_MAX_MS`. A `follow` writes only when the view is off the end, now and once a frame later.
- **A write from an intent that isn't current is dropped**, with one development warning naming both movers. The glider writes through the owner's view, so a stale glide can't move the transcript.
- **Size:** the owner watches the scroller as well as `.thread`, so the composer growing keeps the end in view while following. The plan's `STRIP_OPENS_MS` hold is gone.
- **The end** is `scrollHeight - clientHeight` everywhere. Following used `scrollIntoView` on a sentinel, which stopped 8px short of the open restore's end because of the scroller's bottom padding.
- A reader who is not following stays so when a fold shrinks the range and the browser clamps the view onto the end (`followsAfterScroll`).
- **Browser scroll anchoring stays on.** It is the one mover outside the owner. It holds a reader's rows in place when rows above them resize, so it only matters under `reader`.
- The in-memory row `heights` map is unchanged (KERNEL-954).
