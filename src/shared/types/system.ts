export interface PreflightCheck {
  /** `shell` shows only when reading the login shell timed out (KERNEL-448). */
  id: 'shell' | 'claude' | 'auth' | 'git' | 'gh' | 'hooks' | 'codex'
  ok: boolean
  /** A failing blocking check keeps the user on the checks screen. A failing non-blocking one is a warning (KERNEL-213). */
  blocking: boolean
  title: string
  /** Text in backticks shows as code, like `.zshrc`. */
  detail: string
  /** A muted line under the detail, like where the gh login comes from (KERNEL-437). Backticks show as code. */
  note?: string
  /** Right-hand meta, for example "v2.1.284" or "localhost:7420". */
  meta?: string
  /** `recheck` is a Check again button with nothing to copy. */
  fix?: { command?: string; action?: 'use-next-port' | 'show-process' | 'recheck' }
}

/** Hook server and installed hooks (CheckHooks.png, Settings > Hooks, the footer). */
export interface HookStatus {
  port: number
  listening: boolean
  /** All hook entries are present in ~/.claude/settings.json. */
  installed: boolean
  events: { name: string; installed: boolean; lastSeen?: number }[]
  /** The secret the hook command sends, so the Settings > Hooks snippet matches what Install writes (KERNEL-206). */
  token?: string
  /** Kernel couldn't bring its out-of-date entries up to date at start, so outside sessions don't report until Install. */
  needsInstall?: boolean
  /** Why the hooks can't be written or can't run, with its fix. Check hooks shows it in place of the event list (KERNEL-461). */
  problem?: HookProblem
  /** Which build's entries these are. Kernel Dev's go to their own path, so the snippet in Settings > Hooks carries it (KERNEL-675). */
  build?: HookBuild
}

/**
 * The installed app or Kernel Dev (`pnpm dev`). Each keeps its own token, port and hook entries, so both can run at once
 * (KERNEL-675). `run` is a dev run started inside a Kernel workspace, by its run script or a terminal: a copy of its own
 * with no entries in Claude's settings (KERNEL-679).
 */
export type HookBuild = 'app' | 'dev' | 'run'

/**
 * Why Kernel's hooks aren't installed or can't run, and the one step that fixes it (CheckHooksNotWritable.png and the four
 * beside it, KERNEL-461). Paths are as the user reads them, with ~ for home, and `fix` is a command to paste into Terminal.
 */
export type HookProblem =
  /** EACCES: the account can't add files to `dir`, where `file` lives. */
  | { kind: 'not-writable'; code: string; file: string; dir: string; fix: string }
  /** EROFS: `dir` is on the disk `disk`, mounted read-only. */
  | { kind: 'read-only'; code: string; dir: string; disk: string; fix: string }
  /** `file` links into `store`, a folder Kernel can't write, so Kernel leaves it alone. `nix` when the store is Nix's. */
  | { kind: 'symlink'; code: string; file: string; store: string; nix: boolean; fix: string }
  /**
   * Managed settings set `setting`, in `source` when it is a file. Kernel never edits them. `block` is Kernel's hooks as JSON,
   * for the admin, when only managed hooks run.
   */
  | { kind: 'managed'; setting: 'allowManagedHooksOnly' | 'disableAllHooks'; source?: string; block?: string }
  /** The user's own `file` sets disableAllHooks. */
  | { kind: 'off'; file: string }
  /** This is a dev run started inside a Kernel workspace, which never writes Claude's settings, so it has no hooks to fix (KERNEL-679). */
  | { kind: 'workspace-run' }

/**
 * Kernel's PR reads from GitHub (WorkspaceGitHubPaused.png, KERNEL-401). `pausedUntil` is set while a GitHub rate limit holds
 * the poll off, until that time. `slowDown` is GitHub's "slow down" limit rather than its rate limit running out.
 */
export interface GitHubStatus {
  pausedUntil?: number
  slowDown?: boolean
  /** Each room's PR status reads from GitHub, by room id, for the Pull requests page (KERNEL-861). Local rooms have none. */
  reads?: Record<string, PrReads>
}

/** How fresh a room's PR status is. `at` is the last read GitHub answered, kept when a later one fails; `failed` says why the last read failed. */
export interface PrReads {
  at?: number
  failed?: GitHubErrorKind
}

/**
 * Why a GitHub read failed (KERNEL-861): gh isn't signed in or GitHub rejected its token, the repo is gone or the account
 * can't see it, a rate limit is used up, GitHub can't be reached, or anything else. A failed call carries it in its error,
 * which `githubErrorKind` in `@shared/githubError` reads back.
 */
export type GitHubErrorKind = 'signed-out' | 'not-found' | 'rate-limited' | 'offline' | 'other'

/**
 * Where the GitHub CLI stands. `missing` is no gh, `offline` means gh has an account but couldn't reach GitHub to check its
 * token. `source` is gh's `tokenSource`: "keyring", "GH_TOKEN", "GITHUB_TOKEN" or the path of gh's config file (KERNEL-448).
 */
export interface GitHubAuth { state: 'missing' | 'signed-out' | 'offline' | 'ok'; login?: string; source?: string }

/** Auto-update (UpdateReady.png, WhatsNew.png). KERNEL-30. */
export interface AppUpdate {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  current: string
  version?: string
  notes?: { title: string; body: string }[]
  progress?: number
  error?: string
  /** Why this copy can't update itself, as a sentence: it runs from outside Applications, so Kernel never checks (KERNEL-443). */
  blocked?: string
  /** True on the first `update.get` after Kernel starts on a newly installed version, so What's new opens once. `notes` are that version's. */
  installed?: boolean
  /** The running version's notes, for What's new when no update is ready (KERNEL-154). Release builds carry them; dev runs have none. */
  currentNotes?: { title: string; body: string }[]
}

/**
 * An app on this Mac that Kernel can open a folder or file in, for the Open in menu (KERNEL-427). `id` is the catalog's, the
 * only thing the renderer sends back. `icon` is the app's own icon as a PNG data URL.
 */
export interface OpenApp {
  id: string
  name: string
  kind: 'finder' | 'editor' | 'terminal'
  icon?: string
}

export interface Integration {
  id: 'github' | 'linear'
  name: string
  connected: boolean
  detail: string
}
