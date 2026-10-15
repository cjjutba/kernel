# Kernel: product

## What it is

A Mac app that turns Claude Code and Codex into a small software team. Agents are defined in each repo's `.claude/agents/`, joined by the user's own in `~/.claude/agents/` and those from their Claude Code plugins, and each runs on Claude Code or Codex, as Settings, Models and effort or the agent's own file says. Kernel plans with you and hands each task to an agent, and every agent works in its own git worktree on its own branch. Kernel shows who is doing what in the sidebar and brings everything that needs you to the Inbox.

## Who it is for

Developers who already use Claude Code and want several agents working on one repo at once, each on its own branch, without losing track of who is doing what. Kernel is single-user: you, your Mac and your Claude or ChatGPT plan, or several of each.

## The core loop

1. You brief Kernel in Kernel's chat or the new workspace modal.
2. Kernel plans (plan mode) and asks for approval.
3. You approve. Kernel creates one workspace per task and hands each to an agent.
4. Agents build. Anything risky comes to you as an approval in the Inbox or inline in the chat.
5. You review diffs, the agent opens a PR, checks run, you merge.
6. The workspace is archived and is kept under Archived: search for it with ⌘K, or open Archived from its room's menu in the sidebar.

## Glossary

- **Room**: one repo (a folder with a git checkout). Has a team, a Lead chat and workspaces.
- **Workspace**: one task's working copy, usually a git worktree on its own branch, with its own port. Can also run on the current branch of the main checkout.
- **Chat**: a Claude Code or Codex session inside a workspace. A workspace can have several chats, on either provider, and a big terminal.
- **Agent**: a subagent file in `.claude/agents/` or `~/.claude/agents/`, a Claude Code plugin's agent, or Kernel's own Theo where the repo has no reviewer. Has a name, role, tools and instructions. Its model comes from its role in Settings, Models and effort, unless its file pins one. Its tools line holds in Kernel. Hiring, editing or retiring one is either just for you on this Mac, or for the team as a pull request.
- **Provider**: the CLI an agent runs on, Claude Code or Codex. Each signs in with its own subscription, and can hold several accounts to switch between. An MCP server you added signs in once for every Claude account. A claude.ai connector, such as Google Drive or Gmail, belongs to the claude.ai account, so each Claude account has only the connectors set up on it.
- **Lead**: the role Kernel plays in every room. Each chat with Kernel has a mode. In **Hand off**, the default, Kernel plans and hands out work through its MCP tools and never edits a file. In **Build here**, Kernel makes the change itself in the chat's own worktree and opens the pull request, and suggests Hand off when the work is bigger than one PR. Customize its instructions and tools with `.claude/agents/kernel.md`.
- **Reviewer**: the agent that reviews each pull request: the one picked in Settings, Agents, an agent whose role says review, or Kernel's own Theo.
- **Helper**: an agent the Lead hands no task, because its tools can't open a pull request or Settings, Agents says so.
- **Approval**: anything waiting on you: a tool permission, a plan, or a question.
- **Task**: one step of an approved plan, handed to one agent as a workspace.
- **Work**: the sidebar page with two tabs, Issues and Pull requests: what is waiting to be done and what is open. It is not a Task, and it holds no tasks of its own.
- **Checkpoint**: a snapshot of a workspace after each agent turn.

## Principles

- Real events only. A status in Kernel never comes from a timer.
- You stay in control: plans need approval and nothing merges by itself unless you turn on auto-merge, which is yours alone and off until you do. You pick how much agents do without asking, from Manual to Bypass permissions, and Never allow, network off and protected branches hold in every mode.
- Everything is plain files where possible (agents, settings, scripts), so the setup works outside Kernel too.
- Quiet design. Color means something or it isn't there.

## v1 scope

The light theme, code signing, notarization and auto-update, along with every screen in the app.

The isometric floor and the Board were removed (KERNEL-606). Kernel has no screen for either.

## Not in v1

Multiple users or shared rooms, cloud sync, Windows and Linux builds.

## Definition of done

The journey in KERNEL-31 passes on a real side project, start to finish, plus every failure screen shows when its condition really happens.
