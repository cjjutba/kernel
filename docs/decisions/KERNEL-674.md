**Usage lives in the footer's bottom left, and the sidebar's bottom row is gone.** Amends KERNEL-619 and KERNEL-588. The Usage pill, the gear and What's new left the sidebar. Settings and What's new stay in the account menu, and Cmd+comma still opens Settings.

The row lists every signed-in account of Claude Code, a hairline, then Codex. The active account is first with its mark, name and 5h and wk bars (Compact: mark, one bar and the tightest window's number). Others are a name and their 5-hour number. The active chip opens the popover. Another chip switches with the popover's Switch, ordered by `switchChoices`, and an account waiting for Keychain access or a key that isn't in use gets no chip. Amber from 75%, red from 90%, reset times as clock times, no timers.

The popover is 360px, opens upward, and has a Detailed and Compact switch kept across launches (`ui.usageView`, with the open rows in `ui.usageOpen`). It keeps the KERNEL-619 rules: "Billed per token" for a key, one line with Sign in for a signed-out provider, "No usage reported yet" for a window that has reset. It names a model window "Fable 5.1 weekly", as UsagePopover.png draws it. Settings keeps "Weekly, Fable 5.1".

**The GitHub paused notice was removed** (KERNEL-401), with `githubPause` and its tests. It is not shown anywhere now. **Hooks down no longer shows in the footer.** It shows in the "Hooks are disconnected" banner above the composer and in Settings, Hooks.

## Amendment: the footer spans the window, with an Orca-style row and a refresh button

**The footer is the window's full width.** It sits under the sidebar and the main panel, not inside the main panel, so the usage row starts at the window's bottom left corner and the popover opens upward from there. Screens that hide the footer still do, and with the sidebar hidden it still spans the window. The `design/screens/UsageFooter*.png` targets show the old placement and row on purpose and were not edited.

**The row.** The active account of each provider shows its mark, name, a 5-hour bar and its numbers inline: `5h 6% · wk 100%`, plus `Fable 5.1 0%` for a Claude account that reports a Fable window. Other accounts stay a name and their 5-hour number, then a hairline and Codex the same way. Reset times stay in the popover, because statuses never run on timers. A narrow window drops the other accounts' chips first, then the Fable number. Amber from 75% and red from 90% are unchanged, and Compact keeps its single tightest number.

**Refresh.** An icon button right after the row calls `usage.get` with `{ force: true }`, which reads every signed-in account again and answers when it is done. It spins, is disabled and says "Refreshing usage" meanwhile. A failed read keeps the last numbers.

**The popover's Switch list.** In Detailed, each other account lists its 5-hour, weekly and Fable 5.1 weekly windows with the same meters and notes as the active account. A key still says "Billed per token", and Compact keeps one number.

## Amendment: a shorter Detailed popover and a minimal account menu

**Detailed is one row per window.** The active account lists each window as a label, a short meter, the percentage and the reset as muted text on the same row. Under Switch, each other account is one row: name, muted plan and `5h 12% · wk 20% · Fable 31%` with the same amber and red steps, no bars or reset times. A key row says "Billed per token". Compact and the folded Codex row are unchanged.

**The account menu no longer shows usage.** It lists each provider's accounts as one row each, name and muted plan with a check on the one in use, and the whole row switches to that account. A key says "Billed per token" and a signed-out account says "Signed out". The Usage item is gone, since the footer opens usage.
