import type { ChatPart, PrState, Workspace } from '@shared/types'
import type { TeammateToolDeps } from '../services/teammateMcp'
import { fastForward, fetchOrigin, stripRemote } from '../services/worktrees'
import { isMerged, joinLabels, waitLabel, waitMet, waitRefusal } from '../services/waits'
import { Feature } from './feature'
import { head } from './shared'

/** A workspace waiting for other PRs to merge before it starts or rebases (KERNEL-259, KERNEL-328). */
export class Waits extends Feature {
  /** Waits being released, so a merge seen twice (push and poll) sends the brief once (KERNEL-259). */
  private waitReleases = new Map<string, Promise<void>>()
  /**
   * Started teammates whose rebase message Kernel sent or queued in this run. A queue doesn't survive a quit, so the
   * workspace keeps `waitsFor.releasing` until a turn Kernel started there ends, and a restart sends the message again.
   */
  readonly releaseSent = new Set<string>()

  /** The open workspaces that wait for `id`. */
  waitersOn(id: string) { return this.store.workspaces().filter((w) => w.status !== 'archived' && w.waitsFor?.on.includes(id)) }

  nameOf(ws: Workspace) { return this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)?.name ?? ws.agentId }

  /** "PR #164 by Noor and PR #170 by Ivy": what the workspace waits for. */
  waitLabelOf(ws: Workspace) {
    const targets = (ws.waitsFor?.on ?? []).map((id) => this.store.workspace(id)).filter((t): t is Workspace => !!t)
    return joinLabels(targets.map((t) => waitLabel(t, this.nameOf(t)))) || 'another PR'
  }

  /** A PR merged or closed. Its own wait ends, its waiters whose targets all merged go on, and a close breaks their wait. */
  async onTargetPr(id: string, state: PrState) {
    if (state !== 'merged' && state !== 'closed') return
    const ws = this.store.workspace(id)
    if (!ws) return
    if (ws.waitsFor?.held && ws.status === 'ready') await this.releaseWait(id, { now: true })
    else this.clearWait(id)
    for (const w of this.waitersOn(id)) {
      if (state === 'merged') await this.settleWait(w.id).catch(() => undefined)
      else this.breakWait(w, ws, 'closed')
    }
  }

  /** Tells the Lead a wait can't end on its own: `target` closed or was archived without merging. The waiter stays as it is. */
  breakWait(w: Workspace, target: Workspace, gone: 'closed' | 'archived') {
    if (!w.waitsFor || w.waitsFor.releasing) return
    this.k.leadUpdates.waits(w, 'wait.broken', { on: w.waitsFor.on, label: waitLabel(target, this.nameOf(target)), held: w.waitsFor.held, target: target.id, gone })
  }

  /** Releases the wait when everything it is on has merged. */
  async settleWait(id: string) {
    const ws = this.store.workspace(id)
    if (ws?.waitsFor && ws.status !== 'archived' && waitMet(ws.waitsFor, this.store.workspaces(ws.roomId))) await this.releaseWait(id)
  }

  /**
   * At start, once each room's team is read: a merge saved just before a quit never emits again, so its waiters go now,
   * and rebase messages a quit lost go again. A merge made while Kernel was closed reaches them through the first poll.
   */
  async sweepWaits() {
    for (const r of this.store.rooms()) { if (this.stopped) return; await this.k.agents(r.id).catch(() => undefined) }
    if (!this.stopped) await this.retryWaits()
  }

  async retryWaits() {
    for (const ws of this.store.workspaces()) {
      if (this.stopped) return
      if (!ws.waitsFor || ws.status === 'archived') continue
      if (ws.waitsFor.releasing) await this.deliverRelease(ws.id).catch(() => undefined)
      else await this.settleWait(ws.id).catch(() => undefined)
    }
  }

  /** One release per workspace at a time, as with archives. `now` starts a held brief without waiting for the merge. */
  releaseWait(id: string, o: { now?: boolean } = {}): Promise<void> {
    const running = this.waitReleases.get(id)
    if (running) return running
    const next = this.releaseNow(id, o).finally(() => this.waitReleases.delete(id))
    this.waitReleases.set(id, next)
    return next
  }

  private async releaseNow(id: string, o: { now?: boolean }) {
    const ws = this.mustWs(id)
    let wait = ws.waitsFor
    // Setup running or failed: the brief goes when setup passes, which looks at the wait again.
    if (!wait || ws.status !== 'ready' || wait.releasing) return
    // Started early: what merged already is still a merge to start from. Only the rest is skipped.
    let now = !!o.now
    if (now) {
      const all = this.store.workspaces(ws.roomId)
      const merged = wait.on.filter((t) => isMerged(all.find((w) => w.id === t)))
      if (merged.length) {
        const rest = wait.on.filter((t) => !merged.includes(t))
        if (rest.length) this.note(id, `Started without waiting for ${this.waitLabelOf({ ...ws, waitsFor: { ...wait, on: rest } })}.`)
        wait = this.updateWs(id, { waitsFor: { ...wait, on: merged } }).waitsFor!
        now = false
      }
    }
    const label = this.waitLabelOf(this.mustWs(id))
    if (!wait.held) {
      if (now) { this.clearWait(id); return }
      this.updateWs(id, { waitsFor: { ...wait, releasing: true } })
      this.k.leadUpdates.waits(ws, 'wait.released', { on: wait.on, label, held: false })
      await this.deliverRelease(id)
      return
    }
    const room = this.mustRoom(ws.roomId)
    const chat = this.store.chats(id).find((c) => c.kind !== 'terminal' && this.sessions.queued(c.id).length > 0) ?? this.prChat(id)
    const before = await head(ws.path)
    // Onto the remote's copy of the base, even when the workspace started from the local branch, which a merge on
    // GitHub doesn't move. Only a fast-forward on a clean tree: anything else is the agent's to rebase.
    const remote = await this.k.config.remoteFor(room.path)
    const base = stripRemote(ws.baseRef, remote)
    let forwarded = true
    if (!now && ws.mode === 'worktree') {
      // A failed fetch leaves the remote's copy where it was, and a fast-forward to it would claim a merge it doesn't have.
      const fetched = (await fetchOrigin(room.path, remote, { fresh: true })).ok
      forwarded = fetched && await fastForward(ws.path, `${remote}/${base}`)
    }
    const after = await head(ws.path)
    // Archived, started or changed while git ran.
    const current = this.mustWs(id)
    if (current.status !== 'ready' || !current.waitsFor?.held) return
    if (!now && !waitMet(current.waitsFor, this.store.workspaces(current.roomId))) return
    if (now) this.note(id, `Started without waiting for ${label}.`)
    else {
      if (!forwarded && chat) this.sessions.hold(chat.id, [{ type: 'text', text: `${label} merged after your branch started. Rebase onto ${remote}/${base} before you build on it.` }], { from: 'kernel' })
      this.note(id, forwarded ? `${label} merged. Your branch now starts from it.` : `${label} merged. Kernel couldn't move your branch onto it, so a message after the brief asks for a rebase.`)
      this.k.leadUpdates.waits(current, 'wait.released', { on: wait.on, label, held: true })
    }
    // Setup runs again only when the files under it changed.
    await this.k.setup['startBrief'](current, room, chat, { setup: !!after && after !== (wait.base ?? before), released: current.waitsFor })
  }

  /** The Lead or the user ends a wait before its merge: a held brief goes now, with whatever merged already under it. */
  private async dropWait(id: string) {
    const ws = this.mustWs(id)
    if (ws.waitsFor && ws.status === 'ready' && !ws.waitsFor.releasing) return this.releaseWait(id, { now: true })
    this.clearWait(id)
  }

  private clearWait(id: string) {
    this.releaseSent.delete(id)
    if (this.mustWs(id).waitsFor) this.updateWs(id, { waitsFor: undefined })
  }

  /**
   * Kernel's message to a teammate that started before what it waited for merged. An idle chat takes it now; a busy,
   * paused or offline one queues it, so the running turn's end isn't news for the Lead. A crashed chat, or one with every
   * agent slot taken, waits for the next poll.
   */
  private async deliverRelease(id: string) {
    const remote = await this.k.config.remoteOfWs(this.mustWs(id))
    // Read after the await, and marked before the send, so the poll and a merge can't both send it.
    const ws = this.store.workspace(id)
    if (!ws?.waitsFor?.releasing || ws.status === 'archived' || this.releaseSent.has(id)) return
    const chat = this.prChat(id)
    if (!chat) return
    const base = stripRemote(ws.baseRef, remote)
    const parts: ChatPart[] = [{ type: 'text', text: `${this.waitLabelOf(ws)} merged into ${base}. Fetch ${remote}, rebase onto ${remote}/${base}, re-run the tests, then carry on with your task.` }]
    const busy = this.sessions.isRunning(chat.id) || this.sessions.queued(chat.id).length > 0 || !!this.store.room(ws.roomId)?.paused || this.sessions.heldFor().length > 0
    this.releaseSent.add(id)
    if (busy) await this.sessions.send(chat.id, parts, { from: 'kernel' })
    else if (!this.sessions.post(chat.id, parts)) this.releaseSent.delete(id)
  }

  /** A turn Kernel started ended, with nothing of Kernel's left in the queue: the teammate took the rebase message. */
  releaseTaken(id: string, chatId: string, by: string) {
    const ws = this.store.workspace(id)
    if (by !== 'kernel' || !ws?.waitsFor?.releasing || !this.releaseSent.has(id) || this.prChat(id)?.id !== chatId) return
    if (this.sessions.queued(chatId).some((q) => q.from === 'kernel')) return
    this.releaseSent.delete(id)
    this.updateWs(id, { waitsFor: undefined })
  }

  /**
   * The Lead's wait_for_merge, and a teammate's own (KERNEL-262, `told: false`): `on` replaces what the workspace waits for, with targets that merged already left out.
   * A teammate that started waits with its brief out (`held: false`). An empty list ends the wait, and a held brief goes now.
   */
  async setWait(id: string, on: string[], o: { told?: boolean; why?: string } = {}): Promise<Workspace> {
    const ws = this.mustWs(id)
    if (ws.status === 'archived') throw new Error(`${ws.name} is archived.`)
    const all = this.store.workspaces(ws.roomId)
    const left = [...new Set(on)].filter((t) => !isMerged(all.find((w) => w.id === t)))
    if (!left.length) { await this.dropWait(id); return this.mustWs(id) }
    if (ws.mode === 'current' || ws.reviewOf) throw new Error(`${ws.name} can't wait for a PR.`)
    const was = ws.waitsFor
    const held = ws.status === 'setup' || ws.status === 'failed' || !!was?.held
    this.releaseSent.delete(id)
    const next = this.updateWs(id, { waitsFor: { on: left, held, ...(was?.base ? { base: was.base } : {}) } })
    const label = this.waitLabelOf(next)
    if (next.status === 'ready') this.note(id, held ? `Waiting for ${label} to merge. Kernel sends this brief then. Send now starts it sooner.` : `Waiting for ${label} to merge. Kernel asks ${this.nameOf(next)} to rebase onto it then.`)
    // The Lead set it, and reads what happened in the tool's result. A teammate's own wait is news for the Lead (KERNEL-262).
    this.k.leadUpdates.waits(next, 'wait.started', { on: left, label, held, ...(o.told === false ? {} : { told: true }), ...(o.why ? { why: o.why } : {}) })
    return next
  }

  /** What a teammate's wait_for_merge reads and calls (KERNEL-262). */
  teammateToolDeps(id: string): TeammateToolDeps {
    return {
      workspace: () => this.mustWs(id),
      workspaces: () => this.store.workspaces(this.mustWs(id).roomId),
      isLead: (w) => this.isLeadWorkspace(w),
      nameOf: (w) => this.nameOf(w),
      setWait: (on, why) => this.setWait(id, on, { told: false, why })
    }
  }

  /**
   * A hand-off whose Linear issue is blocked by issues open teammates are building (KERNEL-263). Once the brief has gone
   * out, it waits for their PRs without holding anything (CJ chose "tell on merge"), and Kernel asks the teammate to rebase
   * when they merge. Blockers with no open workspace, or one that merged, don't count. Returns the workspace when it waits.
   */
  async waitOnBlockers(ws: Workspace, blockedBy: string[]): Promise<Workspace | undefined> {
    const now = this.mustWs(ws.id)
    if (now.status !== 'ready' || now.waitsFor) return undefined
    const keys = new Set(blockedBy.map((k) => k.toLowerCase()))
    const all = this.store.workspaces(ws.roomId)
    const isLead = (w: Workspace) => !!this.agentsSync(ws.roomId).find((a) => a.id === w.agentId)?.lead
    const on = all
      .filter((w) => w.status !== 'archived' && !w.reviewOf && !isMerged(w) && w.source?.kind === 'issue' && keys.has(w.source.id.toLowerCase()))
      .filter((w) => !waitRefusal({ workspaces: all, refs: [w.id], waiter: now, isLead }))
      .map((w) => w.id)
    return on.length ? this.setWait(ws.id, on) : undefined
  }
}
