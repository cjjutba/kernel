import type { ReviewVerdict } from './chats'
import type { PrBlocked } from './pullRequests'

export type WorkspaceMode = 'worktree' | 'current'
/** `trust`: the room's scripts or files.copy list changed, or were never trusted, so the workspace waits for `rooms.trust` (KERNEL-209). */
export type WorkspaceStatus = 'setup' | 'trust' | 'ready' | 'failed' | 'archived'
/**
 * The PR header state. `creating`, `resolving` and `merging` are Kernel's own while the agent or gh works;
 * the rest come from GitHub's read of the PR (github.ts prStateOf).
 */
export type PrState =
  | 'none' | 'creating' | 'draft' | 'open' | 'checks' | 'cifail' | 'changes' | 'conflict' | 'resolving'
  | 'ready' | 'merging' | 'merged' | 'closed'

/** Where a workspace started from (NewWorkspaceFrom.png). */
export type WorkspaceSource =
  | { kind: 'pr'; number: number; title: string }
  | { kind: 'branch'; branch: string }
  | { kind: 'issue'; id: string; title: string; url?: string }

export interface DiffStat {
  files: number
  added: number
  removed: number
}

export interface Workspace {
  id: string
  roomId: string
  name: string
  /** The task title it was created from. */
  title?: string
  branch: string
  baseRef: string
  /** Set when fetching origin failed as the workspace started: git's reason and how old `baseRef` is, as a sentence. */
  fetchFailed?: string
  path: string
  mode: WorkspaceMode
  agentId: string
  /** The Lead's own workspace, the one its chats live in (KERNEL-353). Read it through `isLeadWorkspace`. */
  lead?: true
  port: number
  status: WorkspaceStatus
  /** For current-branch workspaces: the commit that captures pre-existing changes. */
  baselineRef?: string
  source?: WorkspaceSource
  /** Board task this workspace builds, for example "T-14". */
  taskId?: string
  /** The Lead chat that handed this workspace off. Kernel's teammate updates about it go there (D-101). */
  leadChatId?: string
  /** The Lead chat that `leadChatId` belongs to, kept so the workspace stays with it after that tab closes (KERNEL-337). */
  threadId?: string
  /** On a review workspace: the workspace whose work it reviews. */
  reviewOf?: string
  /** Reviewers' verdicts on this workspace's PR, one per review workspace. */
  reviews?: ReviewVerdict[]
  /** The PR's head commit as GitHub last reported it. */
  prHead?: string
  prNumber?: number
  prUrl?: string
  prTitle?: string
  prState: PrState
  /** A ready PR GitHub won't merge yet, and why. The header reads Open and Merge PR says why (KERNEL-388). */
  prBlocked?: PrBlocked
  /** Totals for the sidebar and Home (+412 -38). Refreshed after each turn. */
  stat?: DiffStat
  createdAt: number
  mergedAt?: number
  archivedAt?: number
  /** The workspaces whose PRs must merge before this one goes on (KERNEL-259). */
  waitsFor?: WaitsFor
}

/**
 * A workspace waiting for other workspaces' PRs to merge (KERNEL-259). `on` lists their ids. `held` means the brief hasn't
 * gone out. `base` is HEAD when the brief was held. `releasing` means they merged and the teammate, which had already
 * started, hasn't taken Kernel's message yet.
 */
export interface WaitsFor {
  on: string[]
  held: boolean
  base?: string
  releasing?: boolean
}

/** Git facts the archive and discard confirmations show (ConfirmArchive.png, ConfirmDiscard.png). */
export interface WorkspaceGitStatus {
  branch: string
  /** Commits not on the remote yet. */
  ahead: number
  behind: number
  /** Uncommitted changes. */
  dirty: DiffStat
}

/** A workspace Delete leaves alone, with the reason in plain words (KERNEL-333). */
export interface DeleteSkip { id: string; name: string; reason: string }

/** What Delete in History would do, before it does it (KERNEL-333). */
export interface DeletePreview {
  /** How many workspaces would go. */
  workspaces: number
  skipped: DeleteSkip[]
  /** Branches that hold commits pushed nowhere. They stay unless the box is ticked. */
  unpushedBranches: number
  /** Claude Code transcripts that would be deleted, in bytes. */
  transcriptBytes: number
}

/** What Delete in History did (KERNEL-333). */
export interface DeleteResult {
  deleted: string[]
  skipped: DeleteSkip[]
  /** Branches kept because their commits are pushed nowhere. A branch kept because another workspace uses it isn't counted. */
  keptBranches: number
  freedBytes: number
}

export interface ChangedFile {
  path: string
  status: 'A' | 'M' | 'D' | 'R' | '?'
  added: number
  removed: number
}

/** One row of the All files tree (Workspace.png, right panel). */
export interface FileEntry {
  path: string
  dir: boolean
  /** Change status when the file differs from the base. */
  status?: ChangedFile['status']
}

/**
 * One hunk of a file that has both the user's earlier edits and the agent's (WorkspaceHunks.png).
 * `mine` hunks predate the workspace (the current-branch baseline) and stay uncommitted unless picked.
 */
export interface Hunk {
  id: string
  path: string
  lines: string
  added: number
  removed: number
  owner: 'agent' | 'mine'
  patch: string
}

/** A snapshot of the worktree after an agent turn (WorkspaceCheckpoints.png). */
export interface Checkpoint {
  id: string
  workspaceId: string
  chatId: string
  ts: number
  /** First line of the turn, for example "Added the empty and error states". */
  title: string
  stat: DiffStat
  /** Git ref holding the snapshot. */
  ref: string
  /** The checkpoint the worktree is at now: the newest one, or the one last reverted to. */
  current: boolean
  /** Taken before the first turn, so reverting to it undoes all of the agent's work ("start of chat"). */
  start?: boolean
}

export type ScriptKind = 'setup' | 'run' | 'archive'

/**
 * A room's scripts and files.copy list as Kernel would run them, after merging settings.toml and settings.local.toml,
 * waiting for the user to trust that exact text (KERNEL-209).
 */
export interface ScriptTrust {
  roomId: string
  /** What `rooms.trust` takes back. Text that changes after the user read it gets a new hash and asks again. */
  hash: string
  scripts: { setup?: string; run?: string; archive?: string }
  /** Named run scripts from `[run_scripts]` other than `run`, which is `scripts.run` (KERNEL-244). Left out when there are none. */
  runScripts?: { name: string; command: string }[]
  copy: string[]
  /**
   * The repo's `[env] files` list. A file can set ZDOTDIR or BASH_ENV, which makes a shell run repo code, so the list waits
   * for trust like a script (KERNEL-247). Left out when the repo sets none.
   */
  envFiles?: string[]
  /** Open workspaces held in `trust` until the room is trusted. */
  workspaceIds: string[]
}

/** Each workspace gets this many ports, `$KERNEL_PORT` to `$KERNEL_PORT + 9` (KERNEL-244). */
export const PORT_BLOCK = 10

/** A run script's name: a letter or digit, then up to 31 letters, digits, `-` or `_`. `run` is `[scripts] run` (KERNEL-244). */
export const RUN_SCRIPT_NAME = /^[a-z0-9][\w-]{0,31}$/i

/** Whether a run script's name is the reserved `run`, in any case, so `RUN` and `Run` aren't a second script. */
export const isRunName = (name: string) => name.toLowerCase() === 'run'

export interface ScriptLine {
  kind: ScriptKind
  /** Which run script printed the line (`run` is the default one). Setup and archive lines have none. */
  name?: string
  line: string
  stream: 'stdout' | 'stderr'
}
