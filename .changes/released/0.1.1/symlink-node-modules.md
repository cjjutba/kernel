---
type: new
issue: KERNEL-53
---
With Symlink node_modules on in Settings, Files, new and restored workspaces use the main checkout's node_modules, so agents can start without installing packages again.
