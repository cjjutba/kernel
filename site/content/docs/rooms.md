---
title: Rooms
description: A room is one repo in Kernel, with its team, its chats with Kernel and its workspaces.
---

Each repo you add to Kernel is a **room**. A room has a team of agents, one or more chats with Kernel, and the workspaces those chats start. The sidebar lists every room, and Home shows what needs you across all of them.

## Adding a room

Open the menu next to **Your rooms** in the sidebar:

- **Connect a repo** adds a folder that already has a git checkout.
- **New room** starts a room, and saves the repo's install command, such as `pnpm install`, as its setup script.

Room setup shows the agents the repo brings, so you can pick its lead and reviewer, and whether pull requests go to GitHub or merge on your Mac. New rooms pick an install command and a run example for JavaScript, Python, Ruby, Elixir, PHP, Rust and Go repos, and ask before an install that would run the repo's own code.

## What the sidebar shows

Under each room the sidebar lists your chats with Kernel, newest first. The workspaces a chat started sit under it on a guide line, so you can see which task came from which brief. Each row shows its state as an icon:

- a spinner while an agent works
- a question mark when it needs you
- its pull request in green when ready to merge, red for conflicts or failed checks, and purple once merged

Rows with a reply you haven't opened yet show in bold. Rest the pointer on a row to see its latest activity. ⌘1 to ⌘9 open the room's chats with Kernel in sidebar order, and ⌃1 to ⌃9 open the workspaces of the chat you are in.

## Chats with Kernel

A room can have as many chats with Kernel as you like, one per piece of work. Each chat gets its own worktree and branch, runs the room's setup script, and archives into History with the workspaces it started. Kernel answers right away while setup runs in the background, unless you turn on **Wait for setup before the first message** in Settings, Git and worktrees.

## Room settings

Each room has its own pages in Settings: General, Git, Setup and scripts, Environment, Agents, Pull requests, Permissions, and Skills and MCP. See [Room settings](/docs/room-settings) for what each holds and which settings are shared with everyone on the repo.

A room's General page also sets its icon, its issue tracker, and **reference folders**: folders outside the repo that its agents may read and search with @, but never change.

## Usage limits

When your plan hits a usage limit, Kernel pauses the room's agents and resumes them on their own once the limit resets. A paused room stays paused across restarts. If you have another account with room left, Kernel can [switch to it](/docs/accounts#switching-at-a-limit) instead.
