**Nothing Kernel starts waits on a git login prompt.** `exec` sets `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` over whatever the caller passes. `sessionEnv` (Claude) and `codexEnv` (Codex) set the same two, so an agent's own `git push` gets them too. A push with no login now fails at once with git's error, which the agent and the push check can read. Before this, a prompt or a Git Credential Manager window could hold the push until the turn timed out. SSH gets no switch. `BatchMode` would need `GIT_SSH_COMMAND`, which replaces the user's own `core.sshCommand`, and an ssh with no terminal fails on its own.

**The push check does a dry-run push, because gh's answer alone isn't enough.** Reach is `git ls-remote <remote> HEAD`. Push is gh's `permissions.push` on the repo plus `git push --dry-run --no-verify --recurse-submodules=no <remote> HEAD:refs/heads/kernel-push-check-<ms>`. On a public repo, ls-remote needs no login and gh says the user can push, while git itself has no login. That is the case KERNEL-437 draws. The dry run logs in the way a real push does, since GitHub asks for a login before a push even on a public repo. It sends nothing and runs no pre-push hook. The branch name never exists, so it can't be rejected as behind. Each step has 20 seconds.

**A refused login counts as reached.** A private repo refuses ls-remote too. The host answered, so Reach origin says Reached, and Permission to push carries the failure, because the fix is the login. "Check your connection or VPN" shows only when no answer came back.

**Each failure gets one fix where one command fits.** The drawn case is gh signed in and git refused over HTTPS, and the fix is `gh auth setup-git`. These cases aren't drawn:

- gh's login can only read. "sam can only read acme/app. Ask its owner for write access." No command.
- Over HTTPS with gh signed out, the fix is `gh auth login`, which offers to set git up. With no gh at all, it is `brew install gh && gh auth login`.
- An SSH key the host refuses, or a remote that isn't on GitHub, shows git's error in the box with no command, since no single one fits.
- A repo gh can't see reads "sam can't see acme/app on GitHub."
- A checkout with no commit has nothing to dry-run. gh's answer stands, or the row reads Not checked with "Needs a first commit".

This amends KERNEL-437 in one place. Over SSH with gh signed out, the dry run answers the question, so the row reads "Can push" with "From your SSH key" rather than "Not checked" with "gh isn't signed in".

**The same failed push is a red x in Settings, Room, Git and an amber warning in room setup.** A warning never blocks setup (KERNEL-437). A room that can't push can still plan and build, and only the push waits for the fix. Settings, Room, Git reports the state, so it says Failed. A setup that ends with a warning doesn't move to the Lead's chat on its own, so the warning gets read.

**The check runs at room setup and from Settings, Room, Git, not at launch or hand-off.** Setup runs it after Install hooks, for a checkout with a remote. The Git page runs it when it has no result for the room's current remote. Results stay in memory per room, and Check again runs it now, updating the setup step while setup is on screen. Each run costs two round trips to the host. With no prompts, an agent whose push can't work fails right away with git's reason.

**The `setUpstream` setting is gone.** Nothing read it. A settings file that still has it loads without it.

KERNEL-460.
