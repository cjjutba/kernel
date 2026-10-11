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
| del | #eb5757 | diff deletions, errors, the context ring from 90% |
| mod | #e2c08d | a modified file's name and letter (KERNEL-399) |
| merged | #b9a3f5 (text), #7c5ce0 (fill) | merged PRs only |
| working | #7cb2ff | unused since sidebar rows lost their hover card (remove-sidebar-hover-card) |
| needs | #f2c55c | waiting on you: the waiting icon on sidebar rows and chat tabs, the Inbox count, the context ring from 75%, the non-blocking warning icon on a Checks row (KERNEL-217) |
| danger | #e5484d | destructive confirm buttons |
| aside | #0c0d0e | the workspace's right panel, one step below panel |
| plan | #5aa2ff (on-plan #06101e) | plan mode: composer border and glow, caret, send, Approve |
| pr-merged-* | band #2a2140, line #3c2f5c, soft #372b55, edge #64509c, fg #d4c2ff, text #b88fff, solid #8b45f5 | PR header band: merged |
| pr-ready-* | band #15281f, line #22432f, soft #1d3b2c, edge #33704f, fg #a3e8c3, text #62d69d, solid #1b7f50 | PR header band: open, ready, merging |
| pr-fail-* | band #2c1719, line #472428, soft #3e2125, edge #70353c, fg #ffbdbd, text #ff8a8a | PR header band: checks failed, changes requested, conflicts |

There is no brand accent. Primary buttons are ink on canvas. The one brand color is `--claude`, the fill of the Claude mark on the model picker's rows, because it is Claude's logo (claude-mark-in-model-picker). `working` has no use now that sidebar rows show no hover card (remove-sidebar-hover-card). `needs` also marks what waits on you: the waiting icon on a sidebar row or a chat tab, the Inbox count, the context ring in the composer from 75% (red `del` from 90%, KERNEL-334), and the non-blocking warning icon on a Checks row (KERNEL-217). `plan` is plan mode only, and the `pr-*` sets are the PR header, the Merge button on a Team update row, and the header, Merge button and state words on the Lead's PRs tab (KERNEL-347). Files are the other exception (KERNEL-399): a file or folder's icon comes in color from Material Icon Theme, and a changed file's name and letter take VS Code's git colors, `mod` for modified, `add` for added, untracked and renamed, `del` for deleted.

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
| del | #b32e2e | diff deletions, errors, the context ring from 90% |
| mod | #895503 | a modified file's name and letter (KERNEL-399) |
| merged | #6b4bd0 (text), #7c5ce0 (fill) | merged PRs only |
| working | #1a56b0 | unused since sidebar rows lost their hover card (remove-sidebar-hover-card) |
| needs | #7a4f00 | waiting on you: the waiting icon on sidebar rows and chat tabs, the Inbox count, the context ring from 75%, the non-blocking warning icon on a Checks row (KERNEL-217) |
| danger | #bd2b2b | destructive confirm buttons |
| aside | #f7f7f8 | the workspace's right panel |
| plan | #1f5fbf (on-plan #ffffff) | plan mode |
| pr-merged-* | band #f3effd, line #e2d9fa, soft #ebe4fc, edge #b9a7ef, fg #4f34ad, text #5e3fc6, solid #7c5ce0 | PR header band: merged |
| pr-ready-* | band #eef7f2, line #d3eadd, soft #e1f1e8, edge #8fc5a7, fg #0f5235, text #166a45, solid #1a7a4f | PR header band: open, ready, merging |
| pr-fail-* | band #fcf0f0, line #f3d6d6, soft #f8e5e5, edge #e0a3a3, fg #8f2222, text #b32e2e | PR header band: checks failed, changes requested, conflicts |

The terminal palette (`--term-*`) and the floor art (`floor/floor-light.svg`, made by `scripts/floor-light.mjs`) follow the theme. Colors live in `tokens.css` and the floor art only; `test/theme.test.ts` fails on a hex or rgb value anywhere else in the renderer.

## Type

- Inter for UI (13px base, 14px in chat and composer, 12px meta), Geist Mono for code, branches, paths, shortcuts. File names in the All files tree and the Changes tab are Inter 13px, as in VS Code's explorer (KERNEL-399)
- Weights 400 and 500; 600 only for page titles and names on cards
- Sentence case everywhere. Plain words. No em dashes.

## Shape

- Radii: 6px rows, 7 to 8px buttons and inputs, 10px cards and panels, 12px composer, 14px modals, 999px pills and tags
- 1px borders, no drop shadows anywhere
- Icons: 16px stroke icons, 1.4 stroke width, round caps

## Patterns

- No status dots, anywhere. Status is a word ("working", "needs you"), sometimes with a ring on floor tags (the floor is hidden, D-104).
- One modal shell: a blur scrim over the whole window (sidebar included) at z-index 40, the modal at 50, 14px radius, 1px border.
- Settings lists of things you add (variables, env files, presets, run scripts, preview URLs): each row ends in borderless text actions (Edit, Remove), and the section's Add button is a bordered 28px button at the right of its heading. The Permissions rules are the exception and keep a bordered Remove. A masked value is a fixed run of dots. A missing item says "Missing" in a pill. The selected preset in a list is a filled ring with a check. Avatars are grayscale (KERNEL-255).
- File names (KERNEL-399): wherever a repo file shows (file trees, the Changes list, file and diff tabs, view headers, the @ menu, file chips, Read, Edit and Write rows, approvals, the Inbox, Settings file lists), its Material icon sits in front, drawn by `FileIcon` or `FileLabel`. Pasted text, attached images and folders on disk keep their stroke glyphs. A tree row is 24px with 12px steps, a 16px chevron, the icon, the name and the status letter (M, A, U, R, D) at the right. 1px indent guides in `line-2` run down each open folder, the one beside the focused row in `line-4`. A folder with changes inside takes its strongest child's color, modified over deleted over the rest, with no dot. Folders that hold only one folder share a row (`src/renderer/src`). The open file's row is selected in `surface-3`. A tree is one tab stop: arrows move, open and close, Home and End jump.
- Hover actions: message actions (copy, retry, edit, and a reply's `...` menu with its forks) and sidebar `...` menus appear on hover and on keyboard focus. A finished turn's reply ends in one line: the turn's time (`4m 12s · 10:31`), always shown, then those actions (KERNEL-346).
- Sidebar rows sit 3px apart, so hover and selected fills never touch.
- Each level under a room steps in 12px: chat icons sit 20px in and nested workspace icons 32px in. A chat that started workspaces folds like a room and shows the question icon when a hidden workspace needs you.
- Banners for failures and for work held on you: neutral surface (#141517) with an icon per type (limit/clock, offline/wifi, auth/key, setup/x-circle, hooks/plug, retry/spinner, trust/shield: the room's scripts wait for you to trust them). Never red backgrounds.
- Toasts: bottom right, 360px wide, with no close button. The title and sub share one line where they fit. A toast leaves by itself after 2.6s, or sooner when you swipe it right (toast-motion-and-swipe).
- Icon buttons: hover brightens the icon to `--ink` with no fill behind it, because a fill around a small glyph reads louder than the glyph. A fill means the button is on or its menu is open (`aria-pressed`, `aria-expanded`), never hover. Buttons with a label, menu items, rows, and the filled send and stop circles keep their hover fills.
- Tooltips: an icon button's `aria-label` is its tooltip, so give every icon button one and no `title`. Other elements opt in with `data-tip`, `data-tip-kbd` adds the shortcut, and `data-tip=""` opts out.
- Danger: red only on the final confirm button, never on the trigger.
- Merged is the only purple: the PR link, the Merged label, the merged PR band, the merged History row.
- PR header (KERNEL-274): the top of the right panel is a band in the PR's tone: grey (neutral states), green (open, ready, merging), red (checks failed, changes requested, conflicts, resolving), violet (merged). It holds the `#N | ↗` link pill, the state's icon and label, and the actions. Soft buttons use the band's soft fill and edge. Merge PR and a merged PR's Archive take its solid; a closed PR's Archive is soft. Create PR stays ink on the neutral band. The label always shows the state, never a spinner. With the right panel hidden, the header sits in the chat with no band, in neutral colors except merged. `design/redesign/Pr*.png` draws every state.
- Composer (KERNEL-322): one composer everywhere, drawn in `design/redesign/Composer.png`. The box sits recessed on `input-bg`, the agent's name and role sit in a pill with no divider, and send and stop are circles. The permission mode label follows the model picker (KERNEL-435, `design/screens/ComposerModes.png`). The composers drawn on other screens predate it and don't show it.
- Permission modes (KERNEL-435): Manual, Accept edits, Auto and Bypass permissions, always in that order. Plan joins them in the composer only. Settings, Permissions and the onboarding step list them as radio rows in one card, like Big terminal's presets: a filled ring with a check marks the pick, the title is 13.5px, and what the mode does sits below it in muted text. Bypass permissions says what it skips (every prompt, Always ask included) and what still stops it. In Settings an Only in worktrees switch row sits under it, indented to the titles.
  - A mode an agent's provider can't run keeps its row, dimmed, with an info line under it: "Auto isn't available for Codex agents yet." The chat uses Accept edits instead.
  - The onboarding step shows Bypass with a bordered caution block, never a red one.
  - A room's mode is a select with "Use app default" above the four modes. Its saved tools sit in a list under its commands, in the same hairline rows with a bordered Remove.
  - In the composer the mode is a label after the model picker: muted text with a 14px icon, `plan` blue for Plan, and ink in a hairline pill for Bypass, the one mode that skips prompts. It opens the mode menu, and so does Permission mode in the + menu.
  - Shift+Tab cycles Manual, Accept edits, Plan, Auto, Bypass and skips a mode the chat's agent can't run.
  - The first switch into Bypass opens `ConfirmBypass` once, with its confirm in danger red.
  - An approval card says why it asked on one line under the command, with an info icon and `ink-3` text.
  - The PNGs: `SettingsPermissions`, `SettingsRoomPermissions`, `SettingsRoomPermissionsMode`, `ComposerModes`, `ComposerModeMenu`, `SetupPermissions`, `SetupPermissionsNoAuto`, `WorkspacePermReason`, `WorkspacePermReasonCodex`, `ConfirmBypass`.
- Resize edges (KERNEL-419): hovering, keyboard focus or dragging the sidebar, Settings nav or right panel edge lights the content panel's border with a glow, `--ink` at 45% fading to transparent, about 2px at the middle of the edge and thinning toward the top and bottom. It stays at the middle and does not follow the cursor.
- Plan mode (KERNEL-274): the composer gets a `plan` border and a soft glow rising from its bottom edge, and the caret and a ready send button turn `plan`. No hatch, no stripes, no label. A waiting plan keeps the blue and puts Copy and Approve in a blue strip on top; send stays ink there so Approve is the one blue button. The glow moves slowly (see Motion).

## Busy buttons

A button that waits on the main process shows it is working until the call returns. That means git, GitHub, the network, files, agent sessions, scripts and opening Terminal.

- A spinner takes the icon's place and the label says what is happening: "Archiving", "Merging", "Creating". One or two plain words, no trailing dots, the way the canvas writes "Creating PR".
- The button is disabled while the call runs, so a second click, Enter or a shortcut can't start the work twice. Buttons next to it that act on the same thing (Deny beside Approve, Cancel beside Send) are disabled too.
- Every variant takes the canvas's Creating PR look at full opacity: surface-3 fill, line-3 border, ink-3 text. A busy primary or danger button turns grey. The PR header band is the exception: there a busy button keeps the band's tone, with its soft fill and edge, dimmer text and a spinner in the band's text color, so it never reads as a hole in the band (KERNEL-274).
- In code, `useBusy()` tracks which button started the work, and `Button` and `IconButton` take `busy` and `busyLabel`. `ConfirmDialog` passes the same two to its confirm button and takes `disabled` for "can't confirm yet". The sidebar's archive button is the one exception. It stays a plain icon with no spinner or word, and still ignores a second click.
- No spinner for navigation, menus, opening a dialog, toggles and selects that save in place, links that open the browser or the editor, copying, or sending a chat message, which shows up in the thread.

## Motion

- Floor characters (hidden, D-104) bob while working and stride while walking (see `.bob` and `.stride` in `design/canvas/source/templates/_helmet.html`).
- Plan mode (KERNEL-322): the glow rises and fades over 1s each way (KERNEL-418), and breathes every 8s while the box waits for input. Focus settles it over 1s. A plan's strip opens over 1.2s, then one light crosses it over 2.6s. Send changes color in 0.16s. `design/redesign/canvas/PlanMotion.dc.html` plays it.
- Resize edge glow (KERNEL-419): fades in over 200ms ease-out after an 80ms delay and out over 120ms, growing from the middle. Reduced motion turns it on and off with no transition.
- Toasts (toast-motion-and-swipe): a new toast's gap opens over 0.16s, then the toast slides in from past the right edge over 0.34s. It leaves the same way: it slides out over 0.2s, then its gap closes over 0.16s. A drag or a two-finger swipe moves it with your finger. Past 60px, or after a flick, it slides on out. Short of that it springs back.
- Only opacity and transform loop, and nothing on a button loops.
- Respect reduced motion: jump instead of walk, no spinners rotating, no breathing glow, toasts that appear and vanish in place.

## Accessibility

Real `<button>`, `<a>`, `<input>` with labels; focus rings visible; every icon-only control has `aria-label`; text contrast 4.5:1 (3:1 at 24px and up).
