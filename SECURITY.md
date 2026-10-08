# Security

Please report security issues privately through GitHub's private vulnerability reporting: open the [Security tab](https://github.com/cjjutba/kernel/security) of this repo and choose **Report a vulnerability**. Don't open a public issue for them.

Include what you found, how to reproduce it, and the Kernel version (Settings > About). You'll get a reply in the advisory thread.

Kernel runs Claude Code with your own permissions on your own Mac, so the most useful reports are ones where Kernel lets something happen that you didn't approve: a command that skips the approval queue, a hook endpoint reachable from outside your machine, or an agent writing outside its worktree.
