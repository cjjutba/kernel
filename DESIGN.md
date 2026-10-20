# Kernel design rules

These are the system rules every screen follows. A screenshot or mock in a task's brief is the spec for that task. Without one, match the current app and this file. Exact values live in `src/renderer/src/tokens.css`.

## Character

Dark first, quiet. Monochrome UI, colored content kinds: surfaces, text and controls are monochrome, and color carries meaning, either a status or what a thing is (see Content kinds). Dense but calm: 13px UI text, generous line height, hairline borders.

## Content kinds

A chip's icon, and only the icon, takes the color of what the chip is, in the composer and on sent messages. It never shows a status, and a gone or unreadable chip goes back to `--muted`. Purple stays for merged and amber for waiting. The colors are the `--kind-*` tokens, and each light value reaches 3:1 on `surface-3`.

| Chip | Icon | Color |
|---|---|---|
| Image | the image's file icon | green, `--kind-image` |
| Pasted text | document glyph | blue, `--kind-text` |
| Attached PDF | file glyph | red, `--kind-pdf` |
| Attached document | file glyph | blue, `--kind-doc` |
| Attached spreadsheet | file glyph | green, `--kind-sheet` |
| Attached slides | file glyph | orange, `--kind-slides` |
| Attached archive | file glyph | muted, `--kind-archive` |
| Attached audio or video | file glyph | pink, `--kind-media` |
| Any other attached file | file glyph | muted |
| @ repo file | its file icon | the icon's own colors |
| Issue | the tracker's mark | blue for Linear, muted for GitHub |
| Pull request | pr glyph | green while open, muted when closed, purple when merged |
| Workspace | branch glyph | teal, `--kind-branch` |
| Agent | the agent's avatar | the avatar's own color |

## Color (dark)

Every token in `tokens.css`, with its role. A screen picks a role, not a value.

| Token | Value | Role |
|---|---|---|
| canvas | #141414 | window background and the sidebar |
| panel | #1b1b1b | main panel |
| surface | #212121 | composer and cards that sit on a hairline |
| surface-2 | #252525 | menus, modals |
| surface-3 | #292929 | selected rows, hover fills |
| hover | #2c2c2c | menu item hover |
| line | #232323 | dividers in a header or list |
| line-2 | #2a2a2a | a chat card's border, dividers inside a card, hairlines on tables |
| line-3 | #333333 | every outline: dialogs, inputs, selects, buttons, the composer, rail connectors |
| ink | #f7f7f7 | emphasis only: titles, the current row, unread, the primary button |
| ink-2 | #d6d6d6 | default text: rows, body, the transcript |
| ink-3 | #acacac | secondary text |
| muted | #939393 | labels, meta, placeholders, sidebar and Settings nav rows |
| faint | #757575 | icons, disabled, decoration. Never text |
| add | #4cb782 | diff additions, passing checks, the Active pill, an added file |
| del | #f36b6b | diff deletions, errors, failing states |
| mod | #e2c08d | a modified file's name and letter (KERNEL-399) |
| merged | #b9a3f5 | merged PR text and icons. Merged only |
| merged-solid | #7c5ce0 | the Merged button fill. Merged only |
| merge | #1f8a55 | the Merge button fill, with `on-solid` text |
| needs | #f2c55c | amber text. Waiting only |
| needs-fill | #f2c55c | amber as a fill: the waiting icon and hourglass, meter bars from 75% |
| del-fill | #f36b6b | red as a fill: meter bars from 90%, the context ring, the limit banner icon |
| tint-muted | #262626 | the pill behind a muted status word in a hover card |
| aside | #181818 | the stage behind a shared preview |
| plan | #5aa2ff | plan mode: composer border and glow, caret, send, Approve |
| on-plan | #06101e | text on a plan fill |
| claude | #d97757 | the fill of the Claude mark, nowhere else |
| pr-merged-* | band #30254a, line #433468, soft #3d305f, edge #6a55a4, fg #d4c2ff, text #b88fff, solid #8b45f5 | PR header band: merged |
| pr-ready-* | band #1a3126, line #284b38, soft #22422f, edge #387755, fg #a3e8c3, text #62d69d, solid #1b7f50 | PR header band: open, ready, merging; also the green Merge pills on Work, Pull requests |
| pr-fail-* | band #341a1d, line #50292e, soft #47262b, edge #783a42, fg #ffbdbd, text #ff8a8a | PR header band: checks failed, changes requested, conflicts |
| danger | #e5484d | red as a fill |
| on-solid | #ffffff | text on danger and merged fills |
| on-ink | #141414 | text on the primary button |
| ink-hover | #ffffff | text and icon on hover where ink-2 is not bright enough |
| panel-line | #212121 | the main panel's border, Settings tab underline and the Settings search field |
| nav-hover | #1c1c1c | hover fill of a sidebar or Settings nav row |
| panel-hover | #262626 | hover fill of a row that sits on panel (Inbox, Issues, Projects, Pull requests, History) |
| input-bg | #1e1e1e | input fill |
| card-bg | #212121 | card fill |
| card-line | #2c2c2c | a divider inside a card, the modal footer rule |
| code-bg | #171717 | code block fill |
| chip-line | #353535 | chip border |
| pill-line | #262626 | pill border. Used only with --r-pill |
| track | #454545 | meter and toggle tracks |
| scrim | rgba(0, 0, 0, 0.3) | the blur scrim behind a modal |
| focus | rgba(247, 247, 247, 0.55) | the focus ring, 3:1 on every surface |
| term-* | black #7a7a7a, red #f06363, green #4cb782, yellow #d9b44a, blue #6ea8fe, magenta #b9a3f5, cyan #5ec8d8, white #e0e0e0 | the terminal palette |

The neutrals are grey with a slight cool lean: red equals green and blue sits 0 to 3 points above (KERNEL-611, amending KERNEL-431). Nav rows in the sidebar and Settings sit at muted and brighten to ink-2 on hover, so the content area leads. There is no brand accent. Primary buttons are ink on canvas. The one brand color is `--claude`, the fill of the Claude mark, because it is Claude's logo (claude-mark-in-model-picker). Codex shows the OpenAI mark in `currentColor`, ink, since OpenAI allows it only in black or white (openai-mark). Both marks come from `ProviderMark` wherever a provider is a heading or a pick. Purple (`--merged`) is only for merged, amber (`--needs`) is only for waiting, green (`--merge`) is the Merge button and `--del` is a destructive confirm button. Amber marks something that needs you: the hourglass in a waiting fold, the Session rail and the sidebar render in `needs-fill`, since light mode's `needs` is a text value that reads brown on a small glyph. A plan waiting for review is the exception: its icon takes `plan` blue, the color of plan mode and the Approve button (plan-waiting-icon-blue). The account in use on Providers wears the green Active pill (`--add`, `--pr-ready-line`) (feat-providers-redesign). `plan` is plan mode only, plus the plan card, which wears it on its icon, list markers and step numbers (KERNEL-1054), and the `pr-*` sets are the PR header, the Merge button on a Team update row, the header and Merge button on the Lead's PRs tab (KERNEL-347) and the green Merge pills on Work, Pull requests. The state words on that tab take only `add` for an approved review and `del` for a failing state, each with a 13px icon, and every other state stays muted (KERNEL-897). Files are the other exception (KERNEL-399): a file or folder's icon comes in color from Material Icon Theme, and a changed file's name and letter take git colors: `mod` for modified, `add` for added, untracked and renamed, `del` for deleted.

## Color (light)

Light values are in `src/renderer/src/tokens.css`. Where text failed 4.5:1 on any surface, the value was darkened until it passed. `test/theme.test.ts` checks every pair. Roles are the ones in the dark table.

| Token | Value | Role |
|---|---|---|
| canvas | #f2f2f2 | window background and the sidebar |
| panel | #fcfcfc | main panel |
| surface | #f8f8f8 | composer and cards that sit on a hairline |
| surface-2 | #f3f3f3 | menus, modals |
| surface-3 | #e9e9e9 | selected rows, hover fills |
| hover | #e6e6e6 | menu item hover |
| line | #ececec | dividers in a header or list |
| line-2 | #e2e2e2 | a chat card's border, dividers inside a card, hairlines on tables |
| line-3 | #d8d8d8 | every outline: dialogs, inputs, selects, buttons, the composer, rail connectors |
| ink | #1b1b1b | emphasis only: titles, the current row, unread, the primary button |
| ink-2 | #333333 | default text: rows, body, the transcript |
| ink-3 | #535353 | secondary text |
| muted | #676767 | labels, meta, placeholders, sidebar and Settings nav rows |
| faint | #838383 | icons, disabled, decoration. Never text |
| add | #166a45 | diff additions, passing checks, the Active pill, an added file |
| del | #b32e2e | diff deletions, errors, failing states |
| mod | #895503 | a modified file's name and letter (KERNEL-399) |
| merged | #6b4bd0 | merged PR text and icons. Merged only |
| merged-solid | #7c5ce0 | the Merged button fill. Merged only |
| merge | #1f8a55 | the Merge button fill, with `on-solid` text |
| needs | #7a4f00 | amber text. Waiting only |
| needs-fill | #d97706 | amber as a fill: the waiting icon and hourglass, meter bars from 75% |
| del-fill | #dc3e42 | red as a fill: meter bars from 90%, the context ring, the limit banner icon |
| tint-muted | #e8e8e8 | the pill behind a muted status word in a hover card |
| aside | #f7f7f7 | the stage behind a shared preview |
| plan | #1f5fbf | plan mode: composer border and glow, caret, send, Approve |
| on-plan | #ffffff | text on a plan fill |
| claude | #d97757 | the fill of the Claude mark, nowhere else |
| pr-merged-* | band #f3effd, line #e2d9fa, soft #ebe4fc, edge #b9a7ef, fg #4f34ad, text #5e3fc6, solid #7c5ce0 | PR header band: merged |
| pr-ready-* | band #eef7f2, line #d3eadd, soft #e1f1e8, edge #8fc5a7, fg #0f5235, text #166a45, solid #1a7a4f | PR header band: open, ready, merging; also the green Merge pills on Work, Pull requests |
| pr-fail-* | band #fcf0f0, line #f3d6d6, soft #f8e5e5, edge #e0a3a3, fg #8f2222, text #b32e2e | PR header band: checks failed, changes requested, conflicts |
| danger | #bd2b2b | red as a fill |
| on-solid | #ffffff | text on danger and merged fills |
| on-ink | #f2f2f2 | text on the primary button |
| ink-hover | #000000 | text and icon on hover where ink-2 is not bright enough |
| panel-line | #e8e8e8 | the main panel's border, Settings tab underline and the Settings search field |
| nav-hover | #ebebeb | hover fill of a sidebar or Settings nav row |
| panel-hover | #ebebeb | hover fill of a row that sits on panel (Inbox, Issues, Projects, Pull requests, History) |
| input-bg | #f8f8f8 | input fill |
| card-bg | #f8f8f8 | card fill |
| card-line | #e2e2e2 | a divider inside a card, the modal footer rule |
| code-bg | #f2f2f2 | code block fill |
| chip-line | #d4d4d4 | chip border |
| pill-line | #e6e6e6 | pill border. Used only with --r-pill |
| track | #bebebe | meter and toggle tracks |
| scrim | rgba(20, 21, 24, 0.14) | the blur scrim behind a modal |
| focus | rgba(27, 27, 27, 0.55) | the focus ring, 3:1 on every surface |
| term-* | black #18191b, red #b32e2e, green #166a45, yellow #8a5a00, blue #1f5fbf, magenta #6b4bd0, cyan #0b6f80, white #4a4d54 | the terminal palette |

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
- Inline code in a reply is a chip: Geist Mono 12.5px in full ink on surface-2, with a `--line-3` outline (KERNEL-526)
- Sentence case everywhere. Plain words. No em dashes or en dashes. Fixtures never hold a real email address, use you@example.com.

## Shape

- Radii (KERNEL-666), one scale in `tokens.css` and never a hard-coded px value: `--r-2xs` 4px checkboxes and highlights, `--r-xs` 6px 18 to 20px marks (kbd, tags, letter tiles, avatars, inline code), `--r-sm` 8px rows, list items, 22 to 26px controls and chips, `--r` 10px buttons, inputs, tabs and segmented controls (28 to 34px tall), `--r-md` 12px cards, panels, menus and code blocks, `--r-lg` 16px composer, `--r-xl` 18px large surfaces, `--r-modal` 14px modals, `--r-pill` 999px pills, toggles and meters. A control's radius is about 0.35 times its height. An inner radius is never larger than its outer one: the outer minus the padding, and `calc(<outer token> - 1px)` inside a 1px border
- 1px borders, no drop shadows anywhere. Every outline is `--line-3`: dialogs, inputs, selects, buttons, the composer and rail connectors. A hover or focus never moves an outline to another token. Dividers inside a card stay `--line` or `--line-2`.
- Hover previews (image, pasted text, issue chips and the transcript's image rows) share one frame, `.peek-frame`, the landing page's demo bezel at its small size without its shadows: 6px of padding, a 1px outer edge that is `--ink` at 34% along the top and fades to `--line-3` down the sides, and the resize edge's 3px glow (`--ink` at 45%) on the top edge. The picture sits inset behind a 1px dark outline. The frame is at most 480 by 320 and never takes the pointer.
- Icons: Hugeicons free stroke-rounded set (`@hugeicons/core-free-icons`), drawn by `Icon` on one stroke, 2.1 on its 24px grid (the old 1.4 on a 16px grid), round caps. `Icon` has no `stroke` prop, so a glyph is never bolder or lighter than its neighbours. Four sizes, typed as `IconSize`, so the compiler enforces the scale: 12 for carets, chips and inline meta, 14 for rows, buttons and menu items, 16 as the default (headers, the sidebar), 20 for empty states. `name` is an `IconName`, never a free string. `LargeMark` is the one escape, for the 34px and 120px marks on Welcome, and nothing else uses it (icon-sizes-and-stroke)

## Patterns

- No status dots, anywhere. Status is a word ("working", "needs you") and, where something is running, a dot loader beside it.
- One modal shell, used everywhere: a blur scrim over the whole window (sidebar included) at z-index 40, the modal at 50, 480px wide, `--panel` fill, 14px radius (`--r-modal`), a 1px `--line-3` outline. A header with the title and a close button, the body, then a footer under a hairline (`--line`) with Cancel and the action. A destructive action is `--del` with white text.
- Chat cards (questions, approvals, Kernel's choices, hand-offs, files changed, hire, team updates, shared files) share one shell: no fill, a `--line-2` border, radius 12 and no quote bar. The agent's avatar and a title, the body, numbered options with key badges (the pick has a `--surface-2` row and a filled key), and actions at the bottom right.
- Menus open 8px from their trigger and may cover the composer. Flyouts open to the right, level with their row, and open upward when there is no room. One model and effort picker is used everywhere (the composer, onboarding, Settings, New agent).
- Agents get a gradient avatar, never a letter. File and folder icons are Material Icon Theme.
- Dropdowns (KERNEL-680): every dropdown is `Select` from `ui`, never a native `<select>` (`test/noNativeSelect.test.ts`). The button is 28px, in a Settings card too with a `--line-3` outline and a chevron, and takes the open fill only while its list is open. The list is a `.menu`: groups get a heading, a choice can have a muted second line, the picked one has a check, and an action row (Custom folder…, Choose image…) sits under a rule. `variant="chip"` is the filled filter chip and `variant="plain"` text and a chevron at the end of a menu row.
- Segmented controls (KERNEL-680): every option is the same width, so none reads as the default.
- File names (KERNEL-399): wherever a repo file shows (file trees, the Changes list, file and diff tabs, view headers, the @ menu, file chips, Read, Edit and Write rows, approvals, the Inbox, Settings file lists), its Material icon sits in front, drawn by `FileIcon` or `FileLabel`. Pasted text and folders on disk keep their stroke glyphs, colored by kind (see Content kinds), and an image's chip shows its file icon. A tree row is 24px with 12px steps, a 16px chevron, the icon, the name and the status letter (M, A, U, R, D) at the right. 1px indent guides in `line-2` run down each open folder, the one beside the focused row in `line-3`. A folder with changes inside takes its strongest child's color, modified over deleted over the rest, with no dot. Folders that hold only one folder share a row (`src/renderer/src`). The open file's row is selected in `surface-3`. A tree is one tab stop: arrows move, open and close, Home and End jump.
- Hover actions: message actions (copy, retry, edit, and a reply's `...` menu with its forks) and sidebar `...` menus appear on hover and on keyboard focus. A finished turn's reply ends in one line: the turn's time (`4m 12s · 10:31`), always shown, then those actions (KERNEL-346).
- Hover fills: a sidebar or Settings nav row hovers on `--nav-hover`, and a row that sits on `--panel` (Inbox, Issues, Projects, Pull requests, History) on `--panel-hover`. A menu item hovers on `--hover`.
- Sidebar rows sit 3px apart, so hover and selected fills never touch.
- Unread is a bold title, never a dot. A chat row, workspace row, collapsed project and chat tab take 600 weight in `--ink`, and the icon keeps its state, so a row that needs you shows its blue plan or amber question icon and the bold title together. The chat on screen is read (KERNEL-508).
- Check rows (KERNEL-437): a readiness check, a project setup step and a project's Push access row say their result with an icon and a word. A green check passes, a red x-circle fails, and an amber triangle warns. A failing row gives its one fix under it, a command in a code box with Copy or a single button. A warning never blocks. Continue stays on and the row's own button is bordered, so the one ink button is the way forward. A line that passes with more to say, like the gh login's source or Bedrock, adds a muted note under its detail. A warning about files names the file and the variable, never the value. A failed hooks install in Check hooks follows the same shape in its own card. `docs/decisions/KERNEL-437.md` lists the copy.
- Toasts: every error is a toast, never an inline row, card or banner. A toast is 400px wide: a glyph, a title that wraps, one line on why, a close button and up to two actions. It sits 20px above the window's bottom edge (the composer's gap) and 16px from its right edge (the Session card's gap), on every screen whether the rail is open or not. Toasts stack upward with an 8px gap, newest at the bottom. The surface, hairline and radius are the Usage popover's. A toast leaves by itself after 5s (6s for a heads-up, see (4)), or sooner when you close it, use its action or swipe it right or down. A toast is for something you can't see on screen: (1) a call that failed ("Could not ..."), (2) something Kernel or an agent did without your click, like a PR created or merged, an archive after a merge, a config mistake or the window reloading after a crash, (3) an action that changes nothing on screen, like Path copied, Branch copied, Logs exported or the Check for updates result, (4) a heads-up about a cost you just took on that the screen doesn't show, like switching models in a chat that has run a turn (KERNEL-771). A click whose result you can see gets no toast: the archived row is gone, the restored workspace opens (KERNEL-495).
- Errors and what failed: the thing that failed stays as a quiet row ("Skipped", "Not sent") and the toast carries the error and its action. Not toasts: Session rail stages, setup log output, a failed tool call's red text, dialogs the user opens, field validation and "Kernel could not start". A list, panel or page that fails to load shows a calm empty state with Try again, plus a toast. Provider, network and Mac errors are toasts, and the composer placeholder says why it can't send.
- Limits: a limit that needs a choice is a banner above the composer, on `surface` with a 28px glyph tile and its action, never a red background. The tile's glyph is amber (`needs-fill`) when a choice is offered, red (`del-fill`) for a hard limit with nowhere to move, and quiet ink for a heads-up. Work held on you uses the same banner. A heads-up about a cost has a Not now. Provider, network and Mac errors (offline, signed out, overloaded, hooks down) are toasts raised once when the condition starts, and the composer's placeholder says why a message can't go ("You're offline. Messages queue until you're back."). A chat whose folder is gone has no banner: its placeholder says so (KERNEL-1101).
- Sidebar footer (KERNEL-1101): a 48px strip at the bottom of the sidebar with Settings, Help and Usage as 32px icon buttons, and a round 34px download button at the right once an update is ready. The Usage icon is the one meter there: muted, amber from 75% and red from 90% of the tightest window, and a dot loader while an account switches. Hovering it lists each provider's account numbers, and pressing it opens the Usage popover upward, 430px wide, lined up with the sidebar's left padding. The popover only reports. The account menu at the top of the sidebar names the Claude account agents run on and switches accounts, and every switch says so in a toast with Undo.
- Icon buttons: hover brightens the icon to `--ink` with no fill behind it, because a fill around a small glyph reads louder than the glyph. A fill means the button is on or its menu is open (`aria-pressed`, `aria-expanded`), never hover. Buttons with a label, menu items, rows, and the filled send and stop circles keep their hover fills.
- Buttons (KERNEL-879): every variant shows a hover and a press, fading over `--dur-fast` and `--ease-out` in background, border and text color only, with no scale, lift or shadow. Primary, Danger and Merged dim their fill a step on hover and one more on press (`color-mix` toward the text color). Secondary fills `--surface-3` on hover and keeps its `--line-3` outline, then `--hover` on press. Ghost fills the same and turns its text `--ink`. A pill that is not pressed turns its text `--ink` on hover. Icon buttons keep the no-fill hover and only gain the fade. A disabled or busy button does not react. `docs/decisions/KERNEL-879.md` says why.
- Tooltips: an icon button's `aria-label` is its tooltip, so give every icon button one and no `title`. Other elements opt in with `data-tip`, `data-tip-kbd` adds the shortcut, and `data-tip=""` opts out.
- Danger: red only on the final confirm button, never on the trigger. A destructive confirm button is `--del` fill with white text (`--on-solid`).
- Merged is the only purple: the PR link, the Merged label, the merged PR band, the merged History row. Amber is only for waiting: the hourglass in a waiting fold, the Session rail and the sidebar. A Merge button is green (`--merge`) with `--on-solid` text.
- Resize edges (KERNEL-419): hovering, keyboard focus or dragging the sidebar, Settings nav or right panel edge lights the content panel's border with a glow, `--ink` at 45% fading to transparent, about 2px at the middle of the edge and thinning toward the top and bottom. It stays at the middle and does not follow the cursor. The handle between the right panel's top and bottom panes (KERNEL-512) lights the hairline between them the same way, turned horizontal.

## Split button (KERNEL-1046)

- Every split button is `SplitButton` (`src/renderer/src/ui/SplitButton.tsx`): Run, Open in, Create PR, Open file and Settings' Open settings files. One joined control inside a 1px `--line-3` frame, a main half that acts and a caret half that opens a menu, with a hairline between them. Never a detached caret, never its own fill.
- Two sizes: `sm` is 26px with `--r-sm`, `md` is 28px with `--r`. The halves carry no border and no background of their own, so a tone is set once on the frame (`color`, `background`, `border-color`), as the PR band does. Hover is a faint fill, and an open menu holds a stronger one on the caret.
- Both halves are real buttons in the tab order, and focus is `--focus` drawn inside the frame. The caret has an `aria-label` and `aria-expanded`. The main half spins and can't be pressed twice while `busy`.

## Link button (KERNEL-1047)

- Every text button that acts like a link is `LinkButton` (`src/renderer/src/ui/LinkButton.tsx`), a real button with three variants. `inline` is underlined, for a link inside a sentence or a one-off action (Undo, Open in editor). `action` is plain until pointed at, as in the Inbox. `quiet` is muted, for a see-all or a card's Open.
- Without a `size` it takes the size of the text around it. `meta` and `ui` set one. Focus is the global `--focus` ring. It spins and can't be pressed twice while `busy`, like `Button`.

## Attaching files (KERNEL-815)

Dragging, dropping, pasting and picking a file all answer at once, in the workspace chat, the Lead chat and New chat alike.

- Overlay: files dragged over the chat pane cover the whole pane with a `surface` scrim at 92% and a 1px dashed `line-3` rectangle inset 12px, labeled "Drop to attach" in `ink-2`. No shadow, no color. It clears when the drag leaves the pane (an enter and leave count, so moving between child elements doesn't flicker it), on drop, on Escape and when the window loses focus. Text dragged with no files leaves the pane alone, and a blocked or disabled box shows no overlay and takes no drop.
- Drop anywhere: files dropped on the box land at the caret, files dropped elsewhere on the pane land at the end of the draft.
- Chips land done: each file gets its finished chip as soon as it is dropped, picked or pasted, with its name and the icon of its kind, in the order the files came. There is no loader and no dimmed name. While a file is read, only what the read tells (an image's size, a text file's line count) is missing, and it fills in place. Pasted long text is already whole, so its chip lands complete. A file that can't be attached loses its chip and shows the "Could not attach" toast. Send shows its busy label ("Attaching") only while a read is still going, so a message never goes without a file it was meant to carry.
- Entry: a chip that lands fades in and scales from 0.96 over 160ms on `cubic-bezier(0.22, 1, 0.36, 1)`. Under reduced motion it appears in place.

## Remembered choices

- A choice the user makes stays until they change it: a tab, a filter, a picked project, mode, branch or script, a width. Leaving the screen, opening another chat or relaunching never resets it.
- A choice tied to a project (New chat's picks, a project's GitHub filter, its picked run script) is kept per project, and goes when the project is archived or removed.
- Screens keep a choice through `remember.ts` (`useRemembered`, `readSaved`, `writeSaved`), never with `useState` alone and never with localStorage directly. `test/remember.test.ts` enforces the second part.
- A remembered value that no longer fits (a branch that is gone, a script removed from Settings) falls back to the default instead of showing something broken.

## Saving in Settings

- Toggles, segments and dropdowns save on click and get no note and no toast. The control is the confirmation.
- Text and number fields save when they lose focus. A note in muted text sits beside the field: "Saving" with the dot loader while the call runs, then "Saved" with a check. It fades about 1.5s after main answers. The state comes from the save promise, never a timer.
- When main corrects a number, the note says "Set to N, the most allowed" or "Set to N, the least allowed" and stays until the next edit.
- A field with unsaved text saves when it unmounts. Escape inside a field cancels the edit and puts the saved value back.
- A failed save rolls back, shows the "Could not save" toast and no Saved note.
- Editing a value that already exists never takes a Save button: a script, an instruction, an account's name. Multi-line fields save the same way, on losing focus or Cmd+Enter, and a sheet that edits one value has Done instead of Cancel and Save. A button stays only for adding something new in a dialog (a run script, a variable, a preview URL, a terminal preset) and for a step that asks where to save (an agent saved for you or opened as a pull request).

## Busy buttons

A button that waits on the main process shows it is working until the call returns. That means git, GitHub, the network, files, agent sessions, scripts and opening Terminal.

- The ripple dot loader (the 13px grid, `pattern="ripple"` in code, which `Button` and `IconButton` set) takes the icon's place and the label says what is happening: "Archiving", "Merging", "Creating". One or two plain words, no trailing dots, the way the PR header writes "Creating PR".
- The button is disabled while the call runs, so a second click, Enter or a shortcut can't start the work twice. Buttons next to it that act on the same thing (Deny beside Approve, Cancel beside Send) are disabled too.
- Every variant takes the Creating PR look at full opacity: surface-3 fill, line-3 border, ink-3 text. A busy primary or danger button turns grey. The PR header band is the exception: there a busy button keeps the band's tone, with its soft fill and edge, dimmer text and a dot loader in the band's text color, so it never reads as a hole in the band (KERNEL-274).
- Every busy button shows the ripple, whatever the action. The other patterns belong to other waits (see the table under Motion).
- In code, `useBusy()` tracks which button started the work, and `Button` and `IconButton` take `busy` and `busyLabel`. `ConfirmDialog` passes the same two to its confirm button and takes `disabled` for "can't confirm yet". The sidebar's archive button is the one exception. It stays a plain icon with no loader or word, and still ignores a second click. Approvals are the other exception (KERNEL-789, KERNEL-834): Approve, Deny, Allow once, Always allow, Approve and hand off, Approve and build, and the plan strip's Approve act at once, with no loader and no "Approving", "Allowing" or "Denying" label. The approval shows its result in place. A second press, or a press on another button of the same approval, does nothing (a ref guards it, not `useBusy`). A failed call brings the approval back with its error toast. The plan strip closes over --plan-dur; every other approval folds away as an archived row does (Motion, Approvals).
- No loader for navigation, menus, opening a dialog, toggles and selects that save in place, links that open the browser or the editor, copying, or sending a chat message, which shows up in the thread.

## State kinds (KERNEL-859)

Every screen draws a state with one of these components from `ui`, never its own markup. Gallery: `pnpm shots DevUiStates`.

| State | Component | Copy |
| --- | --- | --- |
| Loading | `LoadingRow what="issues"` | The `arrow-down` loader and "Loading issues". Plural noun, no trailing dots. |
| Empty | `EmptyList icon title` (an `EmptyState` centered in its area) | An icon, a title and one muted line. Add one `action` only when the person can fix it from here. |
| Failed | `FailedState title onRetry` | A calm empty state: what failed as the title, the reason under it, and Try again. The failure also raises a toast, which carries the error. Try again uses `useBusy`, spins as "Trying again" and can't be pressed twice. Never red text, never a blank list, never a banner. |
| Not connected | `NotConnectedState page label` | An empty state whose one button opens the Settings page that fixes it ("Open Integrations"). |

- A list that loads shows `LoadingRow`, then one of the other three. A blank area is never a state.
- Failed beats empty: a call that errored is not "No issues".
- Not connected means nothing is set up yet. Failed means it was set up and the call broke.

## Motion tokens (KERNEL-859)

`tokens.css` holds the shared timings. New motion uses them, and a screen moves onto them when its own issue touches it.

| Token | Value | Used for |
| --- | --- | --- |
| `--dur-fast` | 120ms | Fades and exits: modal and scrim leaving, the archive fade, the selected fill. |
| `--dur-base` | 160ms | Reveals: the scrim in, the queue row leaving, a toast's gap, Send changes color. |
| `--dur-glide` | 180ms | Folds: a group collapsing, the nearest thing to a glide with no distance. |
| `--ease-out` | `ease-out` | Everything that appears or leaves. |
| `--ease-glide` | `cubic-bezier(0.45, 0, 0.05, 1)` | Scroll to bottom and the chat rail jump. `GLIDE_EASING` in `scrollGlide.ts` is the same curve. |

The three kinds of motion:

- Place is instant. Opening a chat, a sent message, a plan or question answer, a new chat's first message and anything under reduced motion put the view where it belongs with no motion. A send never glides, lifts or moves to the top: the new row appears at the end and the view stays there while the reply streams. A reader scrolled up jumps straight to the end on a send. A new chat's first message sits at the top because the short thread is top-aligned.
- Glide is one curve, `--ease-glide`, for the two scrolls Kernel makes itself: Scroll to bottom and the chat rail jump. It is time-based, so 60Hz and 120Hz take the same time, it follows a moving target without restarting, and it eases out into the end with no snap. Its duration grows with the distance, 120ms to a 700ms cap, and is not a token.
- Reveal is one duration for folds, chips and the queue, so they read as one family and are tuned together.

## Type, layer and motion tokens (KERNEL-681)

`tokens.css` names every font size, line height, weight, layer, duration and curve the app uses, by role, at the value already on screen. A screen uses the token and never spells the value. `test/theme.test.ts` fails on a literal one outside `tokens.css`, on a literal type, color or spacing in an inline style, on a raw `type="checkbox"`, on a `var()` that names no token and on a token nothing uses. It also fails a color token used outside its role (below). The checks are strict for every file (KERNEL-929). `test/designParity.test.ts` keeps the add and merged colors equal to the site's.

| Family | Tokens | Rule |
| --- | --- | --- |
| `--fs-*` | `tile-xs` 8.5, `tile-sm` 9, `tile-md` 9.5, `tile` 10, `badge` 11, `chip` 11.5, `meta` 12, `code` 12.5, `ui` 13, `row` 13.5, `chat` 14, `sub` 15, `doc-h3` 15.5, `dialog` 16, `md-h1` 17, `doc-h2` 19, `title-sm` 20, `title` 22, `doc-h1` 24, `page` 26, `wordmark` 42.5 | Named by role. A size that isn't here is a new token with a role, never a rounded neighbor. |
| `--lh-*` | `none` 1, `compact` 1.2, `tight` 1.25, `heading` 1.3, `snug` 1.4, `ui` 1.45, `lh` 1.5, `prose` 1.55, `relaxed` 1.6, `code` 1.65, `loose` 1.7 | Unitless only. A px line height stays beside the control height it centres text in. |
| `--fw-*` | `regular` 400, `medium` 500, `semibold` 600, `wordmark` 800 | 600 for page titles, names on cards, letter tiles, avatars, dialog headings and bold text in a reply. |
| `--z-*` | `veil` 30, `scrim` 40, `modal` 50, `popover` 60, `submenu` 61, `preview` 65, `toast` 70, `tooltip` 90 | Anything that floats over other components. 1 to 9 order siblings inside one component and stay literal. |
| `--dur-*` | `fast` 120ms, `base` 160ms, `glide` 180ms, `scroll-in` 150ms, `turn` 150ms, `slow` 200ms, `enter` 300ms, `delay` 80ms, `spin` 0.8s, `ring` 1.2s, `pulse` 1.4s, `sweep` 1.6s, `breathe` 8s | The first three are in Motion tokens above. `turn` is a chevron turning. `spin`, `ring`, `pulse`, `sweep` and `breathe` are loops and ambient motion. |
| `--ease-*` | `out`, `glide`, `enter` `cubic-bezier(0.22, 1, 0.36, 1)`, `exit` `cubic-bezier(0.4, 0, 1, 1)`, `sweep` `cubic-bezier(0.4, 0.1, 0.6, 0.9)`, `dip` `cubic-bezier(0.37, 0, 0.63, 1)` (the dot loader), `plan` `cubic-bezier(0.33, 0, 0.2, 1)` | Keywords such as `ease-in` stay as they are. |
| `--plan-dur` | 0.5s | Every plan mode state change. The 8s breathing loop is ambient and keeps `--dur-breathe`. |
| `--archive-fold`, `--archive-fade` | `--dur-base`, `--dur-fast` | The archive beat. `archiveMotion.tsx` reads them in ms. |

Roles the theme test holds (KERNEL-1048):

- `--pill-line` only on a rule that sets `--r-pill`. `--line`, `--line-2` and `--panel-line` only as a 1px rule, never a fill. `--faint` never as a text color; use `--ink-3`.
- `--add` and `--del` only on diff lines, tones, error text and the other allowed selectors listed in `ADD_DEL_ALLOWED`.
- A radius is a token, or a calc on one. A `box-shadow` is `none`. A `.btn` height is 24, 26, 28 or 32.
- A `:focus-visible` outline is `2px solid var(--focus)`. `outline-style: none` is only for a row or box in `FOCUS_ON_ANCESTOR`, where an ancestor draws the ring.

Shared controls that came with them: `Checkbox` (the box in ink, centred on its label or `align="top"` for a label that wraps), `Button` sizes `xs` (24px, `--r-sm`), `sm` (26px, `--r-sm`), md (28px, `--r`) and `lg` (32px), the only heights a `.btn` has and `IconButton box` (`md` 26px, `sm` 24px, `xs` 22px; the icon keeps its own `size`). A shared utility class goes in `tokens.css` only when three or more screens need it, and it never uses `!important`.

## Motion

- Check an animation with `pnpm shots <Screen> --motion` before it ships: a still can look right while the motion jolts. Give the fixture a `motion` action and share the contact sheet and GIF in the PR.
- Plan mode (KERNEL-322): the glow rises and fades over `--plan-dur`, 0.5s, each way (KERNEL-418, KERNEL-565), and breathes every 8s while the box waits for input. Focus settles it over `--plan-dur`. A plan's strip opens over --plan-dur (0.5s), then one light crosses it over 1.6s. Approve is a user action, so the strip leaves in the frame of the press with no animation: the plan stops waiting, the box leaves plan mode, the Approved row appears and the Working line replaces Waiting for you, all in one render (KERNEL-895, replacing the close of KERNEL-833). A strip whose plan stopped waiting for another reason (Inbox, a denial, an expiry) leaves the same way. The placeholder and the mode chip switch instantly, with no crossfade (KERNEL-839 removed). Approve glides the chat to its true end, re-aiming while the end moves, jumping to one screen above it first when it is more than 1.5 screens away, and the reader's wheel, keys or touch take over at once. With text in the box, Approve asks "Approve without your changes?" in the strip: Send changes sends it as the plan's change request, Approve keeps it in the box, Escape backs out. After Approve the caret goes to the box and a polite live region says "Plan approved". Reduced motion removes the strip's opening. Send changes color in 0.16s.
- Resize edge glow (KERNEL-419): fades in over 200ms ease-out after an 80ms delay and out over 120ms, growing from the middle. Reduced motion turns it on and off with no transition.
- Toasts: a new toast's gap opens over 0.16s, then the toast rises 16px and fades in over 0.3s, ease-out. On timeout, close or its action it sinks 16px and fades over 0.2s, then its gap closes over 0.16s. A drag or a two-finger swipe moves it with your finger, locked to right or down after 6px and never left or up. Past 60px, or after a flick, it slides on out the way it went. Short of that it springs back.
- Archive (KERNEL-579): archiving a chat or workspace is one short beat, played for the three cases below. Every curve is `ease-out`.
  - Order. The row folds and fades from the frame the main panel swaps. It starts when Kernel marks the archive done, after any confirm, never before. A failed archive moves nothing and shows its "Could not archive" toast.
  - The row. Opacity goes 1 to 0 over 120ms while the row's height and the 3px gap under it close to 0 over --dur-base (160ms). The row keeps its size and is clipped, never squeezed. Rows below slide up with the closing height and have no motion of their own, so the open chat's row rides up with them. A chat's nested workspace rows fold with it in the same frames, with no stagger. A folding row can't be clicked, and it leaves the list when the fold ends.
  - The screen (KERNEL-636). When the archived chat or workspace was on screen, the main panel swaps to the destination at once, in one frame, with no fade and no copy of the old screen. The destination is live from the first frame and takes focus and keys at once.
  - Where it goes (KERNEL-596). One destination for every archive of the chat or workspace on screen: the project's front door, which is New chat with Kernel, or Team when the project has no Lead. It is the same for a chat, a workspace it started, a review and a workspace Kernel archives after its PR merged, and whatever else is open in the project. No chat row is picked, the app never goes to History, and the route moves once, in the step the archived status is stored, so no frame shows the workspace without its tabs. Kernel archiving after a merge keeps its toast. An archive by hand has none.
  - Selected fill. When the destination has a row in the sidebar, its fill goes from none to `surface-3` and its text from `ink-2` to `ink` over 120ms, as the archived row fades out. That is Kernel's Lead row, which stands in for New chat with Kernel while the project has no open chat. In a project with open chats, no row stands for New chat, so no fill changes. This is the only selection change that fades. Other clicks still switch it at once.
  - The last chat in a project. Kernel's Lead row opens in the chat row's place: height 0 to full over --dur-base (160ms) and opacity 0 to 1 over 120ms, as the chat row folds. The two heights add up to one row all the way through, so the rows below stay put. A project with no Lead has no row to open, and the rows below slide up.
  - Not on screen. When the archived chat or workspace wasn't on screen, only its row folds. The screen doesn't move, and there is no toast (KERNEL-495).
  - Any archive. The same beat plays however the archive starts: the row's Archive button, a PR's Archive, closing a chat's last tab, or Kernel archiving after a merge.
  - Overlap. Archiving again while a fold runs starts that row's fold at once. The destination row's fill fade that starts over another one jumps the earlier one to its end.
  - Reduced motion. No fold and no fade. In one frame the row leaves, the Lead row appears and the selected fill changes. The screen swaps at once either way.
- Only opacity and transform loop, and nothing on a button loops.
- Dot loader (KERNEL-714, KERNEL-759, KERNEL-1087): one 3x3 grid of round dots, 13px square everywhere (3px dots, 2px gaps, in the 16px icon slot, so it matches the 12 to 13px icons beside it and does not scale with the text), in `--faint` by default and `--ink-3` in PR rows, one steady gray. It always sits beside words and there is no circular spinner anywhere. The dots rest at full size and dip out on their turn: each shrinks on a sine ease (185ms), stays gone (55ms) and grows back the same way (185ms) in a 0.8s loop. Neighbors start their dips at different steps, so a gradient of sizes sweeps across the grid and no single dot pops. Only transform and opacity animate. The center never shows or dips alone (`test/spinnerGuard.test.ts` checks every pattern). Every loader starts its loop together, so rows run in step. Reduced motion draws no animation: a pattern's still-frame dots show at full size and the rest at 0.35 scale. Dots are numbered row by row (0 1 2 / 3 4 5 / 6 7 8), and the patterns are data in `ui/dotPatterns.ts`. There are seven, one per kind of wait, so a person can tell a wait apart at a glance.

| Pattern | Order | Still frame | Used for |
| --- | --- | --- | --- |
| `wave` | diagonals, top left to bottom right | middle diagonal | agents working: sidebar rows, hover card |
| `spiral` | clockwise around the ring, then center | first three dots | the transcript Working line |
| `snake` | one dot dips at a time, tracing the grid | first three dots | setup and run scripts |
| `twinkle` | two or three dots dip at once, fixed uneven delays | three dots | chat tabs working |
| `checker` | the X, then the plus, alternating | the X | PR checks running: PR rows, PR band status |
| `arrow-down` | a `v` chevron moving down, row by row | the chevron | loading data and Starting |
| `ripple` | center and edges together, then corners | the plus | busy buttons and inline action links |

- Modals (KERNEL-648): every modal opens with the scrim fading in over 160ms `ease-out` while the dialog fades in, rises from 8px below and scales from 0.98 over 200ms, `cubic-bezier(0.22, 1, 0.36, 1)`. Escape, the scrim, Close and Cancel play an exit: the dialog fades and drops 4px over 120ms, `cubic-bezier(0.4, 0, 1, 1)`, and the scrim fades over the same 120ms. Neither takes input during the exit, and the modal leaves when it ends. A close after an action that changes the screen leaves at once. Reduced motion turns it on and off in place.
- Escape order and focus return (KERNEL-878): one Escape does one thing, the innermost thing first. In order: a field being edited (it cancels or clears), an open menu, picker or modal (the newest closes), the screen's own Escape (leave Settings, back out of the plan question, leave New chat, stop the running turn), and a toast last. A handled Escape stops there, so one press never both cancels an edit and dismisses a toast. A text field keeps Escape from the screen and the toast whether or not it uses it; the message box does not, so an Escape it leaves alone goes on. Menus, pickers and modals register with `useLayer`, the screen's own Escape with `useScreenEscape` and a toast with `useToastEscape` (`ui/hooks.ts`), never with a window listener of their own.
- Focus return (KERNEL-878): when a menu, picker, popover or modal closes, focus goes back to the element that was focused when it opened, or to the message box when that element is gone. `useLayer` does it for every overlay, so a second Escape after a picker closes still stops the running turn. A close that already left focus on another field leaves it there. The command palette returns to the Search button when that opened it.
- Approvals (KERNEL-834): pressing a decide button in the Inbox or on a chat's card folds the approval away the way an archived row does, over --archive-fold with the fade over --archive-fade, `ease-out`. In the Inbox the list row folds when it leaves its tab, and the detail's buttons fold, then the outcome stands in their place. In a chat the card's buttons fold and the result line takes their place, since the card stays as the record. Nothing spins. A failed call ends the fold and the approval comes back, with the "Could not send your answer" toast. Reduced motion changes it in place, with no fold and no fade.
- A user action draws its result in the same frame (KERNEL-895). Send, a suggestion, Ask to fix, Retry, Send now, Stop, Approve and a plan's change request each put their end state on screen in the render that follows the click: the message's bubble (or its row in the queue tray when a turn runs or setup holds it), the Working line, Stop and "Add a follow up", the emptied box, and a plan's strip leaving. The window makes the message's id, so the row main saves replaces the drawn one in place. Main confirms in place and never redraws: no second layout, no row that appears a frame later, no glide or fade between the click and the end state. The running state comes from the action and main's `chat.running` takes over from it, with no timer, and a failed call takes everything back and returns the text to the box. A queue row leaves and arrives with no animation. Check it with a `--motion` fixture whose main answers late, and look at every frame: the first must already be final, and after it only new content (the reply, the clock) may change.
- Respect reduced motion: jump instead of walk, the dot loader holds a still frame of its pattern, no breathing glow, toasts that appear and vanish in place, archived rows that change in place.

## List keys (KERNEL-871)

Inbox, Issues, Projects, Pull requests and History share one keyboard model, `useListKeys` in `ui/listKeys.ts`. A new list uses it, and doesn't add keys of its own.

- Down arrow and j move to the next row, Up arrow and k to the previous one. Home goes to the first row and End to the last. The ends stop the cursor, they don't wrap. Shift, Ctrl, Alt and Cmd with a key leave it alone.
- Enter opens the focused row: Inbox and Issues select it and hand focus to the detail, Projects opens the project, Pull requests opens the workspace, and History restores the workspace.
- Roving focus: one row is in the tab order, so Tab enters the list once and leaves it again. It is the chosen row where a list has a selection (Inbox, Issues), and otherwise the row focused last, or the first.
- The keys act on a focused row only. Typing in a field, a modal over the list, and the buttons inside a row (Merge, Restore, Delete) are never read as list keys. Inbox keeps j and k from anywhere on the screen, and its a and d decide.
- The focus ring is the global `--focus` ring, drawn inset on the whole row (`outline-offset: -2px`). Where the focusable element is a link inside the row, the row draws the ring with `:has(:focus-visible)`.

## Accessibility

Real `<button>`, `<a>`, `<input>` with labels; focus rings visible; every icon-only control has `aria-label`.

- Text contrast is 4.5:1 for every text tier and status color on every surface (see Text ladder). Faint is for icons, disabled controls and decoration, at 3:1 (WCAG 1.4.11). It never carries body text.
- Every outline is `--line-3` (WCAG 1.4.11 asks 3:1 for a control's edge, and Increase contrast brings it there). Dividers inside a card stay `--line` or `--line-2`. The focus ring (`--focus`) reaches 3:1 on every surface.
- Unread is bold plus a step up the ladder, never color alone.
- Increase contrast: `@media (prefers-contrast: more)` in `tokens.css` follows macOS. Each text tier takes the value of the tier above it, ink goes to full black or white, dividers reach 2:1 and every outline (`--line-3`) 3:1, and the focus ring is near solid.
- `test/theme.test.ts` checks every pair above in both themes and in the Increase contrast block.
