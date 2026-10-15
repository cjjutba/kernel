---
title: Workspaces
description: One task's working copy, with its own worktree, branch, ports, chats and terminal.
---

A workspace is one task. It's usually a git worktree on its own branch, so agents build side by side without touching each other's files or your main checkout.

## What a workspace has

- **A worktree and a branch.** Branch names are short: the issue key and a few words of the title, starting with `fix` for bugs and `feat` otherwise. The pattern is in Settings, Git and worktrees.
- **Its own ports.** Each workspace gets a block of 10 ports between 4300 and 5999. The first is `$KERNEL_PORT`, so two dev servers never fight over one port.
- **Chats.** A workspace can hold several chats, on Claude Code or Codex, as tabs. ⌘T opens a new tab and ⌘W closes one.
- **A big terminal.** ⌘⇧T opens a terminal tab in the worktree. It runs `claude` by default, and Kernel still follows the session. Settings, Big terminal sets what a new tab runs.
- **Files to copy.** Gitignored files the work needs, such as `.env` files, are copied in when the workspace is created. See [Scripts and environment](/docs/scripts).

A project can instead run workspaces on the current branch of the main checkout, with **Workspace type** in its Git settings.

## The right panel

The right panel follows the workspace:

- **Changes** lists every changed file with lines added and removed, as a list or a folder tree. Its menu compares the workspace with another branch, with only its uncommitted changes, or with a single commit. Each file's diff opens in its own tab.
- **All files** browses the worktree.
- **Checks** shows the pull request's checks, with an Open button for the app's preview address.
- **Shared** lists the [files agents shared](/docs/shared-files).

Below the tabs, **Setup**, **Run** and **Terminal** show the workspace's scripts and shell. ⌘J shows or hides that panel, and ⌘R runs the dev script.

## Working in a workspace

- Every reply lists the files its turn created, edited or deleted, with a diff for each.
- The menu under a reply can fork the chat into a new workspace, with its own branch, the same files and the conversation up to that reply.
- **Open in**, in the workspace header, opens the worktree in any editor or terminal on your Mac. ⌘O opens it in the app you used last.
- Every turn is a [checkpoint](/docs/checkpoints) you can revert to.

## Archiving

When a task is done, archive its workspace with ⌘⇧A or from the sidebar. It leaves the sidebar at once and moves to History. With **Archive on merge** on, the default, a workspace is archived as soon as its pull request merges. **Delete the branch on archive** is off by default.

History lists archived workspaces. It can restore one, or delete archived workspaces with their branches, checkpoints and transcripts.
