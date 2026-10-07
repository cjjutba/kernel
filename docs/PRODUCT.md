# Kernel: product

## What it is

A personal Mac app that turns Claude Code into a small software team. Agents are Claude Code subagents defined in each repo's `.claude/agents/`. They work in their own git worktrees, and Kernel shows them as people in an isometric office: seated at desks, walking to hand off tasks, raising a hand when they need CJ.

## Who it is for

CJ, a solo full-stack freelancer, running side projects. He is the first and only user for v1. FiscPlus (client work) stays on Conductor.

## The core loop

1. CJ briefs Rowan, the Lead, from the floor or the new workspace modal.
2. Rowan plans (plan mode) and asks for approval.
3. CJ approves. Rowan creates one workspace per task and hands each to an agent.
4. Agents build. Anything risky comes to CJ as an approval in the Inbox, on the floor, or inline in the chat.
5. CJ reviews diffs, the agent opens a PR, checks run, CJ merges.
6. The workspace is archived and lives in History.

## Glossary

- **Room**: one repo (a folder with a git checkout). Has a floor, a board, a team and workspaces.
- **Floor**: the isometric office view of a room's team and live activity.
- **Workspace**: one task's working copy, usually a git worktree on its own branch, with its own port. Can also run on the current branch of the main checkout.
- **Chat**: a Claude Code session inside a workspace. A workspace can have several chats and a big terminal.
- **Agent**: a subagent file in `.claude/agents/`. Has a name, role, model, tools and instructions.
- **Lead**: the agent marked `lead: true` (Rowan). Plans and hands out work through Kernel's MCP tools.
- **Approval**: anything waiting on CJ: a tool permission, a plan, or a question.
- **Task**: one step of an approved plan, shown on the Board.
- **Checkpoint**: a snapshot of a workspace after each agent turn.

## Principles

- Real events only. The floor never fakes activity.
- CJ stays in control: plans need approval, risky commands need approval, nothing merges by itself.
- Everything is plain files where possible (agents, settings, scripts), so the setup works outside Kernel too.
- Quiet design. Color means something or it isn't there.

## v1 scope

Everything on the canvas (119 screens), including the light theme, code signing, notarization and auto-update. See `docs/SCREENS.md`.

## Not in v1

Multiple users or shared rooms, cloud sync, Windows and Linux builds, API key billing (Kernel runs on the Claude subscription through Claude Code).

## Definition of done

The journey in KERNEL-31 passes on a real side project, start to finish, plus every failure screen shows when its condition really happens.
