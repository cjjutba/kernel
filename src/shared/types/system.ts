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
}

/**
 * Kernel's PR reads from GitHub (WorkspaceGitHubPaused.png, KERNEL-401). `pausedUntil` is set while a GitHub rate limit holds
 * the poll off, until that time. `slowDown` is GitHub's "slow down" limit rather than its rate limit running out.
 */
export interface GitHubStatus {
  pausedUntil?: number
  slowDown?: boolean
}

/** Auto-update (UpdateReady.png, WhatsNew.png). KERNEL-30. */
export interface AppUpdate {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  current: string
  version?: string
  notes?: { title: string; body: string }[]
  progress?: number
  error?: string
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
  id: 'github' | 'linear' | 'vercel' | 'remote'
  name: string
  connected: boolean
  detail: string
}
