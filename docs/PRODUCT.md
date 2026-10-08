# Kernel: product

## What it is

A Mac app that turns Claude Code into a small software team. Agents are Claude Code subagents defined in each repo's `.claude/agents/`. Rowan, the Lead, plans with you and hands each task to an agent, and every agent works in its own git worktree on its own branch. Kernel shows who is doing what in the sidebar and brings everything that needs you to the Inbox.

## Who it is for

Developers who already use Claude Code and want several agents working on one repo at once, each on its own branch, without losing track of who is doing what. Kernel is single-user: you, your Mac and your Claude plan.

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
- **Chat**: a Claude Code session inside a workspace. A workspace can have several chats and a big terminal.
- **Agent**: a subagent file in `.claude/agents/`. Has a name, role, model, tools and instructions.
- **Lead**: the agent marked `lead: true` (Rowan). Plans and hands out work through Kernel's MCP tools.
- **Approval**: anything waiting on you: a tool permission, a plan, or a question.
- **Task**: one step of an approved plan, handed to one agent as a workspace.
- **Checkpoint**: a snapshot of a workspace after each agent turn.

## Principles

- Real events only. A status in Kernel never comes from a timer.
- You stay in control: plans need approval, risky commands need approval, nothing merges by itself.
- Everything is plain files where possible (agents, settings, scripts), so the setup works outside Kernel too.
- Quiet design. Color means something or it isn't there.

## v1 scope

Everything on the canvas (119 screens), including the light theme, code signing, notarization and auto-update. See `docs/SCREENS.md`.

The isometric floor and the Board are hidden for now (D-104). Their code stays, so they can come back.

## Not in v1

Multiple users or shared rooms, cloud sync, Windows and Linux builds, API key billing (Kernel runs on the Claude subscription through Claude Code).

## Definition of done

The journey in KERNEL-31 passes on a real side project, start to finish, plus every failure screen shows when its condition really happens.
