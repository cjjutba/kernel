**A room is called a project everywhere.** "Room" came from the floor, where agents sat in rooms. KERNEL-606 removed the floor, and the word started to read like a chat room. A project is one repo with a team, a Lead chat and workspaces. Code, IPC channels, the database, agent-facing text, UI copy and docs all say project. On the Issues screen a Linear project is always called "Linear project", so the two never share a label. KERNEL-880.

**Strings already on disk keep their old values.** Renaming them would lose what users saved, or break their counts. The constants that hold them take the new name, and a comment at each says why. They are:

- localStorage `kernel.lastRoom` (the last project opened), `kernel.roomsExpanded` (sidebar expanded or collapsed per project), `kernel.roomsTab` (the Projects page's tab) and `kernel.prsRoom` (the project picked on Pull requests).
- `room-icons`, the folder of project icons in Kernel's data folder, and its entry in the list a dev run copies.
- `rooms`, the key in `env.json` that holds each project's variables.
- `room.created`, the telemetry event for a new project, so its counts carry on.

`trust.json` and `agent-overrides.json` are keyed by project id with no room in a key, so they need nothing. Values saved under a room name that the app reads by its new name are read across instead: settings.json's `workspace.oneCurrentBranchPerRoom` loads as `oneCurrentBranchPerProject` and is saved under that name next time, and a `kernel.lastPlace` route saved with `rooms` or `roomId` opens as `projects` and `projectId`.

**Migration 8 renames the database.** Table `rooms` is `projects`, `room_id` is `project_id` in every table that had it, the four indexes named after rooms are dropped and made again under project names, `roomId` in each row's data is `projectId`, the `room.paused` and `room.resumed` activity kinds are `project.paused` and `project.resumed`, and `roomId` at any depth in a meta row (leadUpdates' pending entries hold one) is `projectId`. Activity text that names a file such as Room.tsx stays as it was.

**`set_room_scripts` stays callable by its old name until the release after next.** The tool is `set_project_scripts`. A resumed Codex thread keeps the tools it started with, so a Lead thread from before the rename still calls `kernel_set_room_scripts`. It reaches the same handler the way `hire_agent` reaches `create_agent` (KERNEL-554), and no tool list shows it. Claude sessions get the tool list again on every turn, so they need no alias. Remove the entry from `RENAMED` in `services/providers/codex/tools.ts` in the release after next. KERNEL-880.
