import type { Workspace } from '@shared/types'
import { bus } from '../bus'
import { exec } from '../services/exec'
import { behindCount, fetchOrigin, folderGone, mergeTreeConflicts, snapshotCommit } from '../services/worktrees'
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

/** What Kernel tells a teammate whose branch main has moved away from in a way that would conflict (KERNEL-180). */
export function baseMessage(baseRef: string, behind: number, files: string[]): string {
  return `${baseRef} moved ${behind} ${behind === 1 ? 'commit' : 'commits'} since your branch started, and merging it now would conflict in ${listFiles(files)}. `
    + `At a stopping point, commit your work, rebase onto ${baseRef}, resolve the conflicts and re-run the tests. Then carry on with your task.`
}

/**
 * Tells a teammate when its base branch moves under it in a way that would conflict, before it opens a pull request, so it
 * rebases early (KERNEL-180). GitHub says so only once the PR exists. The check is local: `behind` counts the base's new
 * commits, and `git merge-tree` merges the worktree's committed and uncommitted work with the base in memory. It changes
 * no file, index or stash list, and takes no lock on the index. The teammate hears it through a Kernel message, only when it is idle, once per base commit.
 * Rowan isn't woken.
 *
 * Triggers, all real events: a PR in the room merged (with a fetch), a teammate's turn ended (it may be told what waited
 * while it was busy), and a workspace was created after a fetch that worked.
 */
export class BaseWatch extends Feature {
  private chain = new Map<string, Promise<unknown>>()

  /** One check at a time per room, so two triggers together can't tell a teammate twice. */
  check(roomId: string, o: { fetch: boolean; only?: string }): Promise<void> {
    const next = (this.chain.get(roomId) ?? Promise.resolve()).catch(() => undefined).then(() => this.run(roomId, o))
    this.chain.set(roomId, next)
    return next.finally(() => { if (this.chain.get(roomId) === next) this.chain.delete(roomId) })
  }

  /** Workspaces an open PR doesn't cover yet: GitHub's own conflict check takes over once it exists. */
  private watched(ws: Workspace): boolean {
    return ws.status === 'ready' && ws.mode === 'worktree' && !ws.reviewOf && !this.isLeadWorkspace(ws) && (ws.prState === 'none' || ws.prState === 'creating')
  }

  /** One read and one write, with nothing awaited between them, so two rooms' checks never undo each other's change. */
  private put(id: string, state?: Watched) {
    const all = { ...(this.store.meta<Record<string, Watched>>(META) ?? {}) }
    if (state) all[id] = state
    else if (id in all) delete all[id]
    else return
    this.store.saveMeta(META, all)
  }

  private async run(roomId: string, o: { fetch: boolean; only?: string }) {
    const room = this.store.room(roomId)
    if (!room || this.stopped) return
    if (o.fetch) {
      // Fresh, since this runs because something merged a moment ago, which a fetch already running may have missed.
      const fetched = await fetchOrigin(room.path, await this.k.config.remoteFor(room.path), { fresh: true }).catch(() => undefined)
      if (!fetched?.ok) return
    }
    const known = this.store.meta<Record<string, Watched>>(META) ?? {}
    for (const id of Object.keys(known)) if (!this.store.workspace(id)) this.put(id)
    for (const ws of this.store.workspaces(roomId)) {
      if (o.only && ws.id !== o.only) continue
      if (!this.watched(ws)) { this.put(ws.id); continue }
      await this.watch(ws).catch(() => undefined)
    }
  }

  private async watch(ws: Workspace) {
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
    if (conflicts.length && state.told !== sha && this.tell(this.store.workspace(ws.id) ?? ws, state)) this.put(ws.id, { ...state, told: sha })
  }

  /**
   * The message goes through `Sessions.post`, which sends nothing while the teammate is mid-turn, has messages queued, or
   * is held. The next check tells it then. True when it went, with a line in the room's log.
   */
  private tell(ws: Workspace, state: Watched): boolean {
    const chat = this.prChat(ws.id)
    if (!chat || !this.watched(ws)) return false
    let sent = false
    try { sent = this.sessions.post(chat.id, [{ type: 'text', text: baseMessage(ws.baseRef, state.behind, state.conflicts) }]) } catch { return false }
    if (!sent) return false
    const agent = this.k.team.agentOf(ws.roomId, ws.agentId)
    bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, actor: 'kernel', text: `told ${agent?.name ?? 'the teammate'} to rebase, since ${ws.baseRef} moved ${state.behind} ${state.behind === 1 ? 'commit' : 'commits'} and would conflict in`, object: listFiles(state.conflicts, 3) })
    return true
  }
}
