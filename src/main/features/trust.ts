import { join } from 'node:path'
import type { QueuedMessage, Room, RoomSettingsPatch, ScriptTrust, Workspace } from '@shared/types'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { loadRepoSettings, localSettingsOwn, scriptsToTrust, ScriptTrustStore, trustHash, type RepoSettings, type TrustSubject } from '../services/settings'
import { Feature } from './feature'
import type { SetupHold } from './setup'

/** Whether the user trusts the scripts, files.copy and env files a room's repo brings (KERNEL-327). */
export class Trust extends Feature {
  private trustStore?: ScriptTrustStore
  /** The script text the user trusted, per room (KERNEL-209). Built on first use, since a feature's constructor stores only `k` (R1). */
  get trusted() { return this.trustStore ??= new ScriptTrustStore(join(this.o.dataDir, 'trust.json')) }
  /**
   * Per room, the `[env] files` list `envFor` may read, as JSON: the user's own list, or the repo's once the room is
   * trusted. `untrusted` sets it each time it checks. A room with no entry reads no env file, since `envFor` is
   * synchronous and can't wait for the check (KERNEL-247).
   */
  readonly envFilesOk = new Map<string, string>()

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
   * it (KERNEL-209, KERNEL-190). The user's own personal file needs no trusting.
   */
  private async subjectOf(room: Room, repo?: RepoSettings): Promise<TrustSubject | undefined> {
    return scriptsToTrust(repo ?? await loadRepoSettings(room.path), { localIsOwn: await localSettingsOwn(room.path) })
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
    if (!scriptsOk || !copyOk || !runsOk || !envOk) return
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

  /** The room's text is trusted now: clear the prompt and release every workspace waiting on it. */
  private async releaseHeld(roomId: string) {
    bus.push({ type: 'room.trust', roomId, trust: null })
    for (const ws of this.store.workspaces(roomId)) if (ws.status === 'trust') void this.k.setup.releaseTrust(ws.id).catch(() => undefined)
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
    if (subject) await this.trusted.add(roomId, hash)
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
      if (!waiting || !Array.isArray(queue)) continue
      for (const m of queue) this.sessions.hold(chatId, m.parts, { ...(m.from ? { from: m.from } : {}), ...(m.update ? { update: m.update } : {}) })
    }
  }

  handlers() {
    return {
      'rooms.scriptTrust': async ({ roomId }) => this.untrusted(this.mustRoom(roomId)),
      'rooms.trust': async ({ roomId, hash }) => { await this.trustRoom(roomId, hash); return { ok: true } }
    } satisfies Partial<Handlers>
  }
}
