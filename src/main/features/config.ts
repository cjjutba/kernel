import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { ClaudePlan, DeepPartial, ProductionHint, Project, ProjectSettingsPatch, Workspace } from '@shared/types'
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

/** How `Project.keepCopying` names a file and variable (KERNEL-449). */
const keepKey = (h: Pick<ProductionHint, 'path' | 'name'>) => `${h.path}:${h.name}`

/** The app's settings, each project's settings file, and the git remote they name (KERNEL-325). */
export class Config extends Feature {
  /** Each project's own `workspace.remote` by path, for the review rule, which can't wait on a file read (`remoteFor`). */
  readonly projectRemotes = new Map<string, string | undefined>()

  get settingsFile() { return join(this.o.dataDir, 'settings.json') }

  /** Each project's watcher on its `.kernel/settings*.toml`, from the first time the window reads the project's settings (KERNEL-723). */
  private projectWatchers = new Map<string, () => void>()
  /** The project's settings the window last had from Kernel, as JSON. A file event that reads the same is Kernel's own save. */
  private projectShown = new Map<string, string>()

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
    if (before.pr.autoReview === false && this.settings.pr.autoReview) void this.k.reviews.reviewReady().catch(() => undefined)
    if (before.privacy?.telemetry !== this.settings.privacy.telemetry) await this.k.telemetry.settingsChanged()
    await this.k.remote.settingsChanged(before.remote)
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
   * The git remote a project fetches from and pushes to: the project's, then the app's, then origin (`remoteOf`, KERNEL-190).
   * Pass `repo` when the project's settings are already loaded.
   */
  async remoteFor(path: string, repo?: RepoSettings): Promise<string> {
    const r = repo ?? await loadRepoSettings(path)
    this.projectRemotes.set(path, r.workspace.remote)
    return remoteOf(r, this.settings)
  }

  remoteOfWs(ws: Workspace) { return this.remoteFor(this.mustProject(ws.projectId).path) }

  /**
   * A project's settings file stopped parsing (KERNEL-231). The project runs on its other file and the app's defaults meanwhile, so
   * the project's feed keeps a warning with the line, and a toast says so now. A save from Settings refuses until it's fixed.
   */
  settingsError({ file, problem }: SettingsError) {
    const name = `.kernel/${basename(file)}`
    const where = problem.line ? ` on line ${problem.line}` : ''
    for (const project of this.store.projects().filter((r) => join(r.path, '.kernel') === dirname(file))) {
      bus.activity({ kind: 'note', projectId: project.id, actor: 'kernel', text: `uses the defaults in ${project.name} because ${name} has a mistake${where}:`, object: problem.what, warn: true })
      bus.push({ type: 'toast', toast: { title: `${name} in ${project.name} has a mistake${where}`, sub: `${problem.what}. Kernel uses the defaults until you fix it.` } })
    }
  }

  /**
   * The project's files to copy that look like production, one hint per file: its strongest variable the user hasn't chosen
   * Keep copying for. Names only (KERNEL-449).
   */
  async production(project: Project): Promise<ProductionHint[]> {
    const { files } = await loadRepoSettings(project.path)
    const kept = new Set(project.keepCopying ?? [])
    const out = new Map<string, ProductionHint>()
    for (const h of await productionInCopy(project.path, files.copy, files.exclude)) if (!out.has(h.path) && !kept.has(keepKey(h))) out.set(h.path, h)
    return [...out.values()]
  }

  /**
   * Saves a patch to the project's `.kernel/settings.local.toml`, or to `settings.toml` with `shared`. Settings and the Lead's
   * set_project_scripts both save here (KERNEL-683).
   */
  async setProject(projectId: string, patch: ProjectSettingsPatch, shared?: boolean): Promise<RepoSettings> {
    const project = this.mustProject(projectId)
    const next = this.wrote(projectId, await saveRepoSettings(project.path, patch, shared))
    this.projectRemotes.set(project.path, next.workspace.remote)
    return next
  }

  /** Settings Kernel saved or read for the window. The watcher sends nothing for them, so a save doesn't echo back (KERNEL-723). */
  wrote(projectId: string, rs: RepoSettings): RepoSettings {
    this.projectShown.set(projectId, JSON.stringify(rs))
    this.watchProject(projectId)
    return rs
  }

  /**
   * Watches the project's settings files, so a hand edit, Open settings.toml or a git pull reaches its Settings pages as
   * `settings.projectChanged`. Debounced at 200 ms, as an editor's save is often several events.
   */
  watchProject(projectId: string) {
    if (this.stopped || this.projectWatchers.has(projectId)) return
    const project = this.store.project(projectId)
    if (!project || project.archived || !existsSync(project.path)) return
    this.projectWatchers.set(projectId, watchTeamSettings(project.path, () => void this.projectFileChanged(projectId).catch(() => undefined), 200))
  }

  /**
   * An archived or removed project, or a repo folder that's gone, stops its watcher. A gone folder is noticed at the next event
   * the watcher hears, as macOS sends none when the whole folder is deleted. Quit closes it in any case.
   */
  unwatchProject(projectId: string) {
    this.projectWatchers.get(projectId)?.()
    this.projectWatchers.delete(projectId)
    this.projectShown.delete(projectId)
  }

  watching(projectId: string): boolean { return this.projectWatchers.has(projectId) }

  /** Quit, or a test done with this Kernel: every project's watcher stops. */
  stopWatching() {
    for (const projectId of [...this.projectWatchers.keys()]) this.unwatchProject(projectId)
  }

  private async projectFileChanged(projectId: string) {
    if (this.stopped) return this.stopWatching()
    const project = this.store.project(projectId)
    if (!project || project.archived || !existsSync(project.path)) return this.unwatchProject(projectId)
    // A file that stopped parsing raises `settingsError` here (KERNEL-231). The pages keep the last good values, so nothing is sent.
    const rs = await loadRepoSettings(project.path)
    if (!(await parses(project.path)) || !this.projectWatchers.has(projectId)) return
    const json = JSON.stringify(rs)
    if (this.projectShown.get(projectId) === json) return
    this.projectShown.set(projectId, json)
    this.projectRemotes.set(project.path, rs.workspace.remote)
    bus.push({ type: 'settings.projectChanged', projectId, settings: rs })
  }

  handlers() {
    return {
      'git.branches': async ({ projectId }) => {
        const { path } = this.mustProject(projectId)
        const repo = await loadRepoSettings(path)
        this.projectRemotes.set(path, repo.workspace.remote)
        return listBranches(path, configuredRemote(repo, this.settings))
      },
      'git.branchList': async ({ projectId }) => {
        const { path } = this.mustProject(projectId)
        const repo = await loadRepoSettings(path)
        this.projectRemotes.set(path, repo.workspace.remote)
        return listBranchTimes(path, configuredRemote(repo, this.settings))
      },
      'skills.list': async ({ projectId }) => {
        const off = (await loadRepoSettings(this.mustProject(projectId).path)).disabled?.skills ?? []
        return (await discoverSkills(this.mustProject(projectId).path, this.home)).map((s) => ({ ...s, enabled: !off.includes(s.name) }))
      },
      'settings.get': async () => this.settings,
      'settings.set': async ({ patch }) => this.setSettings(patch),
      'settings.project': async ({ projectId }) => {
        const { path } = this.mustProject(projectId)
        const rs = await loadRepoSettings(path)
        // A read refreshes the project's remote as a save does, so a file edited outside Kernel takes effect (KERNEL-244).
        this.projectRemotes.set(path, rs.workspace.remote)
        return this.wrote(projectId, rs)
      },
      'settings.setProject': async ({ projectId, patch, shared }) => this.setProject(projectId, patch, shared),
      // Lists, never copies, through the same confinement as the copy, so it shows nothing outside the repo (KERNEL-209).
      'files.preview': async ({ projectId, patterns }) => {
        const { path } = this.mustProject(projectId)
        const { files } = await loadRepoSettings(path)
        return resolveFilesToCopy(path, patterns ?? files.copy, [], files.exclude)
      },
      'files.production': async ({ projectId }) => this.production(this.mustProject(projectId)),
      'files.keepCopying': async ({ projectId, hints }) => {
        const project = this.mustProject(projectId)
        // Each file is kept whole: every variable in it that looks like production now, not only the one the banner names.
        // A variable added later warns again.
        const paths = new Set(hints.map((h) => h.path))
        const { files } = await loadRepoSettings(project.path)
        const now = (await productionInCopy(project.path, files.copy, files.exclude)).filter((h) => paths.has(h.path))
        const next = this.store.saveProject({ ...project, keepCopying: [...new Set([...(project.keepCopying ?? []), ...hints.map(keepKey), ...now.map(keepKey)])] })
        bus.push({ type: 'project', project: next })
        return next
      }
    } satisfies Partial<Handlers>
  }
}

/** Whether both settings files parse. A missing file counts, since the project reads it as empty. */
async function parses(repo: string): Promise<boolean> {
  for (const name of ['settings.toml', 'settings.local.toml']) {
    const text = await readFile(join(repo, '.kernel', name), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    try { parseToml(text) } catch { return false }
  }
  return true
}
