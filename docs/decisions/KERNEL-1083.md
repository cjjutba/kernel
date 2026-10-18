# KERNEL-1083: Kernel puts the review worktree on the PR head

Kernel fetches the remote and resets the review worktree to the PR's head commit before a review session's first turn and before each re-review. The review rule names the commit and no longer tells the reviewer to fetch or reset.

Why: the reviewer's own `git fetch` plus `git reset --hard` asked for approval on every Codex round. Adding that command to the skip-asking list in `bashGuard.ts` was rejected, since a hard reset can throw away work in any worktree. Kernel owns the review worktree and nobody edits there, so it does the move from the main process.

A failed fetch or reset stops the round with the usual "couldn't start the review" note and sends no message. A project with no remote reads the commits it has.
