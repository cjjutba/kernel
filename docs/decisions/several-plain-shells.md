# Several plain shells per workspace

A workspace's plain shells are `shell:<workspaceId>` (the first, as before) and `shell:<workspaceId>:<n>` for any other. A shell starts lazily the first time its id is written to or resized, in the workspace's worktree. `terminal.close` kills one shell and drops its output without touching the others or the big terminal chats, and refuses a chat id. `terminal.shells` lists the ids that run or kept output, so a window can bring its panes back after a reload. The renderer picks `n`. Archiving a workspace ends every shell it has.

A resize or write that arrives after `terminal.close` starts the shell again, so the renderer must stop sending for a pane it closed.
