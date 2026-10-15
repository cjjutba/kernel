---
title: Permissions
description: Choose how much agents do without asking, and what always holds.
---

Every chat runs in a permission mode that decides which steps ask you first. Settings, Permissions sets the default, each room can override it, and each chat can pick its own from the mode menu in its message box.

## Modes

| Mode | What it does |
| --- | --- |
| Manual | Asks before every edit and command. |
| Accept edits | Edits files without asking. Commands still ask unless a rule allows them. |
| Plan | Plans first and changes nothing until you approve. See [Plans](/docs/plans). |
| Auto | A classifier approves routine work and asks you about anything else. Commands on your Always ask list still come to you. |
| Bypass permissions | Skips every prompt, including your Always ask list. |

Shift+Tab cycles a chat through them in that order. Auto isn't available on Codex, so Codex agents use Accept edits there, and the menu says why.

## What always holds

In every mode, Bypass permissions included, Kernel still stops for:

- **Never allow**, the commands and tools you never want run
- pushes that might reach a **protected branch**
- **network off**, when you turn off network access
- questions and plan approval

In Bypass permissions, Claude agents run their commands in a sandbox that limits writes to the workspace, the repo's git folder, temp files and package caches, and network access to GitHub and the npm registries.

## Answering a request

A request says what the agent wants to run and why Kernel is asking, in one line under the command. Answer it in the chat, on Home or in the Inbox:

- **Allow once** runs it this time.
- **Always allow here** allows it in this room from now on. A chained command counts when every part of it is allowed.
- **Deny** refuses it. ⌘↵ approves and ⌘⌫ denies.

A room's Permissions page lists the commands and tools saved with Always allow, and removes them.

## Settings, Permissions

| Setting | What it does |
| --- | --- |
| Permission mode | The mode new chats start in |
| Always ask before | Commands that always come to you, except in Bypass permissions |
| Never allow | Commands and tools that never run |
| Protected branches | Branches no push may reach |
| Allow network access | Turn off to keep agents offline |
| Approval timeout | How long a request waits for you |
