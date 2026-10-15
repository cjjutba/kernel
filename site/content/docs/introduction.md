---
title: What is Kernel
description: A Mac app that turns Claude Code and Codex into a small software team, with you as the one who decides.
---

Kernel is a Mac app for developers who already use Claude Code or Codex and want several agents working on one repo at once, without losing track of who is doing what.

You brief **Kernel**, the lead, in a sentence or two. Kernel reads the repo, writes a plan and brings it to you. Once you approve, it splits the work into tasks and hands each one to an agent on your team. Every agent works in its own git worktree, on its own branch, with its own port. Agents ask before anything risky, open pull requests and wait for you to merge.

## What you get

- **A lead that plans.** Kernel turns a brief into tasks, picks who does each one, and keeps track of them until they merge.
- **A workspace for every task.** One worktree, branch and port per task, so agents never edit the same checkout.
- **Reviews and merges.** Pull requests, checks, reviews by a reviewer agent, and merging, without leaving the app.
- **You stay in control.** Plans need your approval, risky commands ask first, and nothing merges by itself unless you turn that on.
- **Your own plan.** Agents run on the Claude or ChatGPT plan you already have. Kernel has no account and no servers of its own.

## How the pieces fit

| Term | What it is |
| --- | --- |
| Project | One repo you added. It has a team, chats with Kernel and workspaces. |
| Kernel | The lead in every project. It plans, hands off work and reports back. |
| Agent | A teammate defined by a file in the repo or on your Mac, running on Claude Code or Codex. |
| Workspace | One task's working copy: a git worktree on its own branch, with its own port. |
| Approval | Anything waiting on you: a command, a plan or a question. |

## Where to start

1. [Install Kernel](/docs/install) and let it check your Mac.
2. [Give it your first brief](/docs/first-brief) and approve the plan.
3. Read [how it works](/docs/how-it-works) to see the whole loop from brief to merge.

> Kernel runs on Macs with Apple silicon today. If you use Windows, Linux or an Intel Mac, [join the waitlist](/#waitlist) and we will email you once if that changes.
