# Settings redesign (KERNEL-680)

The settings canvas from October 2026: every Settings page and every room page, in dark and light. Each `<Board>.png` is a render of
`canvas/<Board>.dc.html`. For Settings, these PNGs replace the `design/screens/Settings*.png` PNGs as the spec. Where a page and its PNG in
`design/screens` disagree, this folder wins.

Live canvas: https://claude.ai/artifact/KTx55KXMrZfpZWuKNSyNg2 (pages "Calm redesign" and "All settings redesign").

To redraw the PNGs after editing a board, run `node design/settings-redesign/render.mjs [Board ...]`. It fills each board from its default
props, expands the page components the boards import, and screenshots it with Playwright's Chromium. Set `CHROME` to the browser binary
when Playwright's own isn't installed (`/opt/pw-browsers/chromium` in a cloud session). The "First pass" page is superseded and has no PNG.

## Boards

- Personal: `AllGeneral`, `AllAppearance`, `AllNotifications`, `AllAccounts`, `AllShortcuts`. Accounts in detail: `Calm` and its states
  `CalmHover`, `CalmExpanded`, `CalmMenu`, `CalmOnHold`, `CalmSignedOut`, `CalmUnavailable`, `CalmNarrow`, `CalmLight`.
- Agents: `AllModels`, `AllAgents`, `AllMcp`, `AllPermissions`, `AllEnvironment`.
- Workspaces: `WsGit`, `WsPrs`, `WsTerminal`.
- System: `SysIntegrations`, `SysHooks`, `SysPrivacy`, `SysAbout`.
- Rooms: `RoomGeneral`, `RoomGit`, `RoomSetup`, `RoomEnv`, `RoomAgents`, `RoomPrs`, `RoomPerms`, `RoomSkills`.
- Every board has a `Light` twin.

## Rules the boards follow

- No text under a page title. A room page's title is a breadcrumb, the room's name then the page, and the name goes back to the room's
  General page.
- A section can carry a count, a scope badge ("Shared with the repo" for `.kernel/settings.toml`, "This Mac only" for everything else) and a
  line under its card. Long or rarely used sections fold.
- One choice of two is a switch, of two or three a segmented control with equal widths, of four or more a dropdown. Every dropdown is
  `Select` from `ui`. Lists are tags or tables, never text boxes.
- A row that only matters because of the one above it hangs off a guide line.
- Row actions that aren't the main one show on hover and on keyboard focus.
- Every setting lives on one page. A pointer to another page is a link.

## Sample data

Names, numbers, paths and usage in the boards are sample data. The pages show real values, and leave out a row when the data for it
doesn't exist.
