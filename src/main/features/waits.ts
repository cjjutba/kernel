import type { ChatPart, NoteRef, PrState, WaitsFor, Workspace } from '@shared/types'
import { waitersOf } from '@shared/waits'
import type { TeammateToolDeps } from '../services/teammateMcp'
import { fastForward, fetchOrigin, isAncestor, isPushed, revParse, stripRemote } from '../services/worktrees'
import { issueTracker } from '../services/trackers'
import { buildsIssue, isMerged, joinLabels, mergedReading, waitLabel, waitMet, waitRefusal } from '../services/waits'
import { head } from './shared'
import { Feature } from './feature'

const withReading = (text: string, reading: string) => (reading ? `${text} ${reading}` : text)

/** A branch the remote has takes the base by a merge: a rebase would need a force push, which the team doesn't make (KERNEL-886). */
const mergeWhy = (remote: string, pushed: boolean) => (pushed ? ` Your branch is on ${remote}, so merge rather than rebase.` : '')

/**
 * A wait kept because the turn Kernel started to rebase ended without the merge in the branch (KERNEL-691). Its targets
 * merged, so nothing releases it again: a turn that rebased, the Lead or a new wait ends it.
 */
const keptForRebase = (w?: WaitsFor) => !!w?.tip && !w.releasing

/** Workspaces that wait for another PR to merge (KERNEL-259, KERNEL-328). */
export class Waits extends Feature {
  /** Waits being released, so a merge seen twice (push and poll) sends the brief once (KERNEL-259). */
  private waitReleases = new Map<string, Promise<void>>()
  /**
   * Started teammates whose rebase message Kernel sent or queued in this run. A queue doesn't survive a quit, so the
   * workspace keeps `waitsFor.releasing` until a turn Kernel started there ends, and a restart sends the message again.
   */
  readonly releaseSent = new Set<string>()

  /** The open workspaces that wait for `id`. */
  waitersOn(id: string) { return waitersOf(id, this.store.workspaces()) }

  nameOf(ws: Workspace) { return this.agentsSync(ws.projectId).find((a) => a.id === ws.agentId)?.name ?? ws.agentId }

  /** "PR #164 by Sean and PR #170 by Teng": what the workspace waits for. */
  waitLabelOf(ws: Workspace) {
    return joinLabels(this.waitRefsOf(ws).map((r) => r.text)) || 'another PR'
  }

  /** Each target's label and workspace, so a note's "PR #164 by Sean" opens Sean's workspace. */
  waitRefsOf(ws: Workspace): NoteRef[] {
    const targets = (ws.waitsFor?.on ?? []).map((id) => this.store.workspace(id)).filter((t): t is Workspace => !!t)
    return targets.map((t) => ({ text: waitLabel(t, this.nameOf(t)), workspaceId: t.id }))
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
    this.leadUpdates.waits(w, 'wait.broken', { on: w.waitsFor.on, label: waitLabel(target, this.nameOf(target)), held: w.waitsFor.held, target: target.id, gone })
  }

  /** Releases the wait when everything it is on has merged. */
  async settleWait(id: string) {
    const ws = this.store.workspace(id)
    // Every poll and start comes here, and a kept wait would send the rebase message again each time.
    if (ws?.waitsFor && !keptForRebase(ws.waitsFor) && ws.status !== 'archived' && waitMet(ws.waitsFor, this.store.workspaces(ws.projectId))) await this.releaseWait(id)
  }

  /**
   * At start, once each project's team is read: a merge saved just before a quit never emits again, so its waiters go now,
   * and rebase messages a quit lost go again. A merge made while Kernel was closed reaches them through the first poll.
   */
  async sweepWaits() {
    for (const r of this.store.projects()) { if (this.stopped) return; await this.k.team.agents(r.id).catch(() => undefined) }
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

  /**
   * One release per workspace at a time, as with archives. `now` starts a held brief without waiting for the merge, and
   * `keep` (Send now) leaves the teammate waiting on what hasn't merged, so Kernel asks it to rebase then (KERNEL-689).
   */
  releaseWait(id: string, o: { now?: boolean; keep?: boolean } = {}): Promise<void> {
    const running = this.waitReleases.get(id)
    if (running) return running
    const next = this.releaseNow(id, o).finally(() => this.waitReleases.delete(id))
    this.waitReleases.set(id, next)
    return next
  }

  private async releaseNow(id: string, o: { now?: boolean; keep?: boolean }) {
    const ws = this.mustWs(id)
    let wait = ws.waitsFor
    // Setup running or failed: the brief goes when setup passes, which looks at the wait again.
    if (!wait || ws.status !== 'ready' || wait.releasing) return
    // Started early: what merged already is still a merge to start from. Only the rest is skipped.
    let now = !!o.now
    // What a teammate started early still waits for: it hears when that merges.
    let left: string[] = []
    if (now) {
      const all = this.store.workspaces(ws.projectId)
      const merged = wait.on.filter((t) => isMerged(all.find((w) => w.id === t)))
      if (o.keep && wait.held) left = wait.on.filter((t) => !merged.includes(t))
      if (merged.length) {
        const rest = wait.on.filter((t) => !merged.includes(t))
        const skipped = { ...ws, waitsFor: { ...wait, on: rest } }
        if (rest.length && left.length) this.note(id, this.earlyNote(skipped, left, await this.pushed(ws)), undefined, this.waitRefsOf(skipped))
        wait = this.updateWs(id, { waitsFor: { ...wait, on: merged } }).waitsFor!
        now = false
      }
    }
    const label = this.waitLabelOf(this.mustWs(id))
    const refs = this.waitRefsOf(this.mustWs(id))
    if (!wait.held) {
      if (now) { this.clearWait(id); return }
      this.updateWs(id, { waitsFor: { ...wait, releasing: true } })
      this.leadUpdates.waits(ws, 'wait.released', { on: wait.on, label, held: false })
      await this.deliverRelease(id)
      return
    }
    const project = this.mustProject(ws.projectId)
    const chat = this.store.chats(id).find((c) => c.kind !== 'terminal' && this.sessions.queued(c.id).length > 0) ?? this.prChat(id)
    const before = await head(ws.path)
    // Onto the remote's copy of the base, even when the workspace started from the local branch, which a merge on
    // GitHub doesn't move. Only a fast-forward on a clean tree: anything else is the agent's to rebase.
    const remote = await this.k.config.remoteFor(project.path)
    const base = stripRemote(ws.baseRef, remote)
    let forwarded = true
    if (!now && ws.mode === 'worktree') {
      // A failed fetch leaves the remote's copy where it was, and a fast-forward to it would claim a merge it doesn't have.
      const fetched = (await fetchOrigin(project.path, remote, { fresh: true })).ok
      forwarded = fetched && await fastForward(ws.path, `${remote}/${base}`) && await this.hasMerges(ws, wait.on, remote)
    }
    const after = await head(ws.path)
    const pushed = await this.pushed(ws)
    // Archived, started or changed while git ran.
    const current = this.mustWs(id)
    if (current.status !== 'ready' || !current.waitsFor?.held) return
    if (!now && !waitMet(current.waitsFor, this.store.workspaces(current.projectId))) return
    if (now && left.length) this.note(id, this.earlyNote(current, left, pushed), undefined, refs)
    else if (!now) {
      // The brief was written before the merge, so the teammate hears what merged and how to read it (KERNEL-695), in a
      // message that goes out in the brief's first turn. A chat note never reaches the agent, and the queue tray told the
      // user about the wait, so a clean release leaves the brief first in the chat (KERNEL-973).
      const reading = this.readingOf(current, before ? `${before}..${remote}/${base}` : undefined)
      const it = refs.length > 1 ? 'them' : 'it'
      const take = pushed ? `Merge ${remote}/${base} into your branch` : `Rebase onto ${remote}/${base}`
      const told = forwarded ? `${label} merged before your brief went out. Your branch already starts from ${it}.` : `${label} merged after your branch started. ${take} before you build on it.${mergeWhy(remote, pushed)}`
      // Right behind the brief, so a message with a skill chip queued after it can't push this out of the first turn.
      if (chat) this.sessions.hold(chat.id, [{ type: 'text', text: withReading(told, reading) }], { from: 'kernel' }, 1)
      // Something went wrong, so the user hears it too.
      if (!forwarded) this.note(id, `${label} merged, but Kernel couldn't move your branch onto ${it}. A message with the brief asks for a ${pushed ? 'merge' : 'rebase'}.`, undefined, refs)
      this.leadUpdates.waits(current, 'wait.released', { on: wait.on, label, held: true })
    }
    // Setup runs again only when the files under it changed.
    await this.k.setup.startBrief(current, project, chat, { setup: !!after && after !== (wait.base ?? before), released: current.waitsFor, ...(left.length ? { left } : {}) })
  }

  /**
   * HEAD has the remote's copy of each base the PRs in `on` merged into. "Already up to date" is a fast-forward too, and a
   * wait set across bases before Kernel refused one would otherwise claim a merge the branch never got (KERNEL-693).
   */
  private async hasMerges(ws: Workspace, on: string[], remote: string) {
    const all = this.store.workspaces(ws.projectId)
    for (const id of on) {
      const t = all.find((w) => w.id === id)
      if (t && await isAncestor(ws.path, `${remote}/${stripRemote(t.baseRef, remote)}`, 'HEAD') !== true) return false
    }
    return true
  }

  /** What merged for `ws`'s wait and how to read it. Text only, from what Kernel already has. */
  private readingOf(ws: Workspace, log?: string) {
    const all = this.store.workspaces(ws.projectId)
    return mergedReading((ws.waitsFor?.on ?? []).map((t) => all.find((w) => w.id === t)).filter((t): t is Workspace => !!t), log)
  }

  /**
   * "Started without waiting for PR #170 by Sean. Kernel asks Teng to rebase once it merges.": who takes the base later
   * when the brief went with the wait kept. Only then, since the queue tray showed the wait and Send now ended it (KERNEL-973).
   */
  private earlyNote(skipped: Workspace, left: string[], pushed: boolean) {
    const label = this.waitLabelOf(skipped)
    const many = left.length > 1
    return `Started without waiting for ${label}. Kernel asks ${this.nameOf(skipped)} to ${pushed ? `merge ${many ? 'them' : 'it'} in` : 'rebase'} once ${many ? 'they merge' : 'it merges'}.`
  }

  /** The workspace's branch is on its room's remote, so it takes a base by a merge (KERNEL-886). */
  private async pushed(ws: Workspace) {
    return isPushed(ws.path, ws.branch, await this.k.config.remoteOfWs(ws))
  }

  /** The Lead or the user ends a wait before its merge: a held brief goes now, with whatever merged already under it. */
  private async dropWait(id: string) {
    const ws = this.mustWs(id)
    // Kept for a missing rebase: Kernel asked already, so ending it asks nothing again (KERNEL-691).
    if (keptForRebase(ws.waitsFor)) return this.clearWait(id)
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
    const was = this.mustWs(id)
    // Every poll comes here while a wait is releasing, so one already sent doesn't fetch again.
    if (this.releaseSent.has(id)) return
    const remote = await this.k.config.remoteOfWs(was)
    // The base it rebases onto, as the fetch leaves it. The turn's end checks the branch has it (KERNEL-691).
    const project = this.store.project(was.projectId)
    const tip = project && (await fetchOrigin(project.path, remote, { fresh: true })).ok ? await revParse(project.path, `${remote}/${stripRemote(was.baseRef, remote)}`) : undefined
    // Read after the awaits, and marked before the send, so the poll and a merge can't both send it.
    const ws = this.store.workspace(id)
    if (!ws?.waitsFor?.releasing || ws.status === 'archived' || this.releaseSent.has(id)) return
    const chat = this.prChat(id)
    if (!chat) return
    if (tip !== ws.waitsFor.tip) this.updateWs(id, { waitsFor: { ...ws.waitsFor, tip } })
    const base = stripRemote(ws.baseRef, remote)
    const pushed = await isPushed(ws.path, ws.branch, remote)
    // Not rebased yet, so HEAD is where the teammate's branch is (KERNEL-695).
    const steps = pushed
      ? `Fetch ${remote}, merge ${remote}/${base} into your branch and re-run the tests.${mergeWhy(remote, true)} Then carry on with your task.`
      : `Fetch ${remote}, rebase onto ${remote}/${base}, re-run the tests, then carry on with your task.`
    const text = withReading(`${this.waitLabelOf(ws)} merged into ${base}. ${steps}`, this.readingOf(ws, `HEAD..${remote}/${base}`))
    const parts: ChatPart[] = [{ type: 'text', text }]
    const busy = this.sessions.isRunning(chat.id) || this.sessions.queued(chat.id).length > 0 || !!this.store.project(ws.projectId)?.paused || this.sessions.heldFor().length > 0
    this.releaseSent.add(id)
    if (busy) await this.sessions.send(chat.id, parts, { from: 'kernel' })
    else if (!this.sessions.post(chat.id, parts)) this.releaseSent.delete(id)
  }

  /**
   * A turn Kernel started ended, with nothing of Kernel's left in the queue: the teammate took the rebase message. The wait
   * ends once the branch contains the base Kernel asked it to rebase onto or merge in, which ancestry tells for both (KERNEL-886). The branch, not HEAD: a rebase stopped on a
   * conflict leaves HEAD on the base. Without it, the wait stays with nothing being released, and the Lead hears
   * (KERNEL-691). A wait saved before that has no tip and ends as it did.
   */
  async releaseTaken(id: string, chatId: string, by: string) {
    const ws = this.store.workspace(id)
    if (keptForRebase(ws?.waitsFor) && this.prChat(id)?.id === chatId) return this.rebasedLater(id, ws!.waitsFor!.tip!)
    if (by !== 'kernel' || !ws?.waitsFor?.releasing || !this.releaseSent.has(id) || this.prChat(id)?.id !== chatId) return
    if (this.sessions.queued(chatId).some((q) => q.from === 'kernel')) return
    const tip = ws.waitsFor.tip
    // Git can't tell, as for a branch that is gone: the wait ends as it did before the check.
    const rebased = !tip || await isAncestor(ws.path, tip, `refs/heads/${ws.branch}`) !== false
    // Changed while git ran: a new wait, or one ended.
    const now = this.store.workspace(id)
    if (!now?.waitsFor?.releasing || now.waitsFor.tip !== tip || !this.releaseSent.has(id)) return
    this.releaseSent.delete(id)
    if (rebased) { this.updateWs(id, { waitsFor: undefined }); return }
    const { releasing: _, ...wait } = now.waitsFor
    const kept = this.updateWs(id, { waitsFor: wait })
    const remote = await this.k.config.remoteOfWs(kept)
    const pushed = await isPushed(kept.path, kept.branch, remote)
    this.leadUpdates.waits(kept, 'wait.rebase_missing', { on: wait.on, label: this.waitLabelOf(kept), held: false, onto: `${remote}/${stripRemote(kept.baseRef, remote)}`, ...(pushed ? { pushed } : {}) })
  }

  /** A wait kept for a missing rebase ends at the end of any later turn, the Lead's message or the user's, that rebased (KERNEL-691). */
  private async rebasedLater(id: string, tip: string) {
    const rebased = await isAncestor(this.mustWs(id).path, tip, `refs/heads/${this.mustWs(id).branch}`) !== false
    const now = this.store.workspace(id)?.waitsFor
    if (rebased && keptForRebase(now) && now!.tip === tip) this.clearWait(id)
  }

  /**
   * The Lead's wait_for_merge, and a teammate's own (KERNEL-262, `told: false`): `on` replaces what the workspace waits for, with targets that merged already left out.
   * A teammate that started waits with its brief out (`held: false`). An empty list ends the wait, and a held brief goes now.
   */
  async setWait(id: string, on: string[], o: { told?: boolean; why?: string } = {}): Promise<Workspace> {
    const ws = this.mustWs(id)
    if (ws.status === 'archived') throw new Error(`${ws.name} is archived.`)
    const all = this.store.workspaces(ws.projectId)
    const left = [...new Set(on)].filter((t) => !isMerged(all.find((w) => w.id === t)))
    if (!left.length) { await this.dropWait(id); return this.mustWs(id) }
    if (ws.mode === 'current' || ws.reviewOf) throw new Error(`${ws.name} can't wait for a PR.`)
    const was = ws.waitsFor
    const held = ws.status === 'setup' || ws.status === 'failed' || !!was?.held
    this.releaseSent.delete(id)
    const next = this.updateWs(id, { waitsFor: { on: left, held, ...(was?.base ? { base: was.base } : {}) } })
    const label = this.waitLabelOf(next)
    // A held brief's wait shows in the composer's queue tray. A started teammate's shows nowhere else (KERNEL-973).
    if (next.status === 'ready' && !held) this.note(id, `Waiting for ${label} to merge. Kernel asks ${this.nameOf(next)} to ${await this.pushed(next) ? 'merge it in' : 'rebase onto it'} then.`, undefined, this.waitRefsOf(next))
    // The Lead set it, and reads what happened in the tool's result. A teammate's own wait is news for the Lead (KERNEL-262).
    this.leadUpdates.waits(next, 'wait.started', { on: left, label, held, ...(o.told === false ? {} : { told: true }), ...(o.why ? { why: o.why } : {}) })
    return next
  }

  /** What a teammate's wait_for_merge reads and calls (KERNEL-262). */
  teammateToolDeps(id: string): TeammateToolDeps {
    return {
      workspace: () => this.mustWs(id),
      workspaces: () => this.store.workspaces(this.mustWs(id).projectId),
      isLead: (w) => this.isLeadWorkspace(w),
      nameOf: (w) => this.nameOf(w),
      setWait: (on, why) => this.setWait(id, on, { told: false, why }),
      remote: () => this.k.config.remoteOfWs(this.mustWs(id)),
      team: () => this.agentsSync(this.mustWs(id).projectId),
      ask: (question, options) => this.leadUpdates.asked(this.mustWs(id), question, options),
      propose: (p) => this.leadUpdates.proposed(this.mustWs(id), p)
    }
  }

  /**
   * A hand-off whose Linear issue is blocked by issues open teammates are building (KERNEL-263). Once the brief has gone
   * out, it waits for their PRs without holding anything (the maintainer chose "tell on merge"), and Kernel asks the teammate to rebase
   * when they merge. Blockers with no open workspace, or one that merged, don't count. Returns the workspace when it waits.
   */
  async waitOnBlockers(ws: Workspace, blockedBy: string[]): Promise<Workspace | undefined> {
    const now = this.mustWs(ws.id)
    if (now.status !== 'ready' || now.waitsFor || now.source?.kind !== 'issue') return undefined
    // The blockers are keys in the project's tracker, which read them with the workspace's own issue and tagged it, so only
    // work on that tracker's issues counts (KERNEL-470).
    const tracker = issueTracker(now.source)
    const all = this.store.workspaces(ws.projectId)
    const remote = await this.k.config.remoteOfWs(now)
    const isLead = (w: Workspace) => !!this.agentsSync(ws.projectId).find((a) => a.id === w.agentId)?.lead
    const on = all
      .filter((w) => w.status !== 'archived' && !w.reviewOf && !isMerged(w) && blockedBy.some((key) => buildsIssue(w, key, tracker)))
      .filter((w) => !waitRefusal({ workspaces: all, refs: [w.id], waiter: now, isLead, remote }))
      .map((w) => w.id)
    return on.length ? this.setWait(ws.id, on) : undefined
  }
}
