---
type: improved
issue: KERNEL-401
---
Kernel hears when GitHub blocks or unblocks a pull request that passed its checks, asks the agent to update a branch that fell behind, and the Inbox waits to say ready to merge until GitHub would merge it.
