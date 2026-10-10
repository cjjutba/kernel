/**
 * Asking before a quit stops working agents (KERNEL-214). Electron stays out of this file: index.ts passes in the
 * dialog, the stop and the quit, so tests cover every path without an app.
 */

/** Why Kernel is quitting. `user` is Cmd+Q or the menu, `update` is Restart to update, `shutdown` is the Mac shutting down, restarting or logging out. */
export type QuitReason = 'user' | 'update' | 'shutdown' | 'bootFailed'

/** How long a quit waits for `Kernel.stop()` before it quits anyway. */
export const STOP_CAP_MS = 5000

/**
 * Whether a quit asks first. Only a quit the user started asks, and only while an agent is working. A Mac that is
 * shutting down won't wait on a dialog, and a failed boot has no agents to lose.
 */
export function quitStep(working: number, reason: QuitReason, confirmed: boolean): 'ask' | 'quit' {
  if (confirmed || working === 0) return 'quit'
  return reason === 'user' || reason === 'update' ? 'ask' : 'quit'
}

/** The native dialog. Cancel is the default and the cancel button, since the dialog is there to catch an accidental quit. */
export interface QuitDialog { message: string; detail: string; buttons: [string, 'Cancel']; defaultId: 1; cancelId: 1 }

export function quitDialog(working: number, reason: QuitReason): QuitDialog {
  return {
    message: working === 1 ? '1 agent is working' : `${working} agents are working`,
    // KERNEL-215 changes this once agents carry on after a relaunch.
    detail: 'Quitting stops them partway through their work.',
    buttons: [reason === 'update' ? 'Restart' : 'Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1
  }
}

/** Waits for `work` for at most `ms`. A stop that fails or hangs must not keep Kernel from quitting. */
export async function capped(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), ms) })
  const done = work.then(() => 'done' as const, (err: unknown) => { console.error('[kernel] stop failed', err); return 'done' as const })
  if ((await Promise.race([done, late])) === 'late') console.warn(`[kernel] stop took longer than ${ms} ms, quitting anyway`)
  clearTimeout(timer)
}

/**
 * Runs every quit. `before-quit` is held until the user answers and Kernel has stopped, then the app quits for real.
 * Restart to update goes through `confirmUpdate` instead, because Electron closes the windows before `before-quit`
 * fires on that path.
 */
export class QuitGuard {
  private reason: QuitReason = 'user'
  /** The dialog is up or Kernel is stopping. Another quit in the meantime does nothing. */
  private pending = false
  /** Kernel has stopped, so the next `before-quit` goes through. */
  private done = false

  constructor(private d: {
    /** Agents with a turn running. */
    working: () => number
    /** Shows the dialog. True means the user chose Quit or Restart. */
    ask: (dialog: QuitDialog) => Promise<boolean>
    stop: () => Promise<void>
    quit: () => void
    /** Fixture and headless runs never ask. */
    quiet?: boolean
    capMs?: number
  }) {}

  /** powerMonitor's `shutdown`: the Mac is shutting down, restarting or logging out. */
  shutdown() { this.reason = 'shutdown' }

  bootFailed() { this.reason = 'bootFailed' }

  /** `before-quit`. */
  beforeQuit(e: { preventDefault(): void }) {
    if (this.done) return
    e.preventDefault()
    void this.settle(this.reason).then((go) => { if (go) this.d.quit() })
  }

  /** Restart to update. True once Kernel has stopped and `quitAndInstall` may run; false when the user canceled. */
  confirmUpdate(): Promise<boolean> { return this.settle('update') }

  private async settle(reason: QuitReason): Promise<boolean> {
    if (this.pending) return false
    this.pending = true
    try {
      const working = this.d.working()
      if (quitStep(working, reason, !!this.d.quiet) === 'ask' && !(await this.d.ask(quitDialog(working, reason)))) return false
      await capped(Promise.resolve().then(() => this.d.stop()), this.d.capMs ?? STOP_CAP_MS)
      this.done = true
      return true
    } finally {
      this.pending = false
    }
  }
}
