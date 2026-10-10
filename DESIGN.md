# Kernel design rules

The canvas is the source of truth. Every screen is exported to `design/screens/<Screen>.png`, and its markup (exact sizes, colors, copy) is in `design/canvas/project/<Screen>.dc.html`. Live canvas: https://claude.ai/artifact/QkKTWG8JptN5AaqvPVBn1o

## Character

Linear-inspired, dark first, quiet. Monochrome surfaces; color only carries meaning. Dense but calm: 13px UI text, generous line height, hairline borders.

## Color (dark)

| Token | Value | Use |
|---|---|---|
| canvas | #08090a | window background |
| panel | #0f1011 | main panel |
| surface | #141516 | inputs, cards |
| surface-2 | #18191b | menus, modals |
| surface-3 | #1c1d21 | selected rows, hover fills |
| hover | #232428 | menu item hover |
| line | #1a1b1e | dividers |
| line-2 | #23252a | input borders |
| line-3 | #2a2b30 | buttons, menus |
| ink | #f7f8f8 | primary text |
| ink-2 | #d0d6e0 | secondary text |
| muted | #8a8f98 | labels, meta |
| faint | #62666d | tertiary |
| add | #4cb782 | diff additions, passing checks |
| del | #eb5757 | diff deletions, errors |
| merged | #b9a3f5 (text), #7c5ce0 (fill) | merged PRs only |
| working | #7cb2ff | status word in sidebar hover cards: work running |
| needs | #f2c55c | waiting on you: hover card status word, the sidebar's waiting icon, the Inbox count |
| danger | #e5484d | destructive confirm buttons |
| aside | #0c0d0e | the workspace's right panel, one step below panel |
| plan | #5aa2ff (on-plan #06101e) | plan mode: composer border and glow, caret, send, Approve |
| pr-merged-* | band #2a2140, line #3c2f5c, soft #372b55, edge #64509c, fg #d4c2ff, text #b88fff, solid #8b45f5 | PR header band: merged |
| pr-ready-* | band #15281f, line #22432f, soft #1d3b2c, edge #33704f, fg #a3e8c3, text #62d69d, solid #1b7f50 | PR header band: open, ready, merging |
| pr-fail-* | band #2c1719, line #472428, soft #3e2125, edge #70353c, fg #ffbdbd, text #ff8a8a | PR header band: checks failed, changes requested, conflicts |

There is no brand accent. Primary buttons are ink on canvas. `working` colors the status word on the sidebar hover cards and nowhere else (D-084). `needs` also marks what waits on you in the sidebar: the waiting icon on a row and the Inbox count. `plan` is plan mode only, and the `pr-*` sets are the PR header only (KERNEL-274).

## Color (light)

Light values start from the lighten map in `design/canvas/source/build.py` (HomeLight, WorkspaceLight). Where text failed 4.5:1 on any surface, the value is darker than the canvas shows. `test/theme.test.ts` checks every pair.

| Token | Value | Use |
|---|---|---|
| canvas | #f3f3f4 | window background |
| panel | #ffffff | main panel |
| surface | #f4f4f5 | inputs, cards |
| surface-2 | #efeff1 | menus, modals |
| surface-3 | #eaeaed | selected rows, hover fills |
| hover | #e6e6e9 | menu item hover |
| line | #e8e8eb | dividers |
| line-2 | #dedee2 | input borders |
| line-3 | #d6d6db | buttons, menus |
| ink | #18191b | primary text |
| ink-2 | #3a3d44 | secondary text |
| muted | #62666d | labels, meta |
| faint | #636770 | tertiary (4.5:1, so close to muted) |
| add | #166a45 | diff additions, passing checks |
| del | #b32e2e | diff deletions, errors |
| merged | #6b4bd0 (text), #7c5ce0 (fill) | merged PRs only |
| working | #1a56b0 | status word in sidebar hover cards: work running |
| needs | #7a4f00 | waiting on you: hover card status word, the sidebar's waiting icon, the Inbox count |
| danger | #bd2b2b | destructive confirm buttons |
| aside | #f7f7f8 | the workspace's right panel |
| plan | #1f5fbf (on-plan #ffffff) | plan mode |
| pr-merged-* | band #f3effd, line #e2d9fa, soft #ebe4fc, edge #b9a7ef, fg #4f34ad, text #5e3fc6, solid #7c5ce0 | PR header band: merged |
| pr-ready-* | band #eef7f2, line #d3eadd, soft #e1f1e8, edge #8fc5a7, fg #0f5235, text #166a45, solid #1a7a4f | PR header band: open, ready, merging |
| pr-fail-* | band #fcf0f0, line #f3d6d6, soft #f8e5e5, edge #e0a3a3, fg #8f2222, text #b32e2e | PR header band: checks failed, changes requested, conflicts |

The terminal palette (`--term-*`) and the floor art (`floor/floor-light.svg`, made by `scripts/floor-light.mjs`) follow the theme. Colors live in `tokens.css` and the floor art only; `test/theme.test.ts` fails on a hex or rgb value anywhere else in the renderer.

## Type

- Inter for UI (13px base, 14px in chat and composer, 12px meta), Geist Mono for code, branches, paths, shortcuts
- Weights 400 and 500; 600 only for page titles and names on cards
- Sentence case everywhere. Plain words. No em dashes.

## Shape

- Radii: 6px rows, 7 to 8px buttons and inputs, 10px cards and panels, 12px composer, 14px modals, 999px pills and tags
- 1px borders, no drop shadows anywhere
- Icons: 16px stroke icons, 1.4 stroke width, round caps

## Patterns

- No status dots, anywhere. Status is a word ("working", "needs you"), sometimes with a ring on floor tags (the floor is hidden, D-104).
- One modal shell: a blur scrim over the whole window (sidebar included) at z-index 40, the modal at 50, 14px radius, 1px border.
- Hover actions: message actions (copy, retry, edit, fork) and sidebar `...` menus appear on hover and on keyboard focus.
- Sidebar rows sit 3px apart, so hover and selected fills never touch.
- Each level under a room steps in 12px: chat icons sit 20px in and nested workspace icons 32px in. A chat that started workspaces folds like a room and shows the question icon when a hidden workspace needs you.
- Sidebar hover cards: a workspace or Lead row shows a card after a short hover or on keyboard focus. Surface-2, 1px line-3 border, 10px radius, no shadow. The status word sits on a pill filled with its `--tint-*` token, at 4.5:1 or better, the one place status takes color beyond the diff and merged colors (D-084).
- Banners for failures: neutral surface (#141517) with an icon per type (limit/clock, offline/wifi, auth/key, setup/x-circle, hooks/plug, retry/spinner). Never red backgrounds.
- Toasts: bottom right, auto-dismiss after 2.6s.
- Tooltips: an icon button's `aria-label` is its tooltip, so give every icon button one and no `title`. Other elements opt in with `data-tip`, `data-tip-kbd` adds the shortcut, and `data-tip=""` opts out.
- Danger: red only on the final confirm button, never on the trigger.
- Merged is the only purple: the PR link, the Merged label, the merged PR band, the merged History row.
- PR header (KERNEL-274): the top of the right panel is a band in the PR's tone: grey (neutral states), green (open, ready, merging), red (checks failed, changes requested, conflicts, resolving), violet (merged). It holds the `#N | ↗` link pill, the state's icon and label, and the actions. Soft buttons use the band's soft fill and edge, Merge PR and Archive its solid. The label always shows the state, never a spinner. `design/redesign/Pr*.png` draws every state.
- Plan mode (KERNEL-274): the composer gets a `plan` border and a soft glow rising from its bottom edge, and the caret and a ready send button turn `plan`. No hatch, no stripes, no label. A waiting plan keeps the blue and puts Copy and Approve in a blue strip on top; send stays ink there so Approve is the one blue button.

## Busy buttons

A button that waits on the main process shows it is working until the call returns. That means git, GitHub, the network, files, agent sessions, scripts and opening Terminal.

- A spinner takes the icon's place and the label says what is happening: "Archiving", "Merging", "Creating". One or two plain words, no trailing dots, the way the canvas writes "Creating PR".
- The button is disabled while the call runs, so a second click, Enter or a shortcut can't start the work twice. Buttons next to it that act on the same thing (Deny beside Approve, Cancel beside Send) are disabled too.
- Every variant takes the canvas's Creating PR look at full opacity: surface-3 fill, line-3 border, ink-3 text. A busy primary or danger button turns grey. The PR header band is the exception: there a busy button keeps the band's tone, with its soft fill and edge, dimmer text and a spinner in the band's text color, so it never reads as a hole in the band (KERNEL-274).
- In code, `useBusy()` tracks which button started the work, and `Button` and `IconButton` take `busy` and `busyLabel`. `ConfirmDialog` passes the same two to its confirm button and takes `disabled` for "can't confirm yet". The sidebar's archive button is the one exception. It stays a plain icon with no spinner or word, and still ignores a second click.
- No spinner for navigation, menus, opening a dialog, toggles and selects that save in place, links that open the browser or the editor, copying, or sending a chat message, which shows up in the thread.

## Motion

- Floor characters (hidden, D-104) bob while working and stride while walking (see `.bob` and `.stride` in `design/canvas/source/templates/_helmet.html`).
- Respect reduced motion: jump instead of walk, no spinners rotating.

## Accessibility

Real `<button>`, `<a>`, `<input>` with labels; focus rings visible; every icon-only control has `aria-label`; text contrast 4.5:1 (3:1 at 24px and up).
