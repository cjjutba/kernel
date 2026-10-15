---
title: How it works
description: The loop from a brief to a merged pull request, and the rules Kernel follows along the way.
---

## The loop

1. **You brief Kernel** in a chat with Kernel, or in the New chat window.
2. **Kernel plans.** In plan mode it writes a plan and asks for your approval.
3. **You approve.** Kernel creates one workspace per task and hands each to an agent.
4. **Agents build.** Anything risky comes to you as an approval: in the chat, on Home and in the Inbox.
5. **Pull requests.** Each agent opens a pull request, checks run, and a reviewer can review it.
6. **You merge.** The workspace is archived and moves to History.

Kernel stays in the loop the whole time. It hears when a teammate finishes, when a pull request changes and when checks fail, and it reports back in a Team update instead of making you check each workspace.

## Real events only

Every status in Kernel comes from a real event, never from a timer. An agent shows as working because its session is running, and a pull request shows as ready because GitHub says so. An idle agent looks idle.

Kernel follows Claude Code through its hooks, a small set of entries Kernel adds to Claude Code's settings so each session reports to Kernel. They stay silent when Kernel isn't running. Settings, Hooks shows them and can send a test event.

## Where work happens

- **Your main checkout stays yours.** Agents work in worktrees, and each chat with Kernel has its own too.
- **One task, one branch.** A workspace is a git worktree on its own branch, with its own block of ports, so two agents never collide.
- **Plain files.** Agents, project settings and scripts are files in the repo or on your Mac, so the setup works outside Kernel too.

## Who decides

Plans need your approval. You pick how much agents do without asking, from Manual to Bypass permissions, and Never allow, network off and protected branches hold in every mode. Nothing merges by itself unless you turn on [merging without asking](/docs/pull-requests#merging-without-asking), which is yours alone and off until you do.
