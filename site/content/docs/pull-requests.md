---
title: Pull requests and merging
description: How agents open pull requests, how checks and fixes work, and how merging works with or without you.
---

When an agent finishes a task, it opens a pull request on the workspace's branch. Kernel follows the pull request on GitHub and shows its state everywhere it appears: the workspace, the sidebar, Team updates and the PRs tab in Kernel's chat.

## States

| State | What it means |
| --- | --- |
| Open | Waiting on checks, reviews or GitHub's branch rules |
| Ready to merge | Checks passed, reviews approved, and GitHub would merge it |
| Failed checks, conflicts or changes requested | Shown in red, with a button to fix it |
| Merging | Kernel is merging it |
| Merged | Shown in purple, the only place Kernel uses that color |

A pull request's status updates within seconds of a change on GitHub, and right away when you come back to Kernel.

## Actions

The pull request header in a workspace has a button for each step. They have shortcuts too:

- **Create PR**, ⌘⇧P. Follows the repo's pull request template and contributing guide. Also marks a draft ready.
- **Fix**, ⌘⇧F. Sends the pull request back to the agent to resolve conflicts, fix checks or address review, replying to review comments in their threads.
- **Merge**, ⌘⇧M. Uses the merge method in Settings, Pull requests, or one the repo allows.
- **Archive**, ⌘⇧A. Archives a merged or closed workspace.

Kernel asks an agent to update a branch that fell behind, tells a teammate to rebase when main changes in a way that would conflict with its unfinished work, and asks you what to do after three automatic tries at failing checks.

## Checks

A failing check the repository doesn't require doesn't mark a pull request as failed. A room's Pull requests page can list **Optional checks** that never do, for repositories whose branch rules require none.

## Merging without asking

**Merge without asking me**, in Settings, Pull requests, lets Kernel merge a pull request by itself once its checks pass and every required review approves its latest commit. It's off by default, it's a personal setting, and a team's shared settings can't turn it on. You can set:

- **Size limit**, the most lines a pull request can change and still merge by itself
- **Paths you always review**, paths whose changes always come to you

A pull request that merged this way says so in the Team update.

## Repos without GitHub

In a repo with no GitHub remote, Kernel merges a workspace into its base branch on your Mac, with the room's merge method. The workspace panel shows whether the branch can merge: ready, behind main with an Update branch button, conflicts, merging, merged, or blocked by uncommitted changes in your main folder.

## Instructions

Settings, Pull requests, and each room's Pull requests page, hold the instructions agents follow to create a pull request, resolve conflicts, fix checks and address review. Edit them to match how your team works.
