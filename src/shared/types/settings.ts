import type { TeamConfig } from './agents'
import type { Effort, Provider } from './chats'
import type { TrackerKind } from './trackers'
import type { LeadMode, WorkspaceMode } from './workspaces'

export type Theme = 'dark' | 'light'
export type SettingsPage =
  /** `accounts` holds every Claude Code and Codex account with its usage, the old Account and usage and Providers pages (KERNEL-680). */
  | 'general' | 'appearance' | 'notifications' | 'accounts' | 'shortcuts'
  | 'models' | 'permissions' | 'env'
  /** Every account's MCP servers, one account at a time (KERNEL-661). */
  | 'mcp'
  /** The personal and plugin agents that join every project, and the editor for one (KERNEL-641). */
  | 'agents'
  /** `git` also holds the setup and archive switches the Scripts page had (KERNEL-680). */
  | 'git' | 'prs' | 'bigterm'
  | 'hooks' | 'integrations' | 'privacy' | 'about'
  /** A project's own pages. `section` on the route picks one, and none means General. */
  | 'project'

/** The Claude plan the account is on, from `subscriptionType`. `unknown` covers a sign-out and a type Kernel doesn't know (KERNEL-225). */
export type ClaudePlan = 'pro' | 'max' | 'team' | 'enterprise' | 'unknown'

/** Summarize a long chat before it moves to another account, continue it as it is, or ask each time (KERNEL-841). */
export type LongChatMove = 'summarize' | 'continue' | 'ask'

/** App-wide settings, stored as JSON in the app's data folder. Every Settings page maps to a key here. */
export interface AppSettings {
  /** Read-only, filled by main when it resolves the settings (KERNEL-225). A patch never writes it. */
  plan?: ClaudePlan
  /** Read-only, filled by main: the dotted keys (`models.reviewer`) whose value is the plan's default and not the user's choice. */
  planDefaulted?: string[]
  hookPort: number
  worktreeRoot: string
  general: { openTo: 'lastPlace' | 'inbox'; openAtLogin: boolean; sendWith: 'enter' | 'cmdEnter'
    /** The Open in app last picked, by its catalog id (KERNEL-427). Unset until the first pick. */
    openIn?: string
  }
  appearance: { theme: Theme | 'system'; fontSize: 'default' | 'small' | 'large'; density: 'comfortable' | 'compact'; pointerCursors: boolean; reduceMotion: boolean }
  notifications: {
    permission: boolean; plan: boolean; merge: boolean; checkFailed: boolean; finished: boolean; idle: boolean
    sound: 'subtle' | 'chime' | 'none'; quietHours: { from: string; to: string } | null
  }
  usage: { warnBeforeWeekly: boolean; pauseNearLimit: boolean }
  /**
   * `switchAtLimit`: per provider, Kernel moves to another signed-in subscription account when the one in use hits its 5-hour
   * or weekly limit. Off by default, and never to an API key account (KERNEL-568).
   * `keepChatsOnAccount`: a chat stays on the account that holds its cache rather than following a switch. `longChatMove`:
   * what Kernel does, per provider, when a chat of `longChatTokens` or more has to move to another account (KERNEL-841).
   */
  accounts: { switchAtLimit: Record<Provider, boolean>; keepChatsOnAccount: boolean; longChatMove: Record<Provider, LongChatMove>; longChatTokens: number }
  workspace: {
    mode: WorkspaceMode; baseRef: string; remote: string; branchPattern: string; deleteBranchOnArchive: boolean; archiveOnMerge: boolean; baselineCurrentBranch: boolean; oneCurrentBranchPerProject: boolean
    /** The branch a new Lead chat starts on. `{lead}` is the Lead's name and `{slug}` the chat's title (KERNEL-405). */
    leadBranchPattern: string
    /** A Lead chat holds its first message until files.copy and setup pass (KERNEL-405). */
    leadWaitForSetup: boolean
    /** Archiving a Lead chat archives the workspaces it handed off too (KERNEL-405). */
    archiveChatWorkspaces: boolean
  }
  scripts: { setupOnCreate: boolean; runAfterSetup: boolean; archiveOnArchive: boolean
    /** Minutes a setup or archive script may run before Kernel stops it (KERNEL-216). Run scripts have no limit. */
    timeoutMinutes: number
  }
  /** `roles` replaced one model per role and a global effort (KERNEL-406). `loadAppSettings` moves the old keys over. */
  models: { roles: Record<Role, RoleModel>; leadPlanMode: boolean; agentTeams: boolean
    /** Where each role's Claude chats compact. One the user never set follows the plan (feat-compact-window-per-role-with-plan). */
    compact: Record<Role, CompactWindow>
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
  /** Settings, Accounts, Advanced (KERNEL-406, KERNEL-680). Accounts and their credentials live apart from this file. */
  providers: { claude: ProviderBinary; codex: ProviderBinary & { personality: CodexPersonality } }
  /**
   * `defaultTemplate` seeds an empty project (Settings, Agents, New projects start with). `leadMode` is how a new chat with Kernel
   * works, Hand off or Build here, where the project's `[agents] lead_mode` doesn't say (KERNEL-770).
   */
  team: { defaultTemplate: 'starter' | 'pair'; leadMode: LeadMode }
  /**
   * `mode` is the app's permission mode, which a project and a chat can override. `bypassOnlyInWorktrees` keeps Bypass
   * permissions off a current-branch workspace. The modes were `ask`, `acceptEdits` and `bypassInWorktrees` before
   * KERNEL-432, and `loadAppSettings` moves them over.
   */
  permissions: { mode: PermissionMode; bypassOnlyInWorktrees: boolean; network: boolean; alwaysAsk: string[]; neverAllow: string[]; protectedBranches: string[]; approvalTimeoutSec: number }
  /**
   * `requireReviewer` holds a merge until a reviewer approves the PR's latest commit, on PRs a reviewer looked at and, from the
   * ready event on, on PRs `autoReview` plans a required review for (KERNEL-717).
   * `autoReview` has Kernel start the reviews a project's `[review]` asks for when a PR passes checks (KERNEL-115, KERNEL-549).
   * Off until the user turns it on, on every plan (feat-automatic-review-off-by-default).
   * `leadMerge` lets the Lead merge ready PRs with merge_workspace, only in a turn the user started (KERNEL-352).
   * `autoMerge` has Kernel merge a PR every review approved by itself, off until the user turns it on (KERNEL-556). Settings, Pull requests has its switch, size limit and paths (KERNEL-557).
   */
  pr: { mergeMethod: MergeMethod; draft: boolean; requireGreen: boolean; requireReviewer: boolean; autoReview: boolean; leadMerge: boolean; autoMerge: AutoMerge } & PrInstructions
  hooks: { requireTestOutput: boolean; keepTeammatesWorking: boolean }
  /** The big terminal tab (KERNEL-248). `preset` is what a new tab runs. `onlyInWorktrees` drops the skip-permissions flag on a current-branch workspace. */
  terminal: { enabled: boolean; preset: string; onlyInWorktrees: boolean; custom: { id: string; name: string; command: string }[] }
  /** `sharing` gives agents share_file (KERNEL-302). On by default since KERNEL-308. No page shows it; `false` in settings.json turns it off. */
  experimental: { sharing?: boolean }
  /**
   * Usage data (KERNEL-397). `ask` until the user answers the one-time question, and nothing is sent until it is `on`.
   * Settings, Privacy changes it.
   */
  privacy: { telemetry: 'ask' | 'on' | 'off' }
}

/** The roles Settings, Models and effort sets a default for. */
export type Role = 'lead' | 'engineers' | 'qa' | 'reviewer'

/**
 * Where a Claude chat compacts: against a 200k window, or against its model's own (feat-compact-window-per-role-with-plan).
 * Kept out of `RoleModel`, which the model pickers pass around.
 */
export type CompactWindow = '200k' | 'full'

/** The windows a role can compact against, for Settings, Models. */
export const COMPACT_WINDOWS: CompactWindow[] = ['200k', 'full']

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

/** The mode a chat's steps run in: one of the app's four, or `plan` while the chat plans (KERNEL-447). */
export type RunMode = PermissionMode | 'plan'

/**
 * Whether a provider can run Auto and Bypass permissions now (KERNEL-432). Auto on Claude depends on the account and the
 * model, and admin policy can turn either off. `reason` says why one can't, for the line under the mode picker.
 */
export interface ModeAvailability { auto: boolean; bypass: boolean; reason?: string }

/**
 * Kernel merging a PR by itself, a person's own setting that is off by default (KERNEL-556). `maxLines` is the most lines a PR
 * may add and remove together. `alwaysReview` lists globs of repo paths: a PR that changes one never merges by itself. They
 * add to Kernel's own list and the base branch's `[merge] always_review`. A project's `.kernel/settings.local.toml` `[merge]`
 * (`auto`, `max_lines`, `always_review`) overrides it for that project. The shared `.kernel/settings.toml` can't.
 */
export interface AutoMerge { on: boolean; maxLines: number; alwaysReview: string[] }

/** How a PR merges: the app's `pr.mergeMethod`, or a project's `[pr] merge_method`. */
export type MergeMethod = 'squash' | 'merge' | 'rebase'

/** What a project does when an agent reaches for an MCP server its file doesn't list: ask the user, or hide the server as Claude Code does. */
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

/** Per-project settings from .kernel/settings.toml, with personal overrides from .kernel/settings.local.toml (SettingsProject.png). */
export interface ProjectSettings {
  scripts: { setup?: string; run?: string; archive?: string; runMode?: 'concurrent' | 'single' }
  /**
   * The project's run scripts in file order: `run` (from `[scripts] run`) first when set, then the `[run_scripts]` table.
   * Their sources are keyed `runScripts.<name>` (KERNEL-244).
   */
  runScripts: { name: string; command: string }[]
  /**
   * `copy` takes exact paths and patterns like `.env*` (KERNEL-245). `exclude` takes the same, and a file it matches is
   * never copied, whatever `copy` says: Don't copy these files on Files to copy adds to it (KERNEL-449).
   */
  files: { copy: string[]; exclude?: string[]; symlinkNodeModules?: boolean }
  workspace: Partial<AppSettings['workspace']>
  /** Skills and MCP servers switched off for this project, by name. */
  disabled?: { skills: string[]; mcp: string[] }
  /** The project's Linear team, by key ("KERNEL"). The Issues screen opens on it. */
  linear?: { team?: string }
  /** The project's issue tracker, `[tracker] kind`. Without it Kernel works the tracker out from the Linear token and the remote (KERNEL-432). */
  tracker?: { kind?: TrackerKind | 'none' }
  /**
   * The project's PR instructions, a `[pr]` table. A missing key uses the app's (KERNEL-190). `optionalChecks` names checks
   * that never fail a PR in a repo that requires none, `*` matching any run of characters ("Vercel*"). A check the repo
   * requires always counts (KERNEL-388). `mergeMethod` (`merge_method`) is this project's over the app's (KERNEL-432).
   */
  pr?: Partial<PrInstructions> & { optionalChecks?: string[]; mergeMethod?: MergeMethod }
  /**
   * `[mcp.aliases]`: a server name the agent files use, and the name of the server this Mac has for it
   * (`linear = "claude_ai_Linear"`). Both files merge alias by alias (KERNEL-432).
   */
  mcp?: { aliases?: Record<string, string> }
  /**
   * The `[agents]` table (KERNEL-432). `unlistedTools` (`unlisted_tools`) is `ask` when unset. `allow` is each agent's
   * `[agents.<id>] allow`: by agent id, the MCP servers the user let it use in this project though its file doesn't list them.
   * Both files merge agent by agent. `openWorkspaces` (`open_workspaces`) is how many teammate workspaces the Lead may have
   * open in the project, 0 to 12, and 0 is no limit. Unset, the project follows Settings, Models' `agentLimit` (KERNEL-492).
   * `leadMode` (`lead_mode`) is how a new chat with Kernel works in this project, over the app's `team.leadMode` (KERNEL-770).
   */
  agents?: { unlistedTools?: UnlistedTools; allow?: Record<string, string[]>; openWorkspaces?: number; leadMode?: LeadMode }
  /**
   * The project's preview URLs, a `[[preview.urls]]` array of tables, in order. `url` may use `$KERNEL_PORT` forms that
   * `resolvePreviewUrl` fills in. A patch replaces the whole list (KERNEL-246).
   */
  preview: { urls: { name: string; url: string }[] }
  /**
   * The project's env files, an `[env] files` key, read in order and resolved against the workspace folder. A later file
   * wins over an earlier one, and the project's own variables win over them all (KERNEL-247). When neither settings file
   * sets the key, the project reads `.env.kernel` (KERNEL-449).
   */
  env: { files: string[] }
  /**
   * Folders outside the repo the project's agents may read but not change, as absolute paths (KERNEL-748): a backend next to a UI.
   * Claude sessions get them as `additionalDirectories`, and the @ menu searches them. Only the personal file's top-level
   * `references` key sets them, since the paths differ per Mac. A patch replaces the whole list.
   */
  references: string[]
  /** Read-only, filled by main: the `references` that aren't a folder on this Mac now. Sessions and search skip them. */
  missingReferences?: string[]
  /**
   * Who leads, who reviews and who takes tasks, where it differs from what Kernel works out from the agent files (KERNEL-397).
   * Written to the shared file with `agents.setTeam`, not `settings.setProject`.
   */
  team?: TeamConfig
  /**
   * The shared file's `[review]` with the defaults filled in (KERNEL-549). The personal file can't change it. Written with
   * `settings.setReview`, not `settings.setProject`. A PR's own reviews read it from the PR's base branch, not from here.
   */
  review?: ReviewConfig
  /**
   * The shared file's `[merge] always_review`: paths a PR never merges by itself through, for everyone on the repo (KERNEL-594).
   * The personal file's list is the user's own and isn't here. Written with `settings.setAlwaysReview`, not `settings.setProject`.
   */
  merge?: { alwaysReview: string[] }
  /**
   * Which file set each value, by app-side dotted path (`scripts.setup`, `workspace.remote`, `pr.createInstructions`).
   * A path missing here means the app default applies (KERNEL-190).
   */
  sources: Record<string, ProjectSettingSource>
}

/**
 * The kinds of review Kernel runs on a pull request (KERNEL-549). Each is its own chat in the PR's review workspace, with
 * its own prompt, and blocks only on what it covers. The UI calls each one a review: "the security review".
 */
export type ReviewKind = 'code' | 'security' | 'ux'

/** Every review kind in the order Kernel starts them and names them in a sentence. */
export const REVIEW_KINDS: readonly { id: ReviewKind; label: string }[] = [
  { id: 'code', label: 'Code' },
  { id: 'security', label: 'Security' },
  { id: 'ux', label: 'UX' }
]

/**
 * One kind in `[review.<kind>]` (KERNEL-549). `enabled`: the code review runs unless its table says `enabled = false`, and
 * the others run once their table is there, unless it says `enabled = false`. `paths`: globs of repo paths, and a PR that
 * changes a matching file gets this review. Empty is every PR. `required`: its approval of the PR's latest commit counts
 * toward "require Reviewer approval". Its blockers hold a merge either way. `agent`: a project agent that runs it with its own
 * prompt, else Kernel's prompt for the kind does (the code review's is the project's reviewer). `model` and `provider`: what its
 * chat runs on, else the agent's model or the reviewer role's from Settings, Models.
 */
export interface ReviewKindConfig { enabled: boolean; paths: string[]; required: boolean; agent?: string; model?: string; provider?: Provider }

/**
 * A project's `[review]` table in the shared settings file (KERNEL-549). `rounds` is how many review rounds a PR gets before
 * Kernel stops sending it back (2 by default, KERNEL-552).
 */
export interface ReviewConfig { rounds: number; kinds: Record<ReviewKind, ReviewKindConfig> }

/** A change to `[review]`. `null` removes the key, so the default applies again. */
export interface ReviewPatch {
  rounds?: number | null
  kinds?: Partial<Record<ReviewKind, { [K in keyof ReviewKindConfig]?: ReviewKindConfig[K] | null }>>
}

/** The text Kernel sends the agent for each PR action (Settings > Pull requests, and per project). */
export interface PrInstructions { createInstructions: string; resolveInstructions: string; fixChecksInstructions: string; addressReviewInstructions: string }

/** `shared`: only `.kernel/settings.toml` sets the value. `local`: only `.kernel/settings.local.toml`. `override`: both, and the personal one wins. */
export type ProjectSettingSource = 'shared' | 'local' | 'override'

/**
 * The sections of a project's settings page. A route without one opens General. `setup` holds the files to copy, the workspace scripts,
 * run scripts and preview URLs; `prs` holds reviews, merge rules and PR instructions (KERNEL-680).
 */
export type ProjectSettingsSection = 'general' | 'git' | 'setup' | 'environment' | 'agents' | 'prs' | 'permissions' | 'skills'

/** One file a new worktree gets from the main checkout. `path` is relative to the project's folder, `size` is in bytes. */
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
 * A patch to a project's settings file. `null` removes the key so the app default applies again.
 * `runScripts` maps a name to its command, and `run` is `[scripts] run`. `mcp.aliases` and `agents.allow` change only the
 * names they list, and `null` removes one (KERNEL-432).
 */
export type ProjectSettingsPatch = {
  [K in Exclude<keyof ProjectSettings, 'sources' | 'runScripts' | 'team' | 'review' | 'mcp' | 'agents' | 'references' | 'missingReferences'>]?: { [P in keyof NonNullable<ProjectSettings[K]>]?: NonNullable<ProjectSettings[K]>[P] | null }
} & {
  runScripts?: Record<string, string | null>
  /** Only the personal file takes it, so a `shared` save that sets it is refused. An empty list or `null` removes the key (KERNEL-748). */
  references?: string[] | null
  mcp?: { aliases?: Record<string, string | null> }
  agents?: { unlistedTools?: UnlistedTools | null; allow?: Record<string, string[] | null>; openWorkspaces?: number | null; leadMode?: LeadMode | null }
}

/**
 * Scripts Kernel found for a project and offers, never applies (KERNEL-682). `source` is where they came from: Conductor's
 * or Superset's files in the repo, or `detected` from the repo's lockfiles. `file` is the one to show, as a path in the
 * repo (".conductor/settings.toml", "pnpm-lock.yaml"). `patch` goes to `settings.setProject` as it is. `notes` say what
 * the patch leaves out or left as written, one sentence each.
 */
export interface ScriptSuggestion {
  source: 'conductor' | 'superset' | 'detected'
  file: string
  patch: ProjectSettingsPatch
  notes: string[]
}

/** Recursive partial for settings patches. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object | null ? DeepPartial<T[K]> : T[K] }
