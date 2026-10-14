# KERNEL-751: a modal or a move elsewhere closes popovers, background events don't

A menu or popover stays open only while the person is still looking at the thing it came from. Two things end that, and one doesn't.

- A modal opening closes every menu and popover below it, newest first, through their own close handlers. `Modal` registers its layer as `blocking`. Layers opened after the modal (a menu inside it, a confirm over it) are left alone, and a blocking layer never closes another blocking layer.
- Moving to another chat, tab or screen closes every menu and popover. `moved()` in `store.ts` calls `closeAllLayers()`, because every move ends there.
- Background events (agent messages, status changes, PR updates, toasts) never close a popover. Nothing in their path calls into the layer stack.

Menus sit at z-index 60 and the modal scrim at 40, so before this a menu open under a new modal stayed sharp and usable above the blurred page. A popover closed this way doesn't hand focus back to its trigger, so focus stays in the modal.
