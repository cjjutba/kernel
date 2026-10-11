import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppUpdate } from '@shared/types'
import type { Handlers } from '../kernel'
import { exec } from '../services/exec'
import { terminalScript } from '../services/health'
import { Feature } from './feature'

/** What the app shell asks Kernel for: updates, Terminal.app and the log export (KERNEL-325). */
export class App extends Feature {
  /** The activity log as plain text, one line per event, saved in the data folder. */
  private async exportLogs(): Promise<{ path: string }> {
    const dir = join(this.o.dataDir, 'logs')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `kernel-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    const lines = this.store.activity(undefined, 5000).reverse().map((e) => `${new Date(e.ts).toISOString()} ${[e.actor, e.text, e.object].filter(Boolean).join(' ')}`)
    await writeFile(path, lines.join('\n') + '\n')
    return { path }
  }

  /** Opens Terminal.app in `cwd` and runs `command` there. */
  private async openTerminal(cwd: string, command?: string) {
    const r = await exec('osascript', ['-e', terminalScript(cwd, command)], { timeoutMs: 15_000 })
    if (r.code !== 0) throw new Error(`Could not open Terminal: ${r.stderr.trim() || 'osascript failed'}`)
  }

  /** What Kernel reports with no updater: no update, and the notes it was given for What's new. */
  private noUpdate(): AppUpdate {
    return { status: 'idle', current: this.o.version ?? '0.0.0', currentNotes: this.o.currentNotes }
  }

  handlers() {
    return {
      'update.get': async () => this.o.updater?.get() ?? this.noUpdate(),
      'update.check': async () => this.o.updater?.check() ?? this.noUpdate(),
      // Electron closes the windows before before-quit on this path, so the shell asks here, before quitAndInstall (KERNEL-214).
      'update.install': async () => {
        if (!this.o.updater) throw new Error('No update to install')
        // Checked before asking: a confirmed restart stops Kernel, and an install that can't happen would leave it stopped.
        if (this.o.updater.get().status !== 'ready') throw new Error('No update is ready')
        if (this.o.confirmQuit && !(await this.o.confirmQuit('update'))) return { ok: true, canceled: true }
        this.o.updater.install()
        return { ok: true }
      },
      'app.openTerminal': async ({ cwd, command }) => { await this.openTerminal(cwd, command); return { ok: true } },
      'app.info': async () => ({ version: this.o.version ?? '0.1.0', dataDir: this.o.dataDir, telemetry: this.k.telemetry.canSend }),
      'app.exportLogs': async () => this.exportLogs()
    } satisfies Partial<Handlers>
  }
}
