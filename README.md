# Kernel

Kernel turns Claude Code into a small software team on your Mac. You brief the Lead, approve a plan, and agents build in their own git worktrees, ask before anything risky, open pull requests and wait for you to merge.

**[Download Kernel for Mac (Apple silicon)](https://github.com/cjjutba/kernel/releases/latest/download/Kernel-arm64.dmg)** · [Website](https://kernel.cjjutba.dev)

![Home: what needs you across every room, with each room's team, Lead and workspaces in the sidebar](docs/images/home.png)

## Requirements

- A Mac with Apple silicon, on a recent version of macOS
- [Claude Code](https://docs.claude.com/en/docs/claude-code) 2.1.80 or later, signed in with a Claude plan
- git
- The [GitHub CLI](https://cli.github.com) (`gh`), signed in, for pull requests

On first launch Kernel checks Claude Code, your sign-in and the GitHub CLI, and tells you how to fix whatever is missing.

## How it works

### Rooms and the team

Each repo you add is a room, and every agent in the repo's `.claude/agents/` folder is on its team. The sidebar lists each room's Team, its Lead and its workspaces, and Home shows what needs you across all of them. Every status comes from real Claude Code events. Nothing changes on a timer, so an idle agent looks idle.

![The team: each agent with its model, status and workspace](docs/images/team.png)

### Rowan plans and hands off

Rowan is the Lead. Open Rowan's chat from the sidebar and brief Rowan in a sentence or two. Rowan works out a plan in plan mode and brings it to you. You approve it or ask for changes. Once you approve, Rowan creates one workspace per task and hands each one to the right teammate.

![Rowan's plan for four tasks, waiting for approval in Rowan's chat](docs/images/lead-plan.png)

### Workspaces and pull requests

A workspace is one task: a git worktree on its own branch, with its own port for the dev server. You can chat with the agent, read the diff file by file, run setup and run scripts, and open a pull request when it's ready. Checks show up in the workspace. After the merge, archive the workspace and it moves to History.

![A workspace after its pull request merged](docs/images/workspace.png)

### The Inbox

Anything that needs a decision lands in the Inbox: a command an agent wants to run, a plan to review, a question, a PR that's ready to merge. You can approve a command once or always allow it in that room. Nothing merges by itself.

![The Inbox with a database command waiting for approval](docs/images/inbox.png)

### Checkpoints and the big terminal

Kernel snapshots the worktree after every agent turn. If a turn goes wrong, revert to an earlier checkpoint and the files go back while the chat stays. When you want plain Claude Code, open a terminal tab in the workspace. It runs `claude` in the same worktree, and Kernel still follows the session through its hooks.

![Checkpoints for a workspace, one per turn](docs/images/checkpoints.png)

![A Claude Code terminal tab inside a workspace](docs/images/terminal.png)

## Privacy

Kernel runs on your own Claude plan, using the Claude Code login you already have. There is no Kernel account and no Kernel server. Your rooms, chats, settings and history stay in a local database on your Mac.

Kernel itself makes these network calls and no others:

- Claude Code, which talks to Anthropic as it always does
- `gh`, for pull requests and checks
- git, to fetch and push branches on your repo's own remote, and your package manager when a new room installs dependencies
- The update check, which reads this repo's GitHub Releases
- An offline check, a DNS lookup of `api.anthropic.com`
- Linear, only if you connect it in Settings

## Build from source

You need Node 22 or later and the Xcode command line tools.

```sh
git clone https://github.com/cjjutba/kernel.git
cd kernel
pnpm install
pnpm dev
```

`pnpm install` also rebuilds the native modules for Electron. `pnpm dist:mac` builds an unsigned app into `dist/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for tests and pull requests, and [docs/RELEASING.md](docs/RELEASING.md) for signed releases.

## How Kernel was built

Claude Code agents built Kernel one Linear issue at a time, working from a canvas of 119 screen designs. [docs/DECISIONS.md](docs/DECISIONS.md) and [docs/decisions/](docs/decisions/) record every choice someone might later want to undo, with the reason. They are kept as they were written.

## License

Kernel's source is available under the [Elastic License 2.0](LICENSE.md). In plain terms:

- You can use Kernel for free, fork it, modify it and self-host it, for personal or commercial work.
- You can't sell Kernel to others as a hosted or managed service.
- You can't remove or work around license keys, if Kernel ever has them.

This summary isn't the license. [LICENSE.md](LICENSE.md) is.
