# KERNEL-950: a plan reveals itself once per plan id

Amends KERNEL-862.

A plan used to glide itself into view every time its chat mounted while it waited. Reopening a chat then ran that glide next to the open restore (KERNEL-918), and the two moved the view to targets about 9px apart every frame.

- A plan reveals itself once per plan id, when it first shows in an open chat. The revealed id is kept in the chat's saved spot (`data.revealed`), so it survives a restart. Reopening the chat uses the open restore only.
- When the reveal runs, it first stops the open restore, so the two never run together.
- A revised plan (a new id) still reveals, but not while the reader is scrolled up.
- KERNEL-918's restore rules are unchanged. One owner for all the scrolling is KERNEL-953.
