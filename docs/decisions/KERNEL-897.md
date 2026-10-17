# KERNEL-897: state words on the Lead's PRs tab take green and red only

**Approved reviews read green and failing states read red. Every other state word stays muted.** This replaces the plain grey words of KERNEL-757 and the `pr-fail-text` red of KERNEL-347 on this tab.

- Green (`--add`): "Code approved" with a check, "Code and security approved" with a shield and check. Red (`--del`): any fail tone, with an x in a circle. These are the colors the Merge button and diff counts already use on the row.
- Running states keep the muted word and show the spinner. "Waiting for approval" keeps the muted word and shows a clock. "Not reviewed" and "Draft" have no icon.
- Why only two: the maintainer compared a six color option against this one in a mock and found six too noisy. Blue for running and amber for waiting would add colors that say nothing a person acts on. Running and waiting need nothing from the reader yet, so grey is the right weight, and the icon carries the difference.
- The row's left icon, agent name, PR number, diff counts and Merge button are unchanged.
- `ReviewPhrase` gained `approved`, the kinds behind a good phrase, so the row tells full approval from code alone without reading its text.
