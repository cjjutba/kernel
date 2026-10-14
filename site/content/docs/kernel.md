---
title: Kernel, the lead
description: Kernel plans with you, hands work to the team, and reports back as it lands.
---

Kernel is the lead in every room. You talk to Kernel the way you would brief a tech lead: what you want, and anything it should know. Kernel works out the plan, hands each task to the right teammate, and keeps track of every task until it merges.

## Talking to Kernel

- ⌘N opens **New chat**, which names the room and remembers your picks. Press it again to close the window.
- ⌘⇧L opens the room's chat with Kernel.
- The sidebar lists every chat with Kernel under its room.

New chat shows how many agents are working, what waits on you, which pull requests are ready to merge, and the next issues from your tracker with a **Plan** button.

## Plans and hand-offs

In plan mode Kernel writes a plan and waits for your approval. See [Plans](/docs/plans). With plan mode off, Kernel still asks before it hands off work or files issues, and only acts on a clear yes.

When a plan has a task nobody on the team fits, Kernel offers to create an agent for it instead of starting the work. When a task depends on another pull request, Kernel holds it and starts it once that pull request merges.

## Team updates

Kernel hears when a teammate finishes a turn, when a pull request opens, changes or merges, and when checks fail. It reports in a **Team update** card in the chat that started the work, with one row per teammate and an Open link. A ready pull request has a **Merge** button right on its row.

Kernel only starts a turn of its own for an update when something needs attention, such as failed checks, a review or a question. Turn this off with **Keep Kernel updated** in Settings, Models and effort.

## The PRs tab

The right panel in a chat with Kernel lists every open pull request in the room. Merge ready ones from there, or use **Merge all**, which merges them one at a time and stops at the first that can't merge.

## Asking Kernel to do housekeeping

You can ask Kernel in plain words to:

- archive finished workspaces. It skips any with an agent still working, an open pull request or uncommitted changes.
- merge pull requests that are ready, once you allow it in Settings, Pull requests.
- answer a teammate's question from the plan, or bring it to you.

## Customizing Kernel

Kernel is the only agent built into the app. To change its instructions or tools for a repo, use **Customize** in Settings, Agents, which copies Kernel into the repo as `.claude/agents/kernel.md` for you to edit. A repo that brings its own lead can pick it in the room's Agents page.
