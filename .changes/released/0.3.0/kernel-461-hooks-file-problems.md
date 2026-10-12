---
type: fixed
issue: KERNEL-461
---
Fixed Check hooks not saying why hooks can't be installed or can't run, such as a settings folder Kernel can't write, a settings file linked into the Nix store, or hooks turned off in Claude Code's settings, and each case now shows one fix.
