---
title: Room settings
description: Each room's own settings, and which ones the whole team shares through the repo.
---

Each room has its own pages in Settings, under the room's name. Each page reads and changes only that room.

## Shared and personal

A room's settings live in two files in the repo:

| File | Holds | Committed |
| --- | --- | --- |
| `.kernel/settings.toml` | Settings the whole team shares, such as scripts, reviews and the team's lead and reviewer | Yes |
| `.kernel/settings.local.toml` | Your personal overrides for this repo | No, it stays on your Mac |

Kernel writes both from the Settings pages, so you rarely edit them by hand. A personal override wins over the shared value. Some settings can only be personal: **Merge without asking me** can't be turned on from the shared file.

## Pages

| Page | What it holds |
| --- | --- |
| General | The room's icon, repository, local path, issue tracker and Linear team, reference folders, and Archive room |
| Git | Workspace type, the branch to branch from, the remote, and branch names for chats with Kernel |
| Setup and scripts | Setup and archive scripts, waiting for setup, files to copy, symlinked node_modules, run scripts, ports and preview URLs. See [Scripts and environment](/docs/scripts) |
| Environment | The room's variables and env files |
| Agents | The room's lead and reviewer, which agents take tasks, and how many workspaces Kernel keeps open |
| Pull requests | Which reviews run and on which files, review rounds before a pull request comes to you, paths you always review, optional checks, the merge method, and instructions. See [Reviews](/docs/reviews) |
| Permissions | The room's permission mode, and the commands and tools saved with Always allow |
| Skills and MCP | The skills and MCP servers the room's agents can reach, with switches to turn each off |

## Archiving a room

**Archive room**, on the General page, archives every workspace in the room, running each one's archive script, and removes the room from the sidebar. The repo on disk stays as it is.
