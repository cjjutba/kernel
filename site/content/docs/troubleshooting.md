---
title: Troubleshooting
description: Fixes for the problems people hit most, and how to report one.
---

## The first launch checks fail

Each failed check shows the command that fixes it. See [Install](/docs/install#first-launch-checks) for the list. After you fix one, press **Check again**. GitHub CLI warnings only matter for pull requests, and a Mac with only local rooms doesn't get them.

## Agents don't show as working

Kernel follows Claude Code through its hooks. Open Settings, Hooks to see whether they're installed and whether the hook server is listening, and send a test event. The footer says when hooks are down.

## A room is paused

A usage limit pauses a room's agents. They resume on their own once the limit resets, or as soon as you switch to an account with room left in Settings, Accounts. Turn on **Switch accounts at a limit** to have Kernel do it for you.

## A workspace is stuck setting up

If the setup script fails, the workspace says so and offers **Run again**. Open the **Setup** tab to read its output. Settings, Git and worktrees sets how long setup may run before Kernel stops it. A workspace waiting for you to trust the repo's scripts shows a banner with a **Review** button.

## A port is taken

Each workspace gets its own block of ports between 4300 and 5999. If another app holds one, Kernel says which and how to free it. Make your dev server use `$KERNEL_PORT` rather than a fixed port.

## A pull request won't merge

Its header says why: failed checks, conflicts, requested changes, blockers from a review, or GitHub's branch rules. **Fix** sends it back to the agent. When Kernel pauses reading pull requests for GitHub's rate limit, the footer says so, and when it reads them again.

## Reporting a problem

1. Click the question mark at the bottom right of the window and pick **Report a problem**. It opens a new GitHub issue with your Kernel and macOS versions filled in.
2. To include Kernel's recent log, pick **Help, Copy diagnostics** in the menu bar first, and paste it into the issue. Diagnostics hold Kernel's versions and its recent log, with tokens and your home folder hidden.

Say what you did, what you expected and what happened. Settings, About opens the data folder and the logs.
