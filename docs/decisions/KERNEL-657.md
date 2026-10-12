# KERNEL-657: The top row always drags the window

Supersedes the sentence in D-063 that the header's empty space drags the window only while the sidebar is hidden.

Moving the window to another monitor meant aiming for the sidebar's top corner. Now the empty space along the whole top row drags it, with the sidebar shown or hidden: every screen header (`.panel > .header`), the workspace right panel's header (`.ws-aside-head`) and the 8px strip above the panels (`.main::before`).

Controls opt out by kind (buttons, links, inputs, labels, roles button, tab, menu, listbox, dialog, separator, anything with a tab stop or tooltip) rather than by position, and menus, listboxes and dialogs are no-drag everywhere, because an open popover over a drag region would otherwise lose its clicks. Nothing below the header row drags. Double-click on empty header space zooms the window, as the native title bar does.
