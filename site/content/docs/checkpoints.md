---
title: Checkpoints
description: Kernel snapshots the worktree after every turn, so you can put the files back without losing the chat.
---

After every agent turn, Kernel takes a checkpoint: a snapshot of the workspace's files at that moment. If a turn goes wrong, revert to an earlier one. The files go back, and the chat stays as it was.

## Reverting

- **Revert files to here**, in the menu under a reply, puts the files back the way they were after that turn.
- **Revert files to start of chat**, under your first message, puts them back the way they were before the chat began.

Kernel shows what will change and asks before it reverts. Checkpoints keep the last 20 turns.

## Discarding changes

Discarding a workspace's changes throws away every uncommitted change in the worktree. Checkpoints keep the last 20 turns if you change your mind.

## What checkpoints cover

Checkpoints cover the worktree's files. They don't undo commits an agent pushed, pull requests it opened, or commands that changed things outside the worktree. Use [permissions](/docs/permissions) to decide which of those ask you first.
