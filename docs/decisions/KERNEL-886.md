**A branch on the remote takes its base by a merge, never a rebase.** The guard hook denies every agent force push (D-023), and a rebased branch that is already on the remote can only be pushed with one. So every message Kernel sends about a base that moved picks its wording from whether the branch is pushed. A branch that has never been pushed rebases onto the base. One on the remote merges `<remote>/<base>` in and pushes as usual. Kernel reads "pushed" from the branch's remote-tracking ref, which a push sets, with no network call. A ref git can't read counts as pushed, since a merge is never wrong and a rebase of a pushed branch is.

Where it applies:

- Update branch always asks for a merge.
- The base watch's conflict and catch-up messages, and the "told X to …" lines in the project's log.
- The wait messages: the release message, the one held with a brief, the "Kernel asks X to …" notes, the teammate's own `wait_for_merge` reply for work that already merged, and the Lead's To do line when a turn ends without the base (the event carries `pushed`).
- The Lead's To do lines for a PR behind its base or in conflict, for a teammate and for a Build here chat. A PR's branch is always pushed, so they ask for a merge and never mention a force push.
- The default Resolve conflicts text asks for a merge, for the same reason. The default Create a pull request text rebases only before the first push, and no longer mentions `--force-with-lease`. Only the defaults changed. Settings save a default as unset, so installs that never edited a text get the new one, and edited text stays as written.
- The Lead-facing wait texts, in its updates and in its `wait_for_merge` result, say Kernel tells the teammate to bring its branch up to date, since they are written before Kernel knows which way it goes.

The wait kept for a missing rebase (KERNEL-691) checks that the branch contains the base by ancestry, so a merge ends it the same way a rebase does. KERNEL-886.
