import { access, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppUpdate, OpenApp } from '@shared/types'
import type { Handlers } from '../kernel'
import { exec } from '../services/exec'
import { terminalScript } from '../services/health'
import { defaultApp, defaultEditor, findApps, launch, mustBeInside, OPEN_APPS, type FoundApp, type OpenAppsSystem } from '../services/openApps'
import { insideRoots } from '../windowGuard'
import { Feature } from './feature'

/** What the app shell asks Kernel for: updates, Terminal.app, the log export (KERNEL-325) and Open in (KERNEL-427). */
export class App extends Feature {
  /** What finding and opening apps goes through. Tests swap it, so nothing on the Mac opens. */
  system: OpenAppsSystem = { exists: (p) => access(p).then(() => true, () => false), exec }
  /** The apps found last, so Open in editor doesn't search Spotlight on every click. The menu finds them again each time. */
  private found?: Promise<FoundApp[]>

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

  /** The installed apps for the Open in menu, each with its icon, and the one its button opens. */
  private async openApps(): Promise<{ apps: OpenApp[]; defaultId?: string }> {
    const found = await (this.found = findApps(this.system, this.home))
    const apps = await Promise.all(found.map(async ({ app, path }) => {
      const icon = await this.o.appIcon?.(path).catch(() => undefined)
      return { id: app.id, name: app.name, kind: app.kind, ...(icon ? { icon } : {}) }
    }))
    return { apps, defaultId: defaultApp(found, this.settings.general.openIn)?.app.id }
  }

  /**
   * Opens `path` in the app the user picked, which becomes the default, or in the default editor. Only a catalog app found on
   * this Mac, launched with `open -a`. Never `shell.openPath`: on a tracked run.command or .terminal file it runs the file,
   * and checkouts carry no quarantine flag.
   */
  private async openIn(path: string, id?: string) {
    mustBeInside(path, [...this.store.rooms(), ...this.store.workspaces()].map((x) => x.path))
    // A chat with Rowan has no folder until its worktree is made (KERNEL-542).
    if (this.store.workspaces().some((w) => w.worktreePending && insideRoots(path, [w.path]))) throw new Error("This chat's worktree isn't made yet.")
    const found = await (this.found ??= findApps(this.system, this.home))
    const saved = this.settings.general.openIn
    let to: FoundApp | undefined
    if (id === undefined) to = defaultEditor(found, saved) ?? found.find((f) => f.app.kind === 'finder')
    else {
      const known = OPEN_APPS.find((a) => a.id === id)
      if (!known) throw new Error(`Kernel can't open files in ${String(id)}`)
      to = found.find((f) => f.app.id === id)
      if (!to) throw new Error(`${known.name} isn't installed on this Mac`)
    }
    const dir = await stat(path).then((s) => s.isDirectory(), () => false)
    const how = to ? launch(to, path, dir) : { reveal: path }
    if ('reveal' in how) this.o.reveal?.(how.reveal)
    else if ((await this.system.exec('open', how.args)).code !== 0) throw new Error(`Could not open in ${to!.app.name}`)
    if (id !== undefined && id !== saved) await this.k.config.setSettings({ general: { openIn: id } })
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
      'app.openApps': async () => this.openApps(),
      'app.openIn': async ({ path, app }) => { await this.openIn(path, app); return { ok: true } },
      'app.info': async () => ({ version: this.o.version ?? '0.1.0', dataDir: this.o.dataDir, telemetry: this.k.telemetry.canSend }),
      'app.exportLogs': async () => this.exportLogs()
    } satisfies Partial<Handlers>
  }
}
