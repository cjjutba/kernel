# KERNEL-934: viewer tabs fill the column, the composer shrinks to one line

**One line in the column, not an overlay.** A shared page and a PDF run in a native view that draws above the DOM (KERNEL-306), so a composer floating over the viewer would be covered by it, or would need the page hidden behind a still every time it showed. The composer instead stays in the column under the viewer, and on a shared page, file, image, text or diff tab it is one line: the input with its hint, + and Stop. `.sv-frame` grows into the height that frees, and `PreviewSurface`'s placement loop moves the native view to the new rect with no new code. Nothing of the composer or its menus can sit under the page. KERNEL-934.

**It opens, and holds open, on what the user is doing.** Focus, a click, ⌘L, typing, a draft (text, chips, attachments, files still being read), `addToComposer`, a paste or a drop open it. A waiting plan, a blocked chat, a banner or notice that asks something, and an open menu hold it open. It closes only when focus leaves and none of that is true. Focus moving into a native view is a blur, so it closes too. The height snaps, with no transition, so a quick switch between tabs doesn't jitter. KERNEL-934.

**Nothing is unmounted but the extras.** The draft, chips and the @ and / lists stay mounted in both states. The toolbar, queue, uncommitted note, hunk card and waiting note leave the one line. The plan strip, banners and open items show in both. KERNEL-934.

**Images need no new mode.** They already open at Fit (KERNEL-598), so the cropped look in a short frame goes away with the extra height. KERNEL-934.

**The shared header is one row.** Title and who shared it on the left, the tools on the right. The title gives way first, and who shared it is dropped under 900px of column. KERNEL-934.
