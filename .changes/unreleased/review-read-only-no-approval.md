---
type: fixed
issue: KERNEL-1074
---
Fixed review workspaces asking for approval before commands that only read, such as git log, git diff and gh pr view. Running tests still asks.
