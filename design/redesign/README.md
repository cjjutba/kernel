# Redesign reference (KERNEL-274)

The redesign canvas from October 2026, saved so later work can check screens against it. Each `<Screen>.png` is a 1440x900 render of `canvas/<Screen>.dc.html`. For the surfaces listed below, these PNGs replace the matching `design/screens/` PNGs as the spec. Everything else still follows `design/screens/`.

Live canvas: https://claude.ai/artifact/WjL6TnLm7UfAGjYtXsQWZe

To redraw the PNGs after editing an artboard, run `node design/redesign/render.mjs [Screen ...]`. It fills each artboard's template from its default props and screenshots it with headless Chrome, with reduced motion so an animated artboard renders as its still state. It skips interactive artboards. Set `CHROME` if the browser isn't at the default macOS path.

## Color

- Linear's neutrals and hues stay: the same greys, `--add`, `--del` and `--merged`. New tokens cover only plan mode and the PR bands.
- **PR header.** Every state gets a band: grey for neutral, green for open and ready, red for anything to fix, violet for merged. The label, the link pill and the buttons take the band's tone. A busy button keeps the tone and dims, and the spinner only ever appears on the button.
- **PR capsule.** With the right panel hidden, the PR cluster moves into the chat header inside a capsule that takes the band's own tint and line, so merged stays violet, ready green and failed red. The toggle sits outside the capsule in neutral grey, because it is window chrome and not a PR action.
- **Plan mode.** The composer gets a blue border and a glow from the bottom edge (`--plan`). Plan waiting uses the same blue, with Copy and Approve in a blue strip on top. There's no hatch and no label.
- **Amber (`--needs`).** It means "your turn": the waiting icon on sidebar rows and chat tabs, and the Inbox count.

## Composer (KERNEL-322)

There is one composer. `Composer` is its spec, and the composers on the other screens draw the same design by hand. Where they differ by a pixel or a grey, `Composer` wins.

- The box sits recessed on `--input-bg`, with padding 12/12/10. With one line of text it is 92px tall, border included.
- The agent is its name and role in a pill (`--line-3`, 999px), with no divider after it.
- Send is a 28px circle: grey when empty, ink when ready, blue when ready in plan mode, and ink again while a plan waits. While the agent works and the box is empty, it's a stop circle with a hairline.
- The role and the placeholder are `--muted`. `--faint` is about 3.4:1 on `--input-bg`.

## Motion (KERNEL-322)

Plan mode moves slowly and only the glow loops. `PlanMotion` plays every step on a loop. Open it on the canvas and press Play.

- The glow rises from the bottom edge over 1s when plan mode turns on, and fades over 1s when it turns off (KERNEL-418). The border follows it.
- While the box waits for input, the glow breathes between 90% and 62% every 8s. Only its opacity changes.
- Focus settles the glow at full over 1s and brightens the border over 0.6s.
- A plan's Copy and Approve strip opens over 1.2s, then one soft light crosses it over 2.6s.
- Send changes color in 0.16s. Nothing on a button loops.
- With reduced motion, nothing moves and the glow holds at 90%.

## Setup wait (KERNEL-430)

A new chat whose setup is still running, failed or was stopped. Canvas: https://claude.ai/artifact/DQK7CYXcuiQqAtpeGtqYDE

- The message you sent shows as a bubble where it will land, at lower contrast, with "Queued, sends after setup", Edit and Cancel under it. There's no skeleton, no note above the composer and no queue row.
- The chat has one line for setup: spinner, "Running setup", the command, and the time since setup started. The log lives only in the Setup tab. The line adds "Show log" only while the right panel is hidden.
- The composer stays usable and reads "Add a follow up". What you type queues behind the first message.
- A failed or stopped setup is one card above the composer: what happened and when, then Run again (solid), Send anyway and Edit script. The setup banner doesn't draw it a second time.
- While setup runs or has failed, the right panel opens on the Setup tab with the files pane folded to its header. After setup it goes back.
- No status tags in the sidebar, on tabs or on the bubble.
- Setup passing leaves one faint line, "Setup finished in M:SS". Send anyway leaves "Setup failed, sent anyway".

## Screens

| PNG | Shows | App surface |
|---|---|---|
| `Main` | The app before the redesign, for comparison | |
| `Proposed` | Workspace with the Run tab open | `screens/workspace/Panels.tsx`, `pr/PrHeader.tsx`, `components/sidebar/` |
| `ProposedSetup` | Setup tab empty state | `Panels.tsx` (bottom panel) |
| `ProposedTerminal` | Terminal tab | `Panels.tsx` (bottom panel) |
| `TeamUpdate` | Team update cards in Rowan's chat | `screens/workspace/cards/TeamUpdateCard.tsx` |
| `TeamUpdateShared` | Team update with a shared file card under the teammate's row (KERNEL-301) | `screens/workspace/cards/TeamUpdateCard.tsx` |
| `TeamUpdateMerge` | Team update rows with Merge: ready (`Merge #162`), a reviewer's row, blocked ("Waiting for Theo's approval"), Merging and Merged (KERNEL-351) | `screens/workspace/cards/TeamUpdateCard.tsx` |
| `LeadPrs` | The Lead's right panel with the PRs tab: "2 ready to merge" in the header, Ready to merge and Still open (KERNEL-354) | `screens/workspace/Panels.tsx` |
| `LeadPrsEmpty` | The Lead's right panel with no open PRs (KERNEL-354) | `screens/workspace/Panels.tsx` |
| `LeadPrsMerging` | A PR merging keeps its row in Ready to merge, with muted Merging (KERNEL-411) | `pr/LeadPrs.tsx`, `pr/MergeButton.tsx` |
| `LeadPrsNoneReady` | Open PRs, none ready: "2 open, none ready" on the grey band (KERNEL-411) | `pr/LeadPrSummary.tsx` |
| `LeadPrsMergeAll` | Merge all on the Ready to merge heading (KERNEL-411) | `pr/LeadPrs.tsx` |
| `LeadPrsMergeAllRunning` | Merge all running: "Merging 1 of 2" on the button, Merging and Next on the rows (KERNEL-411) | `pr/LeadPrs.tsx`, `pr/MergeButton.tsx` |
| `LeadPrsMergeAllStopped` | Merge all stopped: where and why above the lists (KERNEL-411) | `pr/LeadPrs.tsx` |
| `AskRowan` | Ask Rowan popover, empty | `components/footer/QuickAsk.tsx` |
| `NewChat` | New chat empty state | `screens/workspace/Transcript.tsx` |
| `SetupRunning` | New chat while setup runs: the queued bubble, the setup line, the Setup tab with Stop (KERNEL-430) | `screens/workspace/SetupWait.tsx`, `Panels.tsx` |
| `SetupFollowUp` | A follow-up typed while setup runs joins the queued bubble (KERNEL-430) | `screens/workspace/SetupWait.tsx` |
| `SetupEditQueued` | Edit pulls the queued message back into the composer (KERNEL-430) | `composer/Composer.tsx` |
| `SetupPanelHidden` | Setup running with the right panel hidden: the line adds Show log (KERNEL-430) | `screens/workspace/SetupWait.tsx` |
| `SetupFailed` | Setup failed: the card with Run again, Send anyway and Edit script (KERNEL-430) | `screens/workspace/SetupWait.tsx` |
| `SetupStopped` | Setup stopped from the Setup tab (KERNEL-430) | `screens/workspace/SetupWait.tsx` |
| `SetupSentAnyway` | Sent anyway after a failed setup (KERNEL-430) | `screens/workspace/SetupWait.tsx` |
| `SetupDone` | Setup passed and the message went out; the panel is back on the Run tab (KERNEL-430) | `screens/workspace/Transcript.tsx`, `Panels.tsx` |
| `Composer` | Every composer state: normal, working, plan mode and plan waiting, each empty and typing | `screens/workspace/composer/` |
| `PlanStates` | Plan mode and plan waiting, empty and typing | `composer/composer.css`, `cards/plan.tsx` |
| `PlanMotion` (no PNG) | The plan mode motion on a loop | `composer/composer.css`, `new-workspace/newWorkspace.css` |
| `PlanModeEmpty`, `PlanModeTyping` | Plan mode in Rowan's chat | `composer/composer.css` |
| `PlanWaiting`, `PlanWaitingTyping` | A plan waiting for approval | `cards/plan.tsx` (`PlanBar`, `PlanInline`) |
| `PrNoChanges` to `PrClosed` | One screen per PR state, in the order a PR moves through them | `pr/model.ts` (`headerView`), `pr/PrHeader.tsx`, `pr/pr.css` |
| `PrMergedOpen` | Merged with the panel open. The panel toggle ends the panel head, after Archive, in the window's top-right corner. The panel is drawn 400px wide, see Header and panel toggle | `screens/workspace/Workspace.tsx`, `pr/PrHeader.tsx`, `pr/pr.css` |
| `PrMergedHidden` | Merged with the panel hidden. The chat column fills the width, and the PR capsule and the toggle sit at the right end of the header | `screens/workspace/Workspace.tsx`, `pr/PrHeader.tsx`, `pr/pr.css` |
| `PrReadyHidden` | Ready to merge with the panel hidden, in the green band's tone | `screens/workspace/Workspace.tsx`, `pr/PrHeader.tsx`, `pr/pr.css` |
| `PrCiFailHidden` | Checks failed with the panel hidden, in the red band's tone | `screens/workspace/Workspace.tsx`, `pr/PrHeader.tsx`, `pr/pr.css` |
| `PrMergedHiddenLong` | Merged with the panel hidden and a long task title. The title cuts off with an ellipsis next to the capsule | `screens/workspace/Workspace.tsx`, `pr/PrHeader.tsx`, `pr/pr.css` |
| `HeaderBranchTooltip` | The header with the title hovered. The tooltip shows the full branch and "Click to copy the branch" | `screens/workspace/Workspace.tsx`, `pr/PrHeader.tsx`, `pr/pr.css` |
| `PrLocalReady` | A local merge, ready: the green band with Merge, "3 ahead of main · 0 behind" and the diff stat (KERNEL-441) | `pr/model.ts`, `pr/PrHeader.tsx`, `pr/pr.css` |
| `PrLocalBehind` | A local merge behind main: the grey band with Update branch and a note (KERNEL-441) | `pr/model.ts`, `pr/PrHeader.tsx`, `pr/pr.css` |
| `PrLocalConflict` | A local merge with conflicts: the red band with Resolve conflicts, and a note listing the files (KERNEL-441) | `pr/model.ts`, `pr/PrHeader.tsx`, `pr/pr.css` |
| `PrLocalMerging` | A local merge merging: Ready to merge with a busy Merging button (KERNEL-441) | `pr/model.ts`, `pr/PrHeader.tsx`, `pr/pr.css` |
| `PrLocalMerged` | A local merge merged: the violet band, "Squashed into main as 4e1b9c2" (KERNEL-441) | `pr/model.ts`, `pr/PrHeader.tsx`, `pr/pr.css` |
| `PrLocalDirty` | A local merge refused because the main checkout has uncommitted changes: the red band with Try again, and a note with the fix (KERNEL-441) | `pr/model.ts`, `pr/PrHeader.tsx`, `pr/pr.css` |

The PR screens cover No changes yet, No PR yet, Creating PR, Draft, Open, Checks running, Checks failed, Changes requested, Merge conflicts, Resolving, Ready to merge, Merging, Merged and Closed.

## Header and panel toggle

- **Toggle.** One button, `Hide panel` or `Show panel`, in the window's top-right corner in both states. With the panel open it ends the panel head, after Archive. With the panel hidden it ends the chat header. The right edge is at the same x in both. The canvas draws the chat header 40px high and the panel head 44px, so the two toggles differ by about 2px vertically on the canvas. The app has both at 44px.
- **Panel width.** `PrMergedOpen` draws the panel 400px wide. At the 380px the other PR screens use, the toggle takes the room the state label needs, and "Merged" shrinks to "Merg…". "Changes requested" is nearly as tight. 400px is the app's default at this window width (`clamp(320px, 28vw, 400px)` in `workspace.css`). The other PR screens stay as the spec for the panel's contents.
- **Header content.** Left to right: room, then the task title, the issue key chip, the editor icon. On the right: the PR capsule (panel hidden only) and the toggle.
- **Title.** It is `ws.title` on one line, cut off with an ellipsis. If the title starts with the issue key, the key is dropped from the text, because the chip shows it. Everything else in the header keeps its size, so the title is the only thing that shrinks.
- **Branch.** The header shows no branch text. Hovering the title shows the full branch in a tooltip with a second line, "Click to copy the branch", and clicking the title copies it. The tooltip is a hairline box on `--surface-2` with no shadow. A native `title` attribute can't draw it, so it is a custom tooltip.
- **Labels that stay.** Rowan's workspace keeps "latest origin/main" and a current-branch workspace keeps "current branch", because those labels carry meaning. They have no hover-to-copy.
- **Build notes.** The container rule that hides the PR button labels below 370px of head width needs the toggle's width counted in. The rule that hides the branch below 480px of header width goes away with the branch text.

## Merge (KERNEL-347)

- **Team update.** The newest row about a ready PR shows `Merge #N` before Open, in the ready band's soft tone (`--pr-ready-soft`, edge and fg). Older rows about the same PR keep Open only. While it merges the button reads Merging, dims and spins, and the row's events say "Merging PR #N". A merged row's event is violet, and its Open becomes In History once the workspace is archived. A PR that can't merge yet shows the reason in muted text in the button's place, such as "Waiting for Theo's approval". On a reviewer's row the button merges the PR under review.
- **Lead panel.** The header is the ready band with "N ready to merge" and a chevron, and clicking it opens the PRs tab. With nothing open it is the grey band reading "No open PRs", with no chevron. The PRs tab sits first, with the ready count. Ready to merge rows carry Merge and Open. The list scrolls above the Run panel, which keeps its normal height, so `LeadPrs` cuts the last Still open row off. Still open rows are muted, with the state word (Waiting for approval, Checks running, Checks failed, Changes requested, Merge conflicts or Draft) in the band's label tone and Open. A row is the agent, issue key, #N, title, the review line ("Theo approved" green, "Theo found 2 blockers" red, "Not reviewed" faint) and the lines added and removed.
- **Only the pressed button spins (KERNEL-411).** This amends the Team update bullet above. A Merge button spins and reads Merging only when it was pressed. Every other place the same PR shows (its Team update row, the PRs tab, the PR header) reads Merging in muted text with no spinner, and so does every place for a merge Rowan or Merge all started. Other PRs' buttons stay as they are.
- **Rows read like each other (KERNEL-411).** A Team update row shows the issue key from the workspace when the task has none, renders inline code in the reply as chips, says "Ready to merge" with the review as its own segment ("Theo approved" green, "Lumi reviewed an earlier commit" grey), and shows an open PR's state word ("Checks running") where Merge would be. The PRs tab shows the workspace title, never the raw `feat(scope): ... (KEY)` PR title. Both say a review in the same words.
- **Merging and Merge all (KERNEL-411).** A merging row stays in Ready to merge until GitHub says it merged. The band reads "N ready to merge", "N open, none ready" (grey, chevron) or "No open PRs" (grey, no chevron). With two or more ready PRs, Merge all sits at the right of the Ready to merge heading. It merges them one at a time, top to bottom, and reads "Merging 1 of 2" while the rows read Merging and Next. It stops at the first PR that can't merge and says where and why above the lists ("Merged #331. Stopped at #330. It has merge conflicts.") until the next run.
- **Settings.** `SettingsPRs` is drawn in `design/canvas/`. Merging comes before Instructions on Settings, Pull requests, so its switches show without scrolling, and it gains "Let the Lead merge when you ask", off, and "Review every pull request automatically", on. "Require Reviewer approval" now reads "Wait for the reviewer's approval to merge, when a review ran".

## Local merge (KERNEL-441)

A repo with no GitHub remote has no PR. Kernel merges the workspace into the base branch on the Mac, and the panel keeps the PR header's band, buttons and tones, so it reads like a PR on GitHub. The `PrLocal*` screens draw a Shop room, a local folder with no remote. Their sample content is not spec.

- **Header.** The `#N | ↗` link pill becomes a plain `→ main` pill in the band's tone, with the base branch in mono. There is no number to show and nothing to open, so it is not a link. The state's word, the button and the panel toggle follow as they do for a PR. There is no Create PR step, because the branch is what merges.
- **Merge line.** One line under the band, above the tabs, so every tab shows it: "3 ahead of main · 0 behind", with the numbers and `main` in mono. The room's merge method sits at the right in faint text: "Squash merge", "Merge commit" or "Rebase". A branch that is behind reads its count in ink at weight 500. Once merged the line reads "Squashed into main as 4e1b9c2", with the verb from the method: Squashed into, Merged into or Rebased onto. The diff stat stays where the Changes tab has it ("8 files changed +304 -15", Review all), because it is the same count.
- **States.** Ready to merge is green with a solid Merge. Behind main is grey with a soft Update branch. Merge conflicts is red with a soft Resolve conflicts, the same word and tone as the PR state. Merging keeps the green band and the label "Ready to merge", and the button reads Merging with a spinner, dimmed in the band's tone, as for a PR. Merged is the violet band with Continue and Archive, as for a PR. Refused is red, reads "Can't merge" and has a soft Try again.
- **Behind is grey, not red.** Nothing failed: main moved on and the branch needs to catch up. Red stays for what is broken.
- **Notes.** Behind, Conflicts and Refused each add one card under the merge line: `surface` fill, a `line-2` hairline, 8px radius, a 13px title, a 12px muted body, and a list under a hairline where files matter. Behind says "main has 4 new commits" and what to do. Conflicts says "Merging into main would conflict in 2 files", names the action, and lists the files with `C` in `--del` and "both changed" at the right. The Changes list marks the same files `C`. Refused says what is wrong ("Your main checkout has uncommitted changes"), that nothing was merged, and the fix ("Commit or stash these files there, then try again"), then lists the dirty files from `git status` with their M or U letter. The folder is named in mono.
- **Chat row.** The row that ends the transcript says the state in the same words as the PR rows: "Ready to merge into main. 3 ahead, no conflicts.", "main has 4 new commits. Update this branch before it merges.", "Merging into main would conflict in 2 files.", "Squashed into main as 4e1b9c2." and "Merge refused. ~/Projects/shop has uncommitted changes."
- **Sidebar and tabs.** A local workspace's row uses the branch glyph in the band's tone (green ready, grey behind, red conflicts and refused, a spinner while merging) and the violet merged glyph once merged. It never shows the PR glyph. The tabs stay as they are, and Checks reads "No checks reported", as it does for a PR with none. With the panel hidden, the capsule holds the same pill, word and button, as `PrReadyHidden` draws for a PR.
- **Room setup.** `RoomSetupGitHub` and `RoomSetupLocal` are drawn in `design/canvas/`. They add a "Code host" step after the first step (Clone, or Use your folder) and before the worktree folder. GitHub reads "GitHub, cjjutba/client-c", the owner and repo from the remote. Local reads "Local, no GitHub remote. Kernel merges branches on this Mac." It is a normal check row: a spinner while Kernel reads the remote, a check once it knows. `RoomSetup` and `RoomSetupTeam` are not redrawn and gain the row when it is built.

## Not built

The canvas draws a few things KERNEL-274 left out on purpose. Don't treat them as spec:

- The collapse arrow and the + for more terminals in the bottom panel.
- The close button in the Ask Rowan header. Escape and clicking outside close it.
- The centered composer on `NewChat`. The composer stays at the bottom, and only the title, subtitle and suggestions are redesigned.
- Sample copy on the canvas, such as chat text, issue titles and the Kernel notes for PR states the engine doesn't send.
