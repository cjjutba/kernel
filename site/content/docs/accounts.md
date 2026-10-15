---
title: Accounts and usage
description: Sign in to Claude Code and Codex, use several accounts, watch usage and switch accounts at a limit.
---

Agents run on Claude Code or Codex, with your own plan. Settings, Accounts lists every account you've added, with its nickname, plan and usage.

## Adding accounts

- **Claude.** Add account, then sign in in your browser. Each account shows its own email, plan and usage.
- **Codex.** Sign in with your ChatGPT plan. Codex is only needed if a role runs on it.
- **API keys.** Add an Anthropic or OpenAI API key as an account, billed per token by that provider. Subscriptions and API keys are listed apart.

You can hold several Claude and ChatGPT accounts. ⌘K, or the account menu at the top of the sidebar, switches between them.

## Which account a role uses

Settings, Models and effort sets each role's provider, model and effort: Kernel, the reviewer, engineers and QA. It also sets where each role's chats compact. New installs get models, effort and limits that fit your plan.

## Usage

The footer shows usage for the accounts in use, Claude Code and Codex together: the 5-hour window, the weekly window and per-model limits. Click it for every account, with the time each limit resets. Meters turn amber and then red near a limit.

A banner warns before an account reaches its limit and offers to switch to one with project. A weekly warning comes at 80%, if **Weekly limit warning** is on.

## Switching at a limit

With **Switch accounts at a limit** on, in Settings, Accounts, Kernel moves agents to the account with the most headroom when one hits its limit. The chat notes where the account changed, and a notice offers **Undo**.

**Pause new work near a limit** holds new tasks so running ones can finish. When no account has headroom, Kernel pauses the project and resumes it on its own once the limit resets.

## MCP servers

MCP servers you add sign in once for every Claude account. A claude.ai connector, such as Google Drive, belongs to its claude.ai account. Settings, MCP servers shows which servers are ready on each account, and **Set up this account** signs in to everything an account is missing in one go.
