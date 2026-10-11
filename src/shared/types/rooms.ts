import type { AgentDraft } from './agents'
import type { PermissionMode } from './settings'

export type RoomKind = 'repo' | 'folder' | 'scratch'

export interface Room {
  id: string
  name: string
  /** One line under the name on Rooms and Home, for example "Invoicing SaaS · MVP Sprint". */
  desc?: string
  kind?: RoomKind
  /** Absolute path of the main checkout. */
  path: string
  /** owner/repo when the folder has a GitHub remote. */
  repo?: string
  defaultBranch: string
  paused: boolean
  /** Who paused it. A limit pause lifts itself when the limit resets (FloorLimit.png). */
  pausedBy?: 'you' | 'limit'
  /** Agent ids in desk order. Agents past the last desk sit in the overflow strip (FloorFull.png). */
  desks?: string[]
  /** Hidden from the sidebar, still listed on Rooms. */
  hidden?: boolean
  /** Archived from Settings > Room. Agents stop, workspaces archive, the room moves to Rooms > Archived. */
  archived?: boolean
  /** Bash rules the user chose "Always allow in this room" for. An exact command, or `prefix:*`. They beat Always ask. */
  allow?: string[]
  /**
   * The same for tools other than Bash, as Claude Code writes a rule: `mcp__linear__get_issue`, `WebFetch(domain:example.com)`
   * (KERNEL-432).
   */
  allowTools?: string[]
  /** The room's permission mode, over the app's. A chat's own mode wins over it (KERNEL-432). */
  permissionMode?: PermissionMode
  /** Where the room's pull requests merge: on GitHub through gh, or locally with git (KERNEL-432). */
  host?: 'github' | 'local'
  /**
   * The room's picture: the GitHub owner's avatar or a picked PNG or JPEG, saved as `file` in the data folder's room-icons.
   * No icon means the letter. The image itself comes from `rooms.icon`, so room pushes stay small (KERNEL-241).
   */
  icon?: { kind: 'github' | 'image'; file: string; at: number }
  /**
   * The folder under the worktree root that the room's new worktrees go in: the room's id, so two rooms with the same name
   * never share one. A room made before KERNEL-231 has none and keeps the slug of its name.
   */
  worktreeDir?: string
  createdAt: number
}

/** New room modal (NewRoom.png). */
export interface NewRoomRequest {
  source: RoomKind
  name: string
  desc?: string
  /** owner/repo for a repo, an absolute path for a folder, a template repo for scratch. */
  from: string
  baseBranch?: string
  /** Starter agent ids to seat when the repo has no agents. Kernel's own Rowan and Theo lead and review (KERNEL-397). */
  team: string[]
  /** Brief the Lead as soon as setup finishes. */
  autostart: boolean
  /** Repo and scratch rooms: the folder to create the checkout in. Defaults to ~/Projects/<name>. */
  cloneTo?: string
  /** Folder rooms: the folder is not a git repository, so run `git init` and make a first commit. */
  initGit?: boolean
}

/** Values New room opens with. Fixtures use it to show the filled form. */
export interface NewRoomPrefill {
  source: RoomKind
  name: string
  desc?: string
  /** owner/repo, a folder path or a template repo, by `source`. */
  from: string
  baseBranch?: string
}

/** Values New agent opens with. Fixtures use it to show the filled form, the drafted file and the joined step. */
export interface NewAgentPrefill {
  name?: string
  description?: string
  /** An alias: sonnet, opus or haiku. */
  model?: string
  /** The drafted file. Shown by the review and joined steps. */
  draft?: AgentDraft
}

/** One line of the room setup progress (RoomSetup.png). */
export interface RoomSetupStep {
  /** `push` is there only when the room has a remote (KERNEL-460). */
  id: 'clone' | 'worktrees' | 'install' | 'copy' | 'hooks' | 'push' | 'agents'
  title: string
  detail: string
  /** `warn` finished with something to fix that doesn't block the room (RoomSetupWarnings.png, KERNEL-437). */
  state: 'wait' | 'run' | 'ok' | 'warn' | 'fail'
  /** Duration or "running". */
  meta?: string
  error?: string
  /** A tool's own error, shown in a box under the detail. */
  output?: string
  /** A warning's one fix: a command to copy, and `recheck` for a Check again button. */
  fix?: { command?: string; action?: 'recheck' }
  /** On the agents step: how many agent files the repo already had, so Room setup shows the team for review (KERNEL-397). */
  brought?: number
}

/**
 * One row of a room's push check (SettingsRoomGit*.png). `unchecked` is a row that couldn't be asked, like Permission to
 * push while the remote is out of reach.
 */
export interface PushCheckRow {
  state: 'ok' | 'fail' | 'unchecked'
  /** Under the label: what was asked, or why it failed. */
  detail: string
  /** git's own error, shown in a box. */
  output?: string
  /** A line under the box, like "Check your connection or VPN, then check again." */
  note?: string
  /** The one command that fixes it, to copy. */
  fix?: string
}

/**
 * Whether git can push from a room's checkout (KERNEL-460). `reach` is `git ls-remote <remote>`. `push` is gh's permission
 * on the repo and a dry-run push with git's own login.
 */
export interface PushCheck {
  remote: string
  /** owner/name, when the remote is on GitHub. */
  repo?: string
  /** Who gh is signed in as, when the remote is on GitHub and gh has a login. */
  login?: string
  reach: PushCheckRow
  push: PushCheckRow
  /** When it ran, epoch ms. */
  at: number
}

/** A repo on the user's GitHub account (ConnectRepo.png). */
export interface RepoSummary {
  fullName: string
  name: string
  private: boolean
  updatedAt: number
}

/** A local folder that could become a room (OpenFolder.png). */
export interface FolderInfo {
  path: string
  git: boolean
  branch?: string
  /** Uncommitted changes in the checkout. */
  dirty?: number
}

/** Two agents editing the same file in different worktrees (FloorOverlap.png). */
export interface Overlap {
  id: string
  roomId: string
  path: string
  parties: { agentId: string; workspaceId: string; lines: string }[]
  ts: number
  resolved?: boolean
}
