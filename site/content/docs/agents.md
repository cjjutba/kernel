---
title: Agents and the team
description: Where agents come from, how they get their model and tools, and how to change the team.
---

An agent is a teammate with a name, a role, tools and instructions. Agents are plain files, so the same team works in Kernel and in Claude Code outside it.

## Where agents come from

A project's team is made of:

- the repo's agents, in `.claude/agents/`
- your personal agents, in `~/.claude/agents/`
- agents from your Claude Code plugins

A repo with no agents can start from Kernel's starter agents: **Kai** for frontend, **Noor** for the engine, **Ivy** for QA and **Theo** for reviews. Add them from Settings, Agents, or when a plan has nobody who fits a task. An empty project can also copy another project's agents with **Copy from another project**.

## An agent file

An agent is a Markdown file with frontmatter on top and its instructions below, in the same format Claude Code uses for subagents:

```md
---
name: kai
description: Frontend engineer. Builds screens and components.
tools: Read, Edit, Write, Bash, Grep, Glob
---

Build to the screenshot or mock in the brief. Run the tests your change touches.
```

- **Tools hold in Kernel.** An agent only uses the tools its file lists, plus Kernel's own, so an agent marked read only can't edit files. `disallowedTools` holds on Claude and Codex.
- **Model.** An agent runs on the model of its role in Settings, Models and effort, unless its file pins one. Kernel warns when a pinned model isn't offered by any provider you're signed in to.
- **Mistakes show.** A file with an error in it shows in Settings, Agents with what went wrong, instead of disappearing.

## Lead, reviewer and helpers

- **Lead.** Kernel leads every project. Only an agent marked `lead: true`, or with `role: Lead`, can take its place.
- **Reviewer.** The agent that reviews pull requests: the one picked in the project's Agents page, an agent whose role says review, or Kernel's own code review.
- **Helpers.** An agent whose tools can't open a pull request, or that you mark so, gets no tasks of its own. Agents written as subagents with no pull request workflow start as helpers.

## Changing the team

Settings, Agents lists every agent and opens each one's editor. Hiring, editing or retiring an agent is either just for you on this Mac, or for the team as a pull request. A change kept on your Mac never leaves uncommitted files in the repo.

A project's Agents page picks its lead and reviewer, which agents take tasks, and how many workspaces Kernel keeps open in that project. The choice is saved in the repo's Kernel settings, so everyone on the repo gets it. A roster there can limit the team to some of the repo's agents.

## Claude Code or Codex

Each role runs on Claude Code or Codex, with its own model and effort, in Settings, Models and effort. See [Accounts and usage](/docs/accounts) to sign in to either, and to use several accounts.
