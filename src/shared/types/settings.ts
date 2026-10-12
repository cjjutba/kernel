import type { TeamConfig } from './agents'
import type { Effort, Provider } from './chats'
import type { TrackerKind } from './trackers'
import type { WorkspaceMode } from './workspaces'

export type Theme = 'dark' | 'light'
export type SettingsPage =
  | 'general' | 'appearance' | 'notifications' | 'account' | 'shortcuts'
  | 'models' | 'providers' | 'permissions' | 'env'
  | 'git' | 'scripts' | 'prs'
  | 'hooks' | 'integrations' | 'experimental' | 'privacy' | 'bigterm' | 'about'
  /** A room's own pages. `section` on the route picks one, and none means General. */
  | 'room'

/** The Claude plan the account is on, from `subscriptionType`. `unknown` covers a sign-out and a type Kernel doesn't know (KERNEL-225). */
export type ClaudePlan = 'pro' | 'max' | 'team' | 'enterprise' | 'unknown'

/** The plans a Claude account Kernel adds can be on, for the Add account sheet, which asks since its token can't tell (KERNEL-406). */
export const CLAUDE_PLANS: { id: Exclude<ClaudePlan, 'unknown'>; label: string }[] = [
  { id: 'pro', label: 'Pro' },
  { id: 'max', label: 'Max' },
  { id: 'team', label: 'Team' },
  { id: 'enterprise', label: 'Enterprise' }
]

/** App-wide settings, stored as JSON in the app's data folder. Every Settings page maps to a key here. */
export interface AppSettings {
  /** Read-only, filled by main when it resolves the settings (KERNEL-225). A patch never writes it. */
  plan?: ClaudePlan
  /** Read-only, filled by main: the dotted keys (`models.reviewer`) whose value is the plan's default and not the user's choice. */
  planDefaulted?: string[]
  hookPort: number
  worktreeRoot: string
  general: { openTo: 'lastPlace' | 'home' | 'inbox'; openAtLogin: boolean; menuBar: boolean; sendWith: 'enter' | 'cmdEnter'
    /** The Open in app last picked, by its catalog id (KERNEL-427). Unset until the first pick. */
    openIn?: string
  }
  floor: { style: 'isometric' | 'plan' | 'list'; nameTags: boolean; animate: boolean }
  appearance: { theme: Theme | 'system'; fontSize: 'default' | 'small' | 'large'; density: 'comfortable' | 'compact'; pointerCursors: boolean; reduceMotion: boolean }
  notifications: {
    permission: boolean; plan: boolean; merge: boolean; checkFailed: boolean; finished: boolean; idle: boolean
    sound: 'subtle' | 'chime' | 'none'; quietHours: { from: string; to: string } | null
  }
  usage: { warnBeforeWeekly: boolean; pauseNearLimit: boolean }
  workspace: {
    mode: WorkspaceMode; baseRef: string; remote: string; branchPattern: string; deleteBranchOnArchive: boolean; archiveOnMerge: boolean; setUpstream: boolean; baselineCurrentBranch: boolean; oneCurrentBranchPerRoom: boolean
    /** The branch a new chat with Rowan starts on. `{lead}` is the Lead's name and `{slug}` the chat's title (KERNEL-405). */
    leadBranchPattern: string
    /** A chat with Rowan holds its first message until files.copy and setup pass (KERNEL-405). */
    leadWaitForSetup: boolean
    /** Archiving a chat with Rowan archives the workspaces it handed off too (KERNEL-405). */
    archiveChatWorkspaces: boolean
  }
  scripts: { setupOnCreate: boolean; runAfterSetup: boolean; archiveOnArchive: boolean
    /** Minutes a setup or archive script may run before Kernel stops it (KERNEL-216). Run scripts have no limit. */
    timeoutMinutes: number
  }
  /** `roles` replaced one model per role and a global effort (KERNEL-406). `loadAppSettings` moves the old keys over. */
  models: { roles: Record<Role, RoleModel>; leadPlanMode: boolean; agentTeams: boolean
    /** Agents working at once, the Lead's chats left out (D-094). 0 means no limit. Was `maxConcurrent`, whose saved 4 was only the old default. */
    agentLimit: number
    /** Kernel tells the Lead when teammates finish a turn or their PRs change (KERNEL-72). */
    leadUpdates: boolean
    /** Workspaces you start from New workspace begin in plan mode. The Lead's hand-offs don't (KERNEL-74). */
    workspacePlanMode: boolean
    /**
     * The effort you last picked for each model, by model id. Chats you open start at it, the Lead's hand-offs don't (D-130).
     * Claude's ids start with `claude-` and Codex's never do, so one map holds both (KERNEL-406).
     */
    effortByModel: Partial<Record<string, Effort>> }
  /** Settings, Providers (KERNEL-406). Accounts and their credentials live apart from this file. */
  providers: { claude: ProviderBinary; codex: ProviderBinary & { personality: CodexPersonality } }
  /** `defaultTemplate` seeds an empty room (Settings > Agents). */
  team: { addNewAgents: boolean; showNames: boolean; defaultTemplate: 'starter' | 'pair' }
  /**
   * `mode` is the app's permission mode, which a room and a chat can override. `bypassOnlyInWorktrees` keeps Bypass
   * permissions off a current-branch workspace. The modes were `ask`, `acceptEdits` and `bypassInWorktrees` before
   * KERNEL-432, and `loadAppSettings` moves them over.
   */
  permissions: { mode: PermissionMode; bypassOnlyInWorktrees: boolean; network: boolean; alwaysAsk: string[]; neverAllow: string[]; protectedBranches: string[]; approvalTimeoutSec: number }
  /**
   * `requireReviewer` holds a merge until a reviewer approves the PR's latest commit, only on PRs a reviewer looked at.
   * `autoReview` has the Lead start a review when a PR passes checks (KERNEL-115). No page shows it yet.
   * `leadMerge` lets the Lead merge ready PRs with merge_workspace, only in a turn the user started (KERNEL-352).
   */
  pr: { mergeMethod: MergeMethod; draft: boolean; requireGreen: boolean; requireReviewer: boolean; autoReview: boolean; leadMerge: boolean } & PrInstructions
  hooks: { requireTestOutput: boolean; keepTeammatesWorking: boolean }
  /** The big terminal tab (KERNEL-248). `preset` is what a new tab runs. `onlyInWorktrees` drops the skip-permissions flag on a current-branch workspace. */
  terminal: { enabled: boolean; preset: string; onlyInWorktrees: boolean; custom: { id: string; name: string; command: string }[] }
  /** `sharing` gives agents share_file (KERNEL-302). On by default since KERNEL-308. No page shows it; `false` in settings.json turns it off. */
  experimental: { walking: boolean; floor3d: boolean; voice: boolean; sharing?: boolean }
  /**
   * Usage data (KERNEL-397). `ask` until the user answers the one-time question, and nothing is sent until it is `on`.
   * Settings, Privacy changes it.
   */
  privacy: { telemetry: 'ask' | 'on' | 'off' }
}

/** The roles Settings, Models and effort sets a default for. */
export type Role = 'lead' | 'engineers' | 'qa' | 'reviewer'

/** A role's default: the provider, the model on it, and the effort (KERNEL-406). An agent file's `model:` overrides it. */
export interface RoleModel { provider: Provider; model: string; effort: Effort }

/**
 * Which executable a provider runs. An empty `path` uses Kernel's bundled copy, or the one on the PATH while `useSystem`
 * is on. A `path` wins over both.
 */
export interface ProviderBinary { path: string; useSystem: boolean }

/** Codex personality for new chats: Pragmatic by default, Friendly, or None. */
export type CodexPersonality = 'pragmatic' | 'friendly' | 'none'

/**
 * How much an agent does without asking, named as Claude Code names its modes (KERNEL-432): Manual (`default`) asks before
 * edits and commands, Accept edits takes file edits, Auto lets Claude Code's classifier decide, and Bypass permissions asks
 * for nothing Kernel's own rules allow. Plan mode isn't one of them: it is `Chat.plan`.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions'

export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions']

/**
 * Whether a provider can run Auto and Bypass permissions now (KERNEL-432). Auto on Claude depends on the account and the
 * model, and admin policy can turn either off. `reason` says why one can't, for the line under the mode picker.
 */
export interface ModeAvailability { auto: boolean; bypass: boolean; reason?: string }

/** How a PR merges: the app's `pr.mergeMethod`, or a room's `[pr] merge_method`. */
export type MergeMethod = 'squash' | 'merge' | 'rebase'

/** What a room does when an agent reaches for an MCP server its file doesn't list: ask the user, or hide the server as Claude Code does. */
export type UnlistedTools = 'ask' | 'hide'

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
  /**
   * `copy` takes exact paths and patterns like `.env*` (KERNEL-245). `exclude` takes the same, and a file it matches is
   * never copied, whatever `copy` says: Don't copy these files on Files to copy adds to it (KERNEL-449).
   */
  files: { copy: string[]; exclude?: string[]; symlinkNodeModules?: boolean }
  workspace: Partial<AppSettings['workspace']>
  /** Skills and MCP servers switched off for this room, by name. */
  disabled?: { skills: string[]; mcp: string[] }
  /** The room's Linear team, by key ("KERNEL"). The Issues screen opens on it. */
  linear?: { team?: string }
  /** The room's issue tracker, `[tracker] kind`. Without it Kernel works the tracker out from the Linear token and the remote (KERNEL-432). */
  tracker?: { kind?: TrackerKind | 'none' }
  /**
   * The room's PR instructions, a `[pr]` table. A missing key uses the app's (KERNEL-190). `optionalChecks` names checks
   * that never fail a PR in a repo that requires none, `*` matching any run of characters ("Vercel*"). A check the repo
   * requires always counts (KERNEL-388). `mergeMethod` (`merge_method`) is this room's over the app's (KERNEL-432).
   */
  pr?: Partial<PrInstructions> & { optionalChecks?: string[]; mergeMethod?: MergeMethod }
  /**
   * `[mcp.aliases]`: a server name the agent files use, and the name of the server this Mac has for it
   * (`linear = "claude_ai_Linear"`). Both files merge alias by alias (KERNEL-432).
   */
  mcp?: { aliases?: Record<string, string> }
  /**
   * The `[agents]` table (KERNEL-432). `unlistedTools` (`unlisted_tools`) is `ask` when unset. `allow` is each agent's
   * `[agents.<id>] allow`: by agent id, the MCP servers the user let it use in this room though its file doesn't list them.
   * Both files merge agent by agent.
   */
  agents?: { unlistedTools?: UnlistedTools; allow?: Record<string, string[]> }
  /**
   * The room's preview URLs, a `[[preview.urls]]` array of tables, in order. `url` may use `$KERNEL_PORT` forms that
   * `resolvePreviewUrl` fills in. A patch replaces the whole list (KERNEL-246).
   */
  preview: { urls: { name: string; url: string }[] }
  /**
   * The room's env files, an `[env] files` key, read in order and resolved against the workspace folder. A later file
   * wins over an earlier one, and the room's own variables win over them all (KERNEL-247). When neither settings file
   * sets the key, the room reads `.env.kernel` (KERNEL-449).
   */
  env: { files: string[] }
  /**
   * Who leads, who reviews and who takes tasks, where it differs from what Kernel works out from the agent files (KERNEL-397).
   * Written to the shared file with `agents.setTeam`, not `settings.setRoom`.
   */
  team?: TeamConfig
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
 * A file to copy that looks like production, by the file and the variable that gave it away. The value never leaves the
 * main process (KERNEL-449). `live-key` is a live payment key, `remote-database` a database URL on a host that isn't this
 * Mac or its network, `production` an environment name like `NODE_ENV` set to production.
 */
export interface ProductionHint {
  path: string
  name: string
  why: 'live-key' | 'remote-database' | 'production'
}

/**
 * A patch to a room's settings file. `null` removes the key so the app default applies again.
 * `runScripts` maps a name to its command, and `run` is `[scripts] run`. `mcp.aliases` and `agents.allow` change only the
 * names they list, and `null` removes one (KERNEL-432).
 */
export type RoomSettingsPatch = {
  [K in Exclude<keyof RoomSettings, 'sources' | 'runScripts' | 'team' | 'mcp' | 'agents'>]?: { [P in keyof NonNullable<RoomSettings[K]>]?: NonNullable<RoomSettings[K]>[P] | null }
} & {
  runScripts?: Record<string, string | null>
  mcp?: { aliases?: Record<string, string | null> }
  agents?: { unlistedTools?: UnlistedTools | null; allow?: Record<string, string[] | null> }
}

/** Recursive partial for settings patches. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object | null ? DeepPartial<T[K]> : T[K] }
