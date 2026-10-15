import { join } from 'node:path'
import type { QueuedMessage, Project, ProjectSettingsPatch, ScriptTrust, Workspace } from '@shared/types'
import { bus } from '../bus'
import { exec } from '../services/exec'
import { installCommand, installScripts, lockfileInstall, runsPackageInstall } from '../services/projects'
import { loadRepoSettings, localSettingsOwn, type RepoSettings, scriptsToTrust, ScriptTrustStore, trustHash, type TrustSubject } from '../services/settings'
import type { Handlers } from '../kernel'
import type { SetupHold } from './setup'
import { Feature } from './feature'

/** Store meta: the projects whose Install step waited for trust, so trusting runs it (KERNEL-260). */
const HELD_INSTALLS = 'heldInstalls'

/** Whether the user trusts the project's scripts, files.copy list, env files and install scripts (KERNEL-209, KERNEL-260, KERNEL-327). */
export class Trust extends Feature {
  /** The script text the user trusted, per project (KERNEL-209). Made the first time it is read (R1). */
  private get trusted(): ScriptTrustStore { return this.trustStore ??= new ScriptTrustStore(join(this.o.dataDir, 'trust.json')) }
  private trustStore?: ScriptTrustStore
  /**
   * Per project, the `[env] files` list `envFor` may read, as JSON: the user's own list, or the repo's once the project is
   * trusted. `untrusted` sets it each time it checks. A project with no entry reads no env file, since `envFor` is
   * synchronous and can't wait for the check (KERNEL-247).
   */
  readonly envFilesOk = new Map<string, string>()
  /** Per project, whether its scripts were trusted at the last check. `envFor` passes on setup's `$KERNEL_ENV` only then (KERNEL-405). */
  readonly projectTrusted = new Map<string, boolean>()

  /**
   * What the project's scripts and files.copy list wait on, or null when the user trusted this text already or there is
   * nothing to trust (KERNEL-209).
   */
  async untrusted(project: Project, repo?: RepoSettings): Promise<ScriptTrust | null> {
    const settings = repo ?? await loadRepoSettings(project.path)
    const subject = await this.subjectOf(project, settings)
    const hash = subject && trustHash(subject)
    const trusted = !subject || await this.trusted.has(project.id, hash!)
    // What envFor may read until the next check: the project's list, unless it is the repo's and waits for trust (KERNEL-247).
    this.envFilesOk.set(project.id, JSON.stringify(trusted || !subject?.envFiles ? settings.env.files : []))
    this.projectTrusted.set(project.id, trusted)
    if (trusted) return null
    const workspaceIds = this.store.workspaces(project.id).filter((w) => w.status === 'trust').map((w) => w.id)
    return { projectId: project.id, hash: hash!, ...subject!, workspaceIds }
  }

  /** Tell the renderer the project's scripts wait for the user. */
  async askTrust(projectId: string) {
    bus.push({ type: 'project.trust', projectId, trust: await this.untrusted(this.mustProject(projectId)) })
  }

  /**
   * The repo's text the project would run and copy, from `settings.toml` and from a personal file only when a commit brought
   * it (KERNEL-209, KERNEL-190). The user's own personal file needs no trusting. The install scripts in package.json are
   * the repo's text whoever wrote the setup script, and they join it when the project runs a package install: its setup script
   * does, or its Install step still has to (KERNEL-260). Only a JS install counts, so a `bundle install` that runs every
   * time doesn't keep them in (KERNEL-444). While the Install step waits, an install that runs the repo's own code joins
   * too, as the command itself (KERNEL-682).
   */
  private async subjectOf(project: Project, repo?: RepoSettings): Promise<TrustSubject | undefined> {
    const settings = repo ?? await loadRepoSettings(project.path)
    let subject = scriptsToTrust(settings, { localIsOwn: await localSettingsOwn(project.path) })
    const step = await installCommand(project.path)
    if (step.command && step.runsRepoCode && this.heldInstalls().includes(project.id)) subject = { ...(subject ?? { scripts: {}, copy: [] }), install: step.command }
    const installs = await installScripts(project.path)
    if (!installs.length) return subject
    const installing = (!!settings.scripts.setup && runsPackageInstall(settings.scripts.setup, await lockfileInstall(project.path))) || runsPackageInstall(step.command ?? '')
    return installing ? { ...(subject ?? { scripts: {}, copy: [] }), installScripts: installs } : subject
  }

  /** The repo's text as it is now, and whether the user trusts it. Nothing to trust counts as trusted. */
  async trustState(project: Project): Promise<{ subject?: TrustSubject; trusted: boolean }> {
    const subject = await this.subjectOf(project)
    return { subject, trusted: !subject || await this.trusted.has(project.id, trustHash(subject)) }
  }

  /** Trust the project's current text without asking, for text the user wrote in Settings or Kernel wrote itself. */
  async trustCurrent(project: Project, repo?: RepoSettings) {
    const subject = await this.subjectOf(project, repo)
    if (subject) await this.trusted.add(project.id, trustHash(subject))
    await this.untrusted(project, repo)
  }

  /**
   * Text saved in Settings counts as trusted, as far as the save wrote it (KERNEL-209). Project pages write the personal
   * file (KERNEL-190), whose text needs no trusting. A save into settings.toml, or into a personal file a commit brought,
   * trusts the result only when the project's text was trusted before it, and every value of the repo's text the project now
   * runs is either unchanged or one this save wrote into the file it now comes from. So no page vouches for text it
   * doesn't show, and clearing an override can't wave through the repo's value it was hiding.
   */
  async trustSaved(project: Project, before: { subject?: TrustSubject; trusted: boolean }, patch: ProjectSettingsPatch, shared: boolean, next: RepoSettings) {
    const after = await this.subjectOf(project, next)
    // Nothing of the repo's text runs any more, or only text the user already trusted, say after a personal override
    // of every repo script: whatever waited can go, and the prompt clears.
    if (!after || await this.trusted.has(project.id, trustHash(after))) {
      if (!before.trusted || this.store.workspaces(project.id).some((w) => w.status === 'trust')) await this.releaseHeld(project.id)
      return
    }
    if (!before.trusted) return
    const wrote = (group: 'scripts' | 'files' | 'env', key: string) => {
      const v = (patch[group] as Record<string, unknown> | undefined)?.[key]
      if (v === undefined || v === null || v === '') return false
      const source = next.sources[`${group}.${key}`]
      return shared ? source === 'shared' : source === 'local' || source === 'override'
    }
    const scriptsOk = (['setup', 'run', 'archive'] as const).every((k) => after.scripts[k] === before.subject?.scripts[k] || wrote('scripts', k))
    const copyOk = JSON.stringify(after.copy) === JSON.stringify(before.subject?.copy ?? []) || wrote('files', 'copy')
    // A named run script the save changed in the repo's text waits for the dialog (KERNEL-244).
    const runsOk = JSON.stringify(after.runScripts ?? []) === JSON.stringify(before.subject?.runScripts ?? [])
    const envOk = JSON.stringify(after.envFiles ?? []) === JSON.stringify(before.subject?.envFiles ?? []) || wrote('env', 'files')
    // No page writes package.json, so install scripts that are new, or changed, wait for the dialog (KERNEL-260).
    const installsOk = JSON.stringify(after.installScripts ?? []) === JSON.stringify(before.subject?.installScripts ?? [])
    if (!scriptsOk || !copyOk || !runsOk || !envOk || !installsOk) return
    await this.trustCurrent(project, next)
    await this.releaseHeld(project.id)
  }

  /** Put a workspace in `trust` and ask, or carry on at once when the text was trusted while it got here. */
  async holdForTrust(workspaceId: string): Promise<Workspace> {
    const held = this.updateWs(workspaceId, { status: 'trust' })
    if (held.status === 'archived') return held
    const project = this.mustProject(held.projectId)
    if (await this.untrusted(project)) await this.askTrust(project.id)
    else void this.k.setup.releaseTrust(held.id).catch(() => undefined)
    return held
  }

  /** The project's text is trusted now: clear the prompt, release every workspace waiting on it and run the Install step that waited. */
  private async releaseHeld(projectId: string) {
    bus.push({ type: 'project.trust', projectId, trust: null })
    for (const ws of this.store.workspaces(projectId)) if (ws.status === 'trust') void this.k.setup.releaseTrust(ws.id).catch(() => undefined)
    void this.runHeldInstall(projectId).catch(() => undefined)
  }

  private heldInstalls(): string[] { return this.store.meta<string[]>(HELD_INSTALLS) ?? [] }

  /**
   * Whether the project's Install step has to wait: the repo has install scripts, or the install runs the repo's own code
   * (KERNEL-444), and the user hasn't trusted the project's text. A project that waits is remembered, so trusting it runs the
   * install later (KERNEL-260). It is remembered before the check, since a waiting install that runs the repo's own code
   * is part of what the project trusts (KERNEL-682).
   */
  async holdInstall(project: Project, runsRepoCode = false): Promise<boolean> {
    if (!runsRepoCode && !(await installScripts(project.path)).length) return false
    this.store.saveMeta(HELD_INSTALLS, [...new Set([...this.heldInstalls(), project.id])])
    if (await this.untrusted(project)) return true
    this.store.saveMeta(HELD_INSTALLS, this.heldInstalls().filter((id) => id !== project.id))
    return false
  }

  /**
   * The install project setup skipped, run in the background now that the project is trusted. `installCommand` leaves out a stack
   * whose folder exists, such as node_modules, so an install that happened meanwhile isn't run twice. The project's log says how it went.
   */
  private async runHeldInstall(projectId: string) {
    if (!this.heldInstalls().includes(projectId)) return
    const project = this.store.project(projectId)
    if (project && await this.untrusted(project)) return
    this.store.saveMeta(HELD_INSTALLS, this.heldInstalls().filter((id) => id !== projectId))
    if (!project) return
    const { command } = await installCommand(project.path)
    if (!command) return
    const r = await exec('sh', ['-c', command], { cwd: project.path, timeoutMs: 600_000 })
    if (this.stopped) return
    if (r.code === 0) bus.activity({ kind: 'note', projectId, actor: 'kernel', text: 'installed dependencies after you trusted the install scripts in', object: project.name })
    else bus.activity({ kind: 'note', projectId, actor: 'kernel', text: `could not install dependencies in ${project.name}:`, object: (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ') || `${command} failed`, warn: true })
  }

  /**
   * `projects.trust`: the user read the scripts and trusts them. The hash must still match what the project reads, so text
   * that changed after the dialog opened asks again. Every workspace held in `trust` then copies its files, runs setup
   * and sends its brief, like a workspace that never waited (KERNEL-209).
   */
  private async trustProject(projectId: string, hash: string): Promise<void> {
    const project = this.mustProject(projectId)
    const subject = await this.subjectOf(project)
    if (subject && trustHash(subject) !== hash) {
      await this.askTrust(projectId)
      throw new Error("This project's scripts changed since you read them. Read them again before trusting them.")
    }
    if (subject) {
      await this.trusted.add(projectId, hash)
      // The install scripts and the Install step's command count only while the project still has an install to run, which the
      // install itself ends. The same text without them is a part of what the user just read, so it doesn't ask again
      // afterwards (KERNEL-260, KERNEL-682).
      if (subject.installScripts) await this.trusted.add(projectId, trustHash({ ...subject, installScripts: undefined }))
      if (subject.install) await this.trusted.add(projectId, trustHash({ ...subject, install: undefined }))
      if (subject.installScripts && subject.install) await this.trusted.add(projectId, trustHash({ ...subject, installScripts: undefined, install: undefined }))
    }
    await this.untrusted(project)
    await this.releaseHeld(projectId)
  }

  /**
   * Sessions brings back only the queues of workspaces whose setup failed. One waiting for trust holds its brief, and the
   * Lead's messages after it, the same way, so trusting after a restart still sends them in order (KERNEL-209). So does
   * one whose setup trusting started: its brief waits in the chat's queue, not in a `setups` hold, so `recoverSetups`
   * finds no brief to bring back. It still turns the workspace failed with its note, and Run again sends the queue.
   */
  recoverTrust(held: Record<string, QueuedMessage[]>) {
    const setups = this.store.meta<Record<string, SetupHold>>('setups') ?? {}
    for (const [chatId, queue] of Object.entries(held)) {
      const ws = this.store.chat(chatId) && this.store.workspace(this.store.chat(chatId)!.workspaceId)
      const waiting = ws?.status === 'trust' || (ws?.status === 'setup' && !setups[ws.id])
      // A setup that started in this run, as a moved chat's (KERNEL-405), already holds its queue.
      if (!waiting || !Array.isArray(queue) || this.k.setup.fresh.has(ws.id)) continue
      // A forked workspace's chat waits with nothing in its queue (KERNEL-346).
      if (!queue.length) this.sessions.hold(chatId)
      for (const m of queue) this.sessions.hold(chatId, m.parts, { ...(m.from ? { from: m.from } : {}), ...(m.update ? { update: m.update } : {}) })
    }
  }


  /** A removed project's trusted text goes with it. */
  forgetProject(projectId: string) { return this.trusted.forget(projectId) }
  handlers() {
    return {
      'projects.scriptTrust': async ({ projectId }) => this.untrusted(this.mustProject(projectId)),
      'projects.trust': async ({ projectId, hash }) => { await this.trustProject(projectId, hash); return { ok: true } }
    } satisfies Partial<Handlers>
  }
}
