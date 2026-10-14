---
title: Privacy and data
description: What stays on your Mac, every network call Kernel makes, and what the website's waitlist keeps.
---

Kernel runs on your own plan, with the logins you already have. There is no Kernel account and no Kernel server. Your rooms, chats, settings and history stay in a local database on your Mac.

## Network calls

Kernel itself makes these network calls and no others:

- **Claude Code and Codex**, which talk to Anthropic and OpenAI as they always do
- **`gh`**, for pull requests and checks
- **git**, to fetch and push branches on your repo's own remote, and your package manager when a room installs dependencies
- **The update check**, which reads Kernel's GitHub Releases
- **An offline check**, a DNS lookup of `api.anthropic.com`
- **Linear or Jira**, only if you connect them in Settings, Integrations
- **Usage data**, only if you turn it on

## Usage data

Kernel asks once whether to share anonymous usage data, and it's off until you say yes. It sends anonymous counts of what goes wrong and the class of an error, never code, prompts, file paths or names. Settings, Privacy lists every event it kept or sent, and turns sharing off.

## Keys and tokens

Kernel keeps your Linear key in the macOS Keychain. Diagnostics you copy from the Help menu hide tokens and your home folder.

## Agents and permissions

What agents can do is up to you. See [Permissions](/docs/permissions) for the modes, and for Never allow, protected branches and network off, which hold in every mode.

## Waitlist

The website's waitlist for Windows, Linux and Intel Macs, on the home page and Pricing, is the one place this website collects anything.

- **What we keep:** your email address and the platforms you picked.
- **Confirmation first:** we send one email to confirm the address, and add you to the list only once you confirm. Without a confirmation, you aren't added.
- **Who handles it:** the list is kept with Resend, the email service that sends the confirmation and the one announcement.
- **What we send:** one email if Kernel comes to a platform you picked. Nothing else.
- **Leaving:** the announcement has an unsubscribe link. To be removed sooner, [open an issue](https://github.com/cjjutba/kernel/issues) and we will delete your address.
