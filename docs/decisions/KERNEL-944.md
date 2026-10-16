**Every new project lives on GitHub. Kernel creates the repo when a project has none.** Amends KERNEL-460 and KERNEL-477 for new projects. CJ's call, from the onboarding redesign: Kernel's add-a-project flows now ask for a repo up front instead of falling back to a local-only project.

**How.** `NewProjectRequest.github` names an owner and a repo name. Setup runs a `github` step right after the checkout: `gh repo create <owner>/<name> --private --source <folder> --remote origin`, with `--push` when the folder has a commit. The project's `repo` is saved, so Code host reads it as GitHub from then on. `github.owners` lists the signed-in user then their orgs, and `github.repoAvailable` checks a name before the form lets you create it.

**From scratch** is now an empty repo with a README and one commit on main, made by Kernel in a folder that was empty, then pushed to the new repo. The starter kit copy stays for requests that don't ask for a repo.

**A folder that isn't a repo** is initialized and gets the remote, and nothing is committed or pushed: Kernel still commits nothing in the user's folder (KERNEL-231). The step says to make the first commit and push it.

**Where the rule lives.** The add-a-project dialogs (KERNEL-945, KERNEL-946, KERNEL-947) always send `github` for a folder with no GitHub remote. The engine accepts a request without it, so existing local-only projects, and the tests built on local repos, keep working.
