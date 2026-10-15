# Kernel design rules

These are the system rules every screen follows. A screenshot or mock in a task's brief is the spec for that task. Without one, match the current app and this file. Exact values live in `src/renderer/src/tokens.css`.

## Character

Linear-inspired, dark first, quiet. Monochrome surfaces; color only carries meaning. Dense but calm: 13px UI text, generous line height, hairline borders.

## Color (dark)

| Token | Value | Use |
|---|---|---|
| canvas | #09090a | window background and the sidebar |
| panel | #121213 | main panel |
| surface | #18181a | inputs, cards |
| surface-2 | #1d1d1f | menus, modals |
| surface-3 | #232325 | selected rows, hover fills |
| hover | #2a2a2c | menu item hover |
| line | #1f1f21 | dividers |
| line-2 | #29292b | hairlines on cards, tables and chips |
| line-3 | #333335 | buttons, menus |
| input-line | #717174 | input borders, 3:1 on every surface an input sits on (KERNEL-575) |
| ink | #f7f7f8 | emphasis only: titles, the current row, unread, the primary button |
| ink-2 | #d6d6d7 | default text: rows, body, the transcript |
| ink-3 | #b6b6b8 | secondary text |
| muted | #919194 | labels, meta, placeholders, sidebar and Settings nav rows (KERNEL-611) |
| faint | #757578 | icons, disabled, decoration. Never body text |
| add | #4cb782 | diff additions, passing checks |
| del | #f06363 | diff deletions, errors, the context ring from 90% |
| mod | #e2c08d | a modified file's name and letter (KERNEL-399) |
| merged | #b9a3f5 (text), #7c5ce0 (fill) | merged PRs only |
| working | #7cb2ff | unused: the sidebar hover card is monochrome (kernel-630-sidebar-hover-card) |
| needs | #f2c55c | amber text. Usage reads amber from 75% (feat-providers-redesign) |
| needs-fill, del-fill | #f2c55c, #f06363 | amber and red as fills: meter bars from 75% and 90%, the context ring, Settings warning icons, the limit banner's icon (feat-providers-redesign) |
| danger | #e5484d | destructive confirm buttons |
| aside | #0d0d0e | the stage behind a shared preview. The workspace's right panel sits on panel, like the chat (KERNEL-526) |
| plan | #5aa2ff (on-plan #06101e) | plan mode: composer border and glow, caret, send, Approve |
| pr-merged-* | band #2a2140, line #3c2f5c, soft #372b55, edge #64509c, fg #d4c2ff, text #b88fff, solid #8b45f5 | PR header band: merged |
| pr-ready-* | band #15281f, line #22432f, soft #1d3b2c, edge #33704f, fg #a3e8c3, text #62d69d, solid #1b7f50 | PR header band: open, ready, merging |
| pr-fail-* | band #2c1719, line #472428, soft #3e2125, edge #70353c, fg #ffbdbd, text #ff8a8a | PR header band: checks failed, changes requested, conflicts |

The neutrals are grey with a slight cool lean, sampled from Linear: red equals green and blue sits 0 to 3 points above (KERNEL-611, amending KERNEL-431). Nav rows in the sidebar and Settings sit at muted and brighten to ink-2 on hover, so the content area leads. There is no brand accent. Primary buttons are ink on canvas. The one brand color is `--claude`, the fill of the Claude mark, because it is Claude's logo (claude-mark-in-model-picker). Codex shows the OpenAI mark in `currentColor`, ink, since OpenAI allows it only in black or white, so it adds no color (openai-mark). Both marks come from `ProviderMark` wherever a provider is a heading or a pick. `working` has no use now that sidebar rows show no hover card (remove-sidebar-hover-card). Usage takes color as it fills, on every meter and the context ring alike: grey, amber from 75%, red from 90% (`--needs-fill`, `--del-fill`, KERNEL-334, feat-providers-redesign). The waiting icon on a sidebar row or a chat tab and warning triangles outside Settings render in `ink` with no color, and their shape says the state (no-amber-icons). Settings warning lines (`.set-warn`) take an amber icon, and Providers' limit banner a red one. The account in use on Providers wears the green Active pill (`--tint-add`, `--add`, `--pr-ready-line`) (feat-providers-redesign). `plan` is plan mode only, and the `pr-*` sets are the PR header, the Merge button on a Team update row, and the header, Merge button and state words on the Lead's PRs tab (KERNEL-347). Files are the other exception (KERNEL-399): a file or folder's icon comes in color from Material Icon Theme, and a changed file's name and letter take VS Code's git colors, `mod` for modified, `add` for added, untracked and renamed, `del` for deleted.

## Color (light)

Light values are in `src/renderer/src/tokens.css`. Where text failed 4.5:1 on any surface, the value was darkened until it passed. `test/theme.test.ts` checks every pair.

| Token | Value | Use |
|---|---|---|
| canvas | #f3f3f4 | window background |
| panel | #ffffff | main panel |
| surface | #f4f4f5 | inputs, cards |
| surface-2 | #efeff1 | menus, modals |
| surface-3 | #eaeaed | selected rows, hover fills |
| hover | #e6e6e9 | menu item hover |
| line | #e8e8eb | dividers |
| line-2 | #dedee2 | hairlines on cards, tables and chips |
| line-3 | #d6d6db | buttons, menus |
| input-line | #82848a | input borders, 3:1 on every surface an input sits on (KERNEL-575) |
| ink | #18191b | emphasis only: titles, the current row, unread, the primary button |
| ink-2 | #35383f | default text: rows, body, the transcript |
| ink-3 | #4c4f56 | secondary text |
| muted | #62666d | labels, meta, placeholders |
| faint | #7b7f88 | icons, disabled, decoration. Never body text |
| add | #166a45 | diff additions, passing checks |
| del | #b32e2e | diff deletions, errors, the context ring from 90% |
| mod | #895503 | a modified file's name and letter (KERNEL-399) |
| merged | #6b4bd0 (text), #7c5ce0 (fill) | merged PRs only |
| working | #1a56b0 | unused: the sidebar hover card is monochrome (kernel-630-sidebar-hover-card) |
| needs | #7a4f00 | amber text |
| needs-fill, del-fill | #d97706, #dc3e42 | amber and red as fills. Text-safe amber reads brown on a bar, so fills get their own values (feat-providers-redesign) |
| danger | #bd2b2b | destructive confirm buttons |
| aside | #f7f7f8 | the stage behind a shared preview |
| plan | #1f5fbf (on-plan #ffffff) | plan mode |
| pr-merged-* | band #f3effd, line #e2d9fa, soft #ebe4fc, edge #b9a7ef, fg #4f34ad, text #5e3fc6, solid #7c5ce0 | PR header band: merged |
| pr-ready-* | band #eef7f2, line #d3eadd, soft #e1f1e8, edge #8fc5a7, fg #0f5235, text #166a45, solid #1a7a4f | PR header band: open, ready, merging |
| pr-fail-* | band #fcf0f0, line #f3d6d6, soft #f8e5e5, edge #e0a3a3, fg #8f2222, text #b32e2e | PR header band: checks failed, changes requested, conflicts |

The terminal palette (`--term-*`) follows the theme. Colors live in `tokens.css`; `test/theme.test.ts` fails on a hex or rgb value anywhere else in the renderer.

## Text ladder

Five roles in both themes (KERNEL-575). A screen picks a role, not a grey, so the same text reads the same everywhere.

| Role | Token | Dark on panel | Light on panel | Use |
|---|---|---|---|---|
| Emphasis | ink | 17.5:1 | 17.6:1 | titles, the current row, unread, the primary button |
| Default | ink-2 | 12.9:1 | 11.7:1 | rows, body, the transcript |
| Secondary | ink-3 | 9.3:1 | 8.2:1 | secondary text |
| Meta | muted | 6.0:1 | 5.8:1 | labels, meta, placeholders |
| Decoration | faint | 4.1:1 | 4.0:1 | icons, disabled, decoration. Never body text |

- Each tier has at least 1.35x the contrast of the next, so emphasis, default and meta read as three steps and not one.
- ink, ink-2, ink-3, muted and the status text colors reach 4.5:1 on every surface, hover and surface-3 included. Faint is not text and reaches 3:1.
- Light text keeps the slight cool cast it had, which matches the light surfaces. The dark neutrals lean cool too, by at most 3 points of blue (KERNEL-611).

## Type

- Geist Sans for UI (13px base, 14px in chat and composer, 12px meta), Geist Mono for code, branches, paths, shortcuts. Both ship with the app, so text looks the same on every platform (KERNEL-610). File names in the All files tree and the Changes tab are Geist Sans 13px, as in VS Code's explorer (KERNEL-399)
- Weights 400 and 500; 600 only for page titles, names on cards and bold text in a reply, which also takes full ink (KERNEL-526)
- Inline code in a reply is a chip: Geist Mono 12.5px in full ink on surface-2, with a line-3 hairline (KERNEL-526)
- Sentence case everywhere. Plain words. No em dashes.

## Shape

- Radii (KERNEL-666), one scale in `tokens.css` and never a hard-coded px value: `--r-2xs` 4px checkboxes and highlights, `--r-xs` 6px 18 to 20px marks (kbd, tags, letter tiles, avatars, inline code), `--r-sm` 8px rows, list items, 22 to 26px controls and chips, `--r` 10px buttons, inputs, tabs and segmented controls (28 to 34px tall), `--r-md` 12px cards, panels, menus and code blocks, `--r-lg` 16px composer, `--r-xl` 18px modals, `--r-pill` 999px pills, toggles and meters. A control's radius is about 0.35 times its height. An inner radius is never larger than its outer one: the outer minus the padding, and `calc(<outer token> - 1px)` inside a 1px border
- 1px borders, no drop shadows anywhere
- Icons: Hugeicons free stroke-rounded set (`@hugeicons/core-free-icons`), drawn by `Icon` on one stroke, 2.1 on its 24px grid (the old 1.4 on a 16px grid), round caps. `Icon` has no `stroke` prop, so a glyph is never bolder or lighter than its neighbours. Four sizes, typed as `IconSize`, so the compiler enforces the scale: 12 for carets, chips and inline meta, 14 for rows, buttons and menu items, 16 as the default (headers, the sidebar), 20 for empty states. `name` is an `IconName`, never a free string. `LargeMark` is the one escape, for the 34px and 120px marks on Welcome, and nothing else uses it (icon-sizes-and-stroke)

## Patterns

- No status dots, anywhere. Status is a word ("working", "needs you").
- One modal shell: a blur scrim over the whole window (sidebar included) at z-index 40, the modal at 50, 18px radius, 1px border.
- Dropdowns (KERNEL-680): every dropdown is `Select` from `ui`, never a native `<select>` (`test/noNativeSelect.test.ts`). The button is 28px (30px in a Settings card) with an `--input-line` hairline and a chevron, and takes the open fill only while its list is open. The list is a `.menu`: groups get a heading, a choice can have a muted second line, the picked one has a check, and an action row (Custom folder…, Choose image…) sits under a rule. `variant="chip"` is the filled filter chip and `variant="plain"` text and a chevron at the end of a menu row.
- Segmented controls (KERNEL-680): every option is the same width, so none reads as the default.
- File names (KERNEL-399): wherever a repo file shows (file trees, the Changes list, file and diff tabs, view headers, the @ menu, file chips, Read, Edit and Write rows, approvals, the Inbox, Settings file lists), its Material icon sits in front, drawn by `FileIcon` or `FileLabel`. Pasted text, attached images and folders on disk keep their stroke glyphs. A tree row is 24px with 12px steps, a 16px chevron, the icon, the name and the status letter (M, A, U, R, D) at the right. 1px indent guides in `line-2` run down each open folder, the one beside the focused row in `line-4`. A folder with changes inside takes its strongest child's color, modified over deleted over the rest, with no dot. Folders that hold only one folder share a row (`src/renderer/src`). The open file's row is selected in `surface-3`. A tree is one tab stop: arrows move, open and close, Home and End jump.
- Hover actions: message actions (copy, retry, edit, and a reply's `...` menu with its forks) and sidebar `...` menus appear on hover and on keyboard focus. A finished turn's reply ends in one line: the turn's time (`4m 12s · 10:31`), always shown, then those actions (KERNEL-346).
- Sidebar rows sit 3px apart, so hover and selected fills never touch.
- Unread is a bold title, never a dot. A chat row, workspace row, collapsed room and chat tab take 600 weight in `--ink`, and the icon keeps its state, so a row that needs you shows its plan or question icon in ink and the bold title together. The chat on screen is read (KERNEL-508).
- Banners for failures and for work held on you: neutral surface (#141517) with an icon per type (limit/clock, offline/wifi, auth/key, setup/x-circle, hooks/plug, retry/dot loader, trust/shield: the room's scripts wait for you to trust them). Never red backgrounds.
- Check rows (KERNEL-437): a readiness check, a room setup step and a room's Push access row say their result with an icon and a word. A green check passes, a red x-circle fails, and a triangle in ink, with no color, warns. A failing row gives its one fix under it, a command in a code box with Copy or a single button. A warning never blocks. Continue stays on and the row's own button is bordered, so the one ink button is the way forward. A line that passes with more to say, like the gh login's source or Bedrock, adds a muted note under its detail. A warning about files names the file and the variable, never the value. A failed hooks install in Check hooks follows the same shape in its own card. `docs/decisions/KERNEL-437.md` lists the copy.
- Toasts: bottom right of the main panel, 12px in from its right and bottom edges, 360px wide, with no close button. The title is row 1 and the sub row 2, with the action on the right. The surface, hairline and radius are the Usage popover's. A toast leaves by itself after 5s (6s for a heads-up, see (4)), or sooner when you swipe it right or down (toast-motion-and-swipe). A toast is for something you can't see on screen: (1) a call that failed ("Could not ..."), (2) something Kernel or an agent did without your click, like a PR created or merged, an archive after a merge, a config mistake or the window reloading after a crash, (3) an action that changes nothing on screen, like Path copied, Branch copied, Logs exported or the Check for updates result. (4) a heads-up about a cost you just took on that the screen doesn't show, like switching models in a chat that has run a turn (KERNEL-771). That kind stays up about 6s. A click whose result you can see gets no toast: the archived row is gone, the restored workspace opens (KERNEL-495).
- Icon buttons: hover brightens the icon to `--ink` with no fill behind it, because a fill around a small glyph reads louder than the glyph. A fill means the button is on or its menu is open (`aria-pressed`, `aria-expanded`), never hover. Buttons with a label, menu items, rows, and the filled send and stop circles keep their hover fills.
- Tooltips: an icon button's `aria-label` is its tooltip, so give every icon button one and no `title`. Other elements opt in with `data-tip`, `data-tip-kbd` adds the shortcut, and `data-tip=""` opts out.
- Danger: red only on the final confirm button, never on the trigger.
- Merged is the only purple: the PR link, the Merged label, the merged PR band, the merged History row.
- Resize edges (KERNEL-419): hovering, keyboard focus or dragging the sidebar, Settings nav or right panel edge lights the content panel's border with a glow, `--ink` at 45% fading to transparent, about 2px at the middle of the edge and thinning toward the top and bottom. It stays at the middle and does not follow the cursor. The handle between the right panel's top and bottom panes (KERNEL-512) lights the hairline between them the same way, turned horizontal.

## Attaching files (KERNEL-815)

Dragging, dropping, pasting and picking a file all answer at once, in the workspace chat, the Lead chat and New chat alike.

- Overlay: files dragged over the chat pane cover the whole pane with a `surface` scrim at 92% and a 1px dashed `line-4` rectangle inset 12px, labeled "Drop to attach" in `ink-2`, and the composer box's border goes to `line-4`. No shadow, no color. It clears when the drag leaves the pane (an enter and leave count, so moving between child elements doesn't flicker it), on drop, on Escape and when the window loses focus. Text dragged with no files leaves the pane alone, and a blocked or disabled box shows no overlay and takes no drop.
- Drop anywhere: files dropped on the box land at the caret, files dropped elsewhere on the pane land at the end of the draft.
- Placeholder chip: each file gets a chip as soon as it is dropped, picked or pasted, with the dot loader (`arrow-down`) in the icon slot and the file name in `muted`. It becomes the real chip in place, in the order the files came. A file that can't be attached loses its chip and shows the "Could not attach" toast. Send shows its busy label ("Attaching") until every placeholder has settled, so a message never goes without a file it was meant to carry.
- Entry: a chip that lands fades in and scales from 0.96 over 160ms on `cubic-bezier(0.22, 1, 0.36, 1)`. Under reduced motion it appears in place.

## Remembered choices

- A choice the user makes stays until they change it: a tab, a filter, a picked room, mode, branch or script, a width. Leaving the screen, opening another chat or relaunching never resets it.
- A choice tied to a room (New chat's picks, a room's GitHub filter, its picked run script) is kept per room, and goes when the room is archived or removed.
- Screens keep a choice through `remember.ts` (`useRemembered`, `readSaved`, `writeSaved`), never with `useState` alone and never with localStorage directly. `test/remember.test.ts` enforces the second part.
- A remembered value that no longer fits (a branch that is gone, a script removed from Settings) falls back to the default instead of showing something broken.

## Saving in Settings

- Every Settings page has one muted line under its title: "Changes save as you make them." (KERNEL-721).
- Toggles, segments and dropdowns save on click and get no note and no toast. The control is the confirmation.
- Text and number fields save when they lose focus. A note in muted text sits beside the field: "Saving" with a spinner while the call runs, then "Saved" with a check. It fades about 1.5s after main answers. The state comes from the save promise, never a timer.
- When main corrects a number, the note says "Set to N, the most allowed" or "Set to N, the least allowed" and stays until the next edit.
- A field with unsaved text saves when it unmounts. Escape inside a field cancels the edit and puts the saved value back.
- A failed save rolls back, shows the "Could not save" toast and no Saved note.

## Busy buttons

A button that waits on the main process shows it is working until the call returns. That means git, GitHub, the network, files, agent sessions, scripts and opening Terminal.

- The dot loader (one 13px size, small round `faint` dots that dip out and grow back, rippling out as `pattern="ripple-out"`, which `Button` and `IconButton` set) takes the icon's place and the label says what is happening: "Archiving", "Merging", "Creating". One or two plain words, no trailing dots, the way the PR header writes "Creating PR".
- The button is disabled while the call runs, so a second click, Enter or a shortcut can't start the work twice. Buttons next to it that act on the same thing (Deny beside Approve, Cancel beside Send) are disabled too.
- Every variant takes the Creating PR look at full opacity: surface-3 fill, line-3 border, ink-3 text. A busy primary or danger button turns grey. The PR header band is the exception: there a busy button keeps the band's tone, with its soft fill and edge, dimmer text and a dot loader in the band's text color, so it never reads as a hole in the band (KERNEL-274).
- The pattern says what kind of action is waiting. `Button`, `IconButton` and `ConfirmDialog` take `busyPattern`, which defaults to `ripple-out`, and the inline action links and the segmented control pick from the same table. A new busy button picks its row here and falls back to `ripple-out` when none fits (KERNEL-759).

  | Action | `busyPattern` |
  | --- | --- |
  | Send (messages, answers, plans, tests) | `arrow-right` |
  | Merge | `ripple-in` |
  | Approve, allow, deny, trust, and confirming a risky choice (Bypass permissions, Start anyway, Overrule) | `pulse` |
  | Archive, discard, remove, retire, delete, close, disconnect, cancel | `scatter` |
  | Refresh, retry, reload, restart, recheck | `rotate` |
  | Run and stop scripts | `snake` |
  | Restore, revert, reset, switch account or program, sign in to a usage account | `wave-back` |
  | Everything else (save, create, open, copy, add, install, connect, export, move, compact, commit, link) | `ripple-out` |

- In code, `useBusy()` tracks which button started the work, and `Button` and `IconButton` take `busy` and `busyLabel`. `ConfirmDialog` passes the same two to its confirm button and takes `disabled` for "can't confirm yet". The sidebar's archive button is the one exception. It stays a plain icon with no spinner or word, and still ignores a second click. Approvals are the other exception (KERNEL-789, KERNEL-834): Approve, Deny, Allow once, Always allow, Approve and hand off, Approve and build, and the plan strip's Approve act at once, with no spinner and no "Approving", "Allowing" or "Denying" label. The approval shows its result in place, so a spinner adds nothing. A second press, or a press on another button of the same approval, does nothing (a ref guards it, not `useBusy`). A failed call brings the approval back with its error toast. The plan strip closes over --plan-dur; every other approval folds away as an archived row does (Motion, Approvals).
- No spinner for navigation, menus, opening a dialog, toggles and selects that save in place, links that open the browser or the editor, copying, or sending a chat message, which shows up in the thread.

## Motion

- Check an animation with `pnpm shots <Screen> --motion` before it ships: a still can look right while the motion jolts. Give the fixture a `motion` action and share the contact sheet and GIF in the PR.
- Plan mode (KERNEL-322): the glow rises and fades over 1s each way (KERNEL-418), and breathes every 8s while the box waits for input. Focus settles it over 1s. A plan's strip opens over --plan-dur (0.5s), then one light crosses it over 1.6s. Approve closes it in reverse over the same length and easing, and its margin, its hairline and the box's top padding close with it, so the box shrinks as one and nothing moves when the strip unmounts. The box stays in plan mode until the strip is gone: the placeholder, the Plan chip and the glow hold, the glow fades over --plan-dur from the press, and the placeholder and chip fade to the new mode when the close ends (KERNEL-833). A strip whose plan stopped waiting for another reason (Inbox, a denial, an expiry) closes the same way and scrolls nothing. Approve glides the chat to its true end, re-aiming while the end moves, jumping to one screen above it first when it is more than 1.5 screens away, and the reader's wheel, keys or touch take over at once. With text in the box, Approve asks "Approve without your changes?" in the strip: Send changes sends it as the plan's change request, Approve keeps it in the box, Escape backs out. After Approve the caret goes to the box and a polite live region says "Plan approved". Reduced motion removes the strip and jumps. Send changes color in 0.16s.
- Resize edge glow (KERNEL-419): fades in over 200ms ease-out after an 80ms delay and out over 120ms, growing from the middle. Reduced motion turns it on and off with no transition.
- Toasts (toast-motion-and-swipe): a new toast's gap opens over 0.16s, then the toast rises 16px and fades in over 0.3s, ease-out. On timeout or its action it sinks 16px and fades over 0.2s, then its gap closes over 0.16s. A drag or a two-finger swipe moves it with your finger, locked to right or down after 6px and never left or up. Past 60px, or after a flick, it slides on out the way it went. Short of that it springs back.
- Archive (KERNEL-579): archiving a chat or workspace is one short beat, played for the three cases below. Every curve is `ease-out`.
  - Order. The row folds and fades from the frame the main panel swaps. It starts when Kernel marks the archive done, after any confirm, never before. A failed archive moves nothing and shows its "Could not archive" toast.
  - The row. Opacity goes 1 to 0 over 120ms while the row's height and the 3px gap under it close to 0 over 200ms. The row keeps its size and is clipped, never squeezed. Rows below slide up with the closing height and have no motion of their own, so the open chat's row rides up with them. A chat's nested workspace rows fold with it in the same frames, with no stagger. A folding row can't be clicked, and it leaves the list when the fold ends.
  - The screen (KERNEL-636). When the archived chat or workspace was on screen, the main panel swaps to the destination at once, in one frame, with no fade and no copy of the old screen. The destination is live from the first frame and takes focus and keys at once.
  - Where it goes (KERNEL-596). One destination for every archive of the chat or workspace on screen: the room's front door, which is New chat with Kernel, or Team when the room has no Lead. It is the same for a chat, a workspace it started, a review and a workspace Kernel archives after its PR merged, and whatever else is open in the room. No chat row is picked, the app never goes to History, and the route moves once, in the step the archived status is stored, so no frame shows the workspace without its tabs. Kernel archiving after a merge keeps its toast. An archive by hand has none.
  - Selected fill. When the destination has a row in the sidebar, its fill goes from none to `surface-3` and its text from `ink-2` to `ink` over 120ms, as the archived row fades out. That is Kernel's Lead row, which stands in for New chat with Kernel while the room has no open chat. In a room with open chats, no row stands for New chat, so no fill changes. This is the only selection change that fades. Other clicks still switch it at once.
  - The last chat in a room. Kernel's Lead row opens in the chat row's place: height 0 to full over 200ms and opacity 0 to 1 over 120ms, as the chat row folds. The two heights add up to one row all the way through, so the rows below stay put. A room with no Lead has no row to open, and the rows below slide up.
  - Not on screen. When the archived chat or workspace wasn't on screen, only its row folds. The screen doesn't move, and there is no toast (KERNEL-495).
  - Any archive. The same beat plays however the archive starts: the row's Archive button, a PR's Archive, closing a chat's last tab, or Kernel archiving after a merge.
  - Overlap. Archiving again while a fold runs starts that row's fold at once. The destination row's fill fade that starts over another one jumps the earlier one to its end.
  - Reduced motion. No fold and no fade. In one frame the row leaves, the Lead row appears and the selected fill changes. The screen swaps at once either way.
- Only opacity and transform loop, and nothing on a button loops.
- Dot loader (KERNEL-714, KERNEL-759, revised): one 3x3 grid of round dots, 13px square everywhere (3px dots, 2px gaps, in the 16px icon slot, so it matches the 12 to 13px icons beside it and does not scale with the text), in `faint` or `--spin-ink`, one steady gray. The dots rest at full size and dip out on their turn: each shrinks on a sine ease (185ms), stays gone (55ms) and grows back the same way (185ms) in a 0.8s loop, so it is full size for about 47% of the loop and the grid is nearly full most of the time. Neighbors start their dips at different steps, so a gradient of sizes sweeps across the grid and no single dot pops. Opacity only drops once a dot is nearly a pinpoint, so size carries the motion and a gone dot leaves no speck. Only transform and opacity animate. The center never shows or dips alone: its dip always overlaps a neighbor's, which is why `ripple-out`, `ripple-in` and `pulse` start the center with a ring (`test/spinnerGuard.test.ts` checks every pattern). `Spinner` takes a `pattern`, one per kind of wait, so a person can tell a wait apart at a glance. Every loader starts its loop together, so rows run in step. Reduced motion draws no animation: a pattern's still-frame dots show at full size and the rest at 0.35 scale, and the center is never the only full dot. Dots are numbered row by row (0 1 2 / 3 4 5 / 6 7 8), and the patterns are data in `ui/dotPatterns.ts`, shown in DevUi under Loader patterns.

| Pattern | Order | Still frame | Used for |
| --- | --- | --- | --- |
| `wave` | diagonals, top left to bottom right | middle diagonal | agent working: sidebar rows, hover card (default) |
| `wave-back` | the same, bottom right to top left | middle diagonal | switching accounts, a Settings field saving |
| `arrow-right` | a `>` chevron moving right, column by column | the chevron | not used yet |
| `arrow-down` | a `v` chevron moving down, row by row | the chevron | loading data: issue lists, onboarding checks, Starting |
| `ripple-out` | center and edges together, then corners | the plus | busy buttons and inline action links |
| `ripple-in` | corners and center together, then edges | corners | not used yet |
| `spiral` | clockwise around the ring, then center | first three dots | the transcript Working line |
| `rotate` | corners turn clockwise, edges follow half a step behind, then center | one corner | Banner retrying |
| `checker` | the X, then the plus, alternating | the X | PR checks running: PRs rows, PR band status |
| `pulse` | the whole grid dips together | the plus | not used yet |
| `scatter` | one dot dips at a time in a fixed shuffle | three dots | not used yet |
| `twinkle` | two or three dots dip at once, fixed uneven delays | three dots | chat tabs working |
| `snake` | one dot dips at a time, tracing the grid | first three dots | setup and run scripts |

- Modals (KERNEL-648): every modal opens with the scrim fading in over 160ms `ease-out` while the dialog fades in, rises from 8px below and scales from 0.98 over 200ms, `cubic-bezier(0.22, 1, 0.36, 1)`. Escape, the scrim, Close and Cancel play an exit: the dialog fades and drops 4px over 120ms, `cubic-bezier(0.4, 0, 1, 1)`, and the scrim fades over the same 120ms. Neither takes input during the exit, and the modal leaves when it ends. A close after an action that changes the screen leaves at once. Reduced motion turns it on and off in place.
- Approvals (KERNEL-834): pressing a decide button in the Inbox or on a chat's card folds the approval away the way an archived row does, over --archive-fold with the fade over --archive-fade, `ease-out`. In the Inbox the list row folds when it leaves its tab, and the detail's buttons fold, then the outcome stands in their place. In a chat the card's buttons fold and the result line takes their place, since the card stays as the record. Nothing spins. A failed call ends the fold and the approval comes back, with the "Could not send your answer" toast. Reduced motion changes it in place, with no fold and no fade.
- Respect reduced motion: jump instead of walk, the dot loader holds a still frame of its pattern, no breathing glow, toasts that appear and vanish in place, archived rows that change in place.

## Accessibility

Real `<button>`, `<a>`, `<input>` with labels; focus rings visible; every icon-only control has `aria-label`.

- Text contrast is 4.5:1 for every text tier and status color on every surface (see Text ladder). Faint is for icons, disabled controls and decoration, at 3:1 (WCAG 1.4.11). It never carries body text.
- Input borders use `--input-line`, which reaches 3:1 on every surface an input sits on (WCAG 1.4.11). The Settings search field is the exception: a `--panel-line` border that brightens on hover and focus, with its icon and placeholder to say what it is (feat-providers-redesign). Dividers, cards and chips keep their hairlines (`--line`, `--line-2`, `--line-3`). The focus ring (`--focus`) reaches 3:1 on every surface.
- Unread is bold plus a step up the ladder, never color alone.
- Increase contrast: `@media (prefers-contrast: more)` in `tokens.css` follows macOS. Each text tier takes the value of the tier above it, ink goes to full black or white, dividers reach 2:1 and every other line 3:1 (line-4 and the input border 4.5:1), and the focus ring is near solid.
- `test/theme.test.ts` checks every pair above in both themes and in the Increase contrast block.
