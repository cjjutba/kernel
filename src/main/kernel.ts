import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DeletePreview, DeleteResult, DeleteSkip, SharedFile, Checkpoint, PrInfo, QueuedMessage, ReviewVerdict, AgentDef, AgentStatus, Chat, ClaudeAccount, ChatItem, ChatPart, PrState, NewRoomRequest, RateLimit, Room, Workspace, ModelId, Effort } from '@shared/types'
import { isKernelUpdate } from '@shared/teamUpdate'
import { effortFor } from '@shared/effort'
import { NotImplemented, type Channel, type KernelApi } from '@shared/ipc'
import { Store, newId } from './db'
import { bus } from './bus'
import { saveAgent } from './services/agents'
import { Approvals, parsePlanSteps } from './services/approvals'
import { Tasks } from './services/tasks'
import { Notifications } from './services/notifications'
import { LeadUpdates } from './services/leadUpdates'
import { NUDGE_LIMIT, Nudges } from './services/nudges'
import { reviewTools, type ReviewInput } from './services/reviewMcp'
import { teammateTools } from './services/teammateMcp'
import { SharedFiles, type ShareRequest } from './services/sharedFiles'
import { sharedTools } from './services/sharedMcp'
import { reviewRule } from './services/handoff'
import { archiveSkip } from './services/archiveGuard'
import { firstLine } from './services/text'
import type { ReviewState } from './services/leadUpdates'
import { isNudge, Sessions, sessionEnv, type CutOffReason } from './services/sessions'
import { askTitle, titleText } from './services/titles'
import { Ptys } from './services/pty'
import { resolvePreset, terminalCommand, terminalPresets, terminalTitle } from './services/terminalPresets'
import type { deleteSession as DeleteSession, forkSession as ForkSession, getSessionInfo as GetSessionInfo, listSessions as ListSessions } from '@anthropic-ai/claude-agent-sdk'
import { kernelMcpServer, kernelTools, queuedNote, reviewedByBase, type KernelToolDeps } from './services/kernelMcp'
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
import { LEAD_CHAT, messageOf, NEW_CHAT } from './features/shared'
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
import { leadUpdateDeps, listen, notificationDeps, overlapDeps, taskDeps } from './features/wiring'
import { sessionDeps } from './features/sessionDeps'

const COPY = 'fork:'

/** The finished-turn counts at which Kernel names an auto-named chat again from the whole conversation (KERNEL-202). */
const RENAME_AT = [1, 3, 10, 30]

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
type Moved = ChannelsOf<App | Inbox | Checkpoints | Config | Hooks | Account | Integrations | Team | Rooms | Setup | Trust | Env | Workspaces | Archive>

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
  /** Chats with a turn running. Read from `chat.running` so the quit prompt can count agents (KERNEL-214). */
  private runningChats = new Set<string>()

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
  /** Whether agents get share_file. `experimental.sharing` in settings.json, on by default and with no page in Settings (KERNEL-308). */
  private get sharing() { return this.settings?.experimental.sharing === true }

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
    this.backfillLeadChats()
    void this.nameStuckChats().catch(() => undefined)
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

  /**
   * Send now in a room a limit paused sends the message anyway. If the limit is real, Claude Code answers with it and
   * the room stays paused; if it lifted, the answer's rate_limit_event lifts it in Kernel too.
   */
  private async sendNow(chatId: string, id: string) {
    const ws = this.mustWs(this.mustChat(chatId).workspaceId)
    // A brief held for a merge goes now, without waiting (KERNEL-259). One held because setup failed still waits for Run again.
    if (ws.status === 'ready' && ws.waitsFor?.held) {
      await this.sessions.sendNow(chatId, id)
      await this.waits.releaseWait(ws.id, { now: true })
      return this.sessions.queued(chatId)
    }
    const room = this.store.room(ws.roomId)
    return this.sessions.sendNow(chatId, id, { pastPause: room?.pausedBy === 'limit' })
  }

  /** Agents with a turn running: workspaces, not chats, so a Lead with two busy chats is one (KERNEL-214). */
  workingAgents(): number {
    const workspaces = [...this.runningChats].map((id) => this.store.chat(id)?.workspaceId).filter(Boolean)
    return new Set(workspaces).size
  }

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

  /**
   * A quick question to the room's Lead. It always gets a new Lead chat tab, so it never queues behind whatever the first tab
   * is doing or lands in a tab with a brief being typed (KERNEL-145, D-133). The answer arrives there like any turn; the popover
   * reads it from there.
   */
  async askLead(roomId: string, text: string): Promise<{ chatId: string }> {
    const chat = await this.startLeadChat(roomId, { prompt: text, plan: false })
    return { chatId: chat.id }
  }

  /**
   * "Let Rowan sort it": the Lead gets both workspaces and the file, and the card leaves the floor.
   * The overlap itself clears on its own once the agents stop touching the same file.
   */
  async sortOverlap(overlapId: string): Promise<void> {
    const o = this.overlaps.get(overlapId)
    if (!o) throw new Error('That overlap is gone already.')
    const agents = await this.agents(o.roomId)
    const parts = o.parties.map((p) => `${agents.find((a) => a.id === p.agentId)?.name ?? p.agentId} in ${this.store.workspace(p.workspaceId)?.name ?? p.workspaceId} (${p.lines})`)
    // The Lead chat that handed off the newest of the workspaces hears about it (KERNEL-105), and learns which other chats are involved.
    const owners = o.parties.map((p) => this.store.workspace(p.workspaceId)).filter((w): w is Workspace => !!w).sort((a, b) => b.createdAt - a.createdAt)
    const chat = (owners.length ? this.leadUpdateTarget(o.roomId, owners[0].leadChatId)?.chat : undefined) ?? await this.leadChat(o.roomId)
    const others = [...new Set(owners.map((w) => w.leadChatId).filter((id): id is string => !!id && id !== chat.id))].map((id) => this.store.chat(id)?.title).filter(Boolean)
    const elsewhere = others.length ? ` Part of this work was handed off in another Lead chat: ${others.map((t) => `"${t}"`).join(', ')}.` : ''
    const text = `${parts.join(' and ')} both changed ${o.path} in different worktrees, so merging both will conflict. Decide who keeps the change, tell the others, and sort it out before either merges.${elsewhere}`
    await this.sessions.send(chat.id, [{ type: 'text', text }])
    this.overlaps.resolve(overlapId)
    // A note, not a brief: a brief to the Lead would restart the briefing sequence on the floor.
    const lead = agents.find((a) => a.id === this.store.workspace(chat.workspaceId)?.agentId)
    bus.activity({ kind: 'note', roomId: o.roomId, workspaceId: chat.workspaceId, agentId: lead?.id, actor: 'you', text: `asked ${lead?.name ?? 'the Lead'} to sort out the overlap in`, object: o.path.split('/').pop(), quote: text })
  }

  /** The files a workspace changed. Their totals are saved on the workspace too, for the sidebar and Home (+412 -38). */
  changes(id: string): ReturnType<Workspaces['changes']> { return this.workspaces.changes(id) }

  // ---------- checkpoints

  /** Save the worktree after a turn, titled with the prompt that started the turn. */
  checkpoint(ws: Workspace, chat: Chat): Promise<Checkpoint> { return this.checkpoints.checkpoint(ws, chat) }

  // ---------- chats

  chatTabs(workspaceId: string): Chat[] { return records.chatTabs(this.store, workspaceId) }

  private mustChat(chatId: string): Chat { return records.mustChat(this.store, chatId) }

  /** A name the user types is theirs: Kernel never changes it again (KERNEL-202). */
  renameChat(chatId: string, title: string): Chat {
    const t = title.trim()
    if (!t) throw new Error('Give the chat a name.')
    return this.saveChat({ ...this.mustChat(chatId), title: t, autoTitle: undefined })
  }

  /** When Kernel last looked for a session title, by chat, so a busy turn reads the transcript at most every few seconds. */
  private titleChecked = new Map<string, number>()
  /** Chats with a naming request in flight. One at a time per chat. */
  private naming = new Set<string>()
  /** The session a chat had when /clear emptied it. Its title belongs to the old conversation, so Kernel doesn't take it. */
  private clearedSession = new Map<string, string>()
  /** How many times /clear reset each chat's name, so an answer about the old conversation that arrives after one is dropped. */
  private nameResets = new Map<string, number>()
  /**
   * Naming requests in a row that brought back no name, by chat. Each one starts a Claude Code process, and one that fails
   * once (a provider without the Haiku id, no bundled CLI) tends to keep failing, so the retries stop (`nameChat`).
   */
  private nameMisses = new Map<string, number>()
  private stopped = false

  /** Kernel picks this chat's name. A chat still called "New chat" from before KERNEL-202 counts too. */
  private autoNamed(c: Chat) { return c.kind !== 'terminal' && (!!c.autoTitle || c.title === NEW_CHAT) }
  /** An auto-named chat that has no real name yet. */
  private unnamed(c: Chat) { return c.title === NEW_CHAT || (!!c.autoTitle && c.title === LEAD_CHAT) }

  /**
   * Names an auto-named chat (KERNEL-202, amends D-089). Until it has a name, it takes the title Claude Code writes into its
   * transcript a few seconds after the first prompt. The SDK sends no event for it, so Kernel looks on replies, at most every
   * few seconds, and at the end of each turn. At the end of a turn Kernel also asks Haiku for a name from the whole
   * conversation when the chat still has none, or when its count of finished turns reaches 1, 3, 10 or 30. A name the user
   * typed, even while a request is in flight, is never changed. A request that fails leaves the name. A refresh is tried once
   * more at the next turn end, then waits for the next point on the schedule. A chat with no name tries at each turn end and
   * stops after 3 misses in a row, until /clear or the next start.
   */
  private async nameChat(ws: Workspace, chat: Chat, turnEnded = false) {
    if (!this.autoNamed(chat)) return
    const resets = this.nameResets.get(chat.id) ?? 0
    if (this.unnamed(chat) && chat.sessionId && chat.sessionId !== this.clearedSession.get(chat.id)) {
      const last = this.titleChecked.get(chat.id) ?? 0
      if (turnEnded || Date.now() - last >= 3000) {
        this.titleChecked.set(chat.id, Date.now())
        const title = (await this.sessionInfo(chat.sessionId, { dir: ws.path }).catch(() => undefined))?.customTitle?.trim().slice(0, 60)
        if (this.stopped || resets !== (this.nameResets.get(chat.id) ?? 0)) return
        const now = this.store.chat(chat.id)
        if (title && now && this.autoNamed(now) && this.unnamed(now)) {
          this.titleChecked.delete(chat.id)
          this.nameMisses.delete(chat.id)
          this.saveChat({ ...now, title, autoTitle: now.autoTitle ?? { turns: 0 } })
        }
      }
    }
    if (!turnEnded || this.naming.has(chat.id) || resets !== (this.nameResets.get(chat.id) ?? 0)) return
    const before = this.store.chat(chat.id)
    if (!before || before.closed || !this.autoNamed(before)) return
    const unnamed = this.unnamed(before)
    const done = before.autoTitle?.turns ?? 0
    // A named chat past the last point on the schedule is settled. A "New chat" that missed 3 times waits for /clear or a restart.
    if (unnamed ? (this.nameMisses.get(chat.id) ?? 0) >= 3 : done >= RENAME_AT[RENAME_AT.length - 1]) return
    const items = this.store.items(chat.id)
    const turns = items.filter((i) => i.kind === 'result').length
    if (!turns || !(unnamed || RENAME_AT.some((at) => at > done && at <= turns))) return
    this.naming.add(chat.id)
    try {
      const title = await this.titleFor(titleText(items), { cwd: ws.path, current: unnamed ? undefined : before.title }).catch(() => undefined)
      if (this.stopped || resets !== (this.nameResets.get(chat.id) ?? 0)) return
      const now = this.store.chat(chat.id)
      if (!now || !this.autoNamed(now) || now.title !== before.title) return
      if (title) {
        this.nameMisses.delete(chat.id)
        this.saveChat({ ...now, title, autoTitle: { turns } })
        return
      }
      const misses = (this.nameMisses.get(chat.id) ?? 0) + 1
      // A refresh of a chat that has a name gets one retry, then waits for the next point on the schedule.
      if (unnamed || misses < 2) { this.nameMisses.set(chat.id, misses); return }
      this.nameMisses.delete(chat.id)
      this.saveChat({ ...now, autoTitle: { turns } })
    } finally {
      this.naming.delete(chat.id)
    }
  }

  /** /clear starts a new conversation, so an auto name goes back to "New chat" and the schedule starts over. Other resets keep it. */
  private resetName(chat: Chat, trigger?: string) {
    if (trigger && trigger !== 'clear') return
    const now = this.store.chat(chat.id)
    if (!now || !this.autoNamed(now)) return
    if (now.sessionId) this.clearedSession.set(chat.id, now.sessionId)
    this.nameResets.set(chat.id, (this.nameResets.get(chat.id) ?? 0) + 1)
    this.nameMisses.delete(chat.id)
    this.titleChecked.delete(chat.id)
    this.saveChat({ ...now, title: NEW_CHAT, autoTitle: { turns: 0 } })
  }

  /** Open chats still called "New chat" after a finished turn, as /clear left them before KERNEL-202. Named one at a time. */
  private async nameStuckChats() {
    for (const ws of this.store.workspaces().filter((w) => w.status !== 'archived')) {
      for (const chat of this.chatTabs(ws.id)) {
        if (this.stopped) return
        if (chat.kind === 'terminal' || chat.title !== NEW_CHAT || !chat.sessionId) continue
        if (!this.store.items(chat.id).some((i) => i.kind === 'result')) continue
        await this.nameChat(ws, chat, true).catch(() => undefined)
      }
    }
  }

  /** The tab leaves the strip, its transcript stays. A big terminal's process ends. The last open tab is replaced by a fresh chat. */
  closeChat(chatId: string) {
    const chat = this.mustChat(chatId)
    this.sessions.stop(chatId)
    this.ptys.kill(chatId)
    this.saveChat({ ...chat, closed: true })
    if (!this.chatTabs(chat.workspaceId).some((c) => c.kind !== 'terminal')) this.saveChat(this.newChat(chat.workspaceId, NEW_CHAT, { model: chat.model, effort: this.openedEffort(chat.workspaceId, chat.model), plan: false }))
  }

  /**
   * The effort of a chat the user opens: the one they last picked for its model, else the workspace agent's, else Settings, Models (D-130).
   * The Lead's hand-offs and its first chat skip the memory, so they follow the agent file.
   */
  private openedEffort(workspaceId: string, model: ModelId): Effort {
    const ws = this.mustWs(workspaceId)
    const agent = this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)
    return effortFor(model, this.settings.models.effortByModel, agent?.effort ?? this.settings.models.effort)
  }

  private saveChat(chat: Chat): Chat { return records.saveChat(this.store, chat) }

  /**
   * A new chat that resumes from this one with the SDK's session fork. With `itemId` the fork ends at the nearest assistant message
   * at or before it (user messages carry no SDK uuid), and the transcript is copied up to there.
   */
  async forkChat(chatId: string, itemId?: string): Promise<Chat> {
    const chat = this.mustChat(chatId)
    if (chat.kind === 'terminal') throw new Error('A big terminal cannot be forked.')
    const ws = this.mustWs(chat.workspaceId)
    let items = this.store.items(chatId)
    let upTo: string | undefined
    if (itemId) {
      const at = items.findIndex((i) => i.id === itemId)
      if (at < 0) throw new Error('That message is not in this chat.')
      const keep = items.slice(0, at + 1)
      const anchor = [...keep].reverse().find((i) => i.kind !== 'user' && i.id.includes(':') && !i.id.startsWith(COPY))
      if (keep.some((i) => i.id.startsWith(COPY)) && !anchor) throw new Error('Fork the original chat to branch from an earlier message.')
      if (anchor) { items = items.slice(0, items.findIndex((i) => i.id === anchor.id) + 1); upTo = anchor.id.split(':')[0] } else items = []
    }
    let sessionId: string | undefined
    if (chat.sessionId && (!itemId || upTo)) sessionId = (await this.forkSession(chat.sessionId, { dir: ws.path, upToMessageId: upTo, title: `Fork of ${chat.title}` })).sessionId
    const fork = this.saveChat({ ...this.newChat(chat.workspaceId, `Fork of ${chat.title}`, { model: chat.model, effort: chat.effort, plan: chat.plan }), sessionId, forkOf: { chatId, itemId: items[items.length - 1]?.id ?? '' } })
    for (const i of items) this.store.saveItem(fork.id, { ...i, id: `${COPY}${fork.id}:${i.id}` } as ChatItem)
    return fork
  }

  /** Every variable a session, script or terminal in the workspace gets (KERNEL-247). */
  envFor(ws: Workspace, o: { script?: boolean } = {}): Record<string, string> { return this.env.envFor(ws, o) }

  /** Starts the pty for a big terminal chat, or the workspace's plain shell (`shell:<workspaceId>`), the first time it is used. */
  private ensurePty(id: string, size?: { cols: number; rows: number }) {
    if (this.ptys.has(id)) return
    const plain = id.startsWith('shell:')
    const chat = plain ? undefined : this.mustChat(id)
    if (chat && (chat.kind !== 'terminal' || chat.closed)) throw new Error('That tab is not a terminal.')
    const ws = this.mustWs(plain ? id.slice('shell:'.length) : chat!.workspaceId)
    this.ptys.start(id, {
      cwd: ws.path,
      env: sessionEnv(this.envFor(ws), {}, { agentTeams: this.settings.models.agentTeams }),
      command: (plain ? null : terminalCommand(chat!)) ?? undefined,
      ...size
    })
  }

  /** A chat opened with a placeholder name ("New chat", the Lead's "Lead") is auto-named. A workspace's title or a fork's is not (KERNEL-202). */
  newChat(workspaceId: string, title: string, o: { model: ModelId; effort: Effort; plan: boolean; kind?: 'chat' | 'terminal'; terminal?: Chat['terminal'] }): Chat {
    return records.newChat(this.store, workspaceId, title, o)
  }

  /** The preset a new big terminal tab runs, resolved here so the renderer never names the command (KERNEL-248). */
  private async terminalFor(ws: Workspace, preset?: string) {
    const t = this.settings.terminal
    if (!t.enabled) throw new Error('Big terminal tabs are off. Turn them on in Settings, Big terminal.')
    return resolvePreset(await terminalPresets(t), t, ws.mode, preset)
  }

  /** The Lead lives in a room-level workspace on the main checkout, made the first time it is needed. */
  private async leadWorkspace(roomId: string): Promise<{ ws: Workspace; lead: AgentDef }> {
    const agents = await this.agents(roomId)
    const lead = agents.find((a) => a.lead)
    if (!lead) throw new Error('No lead agent. Mark one agent with "lead: true".')
    let ws = this.store.workspaces(roomId).find((w) => w.agentId === lead.id && w.mode === 'current' && w.status !== 'archived')
    if (!ws) {
      const room = this.mustRoom(roomId)
      const branch = await currentBranch(room.path)
      ws = await this.workspaces.withPort((port) => this.saveWs({ id: newId(), roomId, name: 'lead', branch, baseRef: room.defaultBranch, path: room.path, mode: 'current', agentId: lead.id, port, status: 'ready', prState: 'none', createdAt: Date.now() }))
    }
    return { ws, lead }
  }

  /** The Lead's first open chat. Floor briefs go there. */
  async leadChat(roomId: string): Promise<Chat> {
    const { ws, lead } = await this.leadWorkspace(roomId)
    return this.chatTabs(ws.id).find((c) => c.kind !== 'terminal') ?? this.newChat(ws.id, LEAD_CHAT, { model: this.team.modelFor(lead), effort: lead.effort ?? this.settings.models.effort, plan: this.settings.models.leadPlanMode })
  }

  /**
   * A message to the Lead in a chat of its own (KERNEL-148). It always adds a tab, like the tab row's +: an unused tab may
   * hold a draft the engine can't see, since the composer keeps it (D-133, KERNEL-242). The first message names the chat.
   */
  async startLeadChat(roomId: string, o: { prompt: string; parts?: ChatPart[]; model?: ModelId; effort?: Effort; plan?: boolean }): Promise<Chat> {
    const { ws, lead } = await this.leadWorkspace(roomId)
    const pick = { model: o.model ?? this.team.modelFor(lead), effort: o.effort ?? lead.effort ?? this.settings.models.effort, plan: o.plan ?? this.settings.models.leadPlanMode }
    const chat = this.saveChat(this.newChat(ws.id, NEW_CHAT, pick))
    this.userSpoke(chat.id)
    await this.sessions.send(chat.id, messageOf(o.prompt, o.parts))
    return chat
  }

  private leadTools(roomId: string, lead: AgentDef, chat: Chat) {
    return kernelMcpServer(this.leadToolDeps(roomId, lead, chat))
  }

  /** What the Lead's tools call, apart from the server so tests can run the tools against a real Kernel. */
  private leadToolDeps(roomId: string, lead: AgentDef, chat: Chat): KernelToolDeps {
    return {
      roomId, lead,
      agents: () => this.agents(roomId),
      workspaces: () => this.store.workspaces(roomId),
      chatId: chat.id,
      chatTitle: (id) => this.store.chat(id)?.title,
      // The saved chat, not `chat`: the toggle can change after the session starts (KERNEL-176).
      planMode: () => !!this.store.chat(chat.id)?.plan,
      createWorkspace: async ({ issue, ...o }) => {
        // Only plans approved in this chat. Another Lead chat's plan with a step for the same agent is a different hand-off.
        const approvalIds = new Set(this.store.approvals({ roomId }).filter((a) => a.kind === 'plan' && a.chatId === chat.id).map((a) => a.id))
        // The issue the task builds (D-140). Kernel names the branch from it unless the Lead named one (KERNEL-275).
        const linked = issue ? await this.integrations.issueSource(issue, o.title ?? firstLine(o.prompt)) : undefined
        const branch = o.branch
        // A review is not a task of the plan, so it takes no plan step or Board task (KERNEL-130).
        const review = o.reviewOf ?? o.linkReviewOf
        const ws = await this.createWorkspace(roomId, { ...o, ...(linked ? { source: linked.source, labels: linked.labels } : {}), ...(branch ? { branch } : {}), mode: o.mode, leadChatId: chat.id, taskFor: review ? undefined : (w) => this.tasks.link(roomId, o.agentId, w.id, { approvalIds })?.id })
        if (!review) this.linkPlanStep(roomId, o.agentId, ws.id, chat.id)
        // Rowan named no wait, but Linear says the issue is blocked by one a teammate is building (KERNEL-263).
        const blocked = !o.waitFor && linked?.blockedBy?.length ? await this.waits.waitOnBlockers(ws, linked.blockedBy).catch(() => undefined) : undefined
        if (ws.status !== 'failed') {
          // The brief may still wait in the teammate's chat, for a slot, a pause or the connection (KERNEL-272).
          const out = blocked ?? ws
          const brief = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
          const queued = brief && this.sessions.queueReason(brief.id)
          return queued ? { ...out, queued } : out
        }
        const code = this.setup['setupFailures'].get(ws.id)
        return { ...ws, setupFailed: code === null ? 'it was stopped' : code === undefined ? 'it did not pass' : `exit code ${code}` }
      },
      messageWorkspace: (workspaceId, text) => this.messageWorkspace(roomId, workspaceId, text, chat.id),
      askUser: async (o) => {
        // The card goes in the chat Rowan is blocked in, wherever that is, and shows in the Inbox too.
        const agents = await this.agents(roomId)
        const { approval, decision } = this.approvals.request({
          kind: o.kind, source: 'sdk', roomId, workspaceId: chat.workspaceId, chatId: chat.id, agentId: lead.id, title: o.title, detail: o.detail, options: o.options,
          steps: o.steps && parsePlanSteps(o.steps, agents), agentFile: o.agentFile
        })
        this.sessions.placeApproval(chat.id, approval.id)
        // An answer is the user stepping in, so the loop guard starts over for this chat's work (KERNEL-125).
        return decision.then((d) => { if (d) this.userSpoke(chat.id); return d })
      },
      archiveWorkspace: (id) => this.archiveWorkspace(id),
      setWait: (id, on) => this.setWait(id, on),
      refreshPr: (id) => this.refreshPr(id, { settle: true }),
      isRunning: (id) => this.archive.working(id),
      // The sidebar's check before a one-click archive. A current-branch workspace removes no files, and neither does a
      // worktree whose folder is already gone (KERNEL-109).
      unsaved: (id) => this.archive.unsavedOf(id),
      planApproved: () => this.sessions.planApproved(chat.id),
      handedOff: () => this.sessions.handoffs.done(chat.id),
      hireAgent: async (a) => {
        const was = this.team['agentCache'].get(roomId) ?? await this.agents(roomId)
        const file = await saveAgent(this.mustRoom(roomId).path, a)
        this.team['announceTeam'](roomId, await this.agents(roomId), was)
        return file
      }
    }
  }

  /**
   * The Lead's `message_agent` (KERNEL-118). It sends only into an open workspace of this room that has its folder and
   * isn't the Lead's own, opening a chat there when none is open, and says what really happened: sent, waiting for the
   * teammate's turn, for setup, for a paused room, for the connection or for a free slot. A message sent while setup
   * runs goes after the brief.
   */
  private async messageWorkspace(roomId: string, workspaceId: string, text: string, leadChatId?: string): Promise<{ ok: boolean; sent: boolean; note: string }> {
    const refuse = (note: string) => ({ ok: false, sent: false, note })
    const ws = this.store.workspace(workspaceId)
    if (!ws || ws.roomId !== roomId) return refuse(`Not sent: there is no workspace ${workspaceId} in this room. Call list_workspaces for the ids.`)
    if (ws.status === 'archived') return refuse(`Not sent: ${ws.name} is archived. Ask the user to restore it from History, or hand the work out again with create_workspace.`)
    const agent = (await this.agents(roomId)).find((a) => a.id === ws.agentId)
    if (agent?.lead) return refuse('Not sent: that is your own workspace.')
    if (ws.mode === 'worktree' && await folderGone(ws.path).catch(() => false)) return refuse(`Not sent: ${ws.name}'s folder is gone. Ask the user to archive it, or hand the work out again with create_workspace.`)
    const name = agent?.name ?? ws.agentId
    // A request in a Lead turn Kernel started is automatic. After a few tries at one workspace, the user decides (KERNEL-125).
    // The turn is keyed by the message that started it, so several messages in one turn are one try.
    const auto = !!leadChatId && this.sessions.kernelTurn(leadChatId)
    // A limit or restart nudge carries the turn on, so the turn is still the message before it.
    const turn = auto ? [...this.store.items(leadChatId!)].reverse().find((i) => i.kind === 'user' && !(i.from === 'kernel' && isNudge(i.parts)))?.id : undefined
    if (auto && this.nudges.spent(ws.id, turn)) return refuse(`Not sent: Kernel has passed ${NUDGE_LIMIT} automatic requests to ${name} on this workspace and it still needs help. Tell the user what keeps failing and ask how to go on.`)
    if (auto) this.nudges.add(ws.id, turn)
    const parts: ChatPart[] = [{ type: 'text', text }]
    const held = this.setup['setups'].get(ws.id)
    if (held) { held.later.push(parts); this.setup['saveSetups'](); return { ok: true, sent: false, note: `${name}'s workspace is still setting up, so the message waits behind the brief.` } }
    let chat = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
    const opened = !chat
    if (!chat) chat = this.saveChat(this.newChat(ws.id, NEW_CHAT, { model: agent ? this.team.modelFor(agent) : this.settings.models.engineers, effort: agent?.effort ?? this.settings.models.effort, plan: false }))
    const { queued, why } = await this.sessions.send(chat.id, parts, { from: 'lead' })
    if (!queued) return { ok: true, sent: true, note: opened ? `Opened a new chat in ${name}'s workspace and sent it.` : 'Sent.' }
    const waiting = this.store.workspace(ws.id)
    const note = why === 'running' ? `${name} is mid-turn, so the message goes out when that turn ends.`
      : why === 'setup' && ws.status === 'trust' ? `${name}'s workspace waits for the user to trust this room's scripts, so the message waits behind the brief.`
      : why === 'setup' && waiting?.status === 'ready' && waiting.waitsFor?.held ? `${name} waits for ${this.waits.waitLabelOf(waiting)} to merge, so this goes out after the brief. To start ${name} now, call wait_for_merge with an empty list.`
      : why === 'setup' ? (this.setup['settingUp'].has(ws.id) ? `${name}'s workspace is setting up again, so the message waits behind the brief.` : `Setup failed in ${name}'s workspace, so the message waits until the user clicks Run again.`)
      // The same words as create_workspace's brief (KERNEL-272).
      : queuedNote(why, { name }) ?? 'The message waits in the queue.'
    return { ok: true, sent: false, note: opened ? `Opened a new chat in ${name}'s workspace. ${note}` : note }
  }

  /**
   * Point the first unlinked step for this agent in the latest plan approved in `chatId` at the new workspace (the card's
   * Open workspace link). Plans from the room's other Lead chats are left alone (KERNEL-105).
   */
  private linkPlanStep(roomId: string, agentId: string, workspaceId: string, chatId: string) {
    const plan = this.store.approvals({ roomId }).filter((a) => a.kind === 'plan' && a.status === 'allowed' && a.chatId === chatId && a.steps?.some((s) => s.agentId === agentId && !s.workspaceId)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!plan?.steps) return
    const at = plan.steps.findIndex((s) => s.agentId === agentId && !s.workspaceId)
    this.approvals.update(plan.id, { steps: plan.steps.map((s, i) => (i === at ? { ...s, workspaceId } : s)) })
  }

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

  /**
   * The tools in an agent's `kernel` server: the Lead's, a reviewer's or a teammate's own, and share_file for all three
   * while sharing is on.
   */
  toolsFor(ws: Workspace, agent: AgentDef | undefined, chat: Chat) {
    const own = agent?.lead ? kernelTools(this.leadToolDeps(ws.roomId, agent, chat))
      : ws.reviewOf ? reviewTools({ submit: (review) => this.submitReview(ws.id, review) })
      : teammateTools(this.waits.teammateToolDeps(ws.id))
    return this.sharing ? [...own, ...sharedTools({ share: (o) => this.shareFile(ws.id, chat.id, o) })] : own
  }

  /**
   * share_file for a chat: keeps the version, puts its card in the chat, tells the room and the Lead, then asks for a
   * thumbnail. A file with the same bytes as its newest version does none of that. Throws Refused.
   */
  async shareFile(workspaceId: string, chatId: string, o: ShareRequest) {
    const ws = this.mustWs(workspaceId)
    const r = await this.shared.share(ws, { ...o, chatId })
    if (r.status === 'same') return r
    this.sessions.placeShared(chatId, r.file.id, r.version.n)
    bus.push({ type: 'shared', file: r.file })
    this.leadUpdates.shared(ws, r.file, r.version)
    void this.captureThumb(r.file, r.version.n).catch(() => undefined)
    return r
  }

  private async captureThumb(file: SharedFile, n: number) {
    const png = await this.o.capture?.thumbnail(file, n)
    if (!png) return
    const saved = await this.shared.saveThumb(file.id, n, png)
    if (saved) bus.push({ type: 'shared', file: saved })
  }

  /** A shared file's version and the path of Kernel's copy, for the preview host. Undefined when Kernel doesn't have it. */
  sharedFile(id: string, version: number) { return this.shared.get(id, version) }

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

  /**
   * The user wrote in a chat, so the loop guard starts over (KERNEL-125): for that workspace, or, in a Lead chat, for every
   * workspace whose updates that chat gets, a closed chat's work included.
   */
  private userSpoke(chatId: string) {
    const chat = this.store.chat(chatId)
    const ws = chat && this.store.workspace(chat.workspaceId)
    if (!ws) return
    if (!this.isLeadWorkspace(ws)) { this.nudges.reset(ws.id); return }
    this.nudges.reset(...this.store.workspaces(ws.roomId).filter((w) => !this.isLeadWorkspace(w) && this.leadUpdateTarget(ws.roomId, w.leadChatId)?.chat.id === chatId).map((w) => w.id))
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
    this.userSpoke(chat.id)
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

  /** The room's Lead chat if the Lead has been briefed. Unlike `leadChat`, never creates one. */
  private existingLeadChat(roomId: string): Chat | undefined {
    const lead = this.agentsSync(roomId).find((a) => a.lead)
    const ws = lead && this.store.workspaces(roomId).find((w) => w.agentId === lead.id && w.mode === 'current' && w.status !== 'archived')
    return ws ? this.chatTabs(ws.id).find((c) => c.kind !== 'terminal') : undefined
  }

  /** A chat tab still on the strip, in a workspace that isn't archived. */
  private isOpenChat(chat: Chat) {
    return !chat.closed && chat.kind !== 'terminal' && this.store.workspace(chat.workspaceId)?.status !== 'archived'
  }

  /**
   * Where teammate updates about work handed off in `owner` go (KERNEL-105): that chat while it's open, else its newest
   * open fork, else the room's first open Lead chat, with `closed` set so the update can say where the work came from.
   * Work no Lead chat handed off goes to the first open Lead chat. Never creates a chat.
   */
  private leadUpdateTarget(roomId: string, owner?: string): { chat: Chat; closed?: Chat } | undefined {
    const was = owner ? this.store.chat(owner) : undefined
    if (was && this.isOpenChat(was)) return { chat: was }
    const fork = was && this.store.chats(was.workspaceId).filter((c) => c.forkOf?.chatId === was.id && this.isOpenChat(c)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (fork) return { chat: fork }
    const first = this.existingLeadChat(roomId)
    return first && { chat: first, closed: was }
  }

  /**
   * Workspaces the Lead created before Kernel saved `leadChatId` (KERNEL-105). Only a Lead chat has the kernel tools, so
   * each finished `create_workspace` in a chat ("Created <id> on <branch> ...") names a workspace that chat handed off.
   * Runs once; a workspace it can't place reports to the room's first Lead chat, as before.
   */
  private backfillLeadChats() {
    if (this.store.meta<boolean>('leadChatBackfill')) return
    for (const lead of this.store.workspaces().filter((w) => w.mode === 'current')) {
      for (const chat of this.store.chats(lead.id)) {
        for (const item of this.store.items(chat.id)) {
          if (item.kind !== 'tool' || item.name !== 'mcp__kernel__create_workspace' || item.status !== 'done') continue
          const id = /^Created (\S+) on /.exec(item.output ?? '')?.[1]
          const ws = id ? this.store.workspace(id) : undefined
          if (ws && ws.roomId === lead.roomId && !ws.leadChatId) this.store.saveWorkspace({ ...ws, leadChatId: chat.id })
        }
      }
    }
    this.store.saveMeta('leadChatBackfill', true)
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
      this.setup.handlers(), this.trust.handlers(), this.env.handlers(), this.workspaces.handlers(), this.archive.handlers(), this.coreHandlers())
  }

  /** The channels of features still in this file. They move into their feature's `handlers()` (KERNEL-325 to KERNEL-330). */
  private coreHandlers(): Omit<Handlers, Unbuilt | Moved> {
    return {
      'chats.restart': async ({ chatId }) => { await this.sessions.restart(chatId); return { ok: true } },
      'rooms.overlaps': async ({ roomId }) => this.overlaps.check(roomId),
      'rooms.resolveOverlap': async ({ overlapId }) => { await this.sortOverlap(overlapId); return { ok: true } },
      'rooms.brief': async ({ roomId, text, parts, agentId }) => {
        let chat: Chat
        if (agentId) {
          const ws = this.store.workspaces(roomId).find((w) => w.agentId === agentId && w.status !== 'archived')
          if (!ws) throw new Error('That agent has no open workspace. Brief the Lead instead.')
          const first = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
          if (!first) throw new Error('That agent has no open chat. Open a new chat in its workspace, or brief the Lead instead.')
          chat = first
        } else chat = await this.leadChat(roomId)
        const message = messageOf(text, parts)
        this.userSpoke(chat.id)
        await this.sessions.send(chat.id, message)
        // The log line under the brief, and the start of the briefing sequence on the floor (FloorSent.png).
        const to = this.store.workspace(chat.workspaceId)?.agentId
        const name = (await this.agents(roomId)).find((a) => a.id === to)?.name ?? 'the Lead'
        const quote = parts ? message.map((p) => (p.type === 'text' ? p.text : p.name)).join(' ').replace(/\s+/g, ' ').trim() : text
        bus.activity({ kind: 'brief', roomId, workspaceId: chat.workspaceId, agentId: to, actor: 'you', text: agentId ? `messaged ${name}` : `briefed ${name}`, quote })
        return { chatId: chat.id, workspaceId: chat.workspaceId }
      },
      'workspaces.deletePreview': async ({ workspaceIds }) => this.deletePreview(workspaceIds),
      'workspaces.delete': async ({ workspaceIds, deleteUnpushed }) => this.deleteWorkspaces(workspaceIds, { deleteUnpushed }),
      'lead.ask': async ({ roomId, text }) => this.askLead(roomId, text),
      'lead.open': async ({ roomId }) => this.mustWs((await this.leadChat(roomId)).workspaceId),
      'lead.start': async ({ roomId, ...o }) => this.startLeadChat(roomId, o),
      'chats.compact': async ({ chatId }) => { await this.sessions.compact(chatId); return { ok: true } },
      'chats.list': async ({ workspaceId }) => this.chatTabs(workspaceId),
      'chats.rename': async ({ chatId, title }) => this.renameChat(chatId, title),
      'chats.close': async ({ chatId }) => { this.closeChat(chatId); return { ok: true } },
      'chats.fork': async ({ chatId, itemId }) => this.forkChat(chatId, itemId),
      'terminal.write': async ({ chatId, data }) => { this.ensurePty(chatId); this.ptys.write(chatId, data); return { ok: true } },
      'terminal.resize': async ({ chatId, cols, rows }) => { this.ensurePty(chatId, { cols, rows }); this.ptys.resize(chatId, cols, rows); return { ok: true } },
      'terminal.replay': async ({ chatId }) => { this.ptys.replay(chatId); return { ok: true } },
      'chats.create': async ({ workspaceId, kind, preset }) => {
        const ws = this.mustWs(workspaceId)
        const term = kind === 'terminal' ? await this.terminalFor(ws, preset) : undefined
        // Right after a restart nothing may have read the team yet, and the agent's effort is the fallback.
        if (!this.team['agentCache'].has(ws.roomId)) await this.agents(ws.roomId)
        const model = this.store.chats(workspaceId)[0]?.model ?? this.settings.models.engineers
        return this.newChat(workspaceId, term ? terminalTitle(term.preset) : NEW_CHAT, { model, effort: this.openedEffort(workspaceId, model), plan: false, kind, terminal: term?.terminal })
      },
      'terminal.presets': async () => terminalPresets(this.settings.terminal),
      'chats.items': async ({ chatId }) => this.store.items(chatId),
      'commands.list': async () => this.sessions.commands(this.home),
      'chats.queue': async ({ chatId }) => this.sessions.queued(chatId),
      'chats.queueReason': async ({ chatId }) => this.sessions.queueReason(chatId) ?? null,
      'chats.live': async () => ({ running: this.sessions.runningIds(), retry: this.sessions.retries() }),
      'chats.unqueue': async ({ chatId, id }) => this.sessions.unqueue(chatId, id),
      'chats.sendNow': async ({ chatId, id }) => this.sendNow(chatId, id),
      'chats.retry': async ({ chatId, itemId, now }) => {
        // Sending their own message again is the user stepping in; a Kernel update sent again isn't.
        const items = this.store.items(chatId)
        const sent = items.slice(0, items.findIndex((i) => i.id === itemId) + 1).reverse().find((i) => i.kind === 'user')
        if (sent?.kind === 'user' && !sent.from && !isKernelUpdate(sent)) this.userSpoke(chatId)
        const copy = await this.sessions.retry(chatId, itemId)
        // Retry now: the copy goes first and the running turn stops, past a limit's pause as Send now does.
        if (now && copy) await this.sendNow(chatId, copy.id)
        return { ok: true }
      },
      'chats.send': async ({ chatId, parts }) => { this.userSpoke(chatId); return this.sessions.send(chatId, parts) },
      'chats.interrupt': async ({ chatId }) => { await this.sessions.interrupt(chatId); return { ok: true } },
      'chats.configure': async ({ chatId, ...patch }) => this.sessions.configure(chatId, patch),
      'pr.create': async ({ workspaceId, draft }) => this.createPr(workspaceId, draft),
      'pr.refresh': async ({ workspaceId }) => this.refreshPr(workspaceId),
      'pr.merge': async ({ workspaceId }) => this.mergePr(workspaceId),
      'pr.resolve': async ({ workspaceId }) => { await this.resolvePr(workspaceId); return { ok: true } },
      'pr.get': async ({ workspaceId }) => this.getPr(workspaceId),
      'pr.continue': async ({ workspaceId }) => this.continuePr(workspaceId),
      'pr.ready': async ({ workspaceId }) => this.readyPr(workspaceId),
      'pr.reopen': async ({ workspaceId }) => this.reopenPr(workspaceId),
      'shared.list': async ({ roomId, workspaceId, limit }) => this.store.sharedFiles({ roomId, workspaceId, limit }),
      'shared.read': async ({ sharedId, version }) => this.shared.read(sharedId, version),
      'shared.thumb': async ({ sharedId, version }) => this.shared.thumb(sharedId, version),
      'shared.reveal': async ({ sharedId, version }) => {
        const ws = this.store.workspace(this.store.sharedFile(sharedId)?.workspaceId ?? '')
        this.o.reveal?.(await this.shared.revealPath(sharedId, version, ws))
        return { ok: true }
      },
      // Only a PDF, from Kernel's own copy: opening an HTML file or a script by its default app would run it outside the lock.
      'shared.open': async ({ sharedId, version }) => {
        const got = this.shared.get(sharedId, version)
        if (!got) throw new Error('That shared file or version is gone.')
        if (got.file.kind !== 'pdf') throw new Error('Only a PDF opens in Preview.')
        await this.o.openFile?.(got.path)
        return { ok: true }
      }
    }
  }
}
