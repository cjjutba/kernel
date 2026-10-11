import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DeletePreview, DeleteResult, DeleteSkip, Checkpoint, PrInfo, QueuedMessage, ReviewVerdict, AgentDef, AgentStatus, Chat, ClaudeAccount, PrState, NewRoomRequest, RateLimit, Room, Workspace, ModelId, Effort } from '@shared/types'
import { NotImplemented, type Channel, type KernelApi } from '@shared/ipc'
import { Store } from './db'
import { bus } from './bus'
import { Approvals } from './services/approvals'
import { Tasks } from './services/tasks'
import { Notifications } from './services/notifications'
import { LeadUpdates } from './services/leadUpdates'
import { Nudges } from './services/nudges'
import type { ReviewInput } from './services/reviewMcp'
import { SharedFiles } from './services/sharedFiles'
import { reviewRule } from './services/handoff'
import { archiveSkip } from './services/archiveGuard'
import { firstLine } from './services/text'
import type { ReviewState } from './services/leadUpdates'
import { Sessions, type CutOffReason } from './services/sessions'
import { askTitle } from './services/titles'
import { Ptys } from './services/pty'
import type { deleteSession as DeleteSession, forkSession as ForkSession, getSessionInfo as GetSessionInfo, listSessions as ListSessions } from '@anthropic-ai/claude-agent-sdk'
import { reviewedByBase } from './services/kernelMcp'
import { loadAppSettings, loadRepoSettings, prInstructions, remoteOf, saveAppSettings, type AppSettings } from './services/settings'
import { branchState, currentBranch, branchExists, fetchOrigin, folderGone, freeBranch, listWorktrees, resolveBaseRef, stripRemote } from './services/worktrees'
import { claudeSignedIn, readAccount } from './services/account'
import { stopAllScripts } from './services/scripts'
import { EnvStore } from './services/env'
import { githubAvatar, RoomIcons } from './services/roomIcons'
import { exec, git } from './services/exec'
import { allGreen, gh, prNote, resolveFile, type GitHub } from './services/github'
import { Overlaps } from './services/overlap'
import { dropCheckpoints } from './services/checkpoints'
import { unpushedCommits } from './services/archive'
import type { KernelOptions } from './features/options'
import { channels } from './features/channels'
import * as records from './features/records'
import { App } from './features/app'
import { Inbox } from './features/inbox'
import { Checkpoints } from './features/checkpoints'
import { Config } from './features/config'
import { Hooks } from './features/hooks'
import { Account } from './features/account'
import { Integrations } from './features/integrations'
import { Team } from './features/team'
import { Rooms } from './features/rooms'
import { Setup } from './features/setup'
import { Trust } from './features/trust'
import { Env } from './features/env'
import { Workspaces } from './features/workspaces'
import { Archive } from './features/archive'
import { Waits } from './features/waits'
import { Chats } from './features/chats'
import { Lead } from './features/lead'
import { Tools } from './features/tools'
import { Sharing } from './features/sharing'
import { leadUpdateDeps, listen, notificationDeps, overlapDeps, taskDeps } from './features/wiring'
import { sessionDeps } from './features/sessionDeps'

/** What Delete in History does for one workspace (KERNEL-333). See `Kernel.deleteFacts`. */
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

type CoreChannel = Exclude<Channel, `system.${string}`>
export type Handlers = { [C in CoreChannel]: (req: KernelApi[C]['req']) => Promise<KernelApi[C]['res']> }

/**
 * Channels no lane has built yet, and the issue that builds each. They reject with NotImplemented.
 * A lane that builds one deletes its line here and adds the handler to the map in `handlers()`.
 * Empty since KERNEL-30 built the last ones (update.*).
 */
export const UNBUILT = {} as const satisfies Partial<Record<CoreChannel, `KERNEL-${number}`>>

type Unbuilt = keyof typeof UNBUILT

/** The channels of the features that have moved out of this file, so `coreHandlers` holds the rest and a channel in both fails typecheck. */
type ChannelsOf<F> = F extends { handlers(): infer H } ? keyof H : never
type Moved = ChannelsOf<App | Inbox | Checkpoints | Config | Hooks | Account | Integrations | Team | Rooms | Setup | Trust | Env | Workspaces | Archive | Chats | Lead | Sharing>

/** Handlers for every unbuilt channel, each rejecting with the issue that builds it. */
function unbuilt(): Pick<Handlers, Unbuilt> {
  const out: Record<string, () => Promise<never>> = {}
  for (const [channel, issue] of Object.entries(UNBUILT as Record<string, string>)) out[channel] = async () => { throw new NotImplemented(channel as Channel, issue) }
  return out as unknown as Pick<Handlers, Unbuilt>
}

export class Kernel {
  readonly store: Store
  readonly approvals: Approvals
  readonly notifications: Notifications
  readonly leadUpdates: LeadUpdates
  /** The loop guard on the Lead's automatic requests to a teammate (KERNEL-125). */
  private nudges: Nudges
  /**
   * Workspaces Kernel archives on its own and hasn't yet, most often because they were working: reviews whose reviewed
   * work merged or closed (KERNEL-131), and work whose PR merged (KERNEL-114). They go when their turn ends. Saved under
   * the meta key `reviewsToArchive`, so a quit doesn't keep them open, and only these are swept at start, so a workspace
   * the user restored stays restored.
   */
  private reviewsToArchive = new Set<string>()
  /** The delete from History under way, if any. A second one starts when it ends (KERNEL-333). */
  private deleting?: Promise<unknown>
  readonly tasks: Tasks
  readonly sessions: Sessions
  readonly overlaps: Overlaps
  readonly ptys = new Ptys()
  readonly roomIcons: RoomIcons
  /** Copies of the files agents shared, and their checks (KERNEL-302). */
  readonly shared: SharedFiles
  /** App-wide and per-room variables, encrypted in `env.json` (KERNEL-247). */
  readonly envStore: EnvStore
  // ---------- features (KERNEL-325)
  // Each is built with this Kernel and does no work until it is called (R1), so the order here doesn't matter.
  readonly app = new App(this)
  readonly inbox = new Inbox(this)
  readonly checkpoints = new Checkpoints(this)
  readonly config = new Config(this)
  readonly hooks = new Hooks(this)
  readonly account = new Account(this)
  readonly integrations = new Integrations(this)
  readonly team = new Team(this)
  readonly rooms = new Rooms(this)
  readonly setup = new Setup(this)
  readonly trust = new Trust(this)
  readonly env = new Env(this)
  readonly workspaces = new Workspaces(this)
  readonly archive = new Archive(this)
  readonly waits = new Waits(this)
  readonly chats = new Chats(this)
  readonly lead = new Lead(this)
  readonly tools = new Tools(this)
  readonly sharing = new Sharing(this)
  // ---------- test seams
  // Tests swap these on the instance, so code reads them through the Kernel when it calls them and never keeps a copy
  // (KERNEL-324).

  /** Fetches a GitHub owner's avatar for a room icon. Tests swap it for one with gh and fetch stubbed. */
  avatar: (owner: string) => Promise<Buffer> = (owner) => githubAvatar(owner, { fetch: this.o.fetch })
  /** The SDK call behind a fork. Tests swap it for a stub. */
  forkSession: typeof ForkSession = async (id, o) => (await import('@anthropic-ai/claude-agent-sdk')).forkSession(id, o)
  /** The SDK call that reads a session's title from its transcript. Tests swap it for a stub. */
  sessionInfo: typeof GetSessionInfo = async (id, o) => (await import('@anthropic-ai/claude-agent-sdk')).getSessionInfo(id, o)
  /** The SDK call that lists the sessions Claude Code saved for a folder (KERNEL-333). Tests swap it for a stub. */
  listSessions: typeof ListSessions = async (o) => (await import('@anthropic-ai/claude-agent-sdk')).listSessions(o)
  /** The SDK call that deletes a session's transcript (KERNEL-333). Tests swap it for a stub. */
  deleteSession: typeof DeleteSession = async (id, o) => (await import('@anthropic-ai/claude-agent-sdk')).deleteSession(id, o)
  /** The Haiku request that names a chat from its conversation (KERNEL-202). Tests swap it for a stub. */
  titleFor: typeof askTitle = askTitle
  /** Reads `claude auth status`. Tests swap it for a stub. */
  accountReader: () => Promise<ClaudeAccount> = readAccount
  /** Whether Claude Code is signed in, read at launch before agents carry on (KERNEL-215). Tests swap it for a stub. */
  signedInReader: () => Promise<boolean> = claudeSignedIn
  /** The GitHub calls behind the PR methods. Tests swap it for a stub. */
  github: GitHub = gh

  settings!: AppSettings
  private prTimer?: NodeJS.Timeout
  private unlisten: () => void = () => undefined

  constructor(readonly o: KernelOptions) {
    this.store = new Store(join(o.dataDir, 'kernel.db'))
    this.roomIcons = new RoomIcons(o.dataDir)
    this.shared = new SharedFiles({ dataDir: o.dataDir, store: this.store })
    this.envStore = new EnvStore({
      file: join(o.dataDir, 'env.json'), cipher: o.cipher,
      // Names only: the file it moved holds ciphertext, and the note never names a value.
      onSetAside: (file) => void bus.activity({ kind: 'note', actor: 'kernel', text: 'could not read its saved variables and moved them to', object: file })
    })
    this.approvals = new Approvals(this.store)
    this.tasks = new Tasks(taskDeps(this))
    this.notifications = new Notifications(notificationDeps(this))
    this.sessions = new Sessions(sessionDeps(this))
    this.nudges = new Nudges(this.store)
    this.leadUpdates = new LeadUpdates(leadUpdateDeps(this))
    this.overlaps = new Overlaps(overlapDeps(this))
    this.unlisten = listen(this)
  }

  private get home() { return this.o.home ?? homedir() }

  async start() {
    // `stop()` saves cleanExit as its last write, so without it the last run crashed, was force quit or lost power (KERNEL-215).
    const clean = this.store.meta<boolean>('cleanExit') === true
    this.store.saveMeta('cleanExit', false)
    this.settings = await loadAppSettings(this.config.settingsFile, this.home)
    await saveAppSettings(this.config.settingsFile, this.settings)
    this.o.onSettings?.(this.settings)
    await this.hooks.start()
    this.prTimer = setInterval(() => void this.pollPrs(), 45_000)
    void this.workspaces.countChanges()
    // No waiter outlives a restart, so nothing can answer an approval from the last run. It ends before the inbox
    // replays pending ones, and the inbox drops archived workspaces' rows and week-old settled ones (D-137).
    this.approvals.expireStale()
    this.notifications.attach()
    this.lead.backfillLeadChats()
    void this.chats.nameStuckChats().catch(() => undefined)
    this.leadUpdates.attach()
    this.account.start()
    this.tasks.attach()
    for (const r of this.store.rooms()) void this.config.remoteFor(r.path)
    // Claude Code processes a crash or a force quit left behind keep working in the worktrees the chats resume in.
    await this.sessions.endLeftovers()
    // Chats that carry on below need their agent's prompt, and a Lead chat its Kernel tools, which read the agents.
    await Promise.all(this.store.rooms().filter((r) => !r.archived).map((r) => this.agents(r.id).catch(() => undefined)))
    // Before any session restarts, so a trusted room's env files reach it (KERNEL-247).
    await Promise.all(this.store.rooms().map((r) => this.trust.untrusted(r).catch(() => null)))
    // A room paused before the app quit is still paused: its agents wait and its sends are held. The saved limits decide
    // a limit pause: one that reset while Kernel was closed lifts now, and the chats the limit stopped carry on. So do the
    // chats that were working when Kernel quit or closed, after what was queued for them (KERNEL-215).
    for (const r of this.store.rooms()) if (r.paused) this.sessions.pause(r.id)
    const cutOff = this.store.meta<string[] | Record<string, CutOffReason>>('cutOff') ?? {}
    // Offline or signed out, what carries on must wait instead of spending its turn on the failure, and nothing has run yet
    // to notice either. The chats that carry on wait while the network probe and a sign-in read run in the background, so
    // the window, the rest of start, ordinary sends and other queues don't wait for them.
    if (this.sessions.wasWorking() || Object.keys(cutOff).length) {
      this.sessions.holdCarryOn()
      void (async () => {
        try {
          await this.account.network?.check()
          const signedIn = await this.signedInReader().catch(() => true)
          if (!signedIn && !this.stopped) this.account.signedOut()
        } finally {
          // A stopped Kernel's database is closed, and releasing would send what waited.
          if (!this.stopped) this.sessions.releaseCarryOn()
        }
      })()
    }
    const held = this.store.meta<Record<string, QueuedMessage[]>>('held') ?? {}
    this.sessions.restore(this.store.meta<RateLimit[]>('limits') ?? [], cutOff, held, { clean })
    this.trust.recoverTrust(held)
    this.setup.recoverSetups()
    for (const id of this.store.meta<string[]>('reviewsToArchive') ?? []) this.reviewsToArchive.add(id)
    void this.sweepReviews()
    // After the waits, which read each room's team first, so the Lead's workspace is known.
    void this.waits.sweepWaits().catch(() => undefined).then(() => this.sweepMerged()).catch(() => undefined)
    for (const path of this.store.meta<string[]>('trash') ?? []) this.archive.throwAway(path)
    // A reset on claude.ai while Kernel was closed shows only in the real numbers, so ask at once.
    if (this.store.rooms().some((r) => r.pausedBy === 'limit')) void this.account.checkLimits()
  }

  /** Every read of the account can end a sign-out: a signed-in answer lifts the hold and tells the renderer. */
  readAccount(): Promise<ClaudeAccount> { return this.account.readAccount() }

  /** The app calls it when the Mac wakes. */
  checkLimits(): Promise<void> { return this.account.checkLimits() }

  /** Agents with a turn running: workspaces, not chats, so a Lead with two busy chats is one (KERNEL-214). */
  workingAgents(): number { return this.chats.workingAgents() }

  /**
   * Quit, or a test done with this Kernel. Working agents get `budgetMs` to stop their turns, then their processes end.
   * Their queues are saved, and they carry on at the next start (KERNEL-215).
   */
  stop(o: { budgetMs?: number } = {}): Promise<void> {
    // Restart to update and before-quit can both ask (KERNEL-214). Each waits for the same stop to finish.
    this.stopping ??= this.doStop(o)
    return this.stopping
  }

  private stopping?: Promise<void>

  /** Marks itself stopped first, so nothing it closes on the way out (the hook server) pushes to the window (KERNEL-214). */
  private async doStop(o: { budgetMs?: number }) {
    this.stopped = true
    this.unlisten()
    this.notifications.detach()
    this.leadUpdates.detach()
    this.tasks.detach()
    clearInterval(this.prTimer)
    this.account.stop()
    this.team.stop()
    await this.sessions.shutdown(o.budgetMs)
    this.ptys.killAll()
    stopAllScripts()
    // The next start tells a quit from a crash by this. It goes before the hook server closes, the one step left that can
    // wait, so a quit capped by KERNEL-214 still counts as a quit. Nothing after it changes what carries on.
    this.store.saveMeta('cleanExit', true)
    // Nobody can answer an approval once Kernel quits, and the next start would expire it anyway (D-137). It ends now,
    // while the database is open: a dropped hook connection aborts its approval a tick after close() returns, which
    // would reach a closed database. An outside session's hook gets its fallback answer before the connections end.
    this.approvals.expirePending()
    await new Promise((r) => setImmediate(r))
    await this.hooks.stop()
    this.store.db.close()
  }

  // ---------- rooms and agents

  addRoom(path: string, name?: string): Promise<Room> { return this.rooms.addRoom(path, name) }
  createRoom(req: NewRoomRequest): Promise<Room> { return this.rooms.createRoom(req) }
  pauseRoom(roomId: string, by: 'you' | 'limit'): Room { return this.rooms.pauseRoom(roomId, by) }
  resumeRoom(roomId: string, by: 'you' | 'limit' = 'you'): Room { return this.rooms.resumeRoom(roomId, by) }
  updateRoom(roomId: string, patch: Parameters<Rooms['updateRoom']>[1]): Promise<Room> { return this.rooms.updateRoom(roomId, patch) }
  removeRoom(roomId: string, deleteWorktrees: boolean): Promise<void> { return this.rooms.removeRoom(roomId, deleteWorktrees) }
  agents(roomId: string): Promise<AgentDef[]> { return this.team.agents(roomId) }
  statusOf(roomId: string): Record<string, AgentStatus> { return this.team.statusOf(roomId) }

  // ---------- workspaces

  createWorkspace(roomId: string, o: Parameters<Workspaces['createWorkspace']>[1]): Promise<Workspace> { return this.workspaces.createWorkspace(roomId, o) }

  /** "Run again" on a failed setup. */
  retrySetup(workspaceId: string): Promise<Workspace> { return this.setup.retrySetup(workspaceId) }

  /** One archive per workspace at a time: a second call while one runs waits for it, instead of removing the worktree twice. */
  archiveWorkspace(id: string, deleteBranch?: boolean, o: { keepWorktree?: boolean } = {}): Promise<void> { return this.archive.archiveWorkspace(id, deleteBranch, o) }

  /** Resolves once every queued folder delete has run, including ones queued while it waits. */
  trashEmptied(): Promise<void> { return this.archive.trashEmptied() }

  /** Brings an archived workspace back: recreates the worktree from its branch and reopens its chats, which Kernel kept. */
  restoreWorkspace(id: string): Promise<Workspace> { return this.archive.restoreWorkspace(id) }

  // ---------- delete from History (KERNEL-333)

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
      const waiting = this.waits.waitersOn(id)
      if (waiting.length) { skip(waiting.length === 1 ? `${this.waits.nameOf(waiting[0])}'s workspace still waits on it.` : `${waiting.length} workspaces still wait on it.`); continue }
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
    // Check and add in one step with no await between, so workspaces read at the same time can't claim a branch or session twice.
    const branches = new Set<string>()
    const claimed = new Set<string>()
    const facts: DeleteFacts[] = []
    for (const [roomId, list] of byRoom) {
      const room = this.mustRoom(roomId)
      const remote = await this.config.remoteFor(room.path)
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
          for (const info of await this.listSessions({ dir: ws.path, includeWorktrees: false }).catch(() => [])) found.set(info.sessionId, info.fileSize ?? 0)
        }
        for (const chat of this.store.chats(ws.id)) {
          if (chat.sessionId && !found.has(chat.sessionId)) found.set(chat.sessionId, (await this.sessionInfo(chat.sessionId, { dir: ws.path }).catch(() => undefined))?.fileSize ?? 0)
        }
        const sessions = new Map([...found].filter(([id]) => !claimed.has(id)))
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
          try { await this.deleteSession(id, { dir: ws.path }); bytes += size } catch (e) { if (!/not found|invalid sessionId/i.test((e as Error).message)) throw e }
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

  /** A quick question to the room's Lead, in a new Lead chat tab (KERNEL-145, D-133). */
  askLead(roomId: string, text: string): Promise<{ chatId: string }> { return this.lead.askLead(roomId, text) }

  /** "Let Rowan sort it": the Lead gets both workspaces and the file, and the card leaves the floor. */
  sortOverlap(overlapId: string): Promise<void> { return this.lead.sortOverlap(overlapId) }

  /** The files a workspace changed. Their totals are saved on the workspace too, for the sidebar and Home (+412 -38). */
  changes(id: string): ReturnType<Workspaces['changes']> { return this.workspaces.changes(id) }

  // ---------- checkpoints

  /** Save the worktree after a turn, titled with the prompt that started the turn. */
  checkpoint(ws: Workspace, chat: Chat): Promise<Checkpoint> { return this.checkpoints.checkpoint(ws, chat) }

  // ---------- chats

  chatTabs(workspaceId: string): Chat[] { return records.chatTabs(this.store, workspaceId) }

  private stopped = false

  /** The tab leaves the strip, its transcript stays. A big terminal's process ends. The last open tab is replaced by a fresh chat. */
  closeChat(chatId: string): void { this.chats.closeChat(chatId) }

  /** Every variable a session, script or terminal in the workspace gets (KERNEL-247). */
  envFor(ws: Workspace, o: { script?: boolean } = {}): Record<string, string> { return this.env.envFor(ws, o) }

  /** A chat opened with a placeholder name ("New chat", the Lead's "Lead") is auto-named. A workspace's title or a fork's is not (KERNEL-202). */
  newChat(workspaceId: string, title: string, o: { model: ModelId; effort: Effort; plan: boolean; kind?: 'chat' | 'terminal'; terminal?: Chat['terminal'] }): Chat {
    return records.newChat(this.store, workspaceId, title, o)
  }

  /** The Lead's first open chat. Floor briefs go there. */
  leadChat(roomId: string): Promise<Chat> { return this.lead.leadChat(roomId) }

  /** A message to the Lead in a chat of its own (KERNEL-148). */
  startLeadChat(roomId: string, o: Parameters<Lead['startLeadChat']>[1]): Promise<Chat> { return this.lead.startLeadChat(roomId, o) }

  // ---------- pull requests

  /** Workspaces whose merge Kernel is running, so the poll doesn't overwrite `merging`. */
  private merging = new Set<string>()
  /** The method of a merge Kernel ran, until the PR is seen merged, so the note says how it landed. */
  private mergedWith = new Map<string, AppSettings['pr']['mergeMethod']>()

  /** PR instructions and notes go to the workspace's first chat. */
  private prChat(id: string): Chat | undefined { return records.prChat(this.store, id) }

  /** The open review workspaces of a workspace's work. */
  private reviewsOf(id: string) { return this.store.workspaces().filter((w) => w.reviewOf === id && w.status !== 'archived').map((w) => w.id) }

  private markReview(id: string) { if (!this.reviewsToArchive.has(id)) { this.reviewsToArchive.add(id); this.saveReviewsToArchive() } }
  private unmarkReviews(...ids: string[]) { if (ids.map((id) => this.reviewsToArchive.delete(id)).some(Boolean)) this.saveReviewsToArchive() }
  private saveReviewsToArchive() { this.store.saveMeta('reviewsToArchive', [...this.reviewsToArchive]) }

  /**
   * The work a review looked at merged or closed, so its review workspaces are done (KERNEL-131). They go through the same
   * checks as archive_workspace. One still working is archived when its turn ends; one that would lose uncommitted work is
   * kept, with a note in the log, and Kernel doesn't try again.
   */
  private async archiveReviews(ofId: string, only?: string) {
    const of = this.store.workspace(ofId)
    const reviews = this.store.workspaces().filter((w) => w.reviewOf === ofId && w.status !== 'archived' && (!only || w.id === only))
    if (!of || (of.prState !== 'merged' && of.prState !== 'closed')) { this.unmarkReviews(...reviews.map((r) => r.id)); return }
    // Archive on merge covers review cleanup too: off, nothing archives on its own (KERNEL-114).
    if (!reviews.length) return
    if (!(await this.archiveOnMerge(of.roomId))) { this.unmarkReviews(...reviews.map((r) => r.id)); return }
    for (const r of reviews) this.markReview(r.id)
    for (const r of reviews) await this.archiveDone(r, 'kept the review workspace', 'The work it reviewed is done')
  }

  /**
   * Settings, Git's Archive on merge, with the room's own value first (KERNEL-114). It covers the work whose PR merged and
   * the reviews of work that merged or closed.
   */
  private async archiveOnMerge(roomId: string) {
    const room = this.store.room(roomId)
    const own = room ? (await loadRepoSettings(room.path).catch(() => undefined))?.workspace.archiveOnMerge : undefined
    return typeof own === 'boolean' ? own : this.settings.workspace.archiveOnMerge
  }

  /**
   * The workspace's PR merged, so with Archive on merge on it is done (KERNEL-114). It goes through the same checks as a
   * review, and is also kept when its branch has commits GitHub doesn't. Only a worktree goes: a workspace on the room's
   * own checkout, as the Lead's is, can't be checked for uncommitted changes, and that holds even before the team is read.
   * A closed PR keeps its workspace, because its author may reopen it. Reviews go through `archiveReviews`.
   */
  private async archiveMerged(id: string) {
    const ws = this.store.workspace(id)
    if (ws?.mode !== 'worktree') { this.unmarkReviews(id); return }
    if (ws.status === 'archived' || ws.reviewOf) return
    const lead = !!this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)?.lead
    if (ws.prState !== 'merged' || lead || !(await this.archiveOnMerge(ws.roomId))) { this.unmarkReviews(id); return }
    this.markReview(id)
    await this.archiveDone(ws, 'kept the workspace', `Its PR${ws.prNumber ? ' #' + ws.prNumber : ''} merged`)
  }

  /** A marked workspace whose turn ended, or whose session died, or that a quit left marked. */
  private archiveMarked(id: string) {
    const ws = this.store.workspace(id)
    if (!ws || ws.status === 'archived') { this.unmarkReviews(id); return Promise.resolve() }
    return ws.reviewOf ? this.archiveReviews(ws.reviewOf, id) : this.archiveMerged(id)
  }

  /**
   * Archives a marked workspace through the same checks as archive_workspace. One still working goes when its turn ends.
   * One that would lose work is kept, with `text` and `done` in the log, and Kernel doesn't try again.
   */
  private async archiveDone(r: Workspace, text: string, done: string) {
    // A turn running, or a message about to start one: it goes when that turn ends.
    if (this.archive.working(r.id)) return
    const keep = (reason: string) => {
      this.unmarkReviews(r.id)
      bus.activity({ kind: 'note', roomId: r.roomId, workspaceId: r.id, agentId: r.agentId, actor: 'kernel', text, object: r.name, warn: true, quote: `${done}, but it wasn't archived: ${/[.!?…]$/.test(reason) ? reason : reason + '.'}` })
    }
    let why = await archiveSkip(r, { isOwnLead: (w) => this.isLeadWorkspace(w), isRunning: (id) => this.archive.working(id), latestPr: async (w) => w, unsaved: (id) => this.archive.unsavedOf(id) })
    if (why === 'its agent is still working') return
    // The git check followed the branch the work is on now. Work that moved to a fresh branch isn't the merged work.
    if (!r.reviewOf && this.store.workspace(r.id)?.prState !== 'merged') { this.unmarkReviews(r.id); return }
    // Archive keeps a branch with unpushed commits, but the work would leave the sidebar unfinished (KERNEL-114).
    if (!why && !r.reviewOf) {
      const unpushed = await this.unpushedOf(this.store.workspace(r.id) ?? r)
      if (unpushed === null) why = 'its commits could not be counted'
      else if (unpushed > 0) why = `it has ${unpushed === 1 ? 'a commit' : `${unpushed} commits`} that GitHub doesn't`
    }
    if (why) { keep(why); return }
    // Checked again after the git calls: a message may have started a turn meanwhile, the user may have restored it,
    // or another archive got there first.
    if (this.archive.working(r.id) || !this.reviewsToArchive.has(r.id)) return
    const now = this.store.workspace(r.id)
    if (now?.status === 'archived' || (!r.reviewOf && now?.prState !== 'merged')) { this.unmarkReviews(r.id); return }
    try { await this.archiveWorkspace(r.id); this.unmarkReviews(r.id) } catch (e) { keep(firstLine(e instanceof Error ? e.message : String(e))) }
  }

  /**
   * Commits on the workspace's branch that GitHub doesn't have, or null when they can't be counted. As `unpushedCommits`,
   * except that what the PR's head had counts as on GitHub: a squash merge leaves the commits off the base, and GitHub may
   * have deleted the branch.
   */
  private async unpushedOf(ws: Workspace): Promise<number | null> {
    const room = this.store.room(ws.roomId)
    if (!room) return null
    const counted = await unpushedCommits(room.path, ws.branch, ws.baseRef, await this.config.remoteFor(room.path))
    if (counted === 0 || !ws.prHead) return counted
    const r = await exec('git', ['-C', room.path, 'rev-list', '--count', `refs/heads/${ws.branch}`, '--not', ws.prHead])
    const n = Number(r.stdout.trim())
    if (r.code !== 0 || r.stdout.trim() === '' || !Number.isInteger(n)) return counted
    return counted === null ? n : Math.min(counted, n)
  }

  /**
   * At start: the workspaces Kernel meant to archive when it quit, as one whose turn was still running, are archived now
   * (KERNEL-131, KERNEL-114). Work that merged or closed while Kernel was closed reaches them through the first PR poll,
   * since its saved PR state is still open.
   */
  private async sweepReviews() {
    for (const id of [...this.reviewsToArchive]) await this.archiveMarked(id).catch(() => undefined)
    // Reviews the Lead started with base_ref instead of review_of are linked now (KERNEL-299). Those whose work already
    // merged or closed get no PR event, so they are archived here. Each is linked once, so a kept one is noted once. A quit
    // right after start closes the database under it.
    for (const r of await this.linkReviews().catch(() => [])) await this.archiveReviews(r.reviewOf!, r.id).catch(() => undefined)
  }

  /**
   * Once, at the first start with Archive on merge working (KERNEL-114): work whose PR merged before then gets no PR event,
   * so it is archived here, with the same checks. After that a merge archives as it lands, so a workspace the user restores
   * stays, and a kept one is noted once. Saved under the meta key `mergedSwept`.
   */
  private async sweepMerged() {
    if (this.store.meta<boolean>('mergedSwept')) return
    for (const ws of this.store.workspaces()) {
      if (this.stopped) return
      if (ws.mode === 'worktree' && ws.status !== 'archived' && ws.prState === 'merged' && !ws.reviewOf) await this.archiveMerged(ws.id).catch(() => undefined)
    }
    if (!this.stopped) this.store.saveMeta('mergedSwept', true)
  }

  /** Links each open reviewer workspace with no `reviewOf` to the workspace whose branch its base names (KERNEL-299). */
  private async linkReviews() {
    const linked: Workspace[] = []
    for (const room of this.store.rooms()) {
      const agents = await this.agents(room.id).catch(() => [])
      const all = this.store.workspaces(room.id)
      for (const w of all) {
        if (w.status === 'archived' || w.reviewOf) continue
        const of = reviewedByBase(agents.find((a) => a.id === w.agentId), w.baseRef, all, { self: w.id, done: true })
        if (!of || of.reviewOf) continue
        linked.push(this.saveWs({ ...w, reviewOf: of.id }))
      }
    }
    return linked
  }

  // ---------- waits (KERNEL-259)

  /** The Lead's wait_for_merge, and a teammate's own (KERNEL-262). */
  setWait(id: string, on: string[], o: { told?: boolean; why?: string } = {}): Promise<Workspace> { return this.waits.setWait(id, on, o) }

  // ---------- shared files (KERNEL-302)

  /** The tools in an agent's `kernel` server. */
  toolsFor(ws: Workspace, agent: AgentDef | undefined, chat: Chat): ReturnType<Tools['toolsFor']> { return this.tools.toolsFor(ws, agent, chat) }

  /** A shared file's version and the path of Kernel's copy, for the preview host. Undefined when Kernel doesn't have it. */
  sharedFile(id: string, version: number): ReturnType<Sharing['sharedFile']> { return this.sharing.sharedFile(id, version) }

  // ---------- reviews (KERNEL-130)

  /** Where a review worktree starts: the reviewed workspace's branch, or its copy on the remote when the local one is gone. */
  private async reviewBase(repo: string, branch: string, remote: string): Promise<string> {
    try { return await resolveBaseRef(repo, branch, { strict: true, remote }) } catch { return resolveBaseRef(repo, `${remote}/${branch}`, { fetch: true, strict: true, remote }) }
  }

  /** The rule appended to a review workspace's prompt, naming the work it reviews. */
  private reviewRuleFor(ws: Workspace): string | undefined {
    const of = ws.reviewOf ? this.store.workspace(ws.reviewOf) : undefined
    if (!of) return undefined
    const author = this.agentsSync(ws.roomId).find((a) => a.id === of.agentId)?.name ?? of.agentId
    // With a PR, the review is of what the PR holds on GitHub, the commit verdicts are checked against. Before one, it is
    // of the author's local branch, or the remote's copy when the local one was gone (reviewBase).
    const room = this.store.room(ws.roomId)
    const remote = remoteOf({ workspace: { remote: room && this.config['roomRemotes'].get(room.path) } }, this.settings)
    const resetTo = of.prNumber ? `${remote}/${of.branch}` : ws.baseRef
    return reviewRule({ author, task: of.title ?? of.name, workspaceId: of.id, branch: of.branch, resetTo, base: of.baseRef, ...(of.prNumber ? { pr: { number: of.prNumber, url: of.prUrl } } : {}) }, remote)
  }

  /**
   * A reviewer's submit_review. The verdict is saved on the reviewed workspace with the review worktree's HEAD, so a later
   * push makes it stale, and replaces that review workspace's earlier verdict. The Lead hears about it.
   */
  async submitReview(reviewWorkspaceId: string, review: ReviewInput): Promise<string> {
    const rws = this.mustWs(reviewWorkspaceId)
    const of = rws.reviewOf ? this.store.workspace(rws.reviewOf) : undefined
    if (!of || of.status === 'archived') throw new Error('the work under review is no longer open.')
    const sha = (await exec('git', ['-C', rws.path, 'rev-parse', 'HEAD'])).stdout.trim()
    // Read again after the await, so a verdict another reviewer saved meanwhile isn't lost.
    const fresh = this.mustWs(of.id)
    const verdict: ReviewVerdict = {
      workspaceId: rws.id, agentId: rws.agentId, verdict: review.verdict, summary: review.summary.trim(),
      ...(review.verdict === 'blockers' && review.blockers?.length ? { blockers: review.blockers } : {}),
      ...(/^[0-9a-f]{40}$/.test(sha) ? { sha } : {}), ...(fresh.prNumber ? { prNumber: fresh.prNumber } : {}), ts: Date.now()
    }
    const saved = this.updateWs(of.id, { reviews: [...(fresh.reviews ?? []).filter((v) => v.workspaceId !== rws.id), verdict] })
    this.leadUpdates.reviewed(rws, saved, verdict)
    const what = saved.prNumber ? `PR #${saved.prNumber}` : saved.name
    bus.activity({ kind: 'note', roomId: rws.roomId, workspaceId: saved.id, agentId: rws.agentId, text: review.verdict === 'approved' ? 'approved' : 'found blockers in', object: what })
    return review.verdict === 'approved' ? `Saved: you approved ${what}. The Lead hears about it.` : `Saved: ${verdict.blockers?.length ?? 0} blocker(s) in ${what}. The Lead passes them on.`
  }

  /** What Kernel knows about reviews of a workspace's PR, for the Lead's updates. */
  private reviewState(ws: Workspace): ReviewState {
    const name = (id: string) => this.agentsSync(ws.roomId).find((a) => a.id === id)?.name ?? id
    // Verdicts on this PR, and those of them on its head commit, as far as either is known.
    const verdicts = (ws.reviews ?? []).filter((v) => !v.prNumber || !ws.prNumber || v.prNumber === ws.prNumber)
    const current = verdicts.filter((v) => !v.sha || !ws.prHead || v.sha === ws.prHead)
    const blockers = current.some((v) => v.verdict === 'blockers')
    const reviews = this.store.workspaces(ws.roomId).filter((r) => r.reviewOf === ws.id && r.status !== 'archived').sort((a, b) => b.createdAt - a.createdAt)
    // A review runs while its setup runs, or while its reviewer works on it and hasn't sent a verdict on the head commit.
    // A review whose setup failed isn't running: it waits for the user.
    const busy = (r: Workspace) => r.status === 'setup' || (r.status === 'ready' && this.chatTabs(r.id).some((c) => this.sessions.isRunning(c.id) || this.sessions.queued(c.id).length > 0))
    const open = reviews[0]
    return {
      approvedBy: blockers ? [] : current.filter((v) => v.verdict === 'approved').map((v) => name(v.agentId)),
      blockers,
      inProgress: reviews.some((r) => busy(r) && !current.some((v) => v.workspaceId === r.id)),
      stale: verdicts.length > 0 && current.length === 0,
      ...(open ? { open: { workspaceId: open.id, agentId: open.agentId, name: name(open.agentId), ...(open.status === 'failed' ? { failed: true } : {}) } } : {})
    }
  }

  /** `pr` is the PR state the note is about, which draws that state's icon before the text. */
  private note(workspaceId: string, text: string, pr?: 'merged' | 'closed' | 'cifail') { return records.note(this.store, workspaceId, text, pr) }

  private setPrState(ws: Workspace, prState: PrState) {
    const before = this.mustWs(ws.id).prState
    const next = this.updateWs(ws.id, { prState })
    if (next.prState !== before) bus.push({ type: 'pr', workspaceId: ws.id, state: prState })
    return next
  }

  /** The PR instructions for a workspace: its room's, else Settings > Pull requests (KERNEL-190). */
  private async prTexts(ws: Workspace) {
    return prInstructions(this.settings.pr, (await loadRepoSettings(this.mustRoom(ws.roomId).path)).pr)
  }

  /** Sends `create-pr.md` (the room's or Settings > PRs) to the agent. The header shows Creating until its turn ends. */
  async createPr(id: string, draft = false) {
    const ws = this.mustWs(id)
    if (ws.prState !== 'none') throw new Error('This workspace already has a pull request.')
    const chat = this.prChat(id)
    if (!chat) throw new Error('This workspace has no chat.')
    const text = (await this.prTexts(ws)).createInstructions + (draft || this.settings.pr.draft ? '\nOpen as draft' : '')
    await this.sessions.send(chat.id, [{ type: 'file', name: 'create-pr.md', text }])
    return this.setPrState(ws, 'creating')
  }

  /** One button, three situations: conflicts, failing checks, or review comments. Each sends its own instructions, with what GitHub reports. */
  async resolvePr(id: string) {
    const ws = await this.syncBranch(id)
    const chat = this.prChat(id)
    if (!chat) throw new Error('This workspace has no chat.')
    if (ws.prState !== 'conflict' && ws.prState !== 'cifail' && ws.prState !== 'changes') throw new Error('This pull request has nothing to fix.')
    const info = await this.github.info(ws.path, ws.branch, id, { remote: await this.config.remoteOfWs(ws) })
    if (info) bus.push({ type: 'pr.info', info })
    const [name, text] = resolveFile(ws.prState, await this.prTexts(ws), info)
    this.lead.userSpoke(chat.id)
    await this.sessions.send(chat.id, [{ type: 'file', name, text }])
    this.setPrState(ws, 'resolving')
  }

  /** The PR's checks, review comments and conflicts, for the Checks tab and the review card. */
  async getPr(id: string) {
    const ws = await this.syncBranch(id)
    if (!ws.prNumber) return null
    const info = await this.github.info(ws.path, ws.branch, id, { remote: await this.config.remoteOfWs(ws) })
    if (info) bus.push({ type: 'pr.info', info })
    return info
  }

  /**
   * Reads the PR from GitHub and moves the header to its state. `settle` is true once the agent's turn is over:
   * until then Creating and Resolving hold, so the header doesn't flash the old state while the agent works.
   * A workspace with no PR yet only adopts an open one, never an old merged or closed PR on the same branch name.
   * A worktree folder deleted outside Kernel can't run gh, so the room asks for the PR by number instead (KERNEL-109).
   */
  async refreshPr(id: string, o: { settle?: boolean } = {}): Promise<Workspace> {
    const asked = await this.syncBranch(id)
    if (asked.status === 'archived') return asked
    const remote = await this.config.remoteOfWs(asked)
    const info = await folderGone(asked.path)
      ? await this.github.info(this.mustRoom(asked.roomId).path, asked.prNumber ? String(asked.prNumber) : asked.branch, id, { conflicts: false })
      : await this.github.info(asked.path, asked.branch, id, { remote })
    if (info) bus.push({ type: 'pr.info', info })
    // gh takes seconds. Decide on the workspace as it is now: it may have been archived, or a merge may have started.
    const ws = this.mustWs(id)
    if (ws.status === 'archived') return ws
    const settle = o.settle ?? !this.agentBusy(ws)
    const hold = this.merging.has(id) || (!settle && (ws.prState === 'creating' || ws.prState === 'resolving'))
    let state: PrState
    if (hold) state = ws.prState
    else if (!info) state = ws.prState === 'creating' || !ws.prNumber ? 'none' : ws.prState === 'resolving' ? 'open' : ws.prState
    else if (!ws.prNumber && (info.state === 'merged' || info.state === 'closed')) state = 'none'
    else state = info.state
    const adopt = info && state !== 'none'
    const next = this.updateWs(id, {
      prState: state,
      ...(adopt ? { prNumber: info.number, prUrl: info.url, prTitle: info.title || ws.prTitle, ...(info.head ? { prHead: info.head } : {}) } : {}),
      ...(state === 'merged' && !ws.mergedAt ? { mergedAt: Date.now() } : {})
    })
    this.guardOnReady(id, ws.prState, next.prState, info)
    if (next.prState !== ws.prState) {
      bus.push({ type: 'pr', workspaceId: id, state: next.prState })
      bus.activity({ kind: 'pr.changed', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: `PR is ${next.prState}`, object: next.prNumber ? `#${next.prNumber}` : undefined })
      const text = prNote(next, info, this.mergedWith.get(id), remote)
      if (text) this.note(id, text, next.prState === 'merged' || next.prState === 'closed' || next.prState === 'cifail' ? next.prState : undefined)
      if (next.prState === 'merged') { this.mergedWith.delete(id); void this.overlaps.check(ws.roomId).catch(() => undefined) }
    }
    return next
  }

  /** Workspaces whose PR has shown checks, so a ready read with none is a push GitHub hasn't checked yet, not a repo without CI. */
  private hasChecks = new Set<string>()
  /** Ready reads with none of the checks the PR has had: the work moves on once those checks have run and passed. */
  private readyUnchecked = new Set<string>()

  /**
   * The work moved on, so the loop guard starts over for it and its reviews (KERNEL-125): when the PR becomes ready. Right
   * after a push GitHub has no checks for the new commit and reads the PR as ready for a moment, so on a PR that has had
   * checks, ready counts once they ran, even if the state read ready all along.
   */
  private guardOnReady(id: string, before: PrState, after: PrState, info: PrInfo | null | undefined) {
    if (info?.checks.length) this.hasChecks.add(id)
    if (after !== 'ready') { this.readyUnchecked.delete(id); return }
    if (!info?.checks.length && this.hasChecks.has(id)) { this.readyUnchecked.add(id); return }
    if (before !== 'ready' || this.readyUnchecked.delete(id)) this.nudges.reset(id, ...this.reviewsOf(id))
  }

  /** Merges with the method from Settings > PRs. With "require green checks" on, refuses until every check passed. */
  async mergePr(id: string) {
    const ws = await this.syncBranch(id)
    if (ws.prState !== 'ready' && ws.prState !== 'open') throw new Error('This pull request is not ready to merge.')
    if (this.settings.pr.requireGreen) {
      const info = await this.github.info(ws.path, ws.branch, id, { remote: await this.config.remoteOfWs(ws) })
      if (!info) throw new Error('Could not read the pull request from GitHub.')
      bus.push({ type: 'pr.info', info })
      if (!allGreen(info.checks)) throw new Error('Checks have not passed yet. Merging needs green checks (Settings > Pull requests).')
    }
    const method = this.settings.pr.mergeMethod
    this.merging.add(id)
    this.setPrState(ws, 'merging')
    try {
      await this.github.merge(ws.path, ws.branch, method)
      this.mergedWith.set(id, method)
    } catch (e) {
      this.merging.delete(id)
      await this.refreshPr(id, { settle: true }).catch(() => undefined)
      throw e
    }
    this.merging.delete(id)
    return this.refreshPr(id, { settle: true })
  }

  async readyPr(id: string) { const ws = await this.syncBranch(id); await this.github.ready(ws.path, ws.branch); return this.refreshPr(id) }
  async reopenPr(id: string) { const ws = await this.syncBranch(id); await this.github.reopen(ws.path, ws.branch); return this.refreshPr(id) }

  /**
   * Follows the branch a worktree workspace is really on. An agent may switch or create branches in its worktree, for
   * example to a name the repo's own rules ask for, and PRs, merge, push, archive and restore must use the branch the work is on
   * (KERNEL-68). A PR belongs to its branch, so a switch drops the old branch's PR; the next refresh finds the new one.
   * A detached HEAD, or a folder git can't read, changes nothing.
   */
  async syncBranch(id: string): Promise<Workspace> {
    const ws = this.mustWs(id)
    if (ws.mode !== 'worktree' || ws.status === 'archived') return ws
    const now = await currentBranch(ws.path).catch(() => null)
    if (!now || now === 'HEAD' || now === ws.branch) return this.mustWs(id)
    const next = this.updateWs(id, { branch: now, prState: ws.prState === 'creating' ? 'creating' : 'none', prNumber: undefined, prUrl: undefined, prTitle: undefined })
    if (next.branch !== now) return next
    bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: `moved ${ws.name} to the branch`, object: now })
    if (next.prState !== ws.prState) bus.push({ type: 'pr', workspaceId: id, state: next.prState })
    return next
  }

  /** After a merge or close: a fresh branch from the base in the same worktree. The chat stays. */
  async continuePr(id: string) {
    const ws = this.mustWs(id)
    if (ws.prState !== 'merged' && ws.prState !== 'closed') throw new Error('Continue is for a merged or closed pull request.')
    if (ws.mode !== 'worktree') throw new Error('Continue needs a worktree workspace. Start a new workspace to keep going.')
    const room = this.mustRoom(ws.roomId)
    const remote = await this.config.remoteFor(room.path)
    if (ws.baseRef.startsWith(`${remote}/`)) await fetchOrigin(room.path, remote, { fresh: true })
    // feat/x-2 continues as feat/x-3, not feat/x-2-2.
    const stem = ws.branch.replace(/-\d+$/, '')
    const branch = await freeBranch(room.path, stem !== ws.branch && await branchExists(room.path, stem) ? stem : ws.branch)
    await git(ws.path, 'checkout', '-b', branch, ws.baseRef)
    const next = this.updateWs(id, { branch, prState: 'none', prNumber: undefined, prUrl: undefined, prTitle: undefined })
    bus.push({ type: 'pr', workspaceId: id, state: 'none' })
    this.note(id, `Continuing on ${branch} from ${stripRemote(ws.baseRef, remote)}. The chat stays.`)
    return next
  }

  /** Whether the workspace's PR chat is in a turn or has messages waiting for one (a create-pr.md sent mid-turn waits in the queue). */
  private agentBusy(ws: Workspace) {
    const chat = this.prChat(ws.id)
    return chat ? this.sessions.isRunning(chat.id) || this.sessions.queued(chat.id).length > 0 : false
  }

  private async pollPrs() {
    for (const ws of this.store.workspaces()) if (ws.status !== 'archived' && !['none', 'merged', 'closed'].includes(ws.prState)) await this.refreshPr(ws.id).catch(() => undefined)
    // Updates held for a busy or paused Lead go out once it can take them.
    this.leadUpdates.flushAll()
    // A rebase message that couldn't go out, or a release that failed, tries again (KERNEL-259). After the flush, since a
    // release can fetch and rerun setup.
    await this.waits.retryWaits()
  }

  // ---------- helpers

  private saveWs(ws: Workspace) { return records.saveWs(this.store, ws) }

  /**
   * Saves a change to the workspace as it is in the store now, never a copy read before an await, which would put back
   * whatever changed meanwhile (KERNEL-70). An archived workspace only changes through archive and restore, so a slow
   * PR refresh or setup that finishes late leaves it archived. A key set to undefined is dropped when it is stored.
   */
  private updateWs(id: string, patch: Partial<Workspace>, o: { archived?: boolean } = {}): Workspace { return records.updateWs(this.store, id, patch, o) }

  private mustRoom(id: string) { return records.mustRoom(this.store, id) }
  private mustWs(id: string) { return records.mustWs(this.store, id) }
  private agentsSync(roomId: string) { return this.team.agentsSync(roomId) }
  private isLeadWorkspace(ws: Workspace) { return this.team.isLeadWorkspace(ws) }

  /**
   * Every IPC channel, in one map. The preload exposes these to the renderer as window.kernel.invoke. Each feature brings
   * its own channels, and `channels` throws if two answer the same one (KERNEL-324).
   */
  handlers(): Handlers {
    return channels(unbuilt(), this.app.handlers(), this.inbox.handlers(), this.checkpoints.handlers(), this.config.handlers(),
      this.hooks.handlers(), this.account.handlers(), this.integrations.handlers(), this.team.handlers(), this.rooms.handlers(),
      this.setup.handlers(), this.trust.handlers(), this.env.handlers(), this.workspaces.handlers(), this.archive.handlers(), this.chats.handlers(), this.lead.handlers(),
      this.sharing.handlers(), this.coreHandlers())
  }

  /** The channels of features still in this file. They move into their feature's `handlers()` (KERNEL-325 to KERNEL-330). */
  private coreHandlers(): Omit<Handlers, Unbuilt | Moved> {
    return {
      'workspaces.deletePreview': async ({ workspaceIds }) => this.deletePreview(workspaceIds),
      'workspaces.delete': async ({ workspaceIds, deleteUnpushed }) => this.deleteWorkspaces(workspaceIds, { deleteUnpushed }),
      'pr.create': async ({ workspaceId, draft }) => this.createPr(workspaceId, draft),
      'pr.refresh': async ({ workspaceId }) => this.refreshPr(workspaceId),
      'pr.merge': async ({ workspaceId }) => this.mergePr(workspaceId),
      'pr.resolve': async ({ workspaceId }) => { await this.resolvePr(workspaceId); return { ok: true } },
      'pr.get': async ({ workspaceId }) => this.getPr(workspaceId),
      'pr.continue': async ({ workspaceId }) => this.continuePr(workspaceId),
      'pr.ready': async ({ workspaceId }) => this.readyPr(workspaceId),
      'pr.reopen': async ({ workspaceId }) => this.reopenPr(workspaceId)
    }
  }
}
