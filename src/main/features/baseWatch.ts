import type { ChatPart, Workspace } from '@shared/types'
import { ownsFolder } from '@shared/leadWorkspace'
import { bus } from '../bus'
import { exec, git } from '../services/exec'
import { behindCount, fastForward, fetchOrigin, folderGone, isPushed, mergeTreeConflicts, snapshotCommit } from '../services/worktrees'
import { Feature } from './feature'

/** Store meta: what the last check found for each workspace it watches (KERNEL-180). */
const META = 'baseWatch'

/** How many conflicting files the message names before it says "and N more". */
const SHOWN = 10

/**
 * What the last check found for one workspace: the base commit it compared with, how many commits the base has that the branch
 * doesn't, the files a merge would conflict in, and `told`, the base commit the teammate was told about.
 */
interface Watched { sha: string; behind: number; conflicts: string[]; told?: string }

/** "a", "a and b", "a, b and c". Past `max` files it names the first `max` and counts the rest: "a, b and 3 more". */
export function listFiles(files: string[], max = SHOWN): string {
  if (files.length <= max) return files.length > 1 ? `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}` : files[0] ?? ''
  return `${files.slice(0, max).join(', ')} and ${files.length - max} more`
}

/**
 * How a teammate takes the base: a rebase while the branch has never been pushed, a merge once `pushedTo` has it, since
 * that rebase would need a force push, which the team doesn't make (KERNEL-886).
 */
const takeBase = (baseRef: string, pushedTo?: string) => (pushedTo ? `merge ${baseRef} into your branch` : `rebase onto ${baseRef}`)
const mergeWhy = (pushedTo?: string) => (pushedTo ? ` Your branch is on ${pushedTo}, so merge rather than rebase.` : '')

/** What Kernel tells a teammate whose branch main has moved away from in a way that would conflict (KERNEL-180). */
export function baseMessage(baseRef: string, behind: number, files: string[], pushedTo?: string): string {
  return `${baseRef} moved ${behind} ${behind === 1 ? 'commit' : 'commits'} since your branch started, and merging it now would conflict in ${listFiles(files)}. `
    + `At a stopping point, commit your work, ${takeBase(baseRef, pushedTo)}, resolve the conflicts and re-run the tests.${mergeWhy(pushedTo)} Then carry on with your task.`
}

/** What Kernel tells a teammate whose branch started from a stale base, once a fetch works, when it has work of its own (KERNEL-653). */
export function catchUpMessage(baseRef: string, behind: number, pushedTo?: string): string {
  return `Kernel couldn't fetch when your workspace started, so your branch began from ${baseRef} as last fetched. The fetch works now, and ${baseRef} has ${behind} ${behind === 1 ? 'commit' : 'commits'} your branch doesn't. `
    + `At a stopping point, commit your work, ${takeBase(baseRef, pushedTo)} and re-run the tests.${mergeWhy(pushedTo)} Then carry on with your task.`
}

/**
 * Tells a teammate when its base branch moves under it in a way that would conflict, before it opens a pull request, so it
 * takes the base early (KERNEL-180). GitHub says so only once the PR exists. The check is local: `behind` counts the base's new
 * commits, and `git merge-tree` merges the worktree's committed and uncommitted work with the base in memory. It changes
 * no file, index or stash list, and takes no lock on the index. The teammate hears it through a Kernel message, only when it is idle, once per base commit.
 * The Lead isn't woken.
 *
 * Triggers, all real events: a PR in the project merged (with a fetch), a teammate's turn ended (it may be told what waited
 * while it was busy), and a workspace was created after a fetch that worked.
 *
 * It also catches up a workspace that started from a stale base because its fetch failed (KERNEL-179), once a fetch of the
 * project's remote passes (KERNEL-653). A teammate's turn end, while its workspace has `fetchFailed`, fetches again (reusing
 * one that passed in the last minute), so that retry is a real event too.
 */
export class BaseWatch extends Feature {
  private chain = new Map<string, Promise<unknown>>()

  /** One check at a time per project, so two triggers together can't tell a teammate twice. */
  check(projectId: string, o: { fetch: boolean; only?: string; fetched?: boolean }): Promise<void> {
    const next = (this.chain.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(() => this.run(projectId, o))
    this.chain.set(projectId, next)
    return next.finally(() => { if (this.chain.get(projectId) === next) this.chain.delete(projectId) })
  }

  /**
   * Workspaces an open PR doesn't cover yet: GitHub's own conflict check takes over once it exists, and its news reaches the
   * chat as a Team update. A chat with Kernel's own folder counts as a teammate's (KERNEL-778).
   */
  private watched(ws: Workspace): boolean {
    return ws.status === 'ready' && ws.mode === 'worktree' && !ws.reviewOf && this.teammateLike(ws) && (ws.prState === 'none' || ws.prState === 'creating')
  }

  /** A teammate's workspace, or a chat with Kernel's own folder, which builds like one (KERNEL-778). */
  private teammateLike(ws: Workspace) { return !ws.shared && (!this.isLeadWorkspace(ws) || ownsFolder(ws)) }

  /** One read and one write, with nothing awaited between them, so two projects' checks never undo each other's change. */
  private put(id: string, state?: Watched) {
    const all = { ...(this.store.meta<Record<string, Watched>>(META) ?? {}) }
    if (state) all[id] = state
    else if (id in all) delete all[id]
    else return
    this.store.saveMeta(META, all)
  }

  private async run(projectId: string, o: { fetch: boolean; only?: string; fetched?: boolean }) {
    const project = this.store.project(projectId)
    if (!project || this.stopped) return
    const remote = await this.k.config.remoteFor(project.path)
    let fetched = !!o.fetched
    if (o.fetch) {
      // Fresh, since this runs because something merged a moment ago, which a fetch already running may have missed.
      const r = await fetchOrigin(project.path, remote, { fresh: true }).catch(() => undefined)
      if (!r?.ok) return
      fetched = true
    } else if (o.only && this.store.workspace(o.only)?.fetchFailed) {
      // A turn end of a workspace that started stale tries the fetch again (KERNEL-653).
      fetched = !!(await fetchOrigin(project.path, remote).catch(() => undefined))?.ok
    }
    const caughtUp = fetched ? await this.catchUp(projectId, remote) : new Set<string>()
    const known = this.store.meta<Record<string, Watched>>(META) ?? {}
    for (const id of Object.keys(known)) if (!this.store.workspace(id)) this.put(id)
    for (const ws of this.store.workspaces(projectId)) {
      if (o.only && ws.id !== o.only) continue
      // Just moved, or just asked to rebase: one message is enough.
      if (caughtUp.has(ws.id)) continue
      if (!this.watched(ws)) { this.put(ws.id); continue }
      await this.watch(ws, remote).catch(() => undefined)
    }
  }

  private async watch(ws: Workspace, remote: string) {
    if (this.stopped || await folderGone(ws.path)) return
    const base = await exec('git', ['-C', ws.path, 'rev-parse', '--verify', '--quiet', `${ws.baseRef}^{commit}`])
    const sha = base.code === 0 ? base.stdout.trim() : ''
    const behind = sha ? await behindCount(ws.path, ws.baseRef) : undefined
    // A base git can't read says nothing, and what was saved stays.
    if (behind === undefined) return
    if (behind === 0) return this.put(ws.id)
    // The worktree as it is now, with the changes it hasn't committed, made without touching its folder, index or stash list.
    const conflicts = await mergeTreeConflicts(ws.path, await snapshotCommit(ws.path), ws.baseRef)
    // Git older than 2.38 can't do this, and some other failure says nothing either.
    if (conflicts === undefined) return
    const before = this.store.meta<Record<string, Watched>>(META)?.[ws.id]
    const state: Watched = { sha, behind, conflicts, ...(before?.told ? { told: before.told } : {}) }
    this.put(ws.id, state)
    if (!conflicts.length || state.told === sha) return
    const pushedTo = await isPushed(ws.path, ws.branch, remote) ? remote : undefined
    if (this.tell(this.store.workspace(ws.id) ?? ws, state, pushedTo)) this.put(ws.id, { ...state, told: sha })
  }

  /** A turn runs in the workspace or a message waits to go, so its files mustn't move. */
  private busy(id: string): boolean {
    return this.store.chats(id).some((c) => this.sessions.isRunning(c.id) || this.sessions.queued(c.id).length > 0)
  }

  /**
   * After a fetch of the project's remote passed: each idle teammate workspace with `fetchFailed` moves to its base when it has
   * no work of its own, or is told once to take the base when it has, and loses `fetchFailed` (KERNEL-653). A busy one waits for its
   * turn end. Returns the workspaces it moved or told.
   */
  private async catchUp(projectId: string, remote: string): Promise<Set<string>> {
    const done = new Set<string>()
    for (const ws of this.store.workspaces(projectId)) {
      if (!ws.fetchFailed || ws.status !== 'ready' || ws.mode !== 'worktree' || ws.reviewOf || !this.teammateLike(ws)) continue
      if (await this.catchUpOne(ws, remote).catch(() => false)) done.add(ws.id)
    }
    return done
  }

  private async catchUpOne(ws: Workspace, remote: string): Promise<boolean> {
    // Read again after each step that waits on git: a turn can start while git runs.
    const held = () => this.stopped || this.busy(ws.id)
    if (held() || await folderGone(ws.path)) return false
    const count = async (range: string) => Number((await git(ws.path, 'rev-list', '--count', range)).trim())
    const behind = await count(`HEAD..${ws.baseRef}`)
    const own = await count(`${ws.baseRef}..HEAD`)
    const changed = (await git(ws.path, 'status', '--porcelain', '--untracked-files=no')).trim() !== ''
    const pushedTo = await isPushed(ws.path, ws.branch, remote) ? remote : undefined
    if (held()) return false
    const agent = this.k.team.agentOf(ws.projectId, ws.agentId)?.name ?? 'the teammate'
    if (behind && (own || changed || !(await fastForward(ws.path, ws.baseRef)))) {
      const chat = this.prChat(ws.id)
      if (held() || !chat) return false
      let sent = false
      const catchUp: ChatPart[] = [{ type: 'text', text: catchUpMessage(ws.baseRef, behind, pushedTo) }]
      try { sent = this.sessions.post(chat.id, catchUp) } catch { return false }
      if (!sent) return false
      this.updateWs(ws.id, { fetchFailed: undefined })
      bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId, actor: 'kernel', text: `told ${agent} to ${pushedTo ? `merge ${ws.baseRef} in` : `rebase onto ${ws.baseRef}`}, since its workspace started from it as last fetched` })
      return true
    }
    if (this.stopped) return false
    this.updateWs(ws.id, { fetchFailed: undefined })
    this.note(ws.id, `Fetched ${remote}, so this workspace now starts from the latest ${ws.baseRef}.`)
    if (behind) {
      bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId, actor: 'kernel', text: `updated ${agent}'s worktree to ${ws.baseRef}, ${behind === 1 ? '1 new commit' : `${behind} new commits`}` })
      void this.k.workspaces.changes(ws.id).catch(() => undefined)
    }
    return true
  }

  /**
   * The message goes through `Sessions.post`, which sends nothing while the teammate is mid-turn, has messages queued, or
   * is held. The next check tells it then. True when it went, with a line in the project's log.
   */
  private tell(ws: Workspace, state: Watched, pushedTo?: string): boolean {
    const chat = this.prChat(ws.id)
    if (!chat || !this.watched(ws)) return false
    let sent = false
    const base: ChatPart[] = [{ type: 'text', text: baseMessage(ws.baseRef, state.behind, state.conflicts, pushedTo) }]
    try { sent = this.sessions.post(chat.id, base) } catch { return false }
    if (!sent) return false
    const agent = this.k.team.agentOf(ws.projectId, ws.agentId)
    bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId, actor: 'kernel', text: `told ${agent?.name ?? 'the teammate'} to ${pushedTo ? `merge ${ws.baseRef} in` : 'rebase'}, since ${ws.baseRef} moved ${state.behind} ${state.behind === 1 ? 'commit' : 'commits'} and would conflict in`, object: listFiles(state.conflicts, 3) })
    return true
  }
}
