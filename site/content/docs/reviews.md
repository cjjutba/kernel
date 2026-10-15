---
title: Reviews
description: How a reviewer checks each pull request, what holds a merge, and how to choose which reviews run.
---

Kernel can review each pull request once its checks pass, before it comes to you. A review approves the pull request or reports blockers, and blockers on the latest commit hold the merge.

## Turning reviews on

Automatic review is off by default. Turn on **Review every pull request automatically** in Settings, Pull requests. Until you do, Kernel's update says why no review ran and where to turn it on.

## Who reviews

The project's reviewer: the agent picked in the project's Agents page, an agent whose role says review, or Kernel's own code review when the repo has no reviewer agent. Theo is the starter reviewer you can add to any project.

## Kinds of review

| Review | Runs on |
| --- | --- |
| Code | Every pull request |
| Security | The files a project chooses |
| UX | The files a project chooses |

The whole team chooses which reviews run, which agent runs them, and how many review rounds go by before a pull request comes to you, in the project's Pull requests page. Those choices live in the repo's settings, so everyone on the repo gets them.

## Blockers

- Blockers a reviewer found on a pull request's latest commit hold the merge.
- A pull request with blockers doesn't count as ready to merge. **Merge anyway** merges it on purpose.
- After a fix, Kernel reviews again only what found blockers or what the fix touched.
- A pull request still blocked after the project's review rounds comes to you, and the Team update says so.
- Reviews block only on real problems, and on the rules in the repo's own `CLAUDE.md` or `AGENTS.md`.

## Saving usage

When usage is close to a limit, Kernel skips optional reviews, such as UX, and the Team update says which reviews ran or were skipped.
