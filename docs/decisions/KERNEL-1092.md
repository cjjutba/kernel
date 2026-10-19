# KERNEL-1092: sidebar status icons take an accent

Departs from the monochrome rule in DESIGN.md for the sidebar's status icons only.

- A working row's loader is `--term-blue`. A waiting row is `--needs`, an open PR `--add`, a merged one `--merged` and a failed one `--del`. Every other icon stays `--faint`.
- Why: a long list of grouped chats and branches is scanned for what changed, and a color tells a working row from a settled one faster than a shape does.
- A working row never shows a static icon next to the loader.
- The words that name each state ("Working", "PR open", "Needs you") are the icon's tooltip and its accessible name, so color is never the only signal.
- A queued row has no accent yet: no event says a chat is queued, and statuses come from real events only.
