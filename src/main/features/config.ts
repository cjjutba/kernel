import { basename, dirname, join } from 'node:path'
import type { ClaudePlan, DeepPartial, ProductionHint, Room, Workspace } from '@shared/types'
import type { Handlers } from '../kernel'
import { kernelHooksPresent } from '../services/hooksInstaller'
import { applySettingsPatch, configuredRemote, DEFAULT_SETTINGS, loadRepoSettings, PLAN_KEYS, remoteOf, saveAppSettings, saveRepoSettings, withPlan, type AppSettings, type RepoSettings, type SettingsError } from '../services/settings'
import { bus } from '../bus'
import { discoverMcp } from '../services/integrations'
import { discoverSkills } from '../services/files'
import { productionInCopy, resolveFilesToCopy } from '../services/filesToCopy'
import { listBranches } from '../services/worktrees'
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
    if (before.permissions.approvalTimeoutSec !== this.settings.permissions.approvalTimeoutSec && (await kernelHooksPresent(this.k.hooks.claudeSettings).catch(() => false))) await this.k.hooks.writeHooks(this.settings.hookPort)
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
    this.k.settings = withPlan(before, DEFAULT_SETTINGS(this.home), this.saved, plan)
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

  handlers() {
    return {
      'git.branches': async ({ roomId }) => {
        const { path } = this.mustRoom(roomId)
        const repo = await loadRepoSettings(path)
        this.roomRemotes.set(path, repo.workspace.remote)
        return listBranches(path, configuredRemote(repo, this.settings))
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
        return rs
      },
      'settings.setRoom': async ({ roomId, patch, shared }) => {
        const room = this.mustRoom(roomId)
        const before = await this.k.trust.trustState(room)
        const next = await saveRepoSettings(room.path, patch, shared)
        this.roomRemotes.set(room.path, next.workspace.remote)
        await this.k.trust.trustSaved(room, before, patch, !!shared, next)
        // A saved env files list counts once the check agrees, trusted or the user's own (KERNEL-247).
        await this.k.trust.untrusted(room, next)
        return next
      },
      // Lists, never copies, through the same confinement as the copy, so it shows nothing outside the repo (KERNEL-209).
      'files.preview': async ({ roomId, patterns }) => {
        const { path } = this.mustRoom(roomId)
        const { files } = await loadRepoSettings(path)
        return resolveFilesToCopy(path, patterns ?? files.copy, [], files.exclude)
      },
      'files.production': async ({ roomId }) => this.production(this.mustRoom(roomId)),
      'files.keepCopying': async ({ roomId, hints }) => {
        const room = this.mustRoom(roomId)
        const next = this.store.saveRoom({ ...room, keepCopying: [...new Set([...(room.keepCopying ?? []), ...hints.map(keepKey)])] })
        bus.push({ type: 'room', room: next })
        return next
      },
      'mcp.list': async ({ roomId }) => {
        const room = roomId ? this.mustRoom(roomId) : undefined
        const off = room ? (await loadRepoSettings(room.path)).disabled?.mcp ?? [] : []
        return discoverMcp(room?.path ?? this.home, this.home, off)
      }
    } satisfies Partial<Handlers>
  }
}
