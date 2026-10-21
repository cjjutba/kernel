# KERNEL-1094: how an agent's work reads in the transcript

Amends show-steps-while-turn-works-fold-when-done and KERNEL-800.

**A turn opens with one header and its steps sit under it.** While it runs, the header is the spiral loader, "Working" and the time since the turn began. Once it ends, it reads "Worked for 38s", and a turn under a second shows no time. The step count and the "Ran 5 commands, read 3 files" summary are gone: the header says how long and the steps say what. Folds still open while the turn runs and close on a real result, a stop or a quit, never on a timer.

**A step is an icon, a bold verb and a muted detail.** The verb is a present participle while the step runs ("Reading") and past tense once it ends ("Read"). A Bash step with a `description` uses it as its title and keeps the command as the detail, in mono. A failed step turns its title and icon red. A denied or stopped step says so in its verb. Steps carry no timers.

**Every turn ends with a meta line, time first.** The order is the time, then copy, retry and more. A reply that changed files puts the files changed card above it. The line shows on every turn, so a turn that is one reply looks like one with steps.

**A turn that didn't finish ends in one quiet line.** "You stopped Teng after 38s", "The turn stopped on an error", "The turn stopped at a usage limit" or "Cut off when Kernel quit". The error itself is a toast with Retry (`turnFailedToast`), raised when the failed result arrives, so no red card sits in the transcript. A turn the app cut off offers Continue on the last line of a chat that isn't running.

**Kernel's own messages are one line.** Kernel's avatar, the message's first sentence, and a "Note to <agent>" toggle that opens the full text with Copy. A quit note followed by Kernel's message folds into one line. The quiet-footer variant of the transcript is removed.

**The Session rail is a list of stages, drawn from real events only.** Briefed, Set up, Building, Reviewed and Merged. A finished stage is a plain green check (`--add`), a failed one a plain red x (`--del`), the one in progress a ring in ink and one to come a faint ring. Setup reads `workspace.setupRun`. Building reads whether a turn runs or waits on an approval or a question. Review and merge read the pull request. The rail takes the right side while the right panel is closed, and the panel's toggle swaps one for the other. Lead chats have none.

**An approval says why.** The permission card shows the agent's reason above the command, for Claude and for Codex, and an MCP call names its server. A question card has Steps, Long, Url and Other states, and an answered question becomes a quiet list in the transcript. Setup scripts the agent proposes get their own card (`ScriptsCard`). A chat's move to another account is a chat card with a recommended choice, not a banner above the composer.

**A chat that can't load is a calm empty state with Try again, plus a toast.** It reads "This chat didn't load". The red error card in the transcript is deleted.

Left for later parts: "Edit script" beside "Run again" on the Setup tab (6.6), the rail's host row, and the full Review and Merged stage detail (Part 10). Allow once has no "Allowing" label, since approvals still act at once (KERNEL-834). KERNEL-1094.
