# Redesign reference (KERNEL-274)

The redesign canvas from October 2026, saved so later work can check screens against it. Each `<Screen>.png` is a 1440x900 render of `canvas/<Screen>.dc.html`. For the surfaces listed below, these PNGs replace the matching `design/screens/` PNGs as the spec. Everything else still follows `design/screens/`.

Live canvas: https://claude.ai/artifact/WjL6TnLm7UfAGjYtXsQWZe

To redraw the PNGs after editing an artboard, run `node design/redesign/render.mjs [Screen ...]`. It fills each artboard's template from its default props and screenshots it with headless Chrome, with reduced motion so an animated artboard renders as its still state. It skips interactive artboards. Set `CHROME` if the browser isn't at the default macOS path.

## Color

- Linear's neutrals and hues stay: the same greys, `--add`, `--del` and `--merged`. New tokens cover only plan mode and the PR bands.
- **PR header.** Every state gets a band: grey for neutral, green for open and ready, red for anything to fix, violet for merged. The label, the link pill and the buttons take the band's tone. A busy button keeps the tone and dims, and the spinner only ever appears on the button.
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

- The glow rises from the bottom edge over 2.4s when plan mode turns on, and fades over 1.6s when it turns off. The border follows it.
- While the box waits for input, the glow breathes between 90% and 62% every 8s. Only its opacity changes.
- Focus settles the glow at full over 1s and brightens the border over 0.6s.
- A plan's Copy and Approve strip opens over 1.2s, then one soft light crosses it over 2.6s.
- Send changes color in 0.16s. Nothing on a button loops.
- With reduced motion, nothing moves and the glow holds at 90%.

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
| `AskRowan` | Ask Rowan popover, empty | `components/footer/QuickAsk.tsx` |
| `NewChat` | New chat empty state | `screens/workspace/Transcript.tsx` |
| `Composer` | Every composer state: normal, working, plan mode and plan waiting, each empty and typing | `screens/workspace/composer/` |
| `PlanStates` | Plan mode and plan waiting, empty and typing | `composer/composer.css`, `cards/plan.tsx` |
| `PlanMotion` (no PNG) | The plan mode motion on a loop | `composer/composer.css`, `new-workspace/newWorkspace.css` |
| `PlanModeEmpty`, `PlanModeTyping` | Plan mode in Rowan's chat | `composer/composer.css` |
| `PlanWaiting`, `PlanWaitingTyping` | A plan waiting for approval | `cards/plan.tsx` (`PlanBar`, `PlanInline`) |
| `PrNoChanges` to `PrClosed` | One screen per PR state, in the order a PR moves through them | `pr/model.ts` (`headerView`), `pr/PrHeader.tsx`, `pr/pr.css` |

The PR screens cover No changes yet, No PR yet, Creating PR, Draft, Open, Checks running, Checks failed, Changes requested, Merge conflicts, Resolving, Ready to merge, Merging, Merged and Closed.

## Merge (KERNEL-347)

- **Team update.** The newest row about a ready PR shows `Merge #N` before Open, in the ready band's soft tone (`--pr-ready-soft`, edge and fg). Older rows about the same PR keep Open only. While it merges the button reads Merging, dims and spins, and the row's events say "Merging PR #N". A merged row's event is violet, and its Open becomes In History once the workspace is archived. A PR that can't merge yet shows the reason in muted text in the button's place, such as "Waiting for Theo's approval". On a reviewer's row the button merges the PR under review.
- **Lead panel.** The header is the ready band with "N ready to merge" and a chevron, and clicking it opens the PRs tab. With nothing open it is the grey band reading "No open PRs", with no chevron. The PRs tab sits first, with the ready count. Ready to merge rows carry Merge and Open. The list scrolls above the Run panel, which keeps its normal height, so `LeadPrs` cuts the last Still open row off. Still open rows are muted, with the state word (Waiting for approval, Checks running, Checks failed, Changes requested, Merge conflicts or Draft) in the band's label tone and Open. A row is the agent, issue key, #N, title, the review line ("Theo approved" green, "Theo found 2 blockers" red, "Not reviewed" faint) and the lines added and removed.
- **Settings.** `SettingsPRs` is drawn in `design/canvas/`. Merging comes before Instructions on Settings, Pull requests, so its switches show without scrolling, and it gains "Let the Lead merge when you ask", off, and "Review every pull request automatically", on. "Require Reviewer approval" now reads "Wait for the reviewer's approval to merge, when a review ran".

## Not built

The canvas draws a few things KERNEL-274 left out on purpose. Don't treat them as spec:

- The collapse arrow and the + for more terminals in the bottom panel.
- The close button in the Ask Rowan header. Escape and clicking outside close it.
- The centered composer on `NewChat`. The composer stays at the bottom, and only the title, subtitle and suggestions are redesigned.
- Sample copy on the canvas, such as chat text, issue titles and the Kernel notes for PR states the engine doesn't send.
