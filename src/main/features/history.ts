import type { DeletePreview, DeleteResult, DeleteSkip, Room, Workspace } from '@shared/types'
import { branchState, currentBranch, listWorktrees } from '../services/worktrees'
import { exec } from '../services/exec'
import { dropCheckpoints } from '../services/checkpoints'
import { unpushedCommits } from '../services/archive'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** What Delete in History does for one workspace (KERNEL-333). See `deleteFacts`. */
interface DeleteFacts { ws: Workspace; room: Room; branch: 'none' | 'keep' | 'unpushed' | 'delete'; sessions: Map<string, number> }

/** `fn` over `items`, `limit` at a time. The results keep the order of `items`. */
async function inPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

/** Delete in History: archived workspaces, their branches, checkpoints and transcripts (KERNEL-333, KERNEL-328). */
export class History extends Feature {
  /** The delete from History under way, if any. A second one starts when it ends (KERNEL-333). */
  private deleting?: Promise<unknown>

  /** What Delete in History would do for `ids`, counted without deleting anything. */
  async deletePreview(ids: string[]): Promise<DeletePreview> {
    const { byRoom, skipped } = this.planDelete(ids)
    const facts = await this.deleteFacts(byRoom)
    return {
      workspaces: facts.length,
      skipped,
      unpushedBranches: facts.filter((f) => f.branch === 'unpushed').length,
      transcriptBytes: facts.reduce((n, f) => n + [...f.sessions.values()].reduce((a, b) => a + b, 0), 0)
    }
  }

  /** One delete at a time: a second call waits for the first, then plans against what is left. */
  deleteWorkspaces(ids: string[], o: { deleteUnpushed: boolean }): Promise<DeleteResult> {
    const next = (this.deleting ?? Promise.resolve()).catch(() => undefined).then(() => this.deleteNow(ids, o))
    this.deleting = next
    void next.finally(() => { if (this.deleting === next) this.deleting = undefined }).catch(() => undefined)
    return next
  }

  /** The archived workspaces in `ids` that can go, by room, and why the others stay. */
  private planDelete(ids: string[]) {
    const skipped: DeleteSkip[] = []
    const byRoom = new Map<string, Workspace[]>()
    for (const id of new Set(ids)) {
      const ws = this.store.workspace(id)
      const skip = (reason: string) => { skipped.push({ id, name: ws?.name ?? id, reason }) }
      if (!ws) { skip('Kernel no longer has it.'); continue }
      if (ws.status !== 'archived') { skip('It is not archived.'); continue }
      if (ws.name === 'lead' || this.isLeadWorkspace(ws)) { skip("It is the Lead's workspace."); continue }
      if (!this.store.room(ws.roomId)) { skip('Its room is gone.'); continue }
      const waiting = this.k.waits.waitersOn(id)
      if (waiting.length) { skip(waiting.length === 1 ? `${this.k.waits.nameOf(waiting[0])}'s workspace still waits on it.` : `${waiting.length} workspaces still wait on it.`); continue }
      byRoom.set(ws.roomId, [...(byRoom.get(ws.roomId) ?? []), ws])
    }
    return { byRoom, skipped }
  }

  /**
   * What Delete would do for each workspace, from reads only: the fate of its branch, and the Claude Code sessions it
   * leaves, by id with their size in bytes. Preview and delete both read it, so the numbers agree.
   *
   * A branch is kept when another record that stays uses it (review workspaces can share one, KERNEL-265), when a
   * worktree has it checked out, or when it is the room's current branch. Otherwise it goes when its PR merged, since
   * a squash merge makes `unpushedCommits` count merged work as unpushed, or when it holds nothing pushed nowhere.
   * A branch that does hold such commits, or whose commits can't be counted, is `unpushed`: kept unless asked.
   *
   * A worktree workspace that nobody else shares a folder with owns that folder's sessions, so the list finds the ones
   * Kernel forgot after /clear or a fresh session (KERNEL-286). Any other workspace, every current-branch one included,
   * shares its folder with the user's own Claude Code sessions and the Lead's, so only its chats' recorded ids go.
   */
  private async deleteFacts(byRoom: Map<string, Workspace[]>): Promise<DeleteFacts[]> {
    const going = new Set([...byRoom.values()].flat().map((w) => w.id))
    const staying = this.store.workspaces().filter((w) => !going.has(w.id))
    // A session a staying chat resumes is that chat's, wherever its file is. Fork into new workspace leaves the forked session
    // in the source worktree's project folder, so the source's list finds it too (KERNEL-346).
    const kept = new Set(staying.flatMap((w) => this.store.chats(w.id).flatMap((c) => (c.sessionId ? [c.sessionId] : []))))
    // Check and add in one step with no await between, so workspaces read at the same time can't claim a branch or session twice.
    const branches = new Set<string>()
    const claimed = new Set<string>()
    const facts: DeleteFacts[] = []
    for (const [roomId, list] of byRoom) {
      const room = this.mustRoom(roomId)
      const remote = await this.k.config.remoteFor(room.path)
      const trees = await listWorktrees(room.path).then((l) => l, () => undefined)
      const current = await currentBranch(room.path).catch(() => undefined)
      facts.push(...await inPool(list, 8, async (ws): Promise<DeleteFacts> => {
        const branchKey = `${roomId}\0${ws.branch}`
        const first = ws.mode === 'worktree' && !branches.has(branchKey)
        if (first) branches.add(branchKey)
        const state = first ? await branchState(room.path, ws.branch) : 'missing'
        let branch: DeleteFacts['branch'] = 'none'
        if (state === 'unknown') branch = 'keep'
        else if (state === 'exists') {
          const checkedOut = !trees || ws.branch === current || trees.some((t) => t.branch === ws.branch)
          if (checkedOut || staying.some((w) => w.roomId === roomId && w.branch === ws.branch)) branch = 'keep'
          else if (ws.prState === 'merged') branch = 'delete'
          else branch = (await unpushedCommits(room.path, ws.branch, ws.baseRef, remote)) === 0 ? 'delete' : 'unpushed'
        }
        const found = new Map<string, number>()
        if (ws.mode === 'worktree' && !staying.some((w) => w.path === ws.path)) {
          for (const info of await this.k.listSessions({ dir: ws.path, includeWorktrees: false }).catch(() => [])) found.set(info.sessionId, info.fileSize ?? 0)
        }
        for (const chat of this.store.chats(ws.id)) {
          // A forked chat's session may sit in another worktree's project folder (KERNEL-346), so a miss looks in every folder.
          if (chat.sessionId && !found.has(chat.sessionId)) found.set(chat.sessionId, ((await this.k.sessionInfo(chat.sessionId, { dir: ws.path }).catch(() => undefined)) ?? (await this.k.sessionInfo(chat.sessionId).catch(() => undefined)))?.fileSize ?? 0)
        }
        const sessions = new Map([...found].filter(([id]) => !claimed.has(id) && !kept.has(id)))
        for (const id of sessions.keys()) claimed.add(id)
        return { ws, room, branch, sessions }
      }))
    }
    return facts
  }

  private async deleteNow(ids: string[], o: { deleteUnpushed: boolean }): Promise<DeleteResult> {
    const { byRoom, skipped } = this.planDelete(ids)
    const deleted: string[] = []
    let keptBranches = 0
    let freedBytes = 0
    for (const f of await this.deleteFacts(byRoom)) {
      const { ws, room } = f
      // Disk first and records last, so a failure halfway leaves the row in History and Delete can run again.
      try {
        // Restored since the plan was made: it is open work again, so its branch and transcripts stay.
        if (this.store.workspace(ws.id)?.status !== 'archived') throw new Error('It is not archived.')
        const drop = f.branch === 'delete' || (f.branch === 'unpushed' && o.deleteUnpushed)
        if (drop) {
          const r = await exec('git', ['-C', room.path, 'branch', '-D', ws.branch])
          if (r.code !== 0) throw new Error(`Could not delete the branch ${ws.branch}: ${r.stderr.trim() || r.stdout.trim()}`)
        }
        await dropCheckpoints(room.path, ws.id).catch((e) => console.warn(`[delete] could not drop the checkpoints of ${ws.name}`, e))
        let bytes = 0
        for (const [id, size] of f.sessions) {
          const missing = (e: unknown) => /not found|invalid sessionId/i.test((e as Error).message)
          try { await this.k.deleteSession(id, { dir: ws.path }).catch((e) => (missing(e) ? this.k.deleteSession(id) : Promise.reject(e))); bytes += size } catch (e) { if (!missing(e)) throw e }
        }
        deleted.push(ws.id)
        freedBytes += bytes
        if (f.branch === 'unpushed' && !drop) keptBranches++
      } catch (e) {
        skipped.push({ id: ws.id, name: ws.name, reason: (e as Error).message })
      }
    }
    // The same order as removeRoom: the rows, then the files they point at.
    const sharedIds = deleted.flatMap((id) => this.store.sharedFiles({ workspaceId: id }).map((file) => file.id))
    this.store.deleteWorkspaces(deleted)
    await this.shared.remove(sharedIds)
    return { deleted, skipped, keptBranches, freedBytes }
  }

  handlers() {
    return {
      'workspaces.deletePreview': async ({ workspaceIds }) => this.deletePreview(workspaceIds),
      'workspaces.delete': async ({ workspaceIds, deleteUnpushed }) => this.deleteWorkspaces(workspaceIds, { deleteUnpushed })
    } satisfies Partial<Handlers>
  }
}
