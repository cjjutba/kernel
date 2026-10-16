**Project setup happens on the project's New chat page, and adding a project installs nothing.** Amends KERNEL-682 (the project's one-time Install step stays was its line) and the full-screen ProjectSetup from KERNEL-20. CJ's call, from the onboarding redesign: setup should look like Conductor's new workspace, not a screen of its own.

**No Install step.** A new project is only checked out: clone, the GitHub repo when one is made (KERNEL-944), the worktree folder, files to copy, hooks, push access, agents. Dependencies come from the project's setup script, which runs in each new chat's worktree. A project with no setup script shows "No setup script yet" with a link to Settings, Scripts. A setup saved by an older build drops its Install step when it is restored, so it can still finish.

**Rows, not a screen.** Each dialog that makes a project opens its New chat, and the steps show there as plain rows under "You're in <project>". A row says what happened in the past tense; a running step spins; a warning keeps its one action (review the files to copy, copy the push fix); a failure shows its error with Try again. Kernel's own code writes every row, so none of it uses tokens. The rows come from the `project.setup` steps Kernel already pushes, not from stored chat messages.

**Sending waits for the checkout.** Until the clone (and the GitHub repo) is there, Send says so instead of starting a chat that has nothing to branch from. The setup script's own progress is the chat's, as KERNEL-430 built it.

**The old route still works.** `onboarding/project` opens the project's New chat, so a saved place or a dialog from before lands somewhere real.
