import type { Chat, ChatPart, Room, WaitsFor, Workspace } from '@shared/types'
import { bus } from '../bus'
import { loadRepoSettings, type RepoSettings } from '../services/settings'
import { copyLocalFiles, replayScripts, runScript, stopRuns, stopScript } from '../services/scripts'
import { snapshot } from '../services/checkpoints'
import { waitMet } from '../services/waits'
import { head } from './shared'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** A workspace's brief waiting for setup, and the Lead's messages that go after it (KERNEL-118, KERNEL-128). */
export interface SetupHold { chatId?: string; brief?: ChatPart[]; from?: 'lead'; later: ChatPart[][] }

/** A workspace's setup script, the brief that waits for it, and the run scripts (KERNEL-327). */
export class Setup extends Feature {
  /**
   * Workspaces whose brief hasn't gone out yet: the chat and brief, and the Lead's messages that follow it (KERNEL-118).
   * Saved under the meta key `setups`, so a quit during setup doesn't lose the brief (KERNEL-128).
   */
  readonly setups = new Map<string, SetupHold>()
  /** The exit code of a workspace's last failed setup, or null when it was stopped. Cleared when setup passes. */
  readonly setupFailures = new Map<string, number | null>()

  /** Setup passed: the workspace is ready, the run script starts, the start-of-chat checkpoint is taken, and the agent gets its prompt. */
  async setupDone(ws: Workspace, room: Room, chat: Chat, prompt: string, start: () => Promise<void>) {
    const repo = await loadRepoSettings(room.path)
    if (this.mustWs(ws.id).status === 'archived') return this.mustWs(ws.id)
    // The start of chat: reverting to it undoes everything the agent did. Taken before the workspace counts as ready, so
    // ready and the brief going out happen together: a quit between them would leave a ready workspace whose held brief
    // Kernel no longer restores.
    const start0 = await snapshot(ws, { chatId: chat.id, title: prompt, start: true }).catch(() => undefined)
    const done = this.updateWs(ws.id, { status: 'ready' })
    if (done.status === 'archived') return done
    if (start0) bus.push({ type: 'checkpoint', checkpoint: start0 })
    if (this.settings.scripts.runAfterSetup && repo.scripts.run && !(await this.k.trust.untrusted(room, repo))) this.startRun(done, room, repo)
    await start()
    return done
  }

  /**
   * Start one of the room's run scripts (`run` when unnamed). With the room's run mode at One at a time, the run scripts in
   * the room's other open workspaces stop first (KERNEL-244).
   */
  private startRun(ws: Workspace, room: Room, repo: RepoSettings, name = 'run') {
    const script = repo.runScripts.find((r) => r.name === name)?.command
    if (!script) throw new Error(name === 'run' ? 'No run script in .kernel/settings.toml' : `No run script named ${name} in .kernel/settings.toml`)
    if (repo.scripts.runMode === 'single') for (const other of this.store.workspaces(room.id)) if (other.id !== ws.id && other.status !== 'archived') stopRuns(other.id)
    void runScript({ workspaceId: ws.id, kind: 'run', name, script, cwd: ws.path, env: this.k.env.envFor(ws, { script: true }) })
  }

  /** Workspaces whose setup is rerunning, so a second Run again doesn't start it twice. */
  readonly settingUp = new Set<string>()

  /** "Run again" on a failed setup: rerun the script, and when it passes send the prompt that was waiting. */
  async retrySetup(workspaceId: string): Promise<Workspace> {
    if (this.settingUp.has(workspaceId)) return this.mustWs(workspaceId)
    this.settingUp.add(workspaceId)
    try { return await this.rerunSetup(workspaceId) } finally { this.settingUp.delete(workspaceId) }
  }

  private async rerunSetup(workspaceId: string): Promise<Workspace> {
    const ws = this.mustWs(workspaceId)
    const room = this.mustRoom(ws.roomId)
    const repo = await loadRepoSettings(room.path)
    const chat = this.store.chats(ws.id).find((c) => c.kind !== 'terminal')
    // The script changed since it failed, and nobody trusted the new text yet (KERNEL-209).
    if (await this.k.trust.untrusted(room, repo)) return this.k.trust.holdForTrust(ws.id)
    if (repo.scripts.setup) {
      const code = await runScript({ workspaceId: ws.id, kind: 'setup', script: repo.scripts.setup, cwd: ws.path, env: this.k.env.envFor(ws, { script: true }) })
      if (!this.setupPassed(ws, code)) {
        // Run again failed too, and nothing told the Lead (KERNEL-126). A stopped run, by archive or quit, isn't news.
        const now = this.mustWs(workspaceId)
        if (code !== null && now.status !== 'archived') this.leadUpdates.setup(now, false, { code })
        return now
      }
    } else this.setupFailures.delete(ws.id)
    const passed = (w: Workspace) => { const now = this.mustWs(w.id); if (now.status === 'ready') this.leadUpdates.setup(now, true); return now }
    // A brief that waits for a PR stays held: the workspace is ready and keeps waiting (KERNEL-259).
    const wait = this.mustWs(ws.id).waitsFor
    if (wait?.held && chat) {
      if (waitMet(wait, this.store.workspaces(ws.roomId))) {
        this.updateWs(ws.id, { status: 'ready' })
        await this.k.waits.releaseWait(ws.id)
        return passed(this.mustWs(ws.id))
      }
      const base = await head(ws.path)
      const held = this.updateWs(ws.id, { status: 'ready', waitsFor: { ...wait, ...(base ? { base } : {}) } })
      if (held.status === 'ready') this.leadUpdates.setup(held, true, { wait: { on: wait.on, label: this.k.waits.waitLabelOf(held), held: true } })
      return held
    }
    return passed(await this.startBrief(ws, room, chat))
  }

  /**
   * Sends a held brief (KERNEL-259): reruns setup first when asked, then `setupDone` takes the start checkpoint at HEAD,
   * marks the workspace ready, and releases the chat's queue in the same tick as it clears the wait, so nothing saved
   * shows a waiting workspace whose brief went out. Run again's tail and a released wait share it. A setup that fails
   * here leaves the workspace failed, with no wait, so Run again works as it always has.
   */
  async startBrief(ws: Workspace, room: Room, chat: Chat | undefined, o: { setup?: boolean; released?: WaitsFor } = {}): Promise<Workspace> {
    const repo = o.setup && this.settings.scripts.setupOnCreate ? await loadRepoSettings(room.path) : undefined
    const script = repo?.scripts.setup
    // The setup text changed while the brief waited and nobody trusted it yet: the brief keeps waiting, for trust now,
    // and trusting runs setup and sends it (KERNEL-209).
    if (script && await this.k.trust.untrusted(room, repo)) return this.k.trust.holdForTrust(ws.id)
    if (script) {
      const code = await runScript({ workspaceId: ws.id, kind: 'setup', script, cwd: ws.path, env: this.k.env.envFor(ws, { script: true }) })
      if (!this.setupPassed(ws, code)) {
        const failed = this.updateWs(ws.id, { status: 'failed', waitsFor: undefined })
        if (code !== null && failed.status !== 'archived') this.leadUpdates.setup(failed, false, { code })
        return failed
      }
    }
    // The wait this release ends goes. One set while the brief was on its way stays, for a teammate that has now started.
    const settle = () => {
      const w = this.mustWs(ws.id).waitsFor
      if (w) this.updateWs(ws.id, { waitsFor: o.released && w.on.join() === o.released.on.join() ? undefined : { on: w.on, held: false } })
    }
    if (!chat) { settle(); return this.updateWs(ws.id, { status: 'ready' }) }
    const first = this.sessions.queued(chat.id)[0]?.parts.find((p) => p.type === 'text')
    return this.setupDone(ws, room, chat, first?.type === 'text' ? first.text : ws.title ?? ws.name, async () => { settle(); this.sessions.release(chat.id) })
  }

  /** Copy the local files into a new worktree, then run setup. Only for text the user trusted (KERNEL-209). */
  async prepare(ws: Workspace, room: Room, repo: RepoSettings): Promise<boolean> {
    // An archive can land while the trust check or the copy waits: then nothing starts in the removed folder, and the
    // caller sees the workspace archived.
    const archived = () => this.mustWs(ws.id).status === 'archived'
    if (ws.mode === 'worktree' && !archived()) await this.copyFiles(ws, room, repo)
    if (archived()) return false
    return this.runSetup(ws, room, repo.scripts.setup)
  }

  /** A files.copy entry that leaves the repo is refused, and the setup output says which (KERNEL-209). */
  async copyFiles(ws: Workspace, room: Room, repo: RepoSettings) {
    const { refused } = await copyLocalFiles(room.path, ws.path, repo.files.copy)
    for (const f of refused) bus.push({ type: 'script.output', workspaceId: ws.id, kind: 'setup', line: `Did not copy ${f}: files.copy can only copy files inside the repo.`, stream: 'stderr' })
  }

  /** A workspace held for trust: copy, set up and send the brief, or fail the way a new workspace's setup fails. */
  async releaseTrust(workspaceId: string): Promise<void> {
    if (this.settingUp.has(workspaceId)) return
    this.settingUp.add(workspaceId)
    try {
      const ws = this.mustWs(workspaceId)
      if (ws.status !== 'trust') return
      const room = this.mustRoom(ws.roomId)
      const repo = await loadRepoSettings(room.path)
      // The text changed again between trusting and now: it waits for another yes.
      if (await this.k.trust.untrusted(room, repo)) { await this.k.trust.askTrust(room.id); return }
      // Archived while the settings were read: nothing runs in it.
      if (this.updateWs(workspaceId, { status: 'setup' }).status !== 'setup') return
      const chat = this.store.chats(ws.id).find((c) => c.kind !== 'terminal')
      const ready = await this.prepare(ws, room, repo)
      if (this.mustWs(ws.id).status === 'archived') return
      if (!ready) {
        const failed = this.updateWs(ws.id, { status: 'failed' })
        const code = this.setupFailures.get(ws.id)
        if (code !== null && failed.status !== 'archived') this.leadUpdates.setup(failed, false, { code })
        return
      }
      // A workspace that also waits for a PR keeps waiting, ready, until it merges. Otherwise its brief goes now, and
      // a wait that merged meanwhile ends with it (KERNEL-259).
      const wait = this.mustWs(ws.id).waitsFor
      if (wait?.held && wait.on.length && chat && !waitMet(wait, this.store.workspaces(ws.roomId))) {
        const base = await head(ws.path)
        this.updateWs(ws.id, { status: 'ready', waitsFor: { ...wait, ...(base ? { base } : {}) } })
        void this.k.waits.settleWait(ws.id).catch(() => undefined)
        return
      }
      await this.startBrief(this.mustWs(ws.id), room, chat, { released: wait?.held ? wait : undefined })
    } finally { this.settingUp.delete(workspaceId) }
  }

  private async runSetup(ws: Workspace, room: Room, script?: string): Promise<boolean> {
    if (!script || !this.settings.scripts.setupOnCreate) return true
    const code = await runScript({ workspaceId: ws.id, kind: 'setup', script, cwd: ws.path, env: this.k.env.envFor(ws, { script: true }) })
    return this.setupPassed(ws, code)
  }

  /** The last line of a failed setup log says so, the way the canvas draws it (WorkspaceSetupFailed.png). */
  private setupPassed(ws: Workspace, code: number | null) {
    if (code === 0) { this.setupFailures.delete(ws.id); return true }
    this.setupFailures.set(ws.id, code)
    bus.push({ type: 'script.output', workspaceId: ws.id, kind: 'setup', line: code === null ? 'Setup was stopped' : `Setup failed with exit code ${code}`, stream: 'stderr' })
    return false
  }

  setSetup(id: string, hold: SetupHold | undefined) {
    if (hold) this.setups.set(id, hold)
    else this.setups.delete(id)
    this.saveSetups()
  }

  saveSetups() { this.store.saveMeta('setups', Object.fromEntries(this.setups)) }

  /**
   * A workspace still in setup when Kernel quit has no script running any more (KERNEL-128). It counts as failed, with a
   * note saying why, and its brief, and whatever the Lead sent after it, wait in the chat for Run again. So does one whose
   * setup had just passed when Kernel quit, before its brief went out.
   */
  recoverSetups() {
    const saved = this.store.meta<Record<string, SetupHold>>('setups') ?? {}
    for (const ws of this.store.workspaces()) {
      const hold = saved[ws.id]
      const chat = (hold?.chatId && this.store.chat(hold.chatId)) || this.store.chats(ws.id).find((c) => c.kind !== 'terminal')
      const unsent = ws.status === 'ready' && !!hold?.brief && !!chat && !this.store.items(chat.id).some((i) => i.kind === 'user')
      if (ws.status !== 'setup' && !unsent) continue
      if (chat && hold?.brief) this.sessions.hold(chat.id, hold.brief, hold.from ? { from: hold.from } : {})
      if (chat) for (const m of hold?.later ?? []) this.sessions.hold(chat.id, m, { from: 'lead' })
      this.updateWs(ws.id, { status: 'failed' })
      this.note(ws.id, 'Setup stopped when Kernel quit. Click Run again.')
    }
    this.setups.clear()
    this.saveSetups()
  }

  handlers() {
    return {
      'scripts.run': async ({ workspaceId, kind, name }) => {
        const ws = this.mustWs(workspaceId); const room = this.mustRoom(ws.roomId); const repo = await loadRepoSettings(room.path)
        const script = kind === 'run' ? undefined : repo.scripts[kind]
        if (kind !== 'run' && !script) throw new Error(`No ${kind} script in .kernel/settings.toml`)
        // Run again checks trust itself, and holds the workspace for it when the text changed.
        if (kind === 'setup' && ws.status === 'failed') { void this.retrySetup(workspaceId).catch(() => undefined); return { ok: true } }
        // Every kind waits for trust, a named run script included (KERNEL-209, KERNEL-244).
        if (await this.k.trust.untrusted(room, repo)) { await this.k.trust.askTrust(room.id); throw new Error("Trust this room's scripts before running them.") }
        // Trusted since it was held: it sets up the way trusting releases it, brief and all.
        if (ws.status === 'trust') { void this.releaseTrust(workspaceId).catch(() => undefined); return { ok: true } }
        if (kind === 'run') { this.startRun(ws, room, repo, name); return { ok: true } }
        void runScript({ workspaceId, kind, script: script!, cwd: ws.path, env: this.k.env.envFor(ws, { script: true }) })
        return { ok: true }
      },
      'scripts.stop': async ({ workspaceId, name }) => { if (name) stopScript(workspaceId, 'run', name); else stopRuns(workspaceId); return { ok: true } },
      'scripts.replay': async ({ workspaceId }) => { replayScripts(workspaceId); return { ok: true } }
    } satisfies Partial<Handlers>
  }
}
