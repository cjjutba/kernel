import type { AgentDraft, RosterAdvice } from './agents'
import type { PermissionMode } from './settings'

export type ProjectKind = 'repo' | 'folder' | 'scratch'

export interface Project {
  id: string
  name: string
  /** One line under the name on Projects and Home, for example "Invoicing SaaS · MVP Sprint". */
  desc?: string
  kind?: ProjectKind
  /** Absolute path of the main checkout. */
  path: string
  /** owner/repo when the folder has a GitHub remote. */
  repo?: string
  defaultBranch: string
  paused: boolean
  /** Who paused it. A limit pause lifts itself when the limit resets (FloorLimit.png). */
  pausedBy?: 'you' | 'limit'
  /** Agent ids in order. Kept as saved data; it only orders Team's shirts now. */
  desks?: string[]
  /** Hidden from the sidebar, still listed on Projects. */
  hidden?: boolean
  /** Archived from Settings > Project. Agents stop, workspaces archive, the project moves to Projects > Archived. */
  archived?: boolean
  /** Bash rules the user chose "Always allow in this project" for. An exact command, or `prefix:*`. They beat Always ask. */
  allow?: string[]
  /**
   * The same for tools other than Bash, as Claude Code writes a rule: `mcp__linear__get_issue`, `WebFetch(domain:example.com)`
   * (KERNEL-432).
   */
  allowTools?: string[]
  /** The project's permission mode, over the app's. A chat's own mode wins over it (KERNEL-432). */
  permissionMode?: PermissionMode
  /** Where the project's pull requests merge: on GitHub through gh, or locally with git (KERNEL-432). */
  host?: 'github' | 'local'
  /**
   * Rules in the repo's CLAUDE.md, .claude/CLAUDE.md and AGENTS.md that fight how Kernel works, found at project setup. Agents read
   * those files too, so they may follow either. Kernel never edits them. Unset until a setup scans, empty when none fight (KERNEL-452).
   */
  instructionConflicts?: InstructionConflict[]
  /**
   * The project's picture: the GitHub owner's avatar or a picked PNG or JPEG, saved as `file` in the data folder's room-icons.
   * No icon means the letter. The image itself comes from `projects.icon`, so project pushes stay small (KERNEL-241).
   */
  icon?: { kind: 'github' | 'image'; file: string; at: number }
  /**
   * The folder under the worktree root that the project's new worktrees go in: the project's id, so two projects with the same name
   * never share one. A project made before KERNEL-231 has none and keeps the slug of its name.
   */
  worktreeDir?: string
  /**
   * Copied files the user chose Keep copying for on Files to copy, though they look like production, as `<path>:<NAME>`. A
   * file or a variable that isn't in here warns again (KERNEL-449).
   */
  keepCopying?: string[]
  /**
   * The chat that setup made for the project, with its worktree, so the first Send stays in it instead of making another
   * (see docs/decisions/feat-create-new-projects-first-chat-and.md). Set once, when setup finishes. It stays after the chat is archived, and a project made before has none.
   */
  firstChatId?: string
  createdAt: number
}

/**
 * What a rule in the repo's instructions says that Kernel's workflow doesn't do (KERNEL-452):
 * - `commit-to-main`: commit or work straight on the default or a protected branch.
 * - `no-branches`: don't make branches.
 * - `no-pull-requests`: don't open pull requests, or skip them.
 * - `push-to-protected`: push straight to the default or a protected branch.
 * - `stacked-prs`: build each branch or pull request on the one before it.
 */
export type InstructionConflictKind = 'commit-to-main' | 'no-branches' | 'no-pull-requests' | 'push-to-protected' | 'stacked-prs'

/** One rule in the repo's CLAUDE.md or AGENTS.md that fights Kernel's workflow, next to what Kernel tells agents (ProjectSetupConflicts.png). */
export interface InstructionConflict {
  kind: InstructionConflictKind
  /** The rule as the file says it, without its list marker or bold. A long line keeps only the sentence that fights. */
  text: string
  /** Relative to the repo: `CLAUDE.md`, `.claude/CLAUDE.md` or `AGENTS.md`. */
  file: string
  /** 1-based. */
  line: number
  /** What Kernel tells agents instead, for the "Kernel tells agents" column. */
  kernel: string
}

/** New project modal (NewProject.png). */
export interface NewProjectRequest {
  source: ProjectKind
  name: string
  desc?: string
  /** owner/repo for a repo, an absolute path for a folder, a template repo for scratch. */
  from: string
  baseBranch?: string
  /** Starter agent ids to seat when the repo has no agents. Kernel leads (KERNEL-397, KERNEL-553). */
  team: string[]
  /** Brief the Lead as soon as setup finishes. */
  autostart: boolean
  /** Repo and scratch projects: the folder to create the checkout in. Defaults to ~/Projects/<name>. */
  cloneTo?: string
  /** Folder projects: the folder is not a git repository, so run `git init` and make a first commit. */
  initGit?: boolean
  /**
   * Creates a private GitHub repo for the project and makes it `origin` (KERNEL-944). Scratch projects start as an empty repo
   * with a README. A folder with no GitHub remote gets one, and a folder that isn't a repo yet is initialized first.
   */
  github?: { owner: string; name: string }
}

/** Values New project opens with. Fixtures use it to show the filled form. */
export interface NewProjectPrefill {
  source: ProjectKind
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

/** One line of the project setup progress (ProjectSetup.png). */
export interface ProjectSetupStep {
  /** `push` is there only when the project has a remote (KERNEL-460). `host` is the code host read from the remote (KERNEL-477). */
  id: 'clone' | 'github' | 'host' | 'worktrees' | 'install' | 'copy' | 'hooks' | 'push' | 'agents'
  title: string
  detail: string
  /**
   * `warn` finished with something to look at, which never blocks the project (KERNEL-437). `skip` failed, with its `error`,
   * and the steps after it ran anyway, since they don't need it. `fail` failed and stopped setup there (KERNEL-1086).
   */
  state: 'wait' | 'run' | 'ok' | 'warn' | 'skip' | 'fail'
  /** Duration or "running". */
  meta?: string
  error?: string
  /** A tool's own error, shown in a box under the detail. */
  output?: string
  /** A warning's one fix: a command to copy, and `recheck` for a Check again button. */
  fix?: { command?: string; action?: 'recheck' }
  /** On the copy step: the files to copy that look like production, by path. The step warns (KERNEL-449). */
  production?: string[]
  /** On the agents step: how many agent files the repo already had, so Project setup shows the team for review (KERNEL-397). */
  brought?: number
  /**
   * On the agents step: whether to ask for a roster, and who Kernel would pick (KERNEL-465). It counts the user's personal
   * and plugin agents too, since they join every project (KERNEL-463).
   */
  roster?: RosterAdvice
}

/**
 * One row of a project's push check (SettingsProjectGit*.png). `unchecked` is a row that couldn't be asked, like Permission to
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
 * Whether git can push from a project's checkout (KERNEL-460). `reach` is `git ls-remote <remote>`. `push` is gh's permission
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
  /** The repo's one-line description on GitHub (KERNEL-945). */
  description?: string
}

/** An account a new GitHub repo can belong to: the signed-in user, then the orgs they're in (KERNEL-944). */
export interface GitHubOwner {
  login: string
  avatarUrl?: string
  org: boolean
}

/** A local folder that could become a project (OpenFolder.png). */
export interface FolderInfo {
  path: string
  git: boolean
  /** owner/repo of the folder's GitHub remote, when it has one (KERNEL-944). */
  remote?: string
  branch?: string
  /** Uncommitted changes in the checkout. */
  dirty?: number
}

/** Two agents editing the same file in different worktrees (FloorOverlap.png). */
export interface Overlap {
  id: string
  projectId: string
  path: string
  parties: { agentId: string; workspaceId: string; lines: string }[]
  ts: number
  resolved?: boolean
}
