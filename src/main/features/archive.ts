import { basename, dirname } from 'node:path'
import { rm, stat } from 'node:fs/promises'
import type { Room, Thread, Workspace } from '@shared/types'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import { bus } from '../bus'
import { cleanupSwitch, loadRepoSettings, type RepoSettings } from '../services/settings'
import { branchExists, branchState, createWorktree, detachWorktree, dropBranch, folderGone, freeBranch, leadBase, restoreWorktree } from '../services/worktrees'
import { blocksOverlap, linkNodeModules, runScript, scriptTimeout, stopRuns, stopScript, timeoutText } from '../services/scripts'
import { dropCheckpoints, snapshot } from '../services/checkpoints'
import { discardChanges, gitStatus, pushBranch, unpushedCommits } from '../services/archive'
import { exec, git } from '../services/exec'
import { firstLine } from '../services/text'
import { NEW_CHAT, NEW_TAB } from './shared'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

const DAY = 24 * 60 * 60 * 1000
/** What an archive's cleanup was asked, saved so a cleanup a quit cut short finishes the same way (KERNEL-702). */
type Cleanup = { deleteBranch?: boolean; keepWorktree?: boolean; noScript?: boolean }
/** How long an archived workspace keeps its checkpoints, so Restore within it still has its Revert entries (KERNEL-221). */
export const KEEP_CHECKPOINTS_MS = 30 * DAY

/** Archiving and restoring workspaces, the worktree folders archive throws away, and discarding changes (KERNEL-328). */
export class Archive extends Feature {
  /** Archives under way, so a second call for the same workspace waits for the first, and whether each keeps its worktree. */
  private archiving = new Map<string, { done: Promise<void>; keepWorktree?: boolean }>()
  /** Cleanups after an archive that are under way, by workspace, and what each was asked (KERNEL-702). `pending` is saved as `cleanups`. */
  private cleanups = new Map<string, Promise<void>>()
  private pending: Record<string, Cleanup> = {}
  /**
   * Worktree folders archive moved aside and hasn't deleted yet (KERNEL-284). Saved under the meta key `trash`, so a
   * delete cut short by a quit, or one that failed, runs again at the next start. `emptying` is the queue, one at a time.
   */
  private trash = new Set<string>()
  private emptying: Promise<void> = Promise.resolve()
  /** The daily run that drops old checkpoints, and the run under way, so two never overlap (KERNEL-221). */
  private checkpointTimer?: NodeJS.Timeout
  private dropping?: Promise<void>

  /** Throws away uncommitted changes, after a checkpoint so they can still come back from the drawer. */
  private async discard(workspaceId: string) {
    const ws = this.mustWs(workspaceId)
    if (ws.mode === 'current') throw new Error('Discard is off on the current branch, because it would throw away your own changes too. Revert to a checkpoint instead.')
    if (ws.worktreePending) throw new Error("This chat's worktree isn't made yet.")
    const chats = this.store.chats(workspaceId)
    if (chats.some((c) => this.sessions.isRunning(c.id))) throw new Error('The agent is still working. Stop it first, then discard.')
    const chat = chats.find((c) => c.kind !== 'terminal')
    if (chat) await snapshot(ws, { chatId: chat.id, title: 'Before discarding changes' }).then((c) => bus.push({ type: 'checkpoint', checkpoint: c }))
    await discardChanges(ws.path)
    bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId, agentId: ws.agentId, actor: 'you', text: 'discarded the changes in', object: ws.name })
  }

  /**
   * One archive per workspace at a time: a second call while one runs, its cleanup included, waits for it, instead of removing
   * the worktree twice. Its own choice to delete the branch still counts (KERNEL-139). Keeping it, or not saying, leaves the
   * running one's. A Lead chat's workspace archives like any other (KERNEL-405). The shared Lead workspace from before only
   * goes with its room, or when its chats move out (`removingRoom`). `noScript` skips the archive script, for a workspace that
   * never ran the room's scripts.
   *
   * It resolves once the record says archived. The worktree, the archive script and the branch are dealt with after, in the
   * background, and `cleanedUp` says when that is done (KERNEL-702).
   */
  async archiveWorkspace(id: string, deleteBranch?: boolean, o: { keepWorktree?: boolean; removingRoom?: boolean; noScript?: boolean } = {}): Promise<void> {
    const ws = this.store.workspace(id)
    if (ws?.lead && !ws.threadId && !o.removingRoom) throw new Error("The Lead's workspace stays as long as its room. Archive its chats instead.")
    const running = this.archiving.get(id)
    if (running) {
      await running.done
      await this.cleanedUp(id)
      // A kept worktree still has its branch checked out, so the branch stays with it.
      if (deleteBranch && !running.keepWorktree) await this.deleteKeptBranch(id)
      return
    }
    const done = this.archiveNow(id, deleteBranch, o)
    const entry = { done, keepWorktree: o.keepWorktree }
    this.archiving.set(id, entry)
    void done.then(() => this.cleanups.get(id), () => undefined).then(() => { if (this.archiving.get(id) === entry) this.archiving.delete(id) })
    return done
  }

  /** An archive of the workspace is under way, its cleanup included. */
  archivingNow(id: string) { return this.archiving.has(id) || this.cleanups.has(id) }

  /**
   * Resolves once the workspace's cleanup after its archive has finished, or at once when none runs, like `trashEmptied`
   * (KERNEL-702). An archive still saving the record is waited for first. Never rejects: a cleanup that fails says so in a note.
   */
  async cleanedUp(id: string): Promise<void> {
    await this.archiving.get(id)?.done.catch(() => undefined)
    await this.cleanups.get(id)
  }

  /**
   * Deletes the branch an archive that just finished kept, with that archive's guards: never on the current branch, and
   * never with commits that never left this machine or can't be counted (KERNEL-70). A kept branch gets a note saying why.
   */
  private async deleteKeptBranch(id: string) {
    const ws = this.mustWs(id)
    // Restored since, so its branch is checked out again.
    // The shared Lead worktree from before KERNEL-405 is detached, so it has no branch to delete (KERNEL-355).
    if (ws.status !== 'archived' || ws.mode !== 'worktree' || ws.branch === 'HEAD') return
    const room = this.mustRoom(ws.roomId)
    if (!(await branchExists(room.path, ws.branch))) return
    const unpushed = await unpushedCommits(room.path, ws.branch, ws.baseRef, await this.k.config.remoteFor(room.path, await loadRepoSettings(room.path)))
    if (unpushed === 0) return dropBranch(room.path, ws.branch)
    const why = unpushed === null ? 'kept the branch because its commits could not be counted:' : 'kept the branch because it has commits that were never pushed:'
    bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: why, object: ws.branch, warn: true })
  }

  /** The quick part of an archive: everything that stops work in the workspace, then the record says archived (KERNEL-702). */
  private async archiveNow(id: string, deleteBranch?: boolean, o: { keepWorktree?: boolean; removingRoom?: boolean; noScript?: boolean } = {}) {
    this.k.setup.setupFailures.delete(id)
    // The branch the work is on now: archive deletes it, and restore brings it back. It is read here because `syncBranch`
    // leaves an archived workspace alone. A Lead chat whose worktree isn't made yet keeps the branch it picked (KERNEL-542).
    const ws = await this.k.prs.syncBranch(id)
    // A plan card ends as archived before its session stops, which would end it without a reason.
    this.approvals.expireIds(this.store.approvals({ workspaceId: id, pendingOnly: true }).filter((a) => a.kind === 'plan').map((a) => a.id), 'archived')
    this.sessions.stopWorkspace(id)
    this.ptys.killWorkspace(id, this.store.chats(id).map((c) => c.id))
    stopRuns(id)
    // A setup still running would finish after the archive and report on a workspace that is gone.
    stopScript(id, 'setup')
    // Archiving a waiter ends its wait (KERNEL-259). An archived workspace has no folder to miss (KERNEL-291).
    const archived = this.updateWs(id, { status: 'archived', archivedAt: Date.now(), waitsFor: undefined, folderGone: undefined }, { archived: true })
    // In the same tick as the save, so its port block is never free while the cleanup runs.
    this.cleanUp(id, { deleteBranch, keepWorktree: o.keepWorktree, noScript: o.noScript })
    // A Lead chat is archived with its workspace (KERNEL-405).
    if (isLeadChatWorkspace(archived)) this.markThread(archived.threadId!, Date.now())
    this.k.waits.releaseSent.delete(id)
    this.k.prs.forgetPr(id)
    // Work archived without merging never will, so whoever waits for it is stuck. A closed PR already said so.
    if (archived.prState !== 'merged' && archived.prState !== 'closed') for (const w of this.k.waits.waitersOn(id)) this.k.waits.breakWait(w, archived, 'archived')
    // Only once it is archived: an archive that fails keeps the brief for Run again.
    this.sessions.dropHeld(id)
    // Nothing in an archived workspace can still be answered or merged from the inbox (D-137).
    this.approvals.expireWorkspace(id)
    this.notifications.forgetWorkspace(id)
    bus.activity({ kind: 'workspace.archived', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'archived', object: ws.name })
  }

  /**
   * Starts an archived workspace's cleanup in the background (KERNEL-702). It is saved under the meta key `cleanups` until it
   * ends, so one a quit cuts short runs again at the next start. Until then the workspace's port block stays reserved, and its
   * folder stays taken, as git still lists it. A failure is a warning note on the workspace, never a throw.
   */
  private cleanUp(id: string, c: Cleanup) {
    const port = this.store.workspace(id)?.port
    if (port !== undefined) this.k.workspaces.reservedPorts.add(port)
    this.pending[id] = c
    this.savePending()
    const run: Promise<void> = this.cleanNow(id, c).catch((e) => {
      if (this.stopped) return
      const ws = this.store.workspace(id)
      if (!ws) return
      console.warn(`[archive] cleaning up ${ws.name} failed`, e)
      bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, actor: 'kernel', text: "couldn't finish cleaning up after archiving", object: ws.name, warn: true, quote: firstLine(e instanceof Error ? e.message : String(e)) })
    }).finally(() => {
      if (port !== undefined) this.k.workspaces.reservedPorts.delete(port)
      if (this.cleanups.get(id) === run) this.cleanups.delete(id)
      // A quit closes the database, and the cleanup is still saved for the next start.
      if (this.stopped) return
      delete this.pending[id]
      this.savePending()
    })
    this.cleanups.set(id, run)
  }
  private savePending() { this.store.saveMeta('cleanups', this.pending) }

  /** The slow part of an archive, after the record says archived: the archive script, then the worktree and the branch (KERNEL-702). */
  private async cleanNow(id: string, c: Cleanup) {
    // A Lead chat's worktree that git is making is made first, so nothing is left in its folder. One git never made has
    // no folder, branch or script to deal with (KERNEL-542).
    await this.k.workspaces.worktreeMade(id)
    // A quit stops here, and the next start runs it again. A workspace deleted from History meanwhile has nothing left to clean.
    if (this.stopped) return
    const ws = this.store.workspace(id)
    if (ws?.status !== 'archived') return
    const room = this.store.room(ws.roomId)
    if (!room) return
    const unmade = !!ws.worktreePending
    const repo = await loadRepoSettings(room.path)
    // A folder deleted outside Kernel has nothing to run the script in, and counts as removed (KERNEL-109).
    const gone = unmade || await folderGone(ws.path)
    if (!gone && !c.noScript && repo.scripts.archive && this.settings.scripts.archiveOnArchive) await this.archiveScript(ws, room, repo)
    if (this.stopped) return
    // Commits that never left this machine live only on the branch, so it stays whatever was asked. So does a branch
    // whose commits can't be counted: an unknown count is not zero (KERNEL-70).
    // A kept worktree still has its branch checked out, so the branch stays with it.
    // The caller's choice wins, then the room's own value, then the app's (KERNEL-370).
    // The shared Lead worktree from before KERNEL-405 is detached, so it has no branch to delete (KERNEL-355). A Lead chat's
    // branch with no commits of its own holds nothing, so it goes whatever the switch says (KERNEL-405).
    const empty = !unmade && isLeadChatWorkspace(ws) && ws.mode === 'worktree' && await git(room.path, 'rev-list', '--count', `${ws.baseRef}..refs/heads/${ws.branch}`).then((n) => n.trim() === '0', () => false)
    const wanted = !unmade && ws.mode === 'worktree' && ws.branch !== 'HEAD' && !c.keepWorktree && (empty || (c.deleteBranch ?? cleanupSwitch(repo, this.settings.workspace, 'deleteBranchOnArchive')))
    const unpushed = wanted ? await unpushedCommits(room.path, ws.branch, ws.baseRef, await this.k.config.remoteFor(room.path, repo)) : 0
    if (wanted && unpushed === null) bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'kept the branch because its commits could not be counted:', object: ws.branch, warn: true })
    // Work the Lead handed off that ends with no PR and no commit of its own: Kernel counts it (KERNEL-397).
    if (!gone && ws.mode === 'worktree' && ws.leadChatId && !ws.lead && !ws.reviewOf && ws.prState === 'none') {
      const ahead = await git(ws.path, 'rev-list', '--count', `${ws.baseRef}..HEAD`).then((n) => Number(n.trim()), () => NaN)
      if (ahead === 0) bus.track({ name: 'handoff.no_commit' })
    }
    if (this.stopped) return
    // The folder only moves aside here, and is deleted after, without waiting (KERNEL-284).
    const moved = ws.mode === 'worktree' && !c.keepWorktree && !unmade ? await detachWorktree(room.path, ws.path, { force: true, deleteBranch: wanted && unpushed === 0 ? ws.branch : undefined, moving: (p) => this.keepTrash(p) }) : undefined
    if (moved) this.throwAway(moved)
    void this.overlaps.check(ws.roomId).catch(() => undefined)
  }

  /**
   * The room's archive script, in the workspace's folder. It never holds the cleanup: untrusted text is skipped (KERNEL-209),
   * a hung script is stopped at the script timeout (KERNEL-216), and one that fails or times out leaves a warning note (KERNEL-702).
   */
  private async archiveScript(ws: Workspace, room: Room, repo: RepoSettings) {
    const id = ws.id
    if (await this.k.trust.untrusted(room, repo)) {
      bus.push({ type: 'script.output', workspaceId: id, kind: 'archive', lines: [{ line: "Skipped the archive script: this room's scripts aren't trusted yet.", stream: 'stderr' }] })
      return
    }
    const end = await runScript({ workspaceId: id, kind: 'archive', script: repo.scripts.archive!, cwd: ws.path, env: this.k.env.envFor(ws, { script: true }), timeoutMs: scriptTimeout(this.settings) })
    if (this.stopped || end === 0) return
    const warn = (text: string) => bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, actor: 'kernel', text, object: ws.name, warn: true })
    if (end === 'timeout') {
      bus.push({ type: 'script.output', workspaceId: id, kind: 'archive', lines: [{ line: `The archive script didn't finish in ${timeoutText(this.settings)}, so Kernel stopped it.`, stream: 'stderr' }] })
      warn(`stopped the archive script after ${timeoutText(this.settings)} in`)
    } else warn(end === null ? "couldn't run the archive script in" : `saw the archive script fail with exit code ${end} in`)
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

  /** A Lead chat's `closedAt` follows its workspace: set when it is archived, cleared when it is restored (KERNEL-405). */
  private markThread(threadId: string, closedAt: number | undefined) {
    const t = this.store.thread(threadId)
    if (!t || t.closedAt === closedAt) return
    const next: Thread = { ...t, closedAt }
    this.store.saveThread(next)
    bus.push({ type: 'thread', thread: next })
  }

  /**
   * Brings an archived workspace back: recreates the worktree from its branch and reopens its chats, which Kernel kept. A
   * worktree then sets up like a new one, files.copy and setup, with its chats held and the trust prompt, a failed state and
   * Run again, but no start checkpoint (KERNEL-77). It returns once the record says `setup`. A Lead chat whose branch was
   * deleted gets a new one from the latest base (KERNEL-405). A current-branch workspace comes back ready, as before.
   */
  async restoreWorkspace(id: string): Promise<Workspace> {
    // A cleanup still running would remove the folder and the branch restore brings back (KERNEL-702).
    await this.cleanedUp(id)
    const ws = this.mustWs(id)
    if (ws.status !== 'archived') return ws
    const room = this.mustRoom(ws.roomId)
    const repo = await loadRepoSettings(room.path)
    let moved: Partial<Workspace> = {}
    if (ws.mode === 'worktree') {
      const path = await stat(ws.path).then(() => undefined, () => ws.path)
      if (!path) throw new Error(`The folder ${ws.path} is back in use, so ${ws.name} cannot be restored there.`)
      const remote = await this.k.config.remoteFor(room.path, repo)
      const kept = await branchState(room.path, ws.branch) === 'exists' || (await exec('git', ['-C', room.path, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${ws.branch}`])).code === 0
      const base = !kept && isLeadChatWorkspace(ws) ? await leadBase(room.path, remote) : undefined
      if (base) {
        const branch = await this.k.workspaces.withBranchLock(room.id, async () => {
          const free = await freeBranch(room.path, ws.branch, remote, this.k.workspaces.pendingNames(room.id).branches)
          await createWorktree({ repo: room.path, root: dirname(path), branch: free, baseRef: base, path })
          return free
        })
        moved = { branch, baseRef: base }
      } else await restoreWorktree({ repo: room.path, path, branch: ws.branch, remote })
      if (repo.files.symlinkNodeModules) await linkNodeModules(room.path, path)
    } else if (this.settings.workspace.oneCurrentBranchPerRoom && !ws.lead && this.store.workspaces(ws.roomId).some((w) => w.mode === 'current' && w.status !== 'archived' && w.agentId !== ws.agentId)) {
      throw new Error('Another workspace is already working on the current branch in this room.')
    }
    const status = ws.mode === 'worktree' ? 'setup' as const : 'ready' as const
    // A chat archived before its worktree was made has one now (KERNEL-542).
    const patch: Partial<Workspace> = { ...moved, archivedAt: undefined, status, folderGone: undefined, worktreePending: undefined, stat: undefined }
    // It keeps its port, unless another workspace took a port in its block while it was archived.
    const clash = [...this.k.workspaces.openPorts(), ...this.k.workspaces.reservedPorts].some((p) => blocksOverlap(p, ws.port))
    const back = clash ? await this.k.workspaces.withPort((port) => this.updateWs(id, { ...patch, port }, { archived: true })) : this.updateWs(id, patch, { archived: true })
    if (isLeadChatWorkspace(back)) this.markThread(back.threadId!, undefined)
    // A review the user brings back stays, even though the work it reviewed is done (KERNEL-136).
    this.k.autoArchive.unmarkReviews(id)
    bus.activity({ kind: 'workspace.restored', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'restored', object: ws.name })
    if (status === 'setup') this.setUpRestored(back, room, repo)
    return back
  }

  /** A restored worktree's setup, in the background: its chats wait for it, as a new workspace's brief does (KERNEL-77). */
  private setUpRestored(ws: Workspace, room: Room, repo: RepoSettings) {
    let tabs = this.chatTabs(ws.id).filter((c) => c.kind !== 'terminal')
    if (!tabs.length) {
      const agent = this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)
      const pick = { ...(agent ? this.k.team.pickFor(agent) : this.settings.models.roles.engineers), plan: false }
      tabs = [this.saveChat(ws.lead ? this.k.lead.leadTab(ws, NEW_TAB, pick) : this.newChat(ws.id, NEW_CHAT, pick))]
    }
    for (const c of tabs) this.sessions.hold(c.id)
    void this.k.workspaces.setUpWorkspace(ws, room, repo, tabs[0], { checkpoint: false }).catch((e) => {
      if (this.stopped) return
      console.warn(`[restore] setting up ${ws.name} failed`, e)
      if (this.store.workspace(ws.id)?.status === 'setup') this.updateWs(ws.id, { status: 'failed' })
    })
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


  /**
   * Drops the checkpoint refs of every workspace archived more than 30 days ago, in its room's repo, so `.git` stops growing
   * (KERNEL-221). One workspace at a time, each git call under the usual exec timeout. A room whose folder is gone is
   * skipped. The meta key `checkpointsDropped` maps each workspace done to the `archivedAt` it was done for, so a daily run
   * makes no git calls for them, and one restored and archived again counts from its new archive.
   */
  dropOldCheckpoints(now = Date.now()): Promise<void> {
    this.dropping ??= this.dropOld(now).catch((e) => console.warn('[archive] dropping old checkpoints failed', e)).finally(() => { this.dropping = undefined })
    return this.dropping
  }

  private async dropOld(now: number) {
    if (this.stopped) return
    const before = this.store.meta<Record<string, number>>('checkpointsDropped') ?? {}
    // Only workspaces still archived since the same time stay in the list. Restored or deleted ones leave it.
    const done: Record<string, number> = {}
    const due: { ws: Workspace; at: number }[] = []
    for (const ws of this.store.workspaces()) {
      if (ws.status !== 'archived' || !ws.archivedAt) continue
      if (before[ws.id] === ws.archivedAt) done[ws.id] = ws.archivedAt
      else if (now - ws.archivedAt > KEEP_CHECKPOINTS_MS) due.push({ ws, at: ws.archivedAt })
    }
    this.store.saveMeta('checkpointsDropped', done)
    const gone = new Map<string, boolean>()
    for (const { ws, at } of due) {
      const room = this.store.room(ws.roomId)
      if (!room) continue
      if (!gone.has(room.path)) gone.set(room.path, await folderGone(room.path).catch(() => true))
      // A quit closes the database while the run waits on the disk or git.
      if (this.stopped) return
      if (gone.get(room.path)) continue
      // Restored while the run waited: it keeps what it has.
      const cur = this.store.workspace(ws.id)
      if (cur?.status !== 'archived' || cur.archivedAt !== at) continue
      try { await dropCheckpoints(room.path, ws.id) } catch (e) { console.warn(`[archive] could not drop the checkpoints of ${ws.name}`, e); continue }
      // The workspace is done again at the next start, with no refs left to find.
      if (this.stopped) return
      done[ws.id] = at
      this.store.saveMeta('checkpointsDropped', done)
    }
  }

  /** At launch: cleanups and worktree folder deletes a quit or a failure left behind run now (KERNEL-702, KERNEL-284), and old checkpoints go, then daily (KERNEL-221). */
  start() {
    for (const path of this.store.meta<string[]>('trash') ?? []) this.throwAway(path)
    // Cleanups a quit cut short finish now (KERNEL-702).
    for (const [id, c] of Object.entries(this.store.meta<Record<string, Cleanup>>('cleanups') ?? {})) this.cleanUp(id, c)
    void this.dropOldCheckpoints()
    this.checkpointTimer = setInterval(() => void this.dropOldCheckpoints(), DAY)
    this.checkpointTimer.unref()
  }
  stop() {
    clearInterval(this.checkpointTimer)
    this.checkpointTimer = undefined
  }
  handlers() {
    return {
      'workspaces.restore': async ({ workspaceId }) => this.restoreWorkspace(workspaceId),
      'workspaces.archive': async ({ workspaceId, deleteBranch, push }) => {
        if (push) { const ws = await this.k.prs.syncBranch(workspaceId); await pushBranch(ws.path, ws.branch, await this.k.config.remoteOfWs(ws)) }
        await this.k.archiveWorkspace(workspaceId, deleteBranch)
        return { ok: true }
      },
      'workspaces.gitStatus': async ({ workspaceId }) => {
        const ws = await this.k.prs.syncBranch(workspaceId)
        // A Lead chat whose worktree isn't made yet has nothing on its branch (KERNEL-542).
        if (ws.worktreePending) return { branch: ws.branch, ahead: 0, behind: 0, dirty: { files: 0, added: 0, removed: 0 } }
        return gitStatus(ws.path, ws.branch, ws.baseRef, await this.k.config.remoteOfWs(ws))
      },
      'workspaces.discard': async ({ workspaceId }) => { await this.discard(workspaceId); return { ok: true } }
    } satisfies Partial<Handlers>
  }
}
