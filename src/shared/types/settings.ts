import type { Effort, ModelId } from './chats'
import type { WorkspaceMode } from './workspaces'

export type Theme = 'dark' | 'light'
export type SettingsPage =
  | 'general' | 'appearance' | 'notifications' | 'account' | 'shortcuts'
  | 'models' | 'permissions' | 'env'
  | 'git' | 'scripts' | 'prs'
  | 'hooks' | 'integrations' | 'experimental' | 'bigterm' | 'about'
  /** A room's own pages. `section` on the route picks one, and none means General. */
  | 'room'

/** App-wide settings, stored as JSON in the app's data folder. Every Settings page maps to a key here. */
export interface AppSettings {
  hookPort: number
  worktreeRoot: string
  general: { openTo: 'lastPlace' | 'home' | 'inbox'; openAtLogin: boolean; menuBar: boolean; sendWith: 'enter' | 'cmdEnter' }
  floor: { style: 'isometric' | 'plan' | 'list'; nameTags: boolean; animate: boolean }
  appearance: { theme: Theme | 'system'; fontSize: 'default' | 'small' | 'large'; density: 'comfortable' | 'compact'; pointerCursors: boolean; reduceMotion: boolean }
  notifications: {
    permission: boolean; plan: boolean; merge: boolean; checkFailed: boolean; finished: boolean; idle: boolean
    sound: 'subtle' | 'chime' | 'none'; quietHours: { from: string; to: string } | null
  }
  usage: { warnBeforeWeekly: boolean; pauseNearLimit: boolean }
  workspace: { mode: WorkspaceMode; baseRef: string; remote: string; branchPattern: string; deleteBranchOnArchive: boolean; archiveOnMerge: boolean; setUpstream: boolean; baselineCurrentBranch: boolean; oneCurrentBranchPerRoom: boolean }
  scripts: { setupOnCreate: boolean; runAfterSetup: boolean; archiveOnArchive: boolean
    /** Minutes a setup or archive script may run before Kernel stops it (KERNEL-216). Run scripts have no limit. */
    timeoutMinutes: number
  }
  models: { lead: ModelId; engineers: ModelId; qa: ModelId; reviewer: ModelId; effort: Effort; leadPlanMode: boolean; agentTeams: boolean
    /** Agents working at once, the Lead's chats left out (D-094). 0 means no limit. Was `maxConcurrent`, whose saved 4 was only the old default. */
    agentLimit: number
    /** Kernel tells the Lead when teammates finish a turn or their PRs change (KERNEL-72). */
    leadUpdates: boolean
    /** Workspaces you start from New workspace begin in plan mode. The Lead's hand-offs don't (KERNEL-74). */
    workspacePlanMode: boolean
    /** The effort you last picked for each model. Chats you open start at it, the Lead's hand-offs don't (D-130). */
    effortByModel: Partial<Record<ModelId, Effort>> }
  /** `defaultTemplate` seeds an empty room (Settings > Agents). */
  team: { addNewAgents: boolean; showNames: boolean; defaultTemplate: 'starter' | 'pair' }
  permissions: { mode: 'ask' | 'acceptEdits' | 'bypassInWorktrees'; network: boolean; alwaysAsk: string[]; neverAllow: string[]; protectedBranches: string[]; approvalTimeoutSec: number }
  /**
   * `requireReviewer` holds a merge until a reviewer approves the PR's latest commit, only on PRs a reviewer looked at.
   * `autoReview` has the Lead start a review when a PR passes checks (KERNEL-115). No page shows it yet.
   * `leadMerge` lets the Lead merge ready PRs with merge_workspace, only in a turn the user started (KERNEL-352).
   */
  pr: { mergeMethod: 'squash' | 'merge' | 'rebase'; draft: boolean; requireGreen: boolean; requireReviewer: boolean; autoReview: boolean; leadMerge: boolean } & PrInstructions
  hooks: { requireTestOutput: boolean; keepTeammatesWorking: boolean }
  /** The big terminal tab (KERNEL-248). `preset` is what a new tab runs. `onlyInWorktrees` drops the skip-permissions flag on a current-branch workspace. */
  terminal: { enabled: boolean; preset: string; onlyInWorktrees: boolean; custom: { id: string; name: string; command: string }[] }
  /** `sharing` gives agents share_file (KERNEL-302). On by default since KERNEL-308. No page shows it; `false` in settings.json turns it off. */
  experimental: { walking: boolean; floor3d: boolean; voice: boolean; sharing?: boolean }
}

/**
 * What a big terminal tab can run: the built-ins, the CLIs found on the PATH, then the user's custom commands (KERNEL-248).
 * `command` is typed into the login shell, null for a plain shell. `builtin` is false for custom commands only.
 */
export interface TerminalPreset {
  id: string
  name: string
  command: string | null
  builtin: boolean
  skipsPermissions: boolean
}

/** The flag Only in worktrees takes out of a command on a current-branch workspace (KERNEL-248). */
export const SKIP_FLAG = '--dangerously-skip-permissions'

/** Other agent CLIs the big terminal lists when they are on the PATH. Settings checks a custom command's name against these (KERNEL-248, KERNEL-251). */
export const KNOWN_CLIS: readonly { id: string; name: string }[] = [
  { id: 'codex', name: 'Codex' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'amp', name: 'Amp' },
  { id: 'copilot', name: 'Copilot' },
  { id: 'gemini', name: 'Gemini' }
]

/** Per-room settings from .kernel/settings.toml, with personal overrides from .kernel/settings.local.toml (SettingsRoom.png). */
export interface RoomSettings {
  scripts: { setup?: string; run?: string; archive?: string; runMode?: 'concurrent' | 'single' }
  /**
   * The room's run scripts in file order: `run` (from `[scripts] run`) first when set, then the `[run_scripts]` table.
   * Their sources are keyed `runScripts.<name>` (KERNEL-244).
   */
  runScripts: { name: string; command: string }[]
  /** `copy` takes exact paths and patterns like `.env*` (KERNEL-245). */
  files: { copy: string[]; symlinkNodeModules?: boolean }
  workspace: Partial<AppSettings['workspace']>
  /** Skills and MCP servers switched off for this room, by name. */
  disabled?: { skills: string[]; mcp: string[] }
  /** The room's Linear team, by key ("KERNEL"). The Issues screen opens on it. */
  linear?: { team?: string }
  /** The room's PR instructions, a `[pr]` table. A missing key uses the app's (KERNEL-190). */
  pr?: Partial<PrInstructions>
  /**
   * The room's preview URLs, a `[[preview.urls]]` array of tables, in order. `url` may use `$KERNEL_PORT` forms that
   * `resolvePreviewUrl` fills in. A patch replaces the whole list (KERNEL-246).
   */
  preview: { urls: { name: string; url: string }[] }
  /**
   * The room's env files, an `[env] files` key, read in order and resolved against the workspace folder. A later file
   * wins over an earlier one, and the room's own variables win over them all (KERNEL-247).
   */
  env: { files: string[] }
  /**
   * Which file set each value, by app-side dotted path (`scripts.setup`, `workspace.remote`, `pr.createInstructions`).
   * A path missing here means the app default applies (KERNEL-190).
   */
  sources: Record<string, RoomSettingSource>
}

/** The text Kernel sends the agent for each PR action (Settings > Pull requests, and per room). */
export interface PrInstructions { createInstructions: string; resolveInstructions: string; fixChecksInstructions: string; addressReviewInstructions: string }

/** `shared`: only `.kernel/settings.toml` sets the value. `local`: only `.kernel/settings.local.toml`. `override`: both, and the personal one wins. */
export type RoomSettingSource = 'shared' | 'local' | 'override'

/** The sections of a room's settings page. A route without one opens General. */
export type RoomSettingsSection = 'general' | 'git' | 'scripts' | 'files' | 'environment' | 'instructions' | 'permissions' | 'agents' | 'skills'

/** One file a new worktree gets from the main checkout. `path` is relative to the room's folder, `size` is in bytes. */
export interface FileToCopy {
  path: string
  size: number
}

/**
 * A patch to a room's settings file. `null` removes the key so the app default applies again.
 * `runScripts` maps a name to its command, and `run` is `[scripts] run`.
 */
export type RoomSettingsPatch = {
  [K in Exclude<keyof RoomSettings, 'sources' | 'runScripts'>]?: { [P in keyof NonNullable<RoomSettings[K]>]?: NonNullable<RoomSettings[K]>[P] | null }
} & { runScripts?: Record<string, string | null> }

/** Recursive partial for settings patches. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object | null ? DeepPartial<T[K]> : T[K] }
