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

- The box sits recessed on `--input-bg`, with padding 12/12/10. One line of text comes to 90px.
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
| `AskRowan` | Ask Rowan popover, empty | `components/footer/QuickAsk.tsx` |
| `NewChat` | New chat empty state | `screens/workspace/Transcript.tsx` |
| `Composer` | Every composer state: normal, working, plan mode and plan waiting, each empty and typing | `screens/workspace/composer/` |
| `PlanStates` | Plan mode and plan waiting, empty and typing | `composer/composer.css`, `cards/plan.tsx` |
| `PlanMotion` (no PNG) | The plan mode motion on a loop | `composer/composer.css`, `new-workspace/newWorkspace.css` |
| `PlanModeEmpty`, `PlanModeTyping` | Plan mode in Rowan's chat | `composer/composer.css` |
| `PlanWaiting`, `PlanWaitingTyping` | A plan waiting for approval | `cards/plan.tsx` (`PlanBar`, `PlanInline`) |
| `PrNoChanges` to `PrClosed` | One screen per PR state, in the order a PR moves through them | `pr/model.ts` (`headerView`), `pr/PrHeader.tsx`, `pr/pr.css` |

The PR screens cover No changes yet, No PR yet, Creating PR, Draft, Open, Checks running, Checks failed, Changes requested, Merge conflicts, Resolving, Ready to merge, Merging, Merged and Closed.

## Not built

The canvas draws a few things KERNEL-274 left out on purpose. Don't treat them as spec:

- The collapse arrow and the + for more terminals in the bottom panel.
- The close button in the Ask Rowan header. Escape and clicking outside close it.
- The centered composer on `NewChat`. The composer stays at the bottom, and only the title, subtitle and suggestions are redesigned.
- Sample copy on the canvas, such as chat text, issue titles and the Kernel notes for PR states the engine doesn't send.
