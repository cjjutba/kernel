---
type: fixed
issue: KERNEL-829
---
Fixed auto-merge giving up when another pull request landed on the base branch mid-merge, merging a commit pushed after Kernel checked the pull request, and reporting a merge as failed after GitHub had merged it.
