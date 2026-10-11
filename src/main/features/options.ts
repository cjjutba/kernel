import type { AppUpdate, SharedFile } from '@shared/types'
import type { Cipher } from '../services/env'
import type { AppSettings } from '../services/settings'

/** What the app shell, or a test, passes to `new Kernel()`. */
export interface KernelOptions {
  dataDir: string; home?: string; claudeSettingsFile?: string; starterDir?: string; showNotification?: (n: import('@shared/types').Notification, o: { silent: boolean }) => void; inBackground?: () => boolean
  /** Can this machine reach Claude? The app passes a DNS probe; tests leave it out, so they never go offline. */
  probeNetwork?: () => Promise<boolean>
  /** Re-reads the user's PATH before each preflight, so "Check again" finds a CLI installed after launch. Tests leave it out. */
  refreshPath?: () => Promise<void>
  /** Kernel's version, for Settings > About. */
  version?: string
  /** Called with the settings at start and after every change, for the parts only the app shell can do (open at login). */
  onSettings?: (s: AppSettings) => void
  /** Auto-update (src/main/updater.ts). Only a packaged app has one; without it Kernel reports no update. */
  updater?: { get(): AppUpdate; check(): Promise<AppUpdate>; install(): void }
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
  /** Encrypts variables for `env.json`. The app passes `safeStorage`, tests a fake. Without one no variable can be set (KERNEL-247). */
  cipher?: Cipher
}
