import type { AppUpdate, HookBuild, SharedFile } from '@shared/types'
import type { Cipher } from '../services/env'
import type { Log } from '../services/log'
import type { Keychain } from '../services/providers/claudeHome'
import type { AppSettings } from '../services/settings'
import type { ShellRead } from '../services/shellPath'

/** What the app shell, or a test, passes to `new Kernel()`. */
export interface KernelOptions {
  dataDir: string; home?: string; claudeSettingsFile?: string; starterDir?: string; showNotification?: (n: import('@shared/types').Notification, o: { silent: boolean; sound?: string }) => void; inBackground?: () => boolean
  /**
   * Claude Code's subagents, for the plugin agents among them (KERNEL-463). The app passes `claudeAgents`, which starts
   * Claude Code to ask. Tests pass a stub or leave it out, and then no project has plugin agents.
   */
  claudeAgents?: (home: string) => Promise<import('@anthropic-ai/claude-agent-sdk').AgentInfo[]>
  /**
   * Team asks Claude Code or Codex whether it is signed in when an agent file pins one of its models, to flag a pin no
   * signed-in provider offers (KERNEL-550). The app passes true. Tests leave it out, so reading a team starts neither CLI.
   */
  checkPins?: boolean
  /**
   * An account just added gets its MCP servers checked, with a notice when some need a sign-in there (KERNEL-626). The app
   * passes true. Tests leave it out, so adding an account starts no check they didn't ask for.
   */
  checkMcpOnAdd?: boolean
  /**
   * Every account's MCP servers get checked a few seconds after launch and when the Mac wakes (KERNEL-936). The app passes
   * true. Tests leave it out, so no check starts that they didn't ask for.
   */
  checkMcp?: boolean
  /** Can this machine reach Claude? The app passes a DNS probe; tests leave it out, so they never go offline. */
  probeNetwork?: () => Promise<boolean>
  /**
   * Re-reads the user's PATH and shell variables before each preflight, so "Check again" finds a CLI installed after launch.
   * Its answer is what preflight says about the shell and the gh token (KERNEL-448). Tests leave it out.
   */
  refreshPath?: () => Promise<ShellRead | void>
  /** Kernel's version, for Settings > About. */
  version?: string
  /** Called with the settings at start and after every change, for the parts only the app shell can do (open at login). */
  onSettings?: (s: AppSettings) => void
  /** Auto-update (src/main/updater.ts). Only a packaged app has one; without it Kernel reports no update. */
  updater?: { get(): AppUpdate; check(): Promise<AppUpdate>; whenInstallable(): Promise<string>; install(failed?: () => void): void }
  /** Starts Kernel again on the running version, once. Restart to update uses it when the install did not start (KERNEL-1020). */
  relaunch?: () => void
  /** The running version's notes for What's new when there's no updater. A dev run reads them from the repo. */
  currentNotes?: AppUpdate['currentNotes']
  /** What Linear calls and the GitHub avatar download go through. Tests pass a stub; the app leaves it out. */
  fetch?: typeof fetch
  /**
   * Asked before Restart to update quits. False means the user canceled. True means Kernel has stopped and the app
   * is quitting (KERNEL-214). Without it the restart goes ahead.
   */
  confirmQuit?: (reason: 'update') => Promise<boolean>
  /**
   * Draws a PNG thumbnail of a shared file's version for its card, or null when it can't (KERNEL-302). The app passes the
   * preview host (KERNEL-303); tests pass a stub or leave it out, and a file then has no thumbnail.
   */
  capture?: { thumbnail(f: SharedFile, version: number): Promise<Buffer | null> }
  /** Shows a file in Finder, for a shared file's Show in Finder. Left out, it does nothing. */
  reveal?: (path: string) => void
  /** Opens a file in the Mac's default app, for a shared PDF's Open in Preview. Rejects with the reason when it can't. Left out, it does nothing. */
  openFile?: (path: string) => Promise<void>
  /** An app's own icon as a PNG data URL, for the Open in menu (KERNEL-427). Left out, the menu lists apps without icons. */
  appIcon?: (appPath: string) => Promise<string | undefined>
  /** Opens a web page in the browser, for a provider's sign-in (KERNEL-406). Left out, the sign-in page's link shows in Settings. */
  openExternal?: (url: string) => Promise<void>
  /** Encrypts variables for `env.json`. The app passes `safeStorage`, tests a fake. Without one no variable can be set (KERNEL-247). */
  cipher?: Cipher
  /**
   * The Mac's Keychain, where each Claude login keeps its MCP servers' sign-ins, which Kernel shares between logins
   * (KERNEL-616). The app passes `macKeychain`, tests a fake. Without one, each login keeps only its own sign-ins.
   */
  keychain?: Keychain
  /**
   * Where usage data goes, and the Mac it comes from (KERNEL-397). Only a packaged release build with a key passes it, and
   * only when DO_NOT_TRACK and KERNEL_TELEMETRY=0 aren't set. Without it Kernel never sends, whatever Settings, Privacy says.
   */
  telemetry?: { key: string; host: string; os?: string; arch?: string }
  /**
   * Kernel's log, for lines worth keeping that aren't warnings or errors, like Team update delivery timings (KERNEL-651).
   * The app passes its `Log`. Fixture runs and tests leave it out, and those lines go only to the console.
   */
  log?: Pick<Log, 'info'>
  /**
   * The installed app or Kernel Dev (KERNEL-675). It picks the default hook port and which entries in Claude's settings are
   * this build's. Tests and the installed app leave it out, which is `app`.
   */
  build?: HookBuild
  /**
   * The installed app's entries in Claude's settings were Kernel Dev's too until this launch: it just moved its data over, or
   * it had the installed app's hook token and now has its own (KERNEL-675). Kernel Dev's start then adds its own next to them.
   */
  hooksWereShared?: boolean
}
