# Kernel design rules

The canvas is the source of truth. Every screen is exported to `design/screens/<Screen>.png`, and its markup (exact sizes, colors, copy) is in `design/canvas/project/<Screen>.dc.html`. Live canvas: https://claude.ai/artifact/QkKTWG8JptN5AaqvPVBn1o

## Character

Linear-inspired, dark first, quiet. Monochrome surfaces; color only carries meaning. Dense but calm: 13px UI text, generous line height, hairline borders.

## Color (dark)

| Token | Value | Use |
|---|---|---|
| canvas | #070707 | window background |
| panel | #0f0f0f | main panel |
| surface | #141414 | inputs, cards |
| surface-2 | #181818 | menus, modals |
| surface-3 | #1e1e1e | selected rows, hover fills |
| hover | #242424 | menu item hover |
| line | #1c1c1c | dividers |
| line-2 | #262626 | input borders |
| line-3 | #2e2e2e | buttons, menus |
| ink | #f5f5f5 | primary text |
| ink-2 | #e0e0e0 | secondary text |
| muted | #9c9c9c | labels, meta |
| faint | #7a7a7a | tertiary |
| add | #4cb782 | diff additions, passing checks |
| del | #eb5757 | diff deletions, errors, the context ring from 90% |
| mod | #e2c08d | a modified file's name and letter (KERNEL-399) |
| merged | #b9a3f5 (text), #7c5ce0 (fill) | merged PRs only |
| working | #7cb2ff | unused since sidebar rows lost their hover card (remove-sidebar-hover-card) |
| needs | #f2c55c | waiting on you: the waiting icon on sidebar rows and chat tabs, the Inbox count, the context ring from 75%, the non-blocking warning icon on a Checks row (KERNEL-217) |
| danger | #e5484d | destructive confirm buttons |
| aside | #0b0b0b | the workspace's right panel, one step below panel |
| plan | #5aa2ff (on-plan #06101e) | plan mode: composer border and glow, caret, send, Approve |
| pr-merged-* | band #2a2140, line #3c2f5c, soft #372b55, edge #64509c, fg #d4c2ff, text #b88fff, solid #8b45f5 | PR header band: merged |
| pr-ready-* | band #15281f, line #22432f, soft #1d3b2c, edge #33704f, fg #a3e8c3, text #62d69d, solid #1b7f50 | PR header band: open, ready, merging |
| pr-fail-* | band #2c1719, line #472428, soft #3e2125, edge #70353c, fg #ffbdbd, text #ff8a8a | PR header band: checks failed, changes requested, conflicts |

The neutrals are pure grey, with equal red, green and blue, so no surface or text leans blue or violet (KERNEL-431). There is no brand accent. Primary buttons are ink on canvas. The one brand color is `--claude`, the fill of the Claude mark on the model picker's rows, because it is Claude's logo (claude-mark-in-model-picker). `working` has no use now that sidebar rows show no hover card (remove-sidebar-hover-card). `needs` also marks what waits on you: the waiting icon on a sidebar row or a chat tab, the Inbox count, the context ring in the composer from 75% (red `del` from 90%, KERNEL-334), and the non-blocking warning icon on a Checks row (KERNEL-217). `plan` is plan mode only, and the `pr-*` sets are the PR header, the Merge button on a Team update row, and the header, Merge button and state words on the Lead's PRs tab (KERNEL-347). Files are the other exception (KERNEL-399): a file or folder's icon comes in color from Material Icon Theme, and a changed file's name and letter take VS Code's git colors, `mod` for modified, `add` for added, untracked and renamed, `del` for deleted.

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
- Unread is a bold title, never a dot. A chat row, workspace row, collapsed room and chat tab take 600 weight in `--ink`, and the icon keeps its state, so a row that needs you shows the amber icon and the bold title together. The chat on screen is read (KERNEL-508).
- Each level under a room steps in 12px: chat icons sit 20px in and nested workspace icons 32px in. A chat that started workspaces folds like a room and shows the question icon when a hidden workspace needs you.
- Banners for failures and for work held on you: neutral surface (#141517) with an icon per type (limit/clock, offline/wifi, auth/key, setup/x-circle, hooks/plug, retry/spinner, trust/shield: the room's scripts wait for you to trust them). Never red backgrounds.
- Check rows (KERNEL-437): a readiness check, a room setup step and a room's Push access row say their result with an icon and a word. A green check passes, a red x-circle fails, and the amber `needs` triangle warns. A failing row gives its one fix under it, a command in a code box with Copy or a single button. A warning never blocks. Continue stays on and the row's own button is bordered, so the one ink button is the way forward. A line that passes with more to say, like the gh login's source or Bedrock, adds a muted note under its detail. A warning about files names the file and the variable, never the value. A failed hooks install in Check hooks follows the same shape in its own card. `design/screens/CheckHooks*.png`, `Setup*.png` and `RoomSetupWarnings.png` draw them, and `docs/decisions/KERNEL-437.md` lists the copy.
- Toasts: bottom right, 360px wide, with no close button. The title and sub share one line where they fit. A toast leaves by itself after 2.6s, or sooner when you swipe it right (toast-motion-and-swipe). A toast is for something you can't see on screen: (1) a call that failed ("Could not ..."), (2) something Kernel or an agent did without your click, like a PR created or merged, an archive after a merge, a config mistake or the window reloading after a crash, (3) an action that changes nothing on screen, like Path copied, Branch copied, Logs exported or the Check for updates result. A click whose result you can see gets no toast: the archived row is gone, the restored workspace opens (KERNEL-495).
- Icon buttons: hover brightens the icon to `--ink` with no fill behind it, because a fill around a small glyph reads louder than the glyph. A fill means the button is on or its menu is open (`aria-pressed`, `aria-expanded`), never hover. Buttons with a label, menu items, rows, and the filled send and stop circles keep their hover fills.
- Tooltips: an icon button's `aria-label` is its tooltip, so give every icon button one and no `title`. Other elements opt in with `data-tip`, `data-tip-kbd` adds the shortcut, and `data-tip=""` opts out.
- Danger: red only on the final confirm button, never on the trigger.
- Merged is the only purple: the PR link, the Merged label, the merged PR band, the merged History row.
- PR header (KERNEL-274): the top of the right panel is a band in the PR's tone: grey (neutral states), green (open, ready, merging), red (checks failed, changes requested, conflicts, resolving), violet (merged). It holds the `#N | ↗` link pill, the state's icon and label, and the actions. Soft buttons use the band's soft fill and edge. Merge PR and a merged PR's Archive take its solid; a closed PR's Archive is soft. Create PR stays ink on the neutral band. The label always shows the state, never a spinner. With the right panel hidden, the header sits in the chat with no band, in neutral colors except merged. `design/redesign/Pr*.png` draws every state.
- Local merge (KERNEL-441): a repo with no GitHub remote has no PR, and the same band reads its merge. A plain `→ main` pill takes the link pill's place, and a merge line under the band says "3 ahead of main · 0 behind" and the merge method. Ready is green with Merge, behind main is grey with Update branch, conflicts and a refused merge are red, merging is the busy button and merged is violet. Behind, conflicts and refused each add one note card under the merge line, with the files listed where they matter. `design/redesign/PrLocal*.png` draws every state, and Room setup's Code host row is in `design/screens/RoomSetupGitHub.png` and `RoomSetupLocal.png`.
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
- Resize edges (KERNEL-419): hovering, keyboard focus or dragging the sidebar, Settings nav or right panel edge lights the content panel's border with a glow, `--ink` at 45% fading to transparent, about 2px at the middle of the edge and thinning toward the top and bottom. It stays at the middle and does not follow the cursor. The handle between the right panel's top and bottom panes (KERNEL-512) lights the hairline between them the same way, turned horizontal (`design/redesign/PanelResize.png`).
- Issue trackers (KERNEL-438): a room has one tracker, Linear, GitHub Issues or None, picked from a menu on Settings, a room, General. A fourth item such as Jira is one more menu item. Issues lists one room's tracker: the room is a menu after the page title and the source sits at the right. GitHub's rows are Linear's with `#number`, label pills and an assignee avatar, under one group named Open. A room with no tracker says so and offers Choose a tracker, never a Connect Linear page. The notice that someone else is on an issue is a confirm that names what was found, with Start anyway in the primary style and not danger (`design/screens/ConfirmIssueTaken.png`).
- Plan mode (KERNEL-274): the composer gets a `plan` border and a soft glow rising from its bottom edge, and the caret and a ready send button turn `plan`. No hatch, no stripes, no label. A waiting plan keeps the blue and puts Copy and Approve in a blue strip on top; send stays ink there so Approve is the one blue button. The glow moves slowly (see Motion).
- Agent capabilities (KERNEL-440): a line under an agent on Team, in the room-setup team card and in the profile says what Kernel noticed. A server the agent's file lists but the agent can't reach gets an amber warning and one step: "Linear isn't signed in. Sign in", "There's no Figma server in this room. Add server", "Neon didn't connect after 3 tries. Try again", "Playwright is switched off in this room. Turn on". A warning is one line that never wraps, and several stack. A file Kernel can't read is not an agent, so it goes in a "Can't read" section under the table with a red x-circle (the icon only, never a red background), the path, the parse error in mono and Open file. A warning's action is its own button, so a Team row is a list item with a stretched link, not one big button. The profile lists the same servers in a Servers box: the name, where it comes from (In its file, or an allowance), how it is doing (Connected in muted, a problem in ink with the amber triangle) and the one step. `TeamWarnings`, `AgentProfileServers`.
- Personal and allowed (KERNEL-440): an agent from `~/.claude/agents` has a Personal pill after its role, like Built in and Helper. Its File column shows the path and its profile says "All rooms". What Kernel adds on top of an agent's file is muted, with a plus-circle: "Linear allowed in this room by you" and Remove, on Team and in the profile's Servers box. Team says under the table that the files stay as they are. `TeamPersonal`.
- Tools gate card (KERNEL-440): the permission request's card with "Lumi wants to use Linear", one line on why it asks, the tool and its arguments in the code block, then Keep blocked, Allow Linear for Lumi in this room and Allow once (ink). A muted note under the buttons says Keep blocked sends Lumi on without Linear, and that only you can change the agent file. After a choice the card becomes one note, as the permission request does: "Allowed once.", "Allowed Linear for Lumi in Client A." or "Kept Linear blocked." `WorkspaceToolsGate`.
- For me or for the team (KERNEL-440): hire, edit and retire ask with the same two radio rows under a muted question, Just for me and For the team, each saying what it does in a line or two. It starts on Just for me, because For the team opens a pull request. The confirm button names the result: Create agent, Save for me, Retire Kai, or Open pull request once the team is picked. A Personal agent has no team row, because its file isn't in the repo. `WorkspaceHireServers`, `NewAgentDraftScope`, `AgentProfileScope`, `ConfirmRetireScope`.
- Servers row (KERNEL-440): the hire card and the New agent review list the servers the new agent's file names, one pill each. A server that works shows its name. One that doesn't shows the amber triangle and the problem. A sentence under the row says what that means for Rowan's hand-offs.
- Roster picker and rule conflicts (KERNEL-440): with more than about 12 agents, room setup asks who joins. The card has a search box, checkbox rows (name, role, tags, one description line, any warning) and "8 of 23 picked" with Clear and Pick the suggested 8. Kernel suggests the agents that can open pull requests. One written as a subagent with no pull request workflow starts unpicked as a Helper, with its warning. The list scrolls inside the card, so a half row shows at the bottom. The conflicts card lists each rule in CLAUDE.md or AGENTS.md that fights Kernel's workflow, with its file and line, next to what Kernel tells agents. Kernel never edits those files. Setup is taller than the window with these cards, so `RoomSetupRoster` and `RoomSetupConflicts` are drawn scrolled to the end.

## No footer (KERNEL-527)

- There is no strip under the main panel. The panel runs to 8px above the window's bottom edge on every screen.
- The sidebar's bottom row holds the plan chip (or the Update ready pill once an update is ready), then Ask Rowan as a send icon, What's new and Settings. Ask Rowan's popover opens up from it.
- Hooks down and GitHub paused show as a row just above the bottom row, only while they hold.
- With the sidebar hidden, Show sidebar starts every screen header, followed by Ask Rowan and, once an update is ready, the pill. The popover opens down from the header. The chat's banners cover hooks and GitHub there.

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
