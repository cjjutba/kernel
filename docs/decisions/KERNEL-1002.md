# KERNEL-1002: a terminal seat's transcript is read from Claude Code's session file

Extends KERNEL-999.

- Kernel follows the JSONL at the `transcript_path` a seat's hooks report, and saves its rows on the seat's chat like a chat's own, so history and search find them. Every row carries `source: 'terminal'`, and a plan put forward with `ExitPlanMode` is a `plan` row.
- Row ids come from the file (`tt-<entry uuid>`, `tt-tool-<tool use id>`), so reading a line twice, or the whole file again after it was truncated or replaced, saves the same rows and leaves none doubled.
- The file is looked at every 400 ms with a stat poll, and on every hook. A poll survives a file that is replaced, which a file watch on one inode does not. Only bytes past the last newline-ended line are read, and a half-written last line waits for its newline.
- Subagent entries, meta entries, slash command echoes and lines that are not JSON are left out.
- Kernel opens the file read-only and never writes to it. A seat that is forgotten (tab closed, workspace archived) stops being followed. Rows already saved stay.
