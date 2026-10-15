---
title: Issues
description: Plan work straight from Linear, GitHub Issues or Jira, and keep every workspace linked to its issue.
---

Kernel can take work from your issue tracker. Each room uses one tracker: Linear, GitHub Issues, Jira, or none. Set it in the room's General page.

## Connecting a tracker

| Tracker | How to connect |
| --- | --- |
| Linear | Add your Linear API key in Settings, Integrations, then pick the room's Linear team. Kernel keeps the key in the macOS Keychain. |
| GitHub Issues | Uses the GitHub CLI you already signed in to. Nothing else to set up. |
| Jira | Add your Jira site, email and an API token in Settings, Integrations. |

## The Issues screen

**Issues** in the sidebar lists the room's open issues, with filters for team, project and cycle, and the agent and state of any issue already in progress. Select one to read its description, comments and linked workspaces, then:

- **Plan with Kernel** starts a chat with Kernel on the issue. Kernel reads it and its comments first.
- **New chat** starts a plain chat with the issue attached.

New chat also lists the next issues in **Up next**, each with a **Plan** button.

## Before work starts

Before Kernel starts work on an issue, it looks for a branch someone already pushed, an open pull request, or another assignee, and asks you first when it finds one. New branches never take a name someone already pushed.

## While work runs

- Agents read the issue they work on, its description and latest comments, without a tracker MCP server.
- Starting a workspace on a Linear issue moves the issue to In Progress.
- Every workspace Kernel hands off links back to its issue. The issue's page lists them under **Linked workspaces**, with each one's state.
- When Linear marks an issue as blocked by another a teammate is building, Kernel tells the teammate once the blocking pull request merges.

## Linking an issue to a chat

In any chat, ⌘I or the + menu in the message box links an issue, so the agent gets it as context. The same menu can link other workspaces in the room.
