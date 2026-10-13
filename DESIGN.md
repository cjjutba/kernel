# Kernel design rules

The canvas is the source of truth. Every screen is exported to `design/screens/<Screen>.png`, and its markup (exact sizes, colors, copy) is in `design/canvas/project/<Screen>.dc.html`. Live canvas: https://claude.ai/artifact/QkKTWG8JptN5AaqvPVBn1o

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
| needs | #f2c55c | the context ring in the composer from 75% and nothing else (no-amber-icons) |
| danger | #e5484d | destructive confirm buttons |
| aside | #0d0d0e | the stage behind a shared preview. The workspace's right panel sits on panel, like the chat (KERNEL-526) |
| plan | #5aa2ff (on-plan #06101e) | plan mode: composer border and glow, caret, send, Approve |
| pr-merged-* | band #2a2140, line #3c2f5c, soft #372b55, edge #64509c, fg #d4c2ff, text #b88fff, solid #8b45f5 | PR header band: merged |
| pr-ready-* | band #15281f, line #22432f, soft #1d3b2c, edge #33704f, fg #a3e8c3, text #62d69d, solid #1b7f50 | PR header band: open, ready, merging |
| pr-fail-* | band #2c1719, line #472428, soft #3e2125, edge #70353c, fg #ffbdbd, text #ff8a8a | PR header band: checks failed, changes requested, conflicts |

The neutrals are grey with a slight cool lean, sampled from Linear: red equals green and blue sits 0 to 3 points above (KERNEL-611, amending KERNEL-431). Nav rows in the sidebar and Settings sit at muted and brighten to ink-2 on hover, so the content area leads. There is no brand accent. Primary buttons are ink on canvas. The one brand color is `--claude`, the fill of the Claude mark on the model picker's rows, because it is Claude's logo (claude-mark-in-model-picker). `working` has no use now that sidebar rows show no hover card (remove-sidebar-hover-card). `needs` is only the context ring in the composer from 75% (red `del` from 90%, KERNEL-334). No icon is amber: the waiting icon on a sidebar row or a chat tab and every warning triangle render in `ink` with no color, and their shape says the state (no-amber-icons). `plan` is plan mode only, and the `pr-*` sets are the PR header, the Merge button on a Team update row, and the header, Merge button and state words on the Lead's PRs tab (KERNEL-347). Files are the other exception (KERNEL-399): a file or folder's icon comes in color from Material Icon Theme, and a changed file's name and letter take VS Code's git colors, `mod` for modified, `add` for added, untracked and renamed, `del` for deleted.

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
| needs | #7a4f00 | the context ring in the composer from 75% and nothing else (no-amber-icons) |
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
- Token values win over the PNGs in `design/screens/` on text color: the PNGs still draw the old greys. The PNGs stay the spec for layout and copy.

## Type

- Geist Sans for UI (13px base, 14px in chat and composer, 12px meta), Geist Mono for code, branches, paths, shortcuts. Both ship with the app, so text looks the same on every platform (KERNEL-610). File names in the All files tree and the Changes tab are Geist Sans 13px, as in VS Code's explorer (KERNEL-399)
- Weights 400 and 500; 600 only for page titles, names on cards and bold text in a reply, which also takes full ink (KERNEL-526)
- Inline code in a reply is a chip: Geist Mono 12.5px in full ink on surface-2, with a line-3 hairline (KERNEL-526)
- Sentence case everywhere. Plain words. No em dashes.

## Shape

- Radii (KERNEL-666), one scale in `tokens.css` and never a hard-coded px value: `--r-2xs` 4px checkboxes and highlights, `--r-xs` 6px 18 to 20px marks (kbd, tags, letter tiles, avatars, inline code), `--r-sm` 8px rows, list items, 22 to 26px controls and chips, `--r` 10px buttons, inputs, tabs and segmented controls (28 to 34px tall), `--r-md` 12px cards, panels, menus and code blocks, `--r-lg` 16px composer, `--r-xl` 18px modals, `--r-pill` 999px pills, toggles and meters. A control's radius is about 0.35 times its height. An inner radius is never larger than its outer one: the outer minus the padding, and `calc(<outer token> - 1px)` inside a 1px border
- 1px borders, no drop shadows anywhere
- Icons: 16px stroke icons, 1.4 stroke width, round caps

## Patterns

- No status dots, anywhere. Status is a word ("working", "needs you").
- One modal shell: a blur scrim over the whole window (sidebar included) at z-index 40, the modal at 50, 18px radius, 1px border.
- Settings lists of things you add (variables, env files, presets, run scripts, preview URLs): each row ends in borderless text actions (Edit, Remove), and the section's Add button is a bordered 28px button at the right of its heading. The Permissions rules are the exception and keep a bordered Remove. A masked value is a fixed run of dots. A missing item says "Missing" in a pill. The selected preset in a list is a filled ring with a check. Avatars are grayscale (KERNEL-255).
- File names (KERNEL-399): wherever a repo file shows (file trees, the Changes list, file and diff tabs, view headers, the @ menu, file chips, Read, Edit and Write rows, approvals, the Inbox, Settings file lists), its Material icon sits in front, drawn by `FileIcon` or `FileLabel`. Pasted text, attached images and folders on disk keep their stroke glyphs. A tree row is 24px with 12px steps, a 16px chevron, the icon, the name and the status letter (M, A, U, R, D) at the right. 1px indent guides in `line-2` run down each open folder, the one beside the focused row in `line-4`. A folder with changes inside takes its strongest child's color, modified over deleted over the rest, with no dot. Folders that hold only one folder share a row (`src/renderer/src`). The open file's row is selected in `surface-3`. A tree is one tab stop: arrows move, open and close, Home and End jump.
- Hover actions: message actions (copy, retry, edit, and a reply's `...` menu with its forks) and sidebar `...` menus appear on hover and on keyboard focus. A finished turn's reply ends in one line: the turn's time (`4m 12s · 10:31`), always shown, then those actions (KERNEL-346).
- Sidebar rows sit 3px apart, so hover and selected fills never touch.
- Unread is a bold title, never a dot. A chat row, workspace row, collapsed room and chat tab take 600 weight in `--ink`, and the icon keeps its state, so a row that needs you shows its plan or question icon in ink and the bold title together. The chat on screen is read (KERNEL-508).
- Sidebar row ends: the title takes the room. Diff counts show only when the sidebar is 300px or wider, and a PR number stays at any width. ⌘N shows while ⌘ is held, at any width, and takes the place of the spinner and the counts. Hovering a row swaps its whole right end for Archive, and resting on a chat, Lead or workspace row opens its hover card, so these rows carry no tooltip.
- Sidebar hover cards (kernel-630-sidebar-hover-card): a chat, Lead or workspace row opens a card beside the sidebar after 700ms of hover, or at once within 300ms of another card closing or on keyboard focus. Escape, scrolling the sidebar, the window losing focus and a click close it. Surface-2, 1px line-3 border, 12px radius, no shadow. An eyebrow (room or parent chat) with the diff totals in add and del, a bold title, one muted line, then Archive where the row has it, the PR number as a link and the time ago on the right. A monochrome state icon sits top right; only a merged PR takes a color, `merged`.
- Chat groups (KERNEL-600, `SidebarChatGroups`): a Lead chat and the workspaces it started are one block. Chat icons sit 20px in and nested workspace icons 38px in, an 18px step. Tree connectors tie them together (KERNEL-631): a 1px line in `line-3` drops from under the chat's icon, centred on it 28px in, and each workspace gets a 1px elbow into its icon at the icon's vertical centre, ending 4px short of the icon. The last workspace's elbow turns with a 6px radius (`--r-xs`) into a └ and the line stops there. The block that holds the open row takes `line-4`, as the file tree's guides do. A folded chat or one with no workspaces draws none. Blocks sit 8px apart, the 3px row gap plus 5px, and the workspaces no open chat owns form a block of their own. A row keeps its own icon at all times, chat, plan, question or branch, and a row that waits on you shows its plan or question icon in ink, with no color. A running row shows the 11px spinner at its right end, after any counts, so a running chat and a running workspace differ by their icons. A chat that started workspaces folds like a room and shows the question icon when a hidden workspace needs you.
- Banners for failures and for work held on you: neutral surface (#141517) with an icon per type (limit/clock, offline/wifi, auth/key, setup/x-circle, hooks/plug, retry/spinner, trust/shield: the room's scripts wait for you to trust them). Never red backgrounds.
- Check rows (KERNEL-437): a readiness check, a room setup step and a room's Push access row say their result with an icon and a word. A green check passes, a red x-circle fails, and a triangle in ink, with no color, warns. A failing row gives its one fix under it, a command in a code box with Copy or a single button. A warning never blocks. Continue stays on and the row's own button is bordered, so the one ink button is the way forward. A line that passes with more to say, like the gh login's source or Bedrock, adds a muted note under its detail. A warning about files names the file and the variable, never the value. A failed hooks install in Check hooks follows the same shape in its own card. `design/screens/CheckHooks*.png`, `Setup*.png` and `RoomSetupWarnings.png` draw them, and `docs/decisions/KERNEL-437.md` lists the copy.
- Toasts: bottom right, 360px wide, with no close button. The title and sub share one line where they fit. A toast leaves by itself after 2.6s, or sooner when you swipe it right (toast-motion-and-swipe). A toast is for something you can't see on screen: (1) a call that failed ("Could not ..."), (2) something Kernel or an agent did without your click, like a PR created or merged, an archive after a merge, a config mistake or the window reloading after a crash, (3) an action that changes nothing on screen, like Path copied, Branch copied, Logs exported or the Check for updates result. A click whose result you can see gets no toast: the archived row is gone, the restored workspace opens (KERNEL-495).
- Icon buttons: hover brightens the icon to `--ink` with no fill behind it, because a fill around a small glyph reads louder than the glyph. A fill means the button is on or its menu is open (`aria-pressed`, `aria-expanded`), never hover. Buttons with a label, menu items, rows, and the filled send and stop circles keep their hover fills.
- Tooltips: an icon button's `aria-label` is its tooltip, so give every icon button one and no `title`. Other elements opt in with `data-tip`, `data-tip-kbd` adds the shortcut, and `data-tip=""` opts out.
- Danger: red only on the final confirm button, never on the trigger.
- Merged is the only purple: the PR link, the Merged label, the merged PR band, the merged History row.
- PR header (KERNEL-274, KERNEL-528): the top of the right panel is one block in the PR's tone: grey (neutral states), green (open, ready, merging), red (checks failed, changes requested, conflicts, resolving), violet (merged). Its first row, 44px and in line with the chat header, holds the state's icon and label with the `#N | ↗` link pill at the right. Its second row holds the actions at full width and ends where the chat's tab row does, so the block's bottom line meets the line under the chat tabs. No line splits the rows. Every action leads with its icon. Soft buttons use the band's soft fill and edge, Create PR on the neutral band included, with its menu arrow a small square of its own. Merge PR and a merged PR's Archive take the solid; a closed PR's Archive is soft. Continue's border is solid. With the right panel hidden, the capsule in the chat header reads state, link, actions, with the same icons and soft rule. The label always shows the state, never a spinner. With the right panel hidden, the header sits in the chat with no band, in neutral colors except merged. `design/redesign/Pr*.png` draws every state.
- Local merge (KERNEL-441): a repo with no GitHub remote has no PR, and the same band reads its merge. A plain `→ main` pill takes the link pill's place, and a merge line under the band says "3 ahead of main · 0 behind" and the merge method. Ready is green with Merge, behind main is grey with Update branch, conflicts and a refused merge are red, merging is the busy button and merged is violet. Behind, conflicts and refused each add one note card under the merge line, with the files listed where they matter. `design/redesign/PrLocal*.png` draws every state, and Room setup's Code host row is in `design/screens/RoomSetupGitHub.png` and `RoomSetupLocal.png`.
- Composer (KERNEL-322): one composer everywhere, drawn in `design/redesign/Composer.png`. The box sits recessed on `input-bg`, the agent's name and role sit in a pill with no divider, and send and stop are circles. The permission mode is a dropdown after the model button (KERNEL-435, KERNEL-573, `design/screens/ComposerModes.png`). The composers drawn on other screens predate it and don't show it.
- Permission modes (KERNEL-435): Manual, Accept edits, Auto and Bypass permissions, always in that order. Plan joins them in the composer only. Settings, Permissions and the onboarding step list them as radio rows in one card, like Big terminal's presets: a filled ring with a check marks the pick, the title is 13.5px, and what the mode does sits below it in muted text. Bypass permissions says what it skips (every prompt, Always ask included) and what still stops it. In Settings an Only in worktrees switch row sits under it, indented to the titles.
  - A mode an agent's provider can't run keeps its row, dimmed, with an info line under it: "Auto isn't available for Codex agents yet." The chat uses Accept edits instead.
  - The onboarding step shows Bypass with a bordered caution block, never a red one.
  - A room's mode is a select with "Use app default" above the four modes. Its saved tools sit in a list under its commands, in the same hairline rows with a bordered Remove.
  - In the composer the mode is a ghost dropdown after the model button (KERNEL-573), the same button: a 14px muted icon, the mode's name in `ink-2` and a chevron, with the open fill while its menu is open. `plan` blue for Plan, icon, name and chevron. No mode gets a pill, Bypass included. It opens the mode menu above it, 360px wide and lined up with the icon, and so does Permission mode in the + menu (`ComposerModeMenu`).
  - A chat can pick a mode it can't run, like Bypass permissions on a current-branch chat with Only in worktrees on. The label shows the mode it runs in, Accept edits. The menu keeps the check on the picked mode and says what it runs as in that row's description, in `ink-3`: "Runs as Accept edits, Only in worktrees is on".
  - Shift+Tab cycles Manual, Accept edits, Plan, Auto, Bypass and skips a mode the chat's agent can't run.
  - The first switch into Bypass opens `ConfirmBypass` once, with its confirm in danger red.
  - An approval card says why it asked on one line under the command, with an info icon and `ink-3` text.
  - The PNGs: `SettingsPermissions`, `SettingsRoomPermissions`, `SettingsRoomPermissionsMode`, `ComposerModes`, `ComposerModeMenu`, `SetupPermissions`, `SetupPermissionsNoAuto`, `WorkspacePermReason`, `WorkspacePermReasonCodex`, `ConfirmBypass`.
- Resize edges (KERNEL-419): hovering, keyboard focus or dragging the sidebar, Settings nav or right panel edge lights the content panel's border with a glow, `--ink` at 45% fading to transparent, about 2px at the middle of the edge and thinning toward the top and bottom. It stays at the middle and does not follow the cursor. The handle between the right panel's top and bottom panes (KERNEL-512) lights the hairline between them the same way, turned horizontal (`design/redesign/PanelResize.png`).
- Script output (KERNEL-656): the Setup and Run tabs show a script's output in a read-only terminal view, with the Terminal tab's font, size, line height and palette. Tool colors are allowed inside script output only. The app chrome around it stays monochrome.
- Collapsed bottom pane (KERNEL-529): folded to its tab bar, the right panel's bottom says what the scripts are doing in faint 12px before Run or Stop: Setting up, Setup failed, Running (Running web, api when the room has several run scripts), No run script, or Idle, port N (`PanelCollapsedRunning`).
- Issue trackers (KERNEL-438): a room has one tracker, Linear, GitHub Issues or None, picked from a menu on Settings, a room, General. A fourth item such as Jira is one more menu item. Issues lists one room's tracker: the room is a menu after the page title and the source sits at the right. GitHub's rows are Linear's with `#number`, label pills and an assignee avatar, under one group named Open. A room with no tracker says so and offers Choose a tracker, never a Connect Linear page. The notice that someone else is on an issue is a confirm that names what was found, with Start anyway in the primary style and not danger (`design/screens/ConfirmIssueTaken.png`).
- Reviews (KERNEL-551): a room's reviews (Code, Security, UX) are rows on Settings, a room, Reviews. A row has the review's name and what it checks, a Required or Optional segment and its switch, then the files that trigger it, who runs it (Kernel or one of the room's agents) and its model. The page is shared with the team, so its file button opens `settings.toml` first and a note says a change reaches everyone on the repo. Settings, Pull requests opens with Merge automatically, drawn off, a pill saying "Only on this Mac" beside its heading and a sentence under the card. Its size limit and paths stay in place in muted text until the switch is on, and the built-in always-review paths are pills that can't be edited. In a Team update, a merge Kernel made reads "Merged automatically" in the merged violet with why it was allowed and a link to the PR, a pull request still blocked reads "Still blocked after 2 review rounds" in red with what is open listed under it, and a review left out to save usage reads in muted text. `design/screens/SettingsRoomReviews.png`, `SettingsPRs.png`, `design/redesign/TeamUpdateReview.png`, and `docs/decisions/KERNEL-551.md`.
- Plan mode (KERNEL-274): the composer gets a `plan` border and a soft glow rising from its bottom edge, and the caret and a ready send button turn `plan`. No hatch, no stripes, no label. A waiting plan keeps the blue and puts Copy and Approve in a blue strip on top; send stays ink there so Approve is the one blue button. The glow moves slowly (see Motion).
- Agent capabilities (KERNEL-440): a line under an agent on Team, in the room-setup team card and in the profile says what Kernel noticed. A server the agent's file lists but the agent can't reach gets a warning triangle in ink and one step: "Linear isn't signed in. Sign in", "There's no Figma server in this room. Add server", "Neon didn't connect after 3 tries. Try again", "Playwright is switched off in this room. Turn on". A warning is one line that never wraps, and several stack. A file Kernel can't read is not an agent, so it goes in a "Can't read" section under the table with a red x-circle (the icon only, never a red background), the path, the parse error in mono and Open file. A warning's action is its own button, so a Team row is a list item with a stretched link, not one big button. The profile lists the same servers in a Servers box: the name, where it comes from (In its file, or an allowance), how it is doing (Connected in muted, a problem in ink with the warning triangle) and the one step. `TeamWarnings`, `AgentProfileServers`.
- Personal and allowed (KERNEL-440): an agent from `~/.claude/agents` has a Personal pill after its role, like Built in and Helper. Its File column shows the path and its profile says "All rooms". What Kernel adds on top of an agent's file is muted, with a plus-circle: "Linear allowed in this room by you" and Remove, on Team and in the profile's Servers box. Team says under the table that the files stay as they are. `TeamPersonal`.
- Tools gate card (KERNEL-440): the permission request's card with "Lumi wants to use Linear", one line on why it asks, the tool and its arguments in the code block, then Keep blocked, Allow Linear for Lumi in this room and Allow once (ink). A muted note under the buttons says Keep blocked sends Lumi on without Linear, and that only you can change the agent file. After a choice the card becomes one note, as the permission request does: "Allowed once.", "Allowed Linear for Lumi in Client A." or "Kept Linear blocked." `WorkspaceToolsGate`.
- For me or for the team (KERNEL-440): hire, edit and retire ask with the same two radio rows under a muted question, Just for me and For the team, each saying what it does in a line or two. It starts on Just for me, because For the team opens a pull request. The confirm button names the result: Create agent, Save for me, Retire Kai, or Open pull request once the team is picked. A Personal agent has no team row, because its file isn't in the repo. `WorkspaceHireServers`, `NewAgentDraftScope`, `AgentProfileScope`, `ConfirmRetireScope`.
- Servers row (KERNEL-440): the hire card and the New agent review list the servers the new agent's file names, one pill each. A server that works shows its name. One that doesn't shows the warning triangle in ink and the problem. A sentence under the row says what that means for Rowan's hand-offs.
- Roster picker and rule conflicts (KERNEL-440): with more than about 12 agents, room setup asks who joins. The card has a search box, checkbox rows (name, role, tags, one description line, any warning) and "8 of 23 picked" with Clear and Pick the suggested 8. Kernel suggests the agents that can open pull requests. One written as a subagent with no pull request workflow starts unpicked as a Helper, with its warning. The list scrolls inside the card, so a half row shows at the bottom. The conflicts card lists each rule in CLAUDE.md or AGENTS.md that fights Kernel's workflow, with its file and line, next to what Kernel tells agents. Kernel never edits those files. Setup is taller than the window with these cards, so `RoomSetupRoster` and `RoomSetupConflicts` are drawn scrolled to the end.

## Footer (KERNEL-588)

- A 32px strip under the main panel on every screen but Settings and onboarding. It amends KERNEL-527, which had removed it.
- Left: Hooks down and GitHub paused, only while they hold.
- Right: the Update ready pill once an update is ready, then Ask Rowan with its send icon and label. Ask Rowan's popover opens up from it, at the right. Nothing moves when the sidebar or the right panel hides.
- The sidebar's bottom row is the plan chip, What's new and Settings. With the sidebar hidden, the header starts with Show sidebar alone.
- Ask Rowan history (KERNEL-589): a clock icon after Ask Rowan, at the footer's far right, opens the questions asked from Ask Rowan, newest first, in Ask Rowan's popover shell. Each row is the question on one line in ink, then the room and when in muted 12px (the time today, Yesterday, the weekday, then the date). Picking one opens its Lead chat. With none yet, the popover says so in one muted line.

## Busy buttons

A button that waits on the main process shows it is working until the call returns. That means git, GitHub, the network, files, agent sessions, scripts and opening Terminal.

- A spinner takes the icon's place and the label says what is happening: "Archiving", "Merging", "Creating". One or two plain words, no trailing dots, the way the canvas writes "Creating PR".
- The button is disabled while the call runs, so a second click, Enter or a shortcut can't start the work twice. Buttons next to it that act on the same thing (Deny beside Approve, Cancel beside Send) are disabled too.
- Every variant takes the canvas's Creating PR look at full opacity: surface-3 fill, line-3 border, ink-3 text. A busy primary or danger button turns grey. The PR header band is the exception: there a busy button keeps the band's tone, with its soft fill and edge, dimmer text and a spinner in the band's text color, so it never reads as a hole in the band (KERNEL-274).
- In code, `useBusy()` tracks which button started the work, and `Button` and `IconButton` take `busy` and `busyLabel`. `ConfirmDialog` passes the same two to its confirm button and takes `disabled` for "can't confirm yet". The sidebar's archive button is the one exception. It stays a plain icon with no spinner or word, and still ignores a second click.
- No spinner for navigation, menus, opening a dialog, toggles and selects that save in place, links that open the browser or the editor, copying, or sending a chat message, which shows up in the thread.

## Motion

- Plan mode (KERNEL-322): the glow rises and fades over 1s each way (KERNEL-418), and breathes every 8s while the box waits for input. Focus settles it over 1s. A plan's strip opens over 1.2s, then one light crosses it over 2.6s. Send changes color in 0.16s. `design/redesign/canvas/PlanMotion.dc.html` plays it.
- Resize edge glow (KERNEL-419): fades in over 200ms ease-out after an 80ms delay and out over 120ms, growing from the middle. Reduced motion turns it on and off with no transition.
- Toasts (toast-motion-and-swipe): a new toast's gap opens over 0.16s, then the toast slides in from past the right edge over 0.34s. It leaves the same way: it slides out over 0.2s, then its gap closes over 0.16s. A drag or a two-finger swipe moves it with your finger. Past 60px, or after a flick, it slides on out. Short of that it springs back.
- Archive (KERNEL-579): archiving a chat or workspace is one short beat, played for the three cases in `design/redesign/canvas/ArchiveMotion.dc.html`. Every curve is `ease-out`.
  - Order. The row folds and fades from the frame the main panel swaps. It starts when Kernel marks the archive done, after any confirm, never before. A failed archive moves nothing and shows its "Could not archive" toast.
  - The row. Opacity goes 1 to 0 over 120ms while the row's height and the 3px gap under it close to 0 over 200ms. The row keeps its size and is clipped, never squeezed. Rows below slide up with the closing height and have no motion of their own, so the open chat's row rides up with them. A chat's nested workspace rows fold with it in the same frames, with no stagger. A folding row can't be clicked, and it leaves the list when the fold ends.
  - The screen (KERNEL-636). When the archived chat or workspace was on screen, the main panel swaps to the destination at once, in one frame, with no fade and no copy of the old screen. The destination is live from the first frame and takes focus and keys at once.
  - Where it goes (KERNEL-596). One destination for every archive of the chat or workspace on screen: the room's front door, which is New chat with Rowan, or Team when the room has no Lead. It is the same for a chat, a workspace it started, a review and a workspace Kernel archives after its PR merged, and whatever else is open in the room. No chat row is picked, the app never goes to History, and the route moves once, in the step the archived status is stored, so no frame shows the workspace without its tabs. Kernel archiving after a merge keeps its toast. An archive by hand has none.
  - Selected fill. When the destination has a row in the sidebar, its fill goes from none to `surface-3` and its text from `ink-2` to `ink` over 120ms, as the archived row fades out. That is Rowan's Lead row, which stands in for New chat with Rowan while the room has no open chat. In a room with open chats, no row stands for New chat, so no fill changes. This is the only selection change that fades. Other clicks still switch it at once.
  - The last chat in a room. Rowan's Lead row opens in the chat row's place: height 0 to full over 200ms and opacity 0 to 1 over 120ms, as the chat row folds. The two heights add up to one row all the way through, so the rows below stay put. A room with no Lead has no row to open, and the rows below slide up.
  - Not on screen. When the archived chat or workspace wasn't on screen, only its row folds. The screen doesn't move, and there is no toast (KERNEL-495).
  - Any archive. The same beat plays however the archive starts: the row's Archive button, a PR's Archive, closing a chat's last tab, or Kernel archiving after a merge.
  - Overlap. Archiving again while a fold runs starts that row's fold at once. The destination row's fill fade that starts over another one jumps the earlier one to its end.
  - Reduced motion. No fold and no fade. In one frame the row leaves, the Lead row appears and the selected fill changes. The screen swaps at once either way.
- Only opacity and transform loop, and nothing on a button loops.
- Modals (KERNEL-648): every modal opens with the scrim fading in over 160ms `ease-out` while the dialog fades in, rises from 8px below and scales from 0.98 over 200ms, `cubic-bezier(0.22, 1, 0.36, 1)`. Escape, the scrim, Close and Cancel play an exit: the dialog fades and drops 4px over 120ms, `cubic-bezier(0.4, 0, 1, 1)`, and the scrim fades over the same 120ms. Neither takes input during the exit, and the modal leaves when it ends. A close after an action that changes the screen leaves at once. Reduced motion turns it on and off in place.
- Respect reduced motion: jump instead of walk, no spinners rotating, no breathing glow, toasts that appear and vanish in place, archived rows that change in place.

## Accessibility

Real `<button>`, `<a>`, `<input>` with labels; focus rings visible; every icon-only control has `aria-label`.

- Text contrast is 4.5:1 for every text tier and status color on every surface (see Text ladder). Faint is for icons, disabled controls and decoration, at 3:1 (WCAG 1.4.11). It never carries body text.
- Input borders use `--input-line`, which reaches 3:1 on every surface an input sits on (WCAG 1.4.11). Dividers, cards and chips keep their hairlines (`--line`, `--line-2`, `--line-3`). The focus ring (`--focus`) reaches 3:1 on every surface.
- Unread is bold plus a step up the ladder, never color alone.
- Increase contrast: `@media (prefers-contrast: more)` in `tokens.css` follows macOS. Each text tier takes the value of the tier above it, ink goes to full black or white, dividers reach 2:1 and every other line 3:1 (line-4 and the input border 4.5:1), and the focus ring is near solid.
- `test/theme.test.ts` checks every pair above in both themes and in the Increase contrast block.
