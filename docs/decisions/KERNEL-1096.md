# KERNEL-1096: reviewing the work in the right panel

Amends the right panel notes in KERNEL-399 and KERNEL-512, and the shared file card in KERNEL-1094.

**The Session rail and the panel are one switch.** The title bar has three toggles: the bottom pane, the Session rail and the panel. The rail and the panel take the same column, so turning one on turns the other off. The panel has no "Back to session" row. `ui.rail` remembers that the rail is wanted while the panel is closed, in `kernel.railHidden`, so closing the panel brings back what was there before. A chat with no rail (the Lead, or a new chat) hides the Session toggle. KERNEL-1096.

**Focus mode is the state with nothing open.** When the sidebar, the panel and the rail are all closed, the title bar shows a Focus chip. The same shortcut brings back what was open before. It remembers what was open in memory only (`beforeFocus`), so a restart does not restore a Focus session. The chip shows ⌘\, the shortcut Focus already had. The Pen shows another key, which waits for a shortcut pass of its own. KERNEL-1096.

**Panel tabs are Files, Changes, Review and Pull request, and the Lead adds PRs.** Review and Pull request are full panel screens. The old Checks and Shared tabs are gone: checks live in Pull request, and shared files live in the Session rail and as chat cards. `PanelTab` in `src/shared/types/ui.ts` is the contract, and it changed in its own first commit. A saved `right: 'checks'` falls back to Changes. KERNEL-1096.

**Files and Changes are a list and a view that stack when narrow.** From 560px wide the list sits beside the file or diff, below that they stack. Both open the first changed file at once, so the view is never empty when there is something to see. Files defaults to Changed, with All files one click away, and remembers the choice (`kernel.filesScope`). Changes has List and Tree, a filter on its own row, and a Compare button with the base branch, another branch, a commit or the uncommitted changes. When the compared range has no changes the menu says so instead of listing nothing. KERNEL-1096.

**Git letters are A, D and M, and nothing is amber.** A, untracked and renamed are green, D is red with the name struck through, and M keeps its name in ink with a muted letter, so a long list of edits does not turn into a coloured wall. Folders take no colour. KERNEL-1096.

**Review is local until GitHub can resolve.** The Review tab lists the reviewer's blockers and the PR's review comments. Resolve is stored per workspace (`kernel.reviewResolved:<workspace>`). Kernel cannot resolve a comment on GitHub, so the tab says nothing about it and the PR keeps the thread open. "Ask <agent> to fix" and "Send all to <agent>" post a normal message to that agent's chat. KERNEL-1096.

**A diff is read in steps.** The diff has "n of m" with previous and next, and a Viewed mark stored per workspace (`kernel.viewed:<workspace>`). Selecting lines in a file or diff shows Send to agent, which adds the lines to the composer as a file chip. The message is still yours to write and send. KERNEL-1096.

**A shared file is a plain chat card whose images follow their count.** One image fills the card, two sit side by side, three put one large beside two, four make a grid, and five or more make a grid with +N on the last tile. Cards of one turn fold into one group (`foldShared` in `thread.ts`). The Session rail lists every shared file under Shared files. The viewer's toolbar has Version, a width picker (desktop, tablet, phone), zoom for images, Comment, open in the browser or Preview, and Show in Finder. The Reload button is gone, since a shared page is a file that never changes under you. KERNEL-1096.

**The Update pill no longer needs a special case in the workspace.** The panel header sits below the title bar's right edge, so the pill and the panel's buttons do not overlap. `[data-in-workspace]` and the `inWorkspace` prop are removed. KERNEL-1096.

**Left for later parts.** The Pull request tab shows checks, reviews, criteria and a short Merge button, and Part 10 owns the merge flows. The live preview embed (9.11) needs a native view in the main process, so Preview stays a row in the Session rail. The sidebar and shell changes in the Pen belong to their own issue. KERNEL-1096.
