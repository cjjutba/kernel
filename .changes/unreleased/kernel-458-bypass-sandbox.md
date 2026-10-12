---
type: new
issue: KERNEL-458
---
Claude agents in Bypass permissions now run their commands in a sandbox that limits writes to the workspace, the repo's git folder, temp files and package caches, and network access to GitHub and the npm registries.
