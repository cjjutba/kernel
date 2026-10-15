---
title: Install
description: What Kernel needs, how to install it, and what the first launch checks.
---

## Requirements

- A Mac with Apple silicon, on macOS 13 or later
- A Claude plan for Claude Code, a ChatGPT plan for Codex, or both. Either one is enough. Agents run on the plan you already have.
- git 2.38 or later
- The [GitHub CLI](https://cli.github.com) (`gh`), signed in, for pull requests. Everything else works without it.

Kernel brings its own copy of Claude Code and of Codex, so you don't need to install either first. Codex is only checked if you set a role to run on it.

## Download and install

1. [Download Kernel for Mac](https://github.com/cjjutba/kernel/releases/latest/download/Kernel-arm64.dmg). It's a signed and notarized disk image.
2. Open it and drag Kernel into Applications.
3. Open Kernel from Applications.

Kernel updates itself. When an update has downloaded, a card in the bottom right says so, with **See changes** to read what's new and **Restart** to install it.

## First launch checks

On first launch Kernel checks your Mac and tells you how to fix anything missing. Each check that fails comes with the command to run.

| Check | What it needs | How to fix it |
| --- | --- | --- |
| Claude Code | Kernel's own copy, version 2.1.80 or later | Reinstall or update Kernel |
| Signed in | A Claude sign-in for agents on Claude Code | `claude auth login` |
| Hook server | Kernel listening for Claude Code's events | Settings, Hooks |
| Codex | Only if a role runs on Codex, signed in with a ChatGPT plan | `codex login`, or Settings, Accounts |
| Git | git 2.38 or later | `xcode-select --install` or `brew install git` |
| GitHub CLI | `gh`, signed in, for pull requests | `brew install gh`, then `gh auth login` |

If your shell sets `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX`, agents bill your AWS or Google Cloud account and no Claude sign-in is needed.

The first run also asks which [permission mode](/docs/permissions) new chats start in. You can change it later in Settings, Permissions.

## Build from source

You need Node 22 or later and the Xcode command line tools.

```sh
git clone https://github.com/cjjutba/kernel.git
cd kernel
pnpm install
pnpm dev
```

`pnpm install` also rebuilds the native modules for Electron. The repo's contributing guide covers tests and pull requests.

## Next

[Give Kernel your first brief](/docs/first-brief).
