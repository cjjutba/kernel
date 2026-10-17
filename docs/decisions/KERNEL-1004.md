**A teammate's place is picked by the hand-off, then the project, then the app.** `create_workspace` takes `runs_in` (`kernel` or `terminal`). Without it, the project's `[terminal] teammates_run_in` applies, then the app's `terminal.teammatesRunIn` (default `kernel`). The value `lead` means the same as the Lead that handed off: a terminal Lead gets a terminal teammate, a chat Lead gets a Kernel one. The resolver is `teammateRunsIn` in `src/shared/teammateRuns.ts`. KERNEL-1004.

**A terminal teammate is a seat tab started as `claude "$(cat brief.txt)"`.** The brief goes through a file in the seat folder so quoting never breaks it. The first prompt resets the saved command to plain `claude`, so reopening the tab does not replay the brief. The seat reuses the KERNEL-998 wiring, so it has the teammate's prompt and tools. KERNEL-1004.

**Kernel never types into a terminal mid-turn.** A `message_agent` or review blocker for a terminal teammate waits for `Stop`. If the user typed in the seat since, it keeps waiting until a later clean `Stop`. Then it goes in as one bracketed paste followed by a separate Enter, once. Terminal replies such as focus and cursor reports do not count as typing. KERNEL-1004.

**`Stop` from a teammate seat runs the same path as the end of a Kernel turn.** Both call `turnFinished` in `features/sessionDeps.ts`, so the Lead hears about it the same way. KERNEL-1004.

**Terminal teammates count toward `models.agentLimit`.** A seat that is mid-turn takes a slot until `Stop`. A hand-off with no free slot waits without a pty and starts when one frees. KERNEL-1004.

**Some hand-offs stay in Kernel, and the Lead is told why in the `create_workspace` result.** Those are reviews (asking for a terminal review is refused), Codex agents, `wait_for` hand-offs, and briefs with images or other non-text attachments. KERNEL-1004.

**Known limits.** Queued messages live in memory and are lost on a Kernel restart. Only `message_agent` is routed to a seat. Kernel's own nudges (`prs.ts`, `waits.ts`, `inbox.ts`) still use `sessions.send` and do not reach terminal teammates. KERNEL-1004.
