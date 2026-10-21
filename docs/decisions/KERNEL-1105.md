**New chat is a 30px icon beside Search, not a sidebar row, and toasts are one shell on every screen.** Pen 18.2 and every other frame draw the sidebar's top as the Search field with a 30px square icon to its right, then Inbox and Work. The "New chat" row (feat-sidebar-nav-new-chat-row-search, KERNEL-930) is gone. The icon rests on `surface`, takes `surface-3` while New chat is open, and keeps its ⌘N tooltip. Amends KERNEL-930.

A toast is 400px wide, 20px above the window's bottom edge and 16px from its right edge on every screen, with or without the Session rail, stacked upward with an 8px gap and the newest at the bottom (Pen 18.1 and 18.3). It sits against the window, not against the chat panel, so it is 7px under the composer's bottom edge and 9px right of the Session card's edge in the app's inset panel. The frame draws them level, because its window has no inset. The brief fixes the window offsets, so the app keeps them. The border takes one pixel off each side of the frame's padding, which keeps a toast's height and text width at the frame's 102 or 64 and 318.

The merged toast says who merged when Kernel knows the agent: "Noor squashed it into main." Without one it keeps "Squashed into main".

A step in the Session rail that has not started draws its ring in `--pending`: the dark `line-3` value, and `#c6c6c6` in light, where `line-3` is too faint for a ring (the frame's light colors differ from its token there).

A save or customize that fails on an agent's page is a toast, as every failed save is. The scope dialog keeps its own error line, since the user opened it. Loading notes in the Compare, Branch and Link pickers show the arrow-down dot loader beside their words.

Left as they are, each by a rule in DESIGN.md: the error lines inside dialogs the user opens, field validation, the Check hooks card, check rows and the setup log.
