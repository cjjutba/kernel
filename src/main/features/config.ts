import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { ClaudePlan, DeepPartial, ProductionHint, Room, RoomSettingsPatch, Workspace } from '@shared/types'
import type { Handlers } from '../kernel'
import { applySettingsPatch, configuredRemote, DEFAULT_SETTINGS, loadRepoSettings, PLAN_KEYS, remoteOf, saveAppSettings, saveRepoSettings, withPlan, type AppSettings, type RepoSettings, type SettingsError } from '../services/settings'
import { bus } from '../bus'
import { watchTeamSettings } from '../services/agents'
import { discoverSkills } from '../services/files'
import { productionInCopy, resolveFilesToCopy } from '../services/filesToCopy'
import { listBranches, listBranchTimes } from '../services/worktrees'
import { deepMerge } from '../services/settings'
import { Feature } from './feature'

/** The values `patch` names, as `after` holds them. */
function picked(after: any, patch: any): any {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return after
  return Object.fromEntries(Object.keys(patch).map((k) => [k, picked(after?.[k], patch[k])]))
}

const dotted = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o)

/** How `Room.keepCopying` names a file and variable (KERNEL-449). */
const keepKey = (h: Pick<ProductionHint, 'path' | 'name'>) => `${h.path}:${h.name}`

/** The app's settings, each room's settings file, and the git remote they name (KERNEL-325). */
export class Config extends Feature {
  /** Each room's own `workspace.remote` by path, for the review rule, which can't wait on a file read (`remoteFor`). */
  readonly roomRemotes = new Map<string, string | undefined>()

  get settingsFile() { return join(this.o.dataDir, 'settings.json') }

  /** Each room's watcher on its `.kernel/settings*.toml`, from the first time the window reads the room's settings (KERNEL-723). */
  private roomWatchers = new Map<string, () => void>()
  /** The room's settings the window last had from Kernel, as JSON. A file event that reads the same is Kernel's own save. */
  private roomShown = new Map<string, string>()

  /**
   * What the user chose, which is all settings.json holds: the keys they changed, or that an older file carried and still
   * counts as a choice. `k.settings` is these over the plan's defaults over the app's (KERNEL-225).
   */
  saved: DeepPartial<AppSettings> = {}
  /** The Claude plan the defaults follow, as the account last said. Kept under meta `plan`, so a start knows it before the account is read. */
  plan: ClaudePlan = 'unknown'

  /**
   * Settings > any app page. Saves what the page changed to settings.json and applies at once: running sessions read the
   * permission lists on their next tool call, the mode moves to them now, a higher limit on agents working at once starts what
   * was waiting, and a new approval timeout is read per request and rewritten into the installed hooks. `plan` and
   * `planDefaulted` are Kernel's to say, so a patch can't set them.
   */
  async setSettings(patch: Parameters<typeof applySettingsPatch>[1]): Promise<AppSettings> {
    const before = this.settings
    const { plan: _plan, planDefaulted: _from, ...chosen } = patch
    const after = applySettingsPatch(before, chosen)
    // What is saved is the patch's keys with the values the engine kept, such as a limit pulled back into its range.
    this.saved = deepMerge(this.saved, picked(after, chosen))
    this.k.settings = { ...after, planDefaulted: PLAN_KEYS.filter((k) => dotted(this.saved, k) === undefined) }
    await saveAppSettings(this.settingsFile, this.saved)
    this.sessions.applySettings(before)
    this.o.onSettings?.(this.settings)
    if (before.privacy?.telemetry !== this.settings.privacy.telemetry) await this.k.telemetry.settingsChanged()
    // The server reads the timeout per request. Only the copy in the installed hooks needs rewriting.
    if (before.permissions.approvalTimeoutSec !== this.settings.permissions.approvalTimeoutSec && (await this.k.hooks.present())) await this.k.hooks.writeHooks(this.settings.hookPort)
    return this.settings
  }

  /**
   * The account's plan changed, or was read for the first time: the settings the user never set follow it, and what waited on a
   * limit or a model setting is released. Nothing is written to settings.json, since none of this is a choice (KERNEL-225).
   */
  setPlan(plan: ClaudePlan) {
    if (plan === this.plan) return
    this.plan = plan
    this.store.saveMeta('plan', plan)
    const before = this.settings
    this.k.settings = withPlan(before, DEFAULT_SETTINGS(this.home, this.o.build), this.saved, plan)
    this.sessions.applySettings(before)
    this.o.onSettings?.(this.settings)
  }

  /**
   * The git remote a room fetches from and pushes to: the room's, then the app's, then origin (`remoteOf`, KERNEL-190).
   * Pass `repo` when the room's settings are already loaded.
   */
  async remoteFor(path: string, repo?: RepoSettings): Promise<string> {
    const r = repo ?? await loadRepoSettings(path)
    this.roomRemotes.set(path, r.workspace.remote)
    return remoteOf(r, this.settings)
  }

  remoteOfWs(ws: Workspace) { return this.remoteFor(this.mustRoom(ws.roomId).path) }

  /**
   * A room's settings file stopped parsing (KERNEL-231). The room runs on its other file and the app's defaults meanwhile, so
   * the room's feed keeps a warning with the line, and a toast says so now. A save from Settings refuses until it's fixed.
   */
  settingsError({ file, problem }: SettingsError) {
    const name = `.kernel/${basename(file)}`
    const where = problem.line ? ` on line ${problem.line}` : ''
    for (const room of this.store.rooms().filter((r) => join(r.path, '.kernel') === dirname(file))) {
      bus.activity({ kind: 'note', roomId: room.id, actor: 'kernel', text: `uses the defaults in ${room.name} because ${name} has a mistake${where}:`, object: problem.what, warn: true })
      bus.push({ type: 'toast', toast: { title: `${name} in ${room.name} has a mistake${where}`, sub: `${problem.what}. Kernel uses the defaults until you fix it.` } })
    }
  }

  /**
   * The room's files to copy that look like production, one hint per file: its strongest variable the user hasn't chosen
   * Keep copying for. Names only (KERNEL-449).
   */
  async production(room: Room): Promise<ProductionHint[]> {
    const { files } = await loadRepoSettings(room.path)
    const kept = new Set(room.keepCopying ?? [])
    const out = new Map<string, ProductionHint>()
    for (const h of await productionInCopy(room.path, files.copy, files.exclude)) if (!out.has(h.path) && !kept.has(keepKey(h))) out.set(h.path, h)
    return [...out.values()]
  }

  /**
   * Saves a patch to the room's `.kernel/settings.local.toml`, or to `settings.toml` with `shared`, then settles trust for
   * what changed. Settings and the Lead's set_room_scripts both save here (KERNEL-683).
   */
  async setRoom(roomId: string, patch: RoomSettingsPatch, shared?: boolean): Promise<RepoSettings> {
    const room = this.mustRoom(roomId)
    const before = await this.k.trust.trustState(room)
    const next = this.wrote(roomId, await saveRepoSettings(room.path, patch, shared))
    this.roomRemotes.set(room.path, next.workspace.remote)
    await this.k.trust.trustSaved(room, before, patch, !!shared, next)
    // A saved env files list counts once the check agrees, trusted or the user's own (KERNEL-247).
    await this.k.trust.untrusted(room, next)
    return next
  }

  /** Settings Kernel saved or read for the window. The watcher sends nothing for them, so a save doesn't echo back (KERNEL-723). */
  wrote(roomId: string, rs: RepoSettings): RepoSettings {
    this.roomShown.set(roomId, JSON.stringify(rs))
    this.watchRoom(roomId)
    return rs
  }

  /**
   * Watches the room's settings files, so a hand edit, Open settings.toml or a git pull reaches its Settings pages as
   * `settings.roomChanged`. Debounced at 200 ms, as an editor's save is often several events.
   */
  watchRoom(roomId: string) {
    if (this.stopped || this.roomWatchers.has(roomId)) return
    const room = this.store.room(roomId)
    if (!room || room.archived || !existsSync(room.path)) return
    this.roomWatchers.set(roomId, watchTeamSettings(room.path, () => void this.roomFileChanged(roomId).catch(() => undefined), 200))
  }

  /**
   * An archived or removed room, or a repo folder that's gone, stops its watcher. A gone folder is noticed at the next event
   * the watcher hears, as macOS sends none when the whole folder is deleted. Quit closes it in any case.
   */
  unwatchRoom(roomId: string) {
    this.roomWatchers.get(roomId)?.()
    this.roomWatchers.delete(roomId)
    this.roomShown.delete(roomId)
  }

  watching(roomId: string): boolean { return this.roomWatchers.has(roomId) }

  /** Quit, or a test done with this Kernel: every room's watcher stops. */
  stopWatching() {
    for (const roomId of [...this.roomWatchers.keys()]) this.unwatchRoom(roomId)
  }

  private async roomFileChanged(roomId: string) {
    if (this.stopped) return this.stopWatching()
    const room = this.store.room(roomId)
    if (!room || room.archived || !existsSync(room.path)) return this.unwatchRoom(roomId)
    // A file that stopped parsing raises `settingsError` here (KERNEL-231). The pages keep the last good values, so nothing is sent.
    const rs = await loadRepoSettings(room.path)
    if (!(await parses(room.path)) || !this.roomWatchers.has(roomId)) return
    const json = JSON.stringify(rs)
    if (this.roomShown.get(roomId) === json) return
    this.roomShown.set(roomId, json)
    this.roomRemotes.set(room.path, rs.workspace.remote)
    bus.push({ type: 'settings.roomChanged', roomId, settings: rs })
  }

  handlers() {
    return {
      'git.branches': async ({ roomId }) => {
        const { path } = this.mustRoom(roomId)
        const repo = await loadRepoSettings(path)
        this.roomRemotes.set(path, repo.workspace.remote)
        return listBranches(path, configuredRemote(repo, this.settings))
      },
      'git.branchList': async ({ roomId }) => {
        const { path } = this.mustRoom(roomId)
        const repo = await loadRepoSettings(path)
        this.roomRemotes.set(path, repo.workspace.remote)
        return listBranchTimes(path, configuredRemote(repo, this.settings))
      },
      'skills.list': async ({ roomId }) => {
        const off = (await loadRepoSettings(this.mustRoom(roomId).path)).disabled?.skills ?? []
        return (await discoverSkills(this.mustRoom(roomId).path, this.home)).map((s) => ({ ...s, enabled: !off.includes(s.name) }))
      },
      'settings.get': async () => this.settings,
      'settings.set': async ({ patch }) => this.setSettings(patch),
      'settings.room': async ({ roomId }) => {
        const { path } = this.mustRoom(roomId)
        const rs = await loadRepoSettings(path)
        // A read refreshes the room's remote as a save does, so a file edited outside Kernel takes effect (KERNEL-244).
        this.roomRemotes.set(path, rs.workspace.remote)
        return this.wrote(roomId, rs)
      },
      'settings.setRoom': async ({ roomId, patch, shared }) => this.setRoom(roomId, patch, shared),
      // Lists, never copies, through the same confinement as the copy, so it shows nothing outside the repo (KERNEL-209).
      'files.preview': async ({ roomId, patterns }) => {
        const { path } = this.mustRoom(roomId)
        const { files } = await loadRepoSettings(path)
        return resolveFilesToCopy(path, patterns ?? files.copy, [], files.exclude)
      },
      'files.production': async ({ roomId }) => this.production(this.mustRoom(roomId)),
      'files.keepCopying': async ({ roomId, hints }) => {
        const room = this.mustRoom(roomId)
        // Each file is kept whole: every variable in it that looks like production now, not only the one the banner names.
        // A variable added later warns again.
        const paths = new Set(hints.map((h) => h.path))
        const { files } = await loadRepoSettings(room.path)
        const now = (await productionInCopy(room.path, files.copy, files.exclude)).filter((h) => paths.has(h.path))
        const next = this.store.saveRoom({ ...room, keepCopying: [...new Set([...(room.keepCopying ?? []), ...hints.map(keepKey), ...now.map(keepKey)])] })
        bus.push({ type: 'room', room: next })
        return next
      }
    } satisfies Partial<Handlers>
  }
}

/** Whether both settings files parse. A missing file counts, since the room reads it as empty. */
async function parses(repo: string): Promise<boolean> {
  for (const name of ['settings.toml', 'settings.local.toml']) {
    const text = await readFile(join(repo, '.kernel', name), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    try { parseToml(text) } catch { return false }
  }
  return true
}
