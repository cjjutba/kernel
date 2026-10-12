# Kernel: product

## What it is

A Mac app that turns Claude Code and Codex into a small software team. Agents are defined in each repo's `.claude/agents/`, joined by the user's own in `~/.claude/agents/` and those from their Claude Code plugins, and each runs on Claude Code or Codex, as Settings, Models and effort or the agent's own file says. Rowan, the Lead, plans with you and hands each task to an agent, and every agent works in its own git worktree on its own branch. Kernel shows who is doing what in the sidebar and brings everything that needs you to the Inbox.

## Who it is for

Developers who already use Claude Code and want several agents working on one repo at once, each on its own branch, without losing track of who is doing what. Kernel is single-user: you, your Mac and your Claude or ChatGPT plan, or several of each.

## The core loop

1. You brief Rowan, the Lead, in Rowan's chat or the new workspace modal.
2. Rowan plans (plan mode) and asks for approval.
3. You approve. Rowan creates one workspace per task and hands each to an agent.
4. Agents build. Anything risky comes to you as an approval in the Inbox, on Home, or inline in the chat.
5. You review diffs, the agent opens a PR, checks run, you merge.
6. The workspace is archived and lives in History.

## Glossary

- **Room**: one repo (a folder with a git checkout). Has a team, a Lead chat and workspaces.
- **Workspace**: one task's working copy, usually a git worktree on its own branch, with its own port. Can also run on the current branch of the main checkout.
- **Chat**: a Claude Code or Codex session inside a workspace. A workspace can have several chats, on either provider, and a big terminal.
- **Agent**: a subagent file in `.claude/agents/` or `~/.claude/agents/`, a Claude Code plugin's agent, or Kernel's own Rowan or Theo where the repo has no Lead or reviewer. Has a name, role, tools and instructions. Its model comes from its role in Settings, Models and effort, unless its file pins one. Its tools line holds in Kernel. Hiring, editing or retiring one is either just for you on this Mac, or for the team as a pull request.
- **Provider**: the CLI an agent runs on, Claude Code or Codex. Each signs in with its own subscription, and can hold several accounts to switch between.
- **Lead**: the agent marked `lead: true` or `role: Lead`, the one picked in Settings, Agents, or Kernel's own Rowan. Plans and hands out work through Kernel's MCP tools.
- **Reviewer**: the agent that reviews each pull request: the one picked in Settings, Agents, an agent whose role says review, or Kernel's own Theo.
- **Helper**: an agent the Lead hands no task, because its tools can't open a pull request or Settings, Agents says so.
- **Approval**: anything waiting on you: a tool permission, a plan, or a question.
- **Task**: one step of an approved plan, handed to one agent as a workspace.
- **Checkpoint**: a snapshot of a workspace after each agent turn.

## Principles

- Real events only. A status in Kernel never comes from a timer.
- You stay in control: plans need approval and nothing merges by itself. You pick how much agents do without asking, from Manual to Bypass permissions, and Never allow, network off and protected branches hold in every mode.
- Everything is plain files where possible (agents, settings, scripts), so the setup works outside Kernel too.
- Quiet design. Color means something or it isn't there.

## v1 scope

Everything on the canvas, including the light theme, code signing, notarization and auto-update. See `docs/SCREENS.md`.

The isometric floor and the Board are hidden for now (D-104). Their code stays, so they can come back.

## Not in v1

Multiple users or shared rooms, cloud sync, Windows and Linux builds.

## Definition of done

The journey in KERNEL-31 passes on a real side project, start to finish, plus every failure screen shows when its condition really happens.
