import { basename, dirname } from 'node:path'
import { rm, stat } from 'node:fs/promises'
import type { Workspace } from '@shared/types'
import { bus } from '../bus'
import { cleanupSwitch, loadRepoSettings } from '../services/settings'
import { detachWorktree, folderGone, restoreWorktree } from '../services/worktrees'
import { blocksOverlap, linkNodeModules, runScript, scriptTimeout, stopRuns, stopScript, timeoutText } from '../services/scripts'
import { snapshot } from '../services/checkpoints'
import { discardChanges, gitStatus, pushBranch, unpushedCommits } from '../services/archive'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** Archiving and restoring workspaces, the worktree folders archive throws away, and discarding changes (KERNEL-328). */
export class Archive extends Feature {
  /** Archives under way, so a second call for the same workspace waits for the first. */
  private archiving = new Map<string, Promise<void>>()
  /**
   * Worktree folders archive moved aside and hasn't deleted yet (KERNEL-284). Saved under the meta key `trash`, so a
   * delete cut short by a quit, or one that failed, runs again at the next start. `emptying` is the queue, one at a time.
   */
  private trash = new Set<string>()
  private emptying: Promise<void> = Promise.resolve()

  /** Throws away uncommitted changes, after a checkpoint so they can still come back from the drawer. */
  private async discard(workspaceId: string) {
    const ws = this.mustWs(workspaceId)
    if (ws.mode === 'current') throw new Error('Discard is off on the current branch, because it would throw away your own changes too. Revert to a checkpoint instead.')
    const chats = this.store.chats(workspaceId)
    if (chats.some((c) => this.sessions.isRunning(c.id))) throw new Error('The agent is still working. Stop it first, then discard.')
    const chat = chats.find((c) => c.kind !== 'terminal')
    if (chat) await snapshot(ws, { chatId: chat.id, title: 'Before discarding changes' }).then((c) => bus.push({ type: 'checkpoint', checkpoint: c }))
    await discardChanges(ws.path)
    bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId, agentId: ws.agentId, actor: 'you', text: 'discarded the changes in', object: ws.name })
  }

  /**
   * One archive per workspace at a time: a second call while one runs waits for it, instead of removing the worktree twice.
   * The Lead's workspace only goes with its room (`removingRoom`), since every Lead chat lives there (KERNEL-355).
   */
  async archiveWorkspace(id: string, deleteBranch?: boolean, o: { keepWorktree?: boolean; removingRoom?: boolean } = {}): Promise<void> {
    if (this.store.workspace(id)?.lead && !o.removingRoom) throw new Error("The Lead's workspace stays as long as its room. Close its chats instead.")
    const running = this.archiving.get(id)
    if (running) return running
    const next = this.archiveNow(id, deleteBranch, o).finally(() => this.archiving.delete(id))
    this.archiving.set(id, next)
    return next
  }

  private async archiveNow(id: string, deleteBranch?: boolean, o: { keepWorktree?: boolean; removingRoom?: boolean } = {}) {
    this.k.setup.setupFailures.delete(id)
    // The branch the work is on now: archive deletes it, and restore brings it back.
    const ws = await this.k.prs.syncBranch(id)
    const room = this.mustRoom(ws.roomId)
    this.sessions.stopWorkspace(id)
    this.ptys.killWorkspace(id, this.store.chats(id).map((c) => c.id))
    stopRuns(id)
    // A setup still running would finish after the archive and report on a workspace that is gone.
    stopScript(id, 'setup')
    const repo = await loadRepoSettings(room.path)
    // A folder deleted outside Kernel has nothing to run the script in, and counts as removed (KERNEL-109).
    const gone = await folderGone(ws.path)
    if (!gone && repo.scripts.archive && this.settings.scripts.archiveOnArchive) {
      // Archiving never waits on trust: untrusted text is skipped and the workspace archives (KERNEL-209).
      if (await this.k.trust.untrusted(room, repo)) bus.push({ type: 'script.output', workspaceId: id, kind: 'archive', lines: [{ line: "Skipped the archive script: this room's scripts aren't trusted yet.", stream: 'stderr' }] })
      else if (await runScript({ workspaceId: id, kind: 'archive', script: repo.scripts.archive, cwd: ws.path, env: this.k.env.envFor(ws, { script: true }), timeoutMs: scriptTimeout(this.settings) }) === 'timeout') {
        // A hung archive script would hold the archive forever. It is stopped and the archive goes on (KERNEL-216).
        bus.push({ type: 'script.output', workspaceId: id, kind: 'archive', lines: [{ line: `The archive script didn't finish in ${timeoutText(this.settings)}, so Kernel stopped it.`, stream: 'stderr' }] })
      }
    }
    // Commits that never left this machine live only on the branch, so it stays whatever was asked. So does a branch
    // whose commits can't be counted: an unknown count is not zero (KERNEL-70).
    // A kept worktree still has its branch checked out, so the branch stays with it.
    // The caller's choice wins, then the room's own value, then the app's (KERNEL-370).
    // The Lead's worktree is detached, so it has no branch to delete (KERNEL-355).
    const wanted = ws.mode === 'worktree' && !ws.lead && !o.keepWorktree && (deleteBranch ?? cleanupSwitch(repo, this.settings.workspace, 'deleteBranchOnArchive'))
    const unpushed = wanted ? await unpushedCommits(room.path, ws.branch, ws.baseRef, await this.k.config.remoteFor(room.path, repo)) : 0
    if (wanted && unpushed === null) bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'kept the branch because its commits could not be counted:', object: ws.branch, warn: true })
    // The folder only moves aside here, and is deleted after the workspace is archived, without waiting (KERNEL-284).
    const moved = ws.mode === 'worktree' && !o.keepWorktree ? await detachWorktree(room.path, ws.path, { force: true, deleteBranch: wanted && unpushed === 0 ? ws.branch : undefined, moving: (p) => this.keepTrash(p) }) : undefined
    // Archiving a waiter ends its wait (KERNEL-259).
    const archived = this.updateWs(id, { status: 'archived', archivedAt: Date.now(), waitsFor: undefined }, { archived: true })
    if (moved) this.throwAway(moved)
    this.k.waits.releaseSent.delete(id)
    this.k.prs.cancelRecheck(id)
    // Work archived without merging never will, so whoever waits for it is stuck. A closed PR already said so.
    if (archived.prState !== 'merged' && archived.prState !== 'closed') for (const w of this.k.waits.waitersOn(id)) this.k.waits.breakWait(w, archived, 'archived')
    // Only once it is archived: an archive that fails keeps the brief for Run again.
    this.sessions.dropHeld(id)
    // Nothing in an archived workspace can still be answered or merged from the inbox (D-137).
    this.approvals.expireWorkspace(id)
    this.notifications.forgetWorkspace(id)
    bus.activity({ kind: 'workspace.archived', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'archived', object: ws.name })
    void this.overlaps.check(ws.roomId).catch(() => undefined)
  }

  /**
   * Queues a moved-aside worktree folder for deletion. `rm` unlinks a symlinked `node_modules` and leaves what it points
   * to alone. A path leaves the saved list only once it is deleted; a failure stays for the next start, silently. Only a
   * folder inside a `.trash` folder is deleted, whatever the saved list says.
   */
  private throwAway(path: string) {
    this.keepTrash(path)
    this.emptying = this.emptying.then(async () => {
      if (this.stopped) return
      if (basename(dirname(path)) === '.trash') try { await rm(path, { recursive: true, force: true }) } catch { return }
      // A quit closes the database, and the path is still saved for the next start.
      if (this.stopped) return
      this.trash.delete(path)
      this.saveTrash()
    }).catch(() => undefined)
  }
  private keepTrash(path: string) { if (!this.trash.has(path)) { this.trash.add(path); this.saveTrash() } }
  private saveTrash() { this.store.saveMeta('trash', [...this.trash]) }

  /** Resolves once every queued folder delete has run, including ones queued while it waits. */
  async trashEmptied(): Promise<void> {
    for (let p = this.emptying; ; p = this.emptying) { await p; if (p === this.emptying) return }
  }

  /** Brings an archived workspace back: recreates the worktree from its branch and reopens its chats, which Kernel kept. */
  async restoreWorkspace(id: string): Promise<Workspace> {
    const ws = this.mustWs(id)
    if (ws.status !== 'archived') return ws
    const room = this.mustRoom(ws.roomId)
    if (ws.mode === 'worktree') {
      const path = await stat(ws.path).then(() => undefined, () => ws.path)
      if (!path) throw new Error(`The folder ${ws.path} is back in use, so ${ws.name} cannot be restored there.`)
      const repo = await loadRepoSettings(room.path)
      await restoreWorktree({ repo: room.path, path, branch: ws.branch, remote: await this.k.config.remoteFor(room.path, repo) })
      if (!(await this.k.trust.untrusted(room, repo))) await this.k.setup.copyFiles(ws, room, repo)
      else bus.push({ type: 'script.output', workspaceId: ws.id, kind: 'setup', lines: [{ line: "Did not copy local files: this room's scripts aren't trusted yet.", stream: 'stderr' }] })
      if (repo.files.symlinkNodeModules) await linkNodeModules(room.path, path)
    } else if (this.settings.workspace.oneCurrentBranchPerRoom && this.store.workspaces(ws.roomId).some((w) => w.mode === 'current' && w.status !== 'archived' && w.agentId !== ws.agentId)) {
      throw new Error('Another workspace is already working on the current branch in this room.')
    }
    // It keeps its port, unless another workspace took a port in its block while it was archived.
    const clash = [...this.k.workspaces.openPorts(), ...this.k.workspaces.reservedPorts].some((p) => blocksOverlap(p, ws.port))
    const back = clash ? await this.k.workspaces.withPort((port) => this.updateWs(id, { archivedAt: undefined, port, status: 'ready' }, { archived: true }))
      : this.updateWs(id, { archivedAt: undefined, status: 'ready' }, { archived: true })
    // A review the user brings back stays, even though the work it reviewed is done (KERNEL-136).
    this.k.autoArchive.unmarkReviews(id)
    bus.activity({ kind: 'workspace.restored', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'restored', object: ws.name })
    return back
  }

  /**
   * The sidebar's check before a one-click archive: whether archiving would lose uncommitted work. A current-branch
   * workspace removes no files, and neither does a worktree whose folder is already gone (KERNEL-109).
   */
  async unsavedOf(id: string): Promise<'dirty' | 'unknown' | false> {
    try {
      const ws = await this.k.prs.syncBranch(id)
      if (ws.mode !== 'worktree') return false
      if (await folderGone(ws.path)) return false
      return (await gitStatus(ws.path, ws.branch, ws.baseRef, await this.k.config.remoteOfWs(ws))).dirty.files ? 'dirty' : false
    } catch { return 'unknown' }
  }

  /**
   * A workspace's agent is working, or has a message waiting to start a turn. One whose setup failed isn't: its held
   * brief waits for the user to click Run again, not for a turn. Nor is one whose brief waits for a merge (KERNEL-259).
   */
  working(id: string) {
    const ws = this.store.workspace(id)
    if (ws?.status === 'failed' || ws?.waitsFor?.held) return false
    return this.chatTabs(id).some((c) => this.sessions.isRunning(c.id) || this.sessions.queued(c.id).length > 0)
  }


  /** At launch: worktree folders a quit or a failure left behind are deleted now (KERNEL-284). */
  start() {
    for (const path of this.store.meta<string[]>('trash') ?? []) this.throwAway(path)
  }
  handlers() {
    return {
      'workspaces.restore': async ({ workspaceId }) => this.restoreWorkspace(workspaceId),
      'workspaces.archive': async ({ workspaceId, deleteBranch, push }) => {
        if (push) { const ws = await this.k.prs.syncBranch(workspaceId); await pushBranch(ws.path, ws.branch, await this.k.config.remoteOfWs(ws)) }
        await this.k.archiveWorkspace(workspaceId, deleteBranch)
        return { ok: true }
      },
      'workspaces.gitStatus': async ({ workspaceId }) => { const ws = await this.k.prs.syncBranch(workspaceId); return gitStatus(ws.path, ws.branch, ws.baseRef, await this.k.config.remoteOfWs(ws)) },
      'workspaces.discard': async ({ workspaceId }) => { await this.discard(workspaceId); return { ok: true } }
    } satisfies Partial<Handlers>
  }
}
