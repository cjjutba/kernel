import type { AgentDraft } from './agents'

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
   * The room's picture: the GitHub owner's avatar or a picked PNG or JPEG, saved as `file` in the data folder's room-icons.
   * No icon means the letter. The image itself comes from `rooms.icon`, so room pushes stay small (KERNEL-241).
   */
  icon?: { kind: 'github' | 'image'; file: string; at: number }
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
  id: 'clone' | 'worktrees' | 'install' | 'copy' | 'hooks' | 'agents'
  title: string
  detail: string
  state: 'wait' | 'run' | 'ok' | 'fail'
  /** Duration or "running". */
  meta?: string
  error?: string
  /** On the agents step: how many agent files the repo already had, so Room setup shows the team for review (KERNEL-397). */
  brought?: number
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
