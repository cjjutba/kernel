---
title: Your first brief
description: Add a repo, brief Kernel, approve the plan and watch the team build.
---

This walks through one change from brief to merge. It takes a few minutes of your time, and the agents do the rest.

## 1. Add a repo

Open the menu next to **Your projects** in the sidebar and pick **Connect a repo** for a folder you already have, or **New project** to start one. Each repo becomes a [project](/docs/projects).

Project setup shows the team the repo brings, if any, so you can pick who leads and who reviews before the project opens. It also finds rules in the repo's `CLAUDE.md` or `AGENTS.md` that work against Kernel, such as committing straight to main, and shows what Kernel tells agents instead.

## 2. Brief Kernel

Press ⌘N for **New chat**, or open the project's chat with Kernel from the sidebar. Say what you want in a sentence or two:

```text
Add PDF export to invoices. Spec first.
```

Kernel reads the repo before it answers. Each chat with Kernel gets its own worktree and branch, so its reading never touches your main checkout.

## 3. Get a plan

Switch the chat to plan mode with Shift+Tab, or pick **Plan** from the mode menu in the message box. The box turns blue. Ask for the plan, and Kernel writes it up: what changes, the files it touches, the checks, and one task per agent.

Nothing changes while you read it. To change the plan, type what you want different in the message box and send it. Kernel revises the plan and brings it back. You can attach screenshots too.

## 4. Approve

Press **Approve** on the plan. Kernel creates one [workspace](/docs/workspaces) per task and hands each to an agent. The workspaces appear in the sidebar under the chat, each building on its own branch.

Open any workspace to watch its agent work, read its changes, or talk to it directly.

## 5. Review and merge

Each agent opens a [pull request](/docs/pull-requests) when its task is done. Kernel posts a **Team update** card in your chat as they land. If automatic reviews are on, a reviewer checks each pull request first.

When a pull request is ready, press **Merge** on its row in the Team update, in the PRs tab of Kernel's chat, or in its workspace. Merged workspaces are archived into History.

## What to read next

- [How it works](/docs/how-it-works), for the whole loop.
- [Permissions](/docs/permissions), to choose how much agents do without asking.
- [Issues](/docs/issues), to plan straight from Linear, GitHub Issues or Jira.
