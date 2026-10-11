import { join } from 'node:path'
import type { QueuedMessage, Room, RoomSettingsPatch, ScriptTrust, Workspace } from '@shared/types'
import { bus } from '../bus'
import { exec } from '../services/exec'
import { installCommand, installScripts, lockfileInstall, runsPackageInstall } from '../services/rooms'
import { loadRepoSettings, localSettingsOwn, type RepoSettings, scriptsToTrust, ScriptTrustStore, trustHash, type TrustSubject } from '../services/settings'
import type { Handlers } from '../kernel'
import type { SetupHold } from './setup'
import { Feature } from './feature'

/** Store meta: the rooms whose Install step waited for trust, so trusting runs it (KERNEL-260). */
const HELD_INSTALLS = 'heldInstalls'

/** Whether the user trusts the room's scripts, files.copy list, env files and install scripts (KERNEL-209, KERNEL-260, KERNEL-327). */
export class Trust extends Feature {
  /** The script text the user trusted, per room (KERNEL-209). Made the first time it is read (R1). */
  private get trusted(): ScriptTrustStore { return this.trustStore ??= new ScriptTrustStore(join(this.o.dataDir, 'trust.json')) }
  private trustStore?: ScriptTrustStore
  /**
   * Per room, the `[env] files` list `envFor` may read, as JSON: the user's own list, or the repo's once the room is
   * trusted. `untrusted` sets it each time it checks. A room with no entry reads no env file, since `envFor` is
   * synchronous and can't wait for the check (KERNEL-247).
   */
  readonly envFilesOk = new Map<string, string>()
  /** Per room, whether its scripts were trusted at the last check. `envFor` passes on setup's `$KERNEL_ENV` only then (KERNEL-405). */
  readonly roomTrusted = new Map<string, boolean>()

  /**
   * What the room's scripts and files.copy list wait on, or null when the user trusted this text already or there is
   * nothing to trust (KERNEL-209).
   */
  async untrusted(room: Room, repo?: RepoSettings): Promise<ScriptTrust | null> {
    const settings = repo ?? await loadRepoSettings(room.path)
    const subject = await this.subjectOf(room, settings)
    const hash = subject && trustHash(subject)
    const trusted = !subject || await this.trusted.has(room.id, hash!)
    // What envFor may read until the next check: the room's list, unless it is the repo's and waits for trust (KERNEL-247).
    this.envFilesOk.set(room.id, JSON.stringify(trusted || !subject?.envFiles ? settings.env.files : []))
    this.roomTrusted.set(room.id, trusted)
    if (trusted) return null
    const workspaceIds = this.store.workspaces(room.id).filter((w) => w.status === 'trust').map((w) => w.id)
    return { roomId: room.id, hash: hash!, ...subject!, workspaceIds }
  }

  /** Tell the renderer the room's scripts wait for the user. */
  async askTrust(roomId: string) {
    bus.push({ type: 'room.trust', roomId, trust: await this.untrusted(this.mustRoom(roomId)) })
  }

  /**
   * The repo's text the room would run and copy, from `settings.toml` and from a personal file only when a commit brought
   * it (KERNEL-209, KERNEL-190). The user's own personal file needs no trusting. The install scripts in package.json are
   * the repo's text whoever wrote the setup script, and they join it when the room runs a package install: its setup script
   * does, or its Install step still has to (KERNEL-260).
   */
  private async subjectOf(room: Room, repo?: RepoSettings): Promise<TrustSubject | undefined> {
    const settings = repo ?? await loadRepoSettings(room.path)
    const subject = scriptsToTrust(settings, { localIsOwn: await localSettingsOwn(room.path) })
    const installs = await installScripts(room.path)
    if (!installs.length) return subject
    const installing = (!!settings.scripts.setup && runsPackageInstall(settings.scripts.setup, await lockfileInstall(room.path))) || !!(await installCommand(room.path)).command
    return installing ? { ...(subject ?? { scripts: {}, copy: [] }), installScripts: installs } : subject
  }

  /** The repo's text as it is now, and whether the user trusts it. Nothing to trust counts as trusted. */
  async trustState(room: Room): Promise<{ subject?: TrustSubject; trusted: boolean }> {
    const subject = await this.subjectOf(room)
    return { subject, trusted: !subject || await this.trusted.has(room.id, trustHash(subject)) }
  }

  /** Trust the room's current text without asking, for text the user wrote in Settings or Kernel wrote itself. */
  async trustCurrent(room: Room, repo?: RepoSettings) {
    const subject = await this.subjectOf(room, repo)
    if (subject) await this.trusted.add(room.id, trustHash(subject))
    await this.untrusted(room, repo)
  }

  /**
   * Text saved in Settings counts as trusted, as far as the save wrote it (KERNEL-209). Room pages write the personal
   * file (KERNEL-190), whose text needs no trusting. A save into settings.toml, or into a personal file a commit brought,
   * trusts the result only when the room's text was trusted before it, and every value of the repo's text the room now
   * runs is either unchanged or one this save wrote into the file it now comes from. So no page vouches for text it
   * doesn't show, and clearing an override can't wave through the repo's value it was hiding.
   */
  async trustSaved(room: Room, before: { subject?: TrustSubject; trusted: boolean }, patch: RoomSettingsPatch, shared: boolean, next: RepoSettings) {
    const after = await this.subjectOf(room, next)
    // Nothing of the repo's text runs any more, or only text the user already trusted, say after a personal override
    // of every repo script: whatever waited can go, and the prompt clears.
    if (!after || await this.trusted.has(room.id, trustHash(after))) {
      if (!before.trusted || this.store.workspaces(room.id).some((w) => w.status === 'trust')) await this.releaseHeld(room.id)
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
    await this.trustCurrent(room, next)
    await this.releaseHeld(room.id)
  }

  /** Put a workspace in `trust` and ask, or carry on at once when the text was trusted while it got here. */
  async holdForTrust(workspaceId: string): Promise<Workspace> {
    const held = this.updateWs(workspaceId, { status: 'trust' })
    if (held.status === 'archived') return held
    const room = this.mustRoom(held.roomId)
    if (await this.untrusted(room)) await this.askTrust(room.id)
    else void this.k.setup.releaseTrust(held.id).catch(() => undefined)
    return held
  }

  /** The room's text is trusted now: clear the prompt, release every workspace waiting on it and run the Install step that waited. */
  private async releaseHeld(roomId: string) {
    bus.push({ type: 'room.trust', roomId, trust: null })
    for (const ws of this.store.workspaces(roomId)) if (ws.status === 'trust') void this.k.setup.releaseTrust(ws.id).catch(() => undefined)
    void this.runHeldInstall(roomId).catch(() => undefined)
  }

  private heldInstalls(): string[] { return this.store.meta<string[]>(HELD_INSTALLS) ?? [] }

  /**
   * Whether the room's Install step has to wait: the repo has install scripts and the user hasn't trusted them. A room that
   * waits is remembered, so trusting it runs the install later (KERNEL-260).
   */
  async holdInstall(room: Room): Promise<boolean> {
    if (!(await installScripts(room.path)).length || !(await this.untrusted(room))) return false
    this.store.saveMeta(HELD_INSTALLS, [...new Set([...this.heldInstalls(), room.id])])
    return true
  }

  /**
   * The install room setup skipped, run in the background now that the room is trusted. `installCommand` runs nothing when
   * node_modules exists, so an install that happened meanwhile isn't run twice. The room's log says how it went.
   */
  private async runHeldInstall(roomId: string) {
    if (!this.heldInstalls().includes(roomId)) return
    const room = this.store.room(roomId)
    if (room && await this.untrusted(room)) return
    this.store.saveMeta(HELD_INSTALLS, this.heldInstalls().filter((id) => id !== roomId))
    if (!room) return
    const { command } = await installCommand(room.path)
    if (!command) return
    const r = await exec('sh', ['-c', command], { cwd: room.path, timeoutMs: 600_000 })
    if (this.stopped) return
    if (r.code === 0) bus.activity({ kind: 'note', roomId, actor: 'kernel', text: 'installed dependencies after you trusted the install scripts in', object: room.name })
    else bus.activity({ kind: 'note', roomId, actor: 'kernel', text: `could not install dependencies in ${room.name}:`, object: (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ') || `${command} failed`, warn: true })
  }

  /**
   * `rooms.trust`: the user read the scripts and trusts them. The hash must still match what the room reads, so text
   * that changed after the dialog opened asks again. Every workspace held in `trust` then copies its files, runs setup
   * and sends its brief, like a workspace that never waited (KERNEL-209).
   */
  private async trustRoom(roomId: string, hash: string): Promise<void> {
    const room = this.mustRoom(roomId)
    const subject = await this.subjectOf(room)
    if (subject && trustHash(subject) !== hash) {
      await this.askTrust(roomId)
      throw new Error("This room's scripts changed since you read them. Read them again before trusting them.")
    }
    if (subject) {
      await this.trusted.add(roomId, hash)
      // The install scripts count only while the room still has an install to run, which the install itself ends. The same
      // text without them is a part of what the user just read, so it doesn't ask again afterwards (KERNEL-260).
      if (subject.installScripts) await this.trusted.add(roomId, trustHash({ ...subject, installScripts: undefined }))
    }
    await this.untrusted(room)
    await this.releaseHeld(roomId)
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


  /** A removed room's trusted text goes with it. */
  forgetRoom(roomId: string) { return this.trusted.forget(roomId) }
  handlers() {
    return {
      'rooms.scriptTrust': async ({ roomId }) => this.untrusted(this.mustRoom(roomId)),
      'rooms.trust': async ({ roomId, hash }) => { await this.trustRoom(roomId, hash); return { ok: true } }
    } satisfies Partial<Handlers>
  }
}
