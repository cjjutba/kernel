---
title: Scripts and environment
description: Setup, run and archive scripts, ports, preview URLs, files to copy and environment variables.
---

Each project's **Setup and scripts** page in Settings decides what happens when a workspace is created, how its app runs, and what happens when it's archived.

## Setup script

The setup script runs when a workspace or a chat with Kernel is created, such as `pnpm install`. A setup script can write variables to the file named in `$KERNEL_ENV`, and every agent, run script and terminal in that workspace gets them:

```sh
pnpm install
echo "DATABASE_URL=postgres://localhost:5432/app_$KERNEL_PORT" >> "$KERNEL_ENV"
```

If setup fails, the workspace says so and offers **Run again**. Settings, Git and worktrees can stop setup and archive scripts after a time you choose.

## Trusting a repo's scripts

Scripts in a repo's shared settings run code from the repo. The first time, a workspace waits with a banner and a **Review** button, and a dialog lists exactly what will run. Trust it, or leave it held.

## Run scripts

Add named run scripts, such as `frontend` and `backend`. The Run tab has a picker, so each script starts, stops and shows its own output with its colors. ⌘R runs the dev script.

### Ports and preview URLs

Each workspace gets a block of 10 ports between 4300 and 5999. The first is `$KERNEL_PORT`. Point your dev server at it:

```sh
pnpm dev --port $KERNEL_PORT
```

**Preview URLs** list the addresses your app serves. The Checks tab's **Open** button opens the first one, or the address a run script printed.

## Archive script

The archive script runs when a workspace is archived, such as stopping a database container. Turn it off with **Run the archive script on archive** in Settings, Git and worktrees.

## Files to copy

Gitignored files the work needs, such as `.env.local`, are copied into each new worktree. The list takes patterns like `.env*`, shows which files a new worktree will get, and warns when a file looks like production, such as one holding a live key. **Symlink node_modules** lets new workspaces use the main checkout's `node_modules`, so agents can start without installing packages again.

## Environment variables

Settings, Environment holds variables every chat, script and terminal gets. Each project's Environment page adds the project's own, and lists its env files. Values are shown only when you ask.
