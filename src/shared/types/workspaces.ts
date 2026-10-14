import type { ReviewVerdict } from './chats'
import type { PrBlocked } from './pullRequests'
import type { MergeMethod, ReviewKind } from './settings'
import type { TrackerKind } from './trackers'

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

/**
 * Where a workspace started from (NewWorkspaceFrom.png). An issue's `tracker` is the one it came from (KERNEL-432). A source
 * saved before has none, and its id tells: `#41` is a GitHub issue, anything else Linear.
 */
export type WorkspaceSource =
  | { kind: 'pr'; number: number; title: string }
  | { kind: 'branch'; branch: string }
  | { kind: 'issue'; id: string; title: string; url?: string; tracker?: TrackerKind }

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
  /**
   * One of the Lead's own workspaces (KERNEL-353). Since KERNEL-405 each Lead chat has one, with the chat in `threadId`.
   * One with no `threadId` is the shared workspace every chat lived in before. Read it through `isLeadChatWorkspace`.
   */
  lead?: true
  port: number
  status: WorkspaceStatus
  /** For current-branch workspaces: the commit that captures pre-existing changes. */
  baselineRef?: string
  source?: WorkspaceSource
  /** The task this workspace builds, for example "T-14". */
  taskId?: string
  /** The Lead chat that handed this workspace off. Kernel's teammate updates about it go there (D-101). */
  leadChatId?: string
  /** The user's words that approved the hand-off with plan mode off, quoted from their message by the Lead (KERNEL-678). */
  goAhead?: string
  /**
   * The Lead chat this workspace belongs to: the one that handed it off, kept after that tab closes (KERNEL-337), or, on a
   * `lead` workspace, the chat it hosts (KERNEL-405).
   */
  threadId?: string
  /**
   * What of a new Lead chat's worktree still takes its name from the chat's first title, once (KERNEL-424): `branch` until
   * that title arrives and names the branch, then `folder` until the folder moves to match, which waits for the chat to be idle.
   * Unset once both are named, and on chats from before, which keep their branch and folder.
   */
  naming?: 'branch' | 'folder'
  /**
   * A new Lead chat whose worktree Kernel hasn't made yet (KERNEL-542). `lead.start` answers once the records exist, with
   * `branch` and `path` picked, and Kernel fetches and makes the worktree after. Nothing reads `path` meanwhile. The branch,
   * folder and `baseRef` can still change: a name someone took meanwhile gets a suffix, and the base is read again after the
   * fetch. `error` is why making it failed, git's reason as git says it: the workspace is `failed`, the first message still
   * waits in the tab's queue, and Run again (`scripts.run` with `setup`) makes the worktree, then runs setup. Unset once the
   * worktree exists.
   */
  worktreePending?: { error?: string }
  /** The worktree's folder was deleted outside Kernel. Checked at launch and when the workspace is opened (KERNEL-291). */
  folderGone?: true
  /** On a review workspace: the workspace whose work it reviews. */
  reviewOf?: string
  /** Reviewers' verdicts on this workspace's PR, one per review workspace and kind of review (KERNEL-549). */
  reviews?: ReviewVerdict[]
  /** The latest review round Kernel started on this workspace's PR (KERNEL-552). */
  reviewRound?: ReviewRound
  /**
   * The user's overrule of the reviews' blockers on one head commit of the PR, or the Lead's on the user's quoted words
   * (KERNEL-732). Everything that reads blockers treats `kinds` as overruled while `head` is the PR's head, so a new commit
   * brings back whatever its reviews find. `note` is why, as the user put it.
   */
  overruled?: Overrule
  /**
   * The PR head Kernel is working out the reviews for, from the ready event until the round is saved or the plan comes back
   * empty (KERNEL-717). With "Wait for the reviewer's approval to merge" on, the PR doesn't merge meanwhile.
   */
  reviewPending?: string
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
  /** How Kernel's last merge of this workspace's PR landed: the room's method, which can differ from the app's (KERNEL-468). */
  mergedWith?: MergeMethod
  /** The commit a local merge left on the base branch, for "Squashed into main as 4e1b9c2" (KERNEL-467). */
  mergeCommit?: string
  archivedAt?: number
  /** The workspaces whose PRs must merge before this one goes on (KERNEL-259). */
  waitsFor?: WaitsFor
  /** The setup script's last run, for the chat's setup line and the note when it passes (KERNEL-430). */
  setupRun?: SetupRun
}

/** An overrule of the reviews' blockers on one head commit (KERNEL-732). */
export interface Overrule { head: string; kinds: ReviewKind[]; by: 'user' | 'lead'; ts: number; note?: string }

/**
 * A review round: one set of review runs on one head commit of a PR (KERNEL-552). Kernel saves the kinds it chose as the
 * round starts, so a change to `[review]` meanwhile applies from the next round. `n` counts the rounds that ran a review,
 * from 1. `rounds` is `[review] rounds`, the most Kernel runs while blockers are left. `kept` approved the head before and
 * kept that approval, since the new commits touched none of their paths. `skipped` are optional kinds Kernel left out to
 * save usage. The kinds in neither ran. `optional` are the kinds whose approval the merge doesn't wait for (KERNEL-717).
 */
export interface ReviewRound { n: number; rounds: number; head: string; prNumber: number; kinds: ReviewKind[]; kept?: ReviewKind[]; skipped?: ReviewKind[]; optional?: ReviewKind[] }

/** When the setup script started and how it ended: an exit code, null when it was stopped, or `timeout`. No `endedAt` while it runs. */
export interface SetupRun { startedAt: number; endedAt?: number; end?: number | null | 'timeout' }

/**
 * A workspace waiting for other workspaces' PRs to merge (KERNEL-259). `on` lists their ids. `held` means the brief hasn't
 * gone out. `base` is HEAD when the brief was held. `releasing` means they merged and the teammate, which had already
 * started, hasn't taken Kernel's message yet. `tip` is `<remote>/<base>` when Kernel asked that teammate to rebase onto it,
 * and the wait ends only once the teammate's branch contains it (KERNEL-691).
 */
export interface WaitsFor {
  on: string[]
  held: boolean
  base?: string
  releasing?: boolean
  tip?: string
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
  /** A renamed file's old path, with `path` the new one. Every compare target but `base` sets it (KERNEL-516). */
  from?: string
}

/**
 * What the Changes list compares a workspace with, from the Changes ⋯ menu (PanelCompare, KERNEL-516). `base`, the default,
 * is the workspace's base as before. `branch` is the work since its merge base with another branch, uncommitted files
 * included, as `git diff --merge-base <ref>` gives it. `uncommitted` is what isn't committed yet, as `git diff HEAD` gives it.
 * `commit` is one commit against its first parent.
 */
export type CompareTarget =
  | { kind: 'base' }
  | { kind: 'branch'; ref: string }
  | { kind: 'uncommitted' }
  | { kind: 'commit'; sha: string }

/** A commit on a workspace's branch since its base, one row of the compare menu (KERNEL-516). `time` is the author's, in ms. */
export interface BranchCommit {
  sha: string
  subject: string
  author: string
  time: number
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
  /**
   * The lifecycle scripts in the repo's root `package.json` that a package install runs (`preinstall`, `install`, `postinstall`
   * and the prepare ones). The room's Install step and its setup script run that install, so the list waits for trust like a
   * script (KERNEL-260). Left out when the repo has none.
   */
  installScripts?: { name: string; command: string }[]
  /**
   * The command the room's one-time Install step waits to run in the main checkout, when it runs the repo's own code, as
   * `bundle install` does (KERNEL-444). Set only while that step waits for trust (KERNEL-682).
   */
  install?: string
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
