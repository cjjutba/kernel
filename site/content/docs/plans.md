---
title: Plans and plan mode
description: How Kernel turns a brief into a plan you approve, and how to change a plan before work starts.
---

A plan is Kernel's write-up of what to build: the reasoning, the behavior, the files, the checks, and one task per agent. Nothing changes until you approve it.

## Plan mode

A chat in plan mode plans first and changes nothing. Turn it on with Shift+Tab, which cycles the chat through its modes, or pick **Plan** from the mode menu in the message box. The message box turns blue while plan mode is on, and chats in plan mode show a blue icon in the sidebar.

Two settings in Settings, Models and effort start chats in plan mode:

- **Kernel starts in plan mode**, for chats with Kernel
- **New workspaces start in plan mode**, for a workspace's own chat

## Reviewing a plan

The plan shows in the chat as a formatted document, with **Copy** and **Approve** on the message box. You can:

- **Approve** it. Kernel creates one workspace per task and hands each one out.
- **Ask for changes.** Type what you want different in the message box and send it. You can attach images, and the agent looks at them before revising. The revised plan replaces the old one.

Kernel saves each plan as a file under `.kernel/plans` in its workspace, so a later chat can attach it with @ and build from it without planning again.

## Tasks

Each task names the agent that takes it. When you approve:

- each task gets its own [workspace](/docs/workspaces), branch and port
- a task that waits on another pull request starts once that one merges
- a task from an issue starts with the issue's description and its latest comments

If a task fits nobody on the team, Kernel offers to create an agent for it first.

## Questions

When Kernel or an agent needs a decision, it asks with a question card: a few short answers, each with a line of explanation, and the recommended one tagged. Pick one, or type your own under **Something else**, then press Send.
