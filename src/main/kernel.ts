import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Chat, Checkpoint, ClaudeAccount, ClaudePlan, Effort, ModelId, QueuedMessage, RateLimit, Workspace } from '@shared/types'
import { NotImplemented, type Channel, type KernelApi } from '@shared/ipc'
import { Store } from './db'
import { bus } from './bus'
import { Approvals } from './services/approvals'
import { Tasks } from './services/tasks'
import { Notifications } from './services/notifications'
import { LeadUpdates } from './services/leadUpdates'
import { Nudges } from './services/nudges'
import { SharedFiles } from './services/sharedFiles'
import { Sessions, type CutOffReason } from './services/sessions'
import { askTitle } from './services/titles'
import { Ptys } from './services/pty'
import type { deleteSession as DeleteSession, forkSession as ForkSession, getSessionInfo as GetSessionInfo, listSessions as ListSessions } from '@anthropic-ai/claude-agent-sdk'
import { loadAppSettings, type AppSettings } from './services/settings'
import { claudeSignedIn, readAccount } from './services/account'
import { stopAllScripts } from './services/scripts'
import { EnvStore } from './services/env'
import { githubAvatar, RoomIcons } from './services/roomIcons'
import { gh, type GitHub } from './services/github'
import { Overlaps } from './services/overlap'
import type { KernelOptions } from './features/options'
import { channels } from './features/channels'
import * as records from './features/records'
import { leadUpdateDeps, listen, notificationDeps, overlapDeps, taskDeps } from './features/wiring'
import { sessionDeps } from './features/sessionDeps'
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
import { History } from './features/history'
import { Waits } from './features/waits'
import { Chats } from './features/chats'
import { Lead } from './features/lead'
import { Tools } from './features/tools'
import { Sharing } from './features/sharing'
import { Prs } from './features/prs'
import { AutoArchive } from './features/autoArchive'
import { Reviews } from './features/reviews'
import { Telemetry } from './features/telemetry'
import { BaseWatch } from './features/baseWatch'

export { fetchedAt } from './features/workspaces'

type CoreChannel = Exclude<Channel, `system.${string}`>
export type Handlers = { [C in CoreChannel]: (req: KernelApi[C]['req']) => Promise<KernelApi[C]['res']> }

/**
 * Channels no lane has built yet, and the issue that builds each. They reject with NotImplemented.
 * A lane that builds one deletes its line here and adds the handler to its feature's `handlers()`.
 * Empty since KERNEL-30 built the last ones (update.*).
 */
export const UNBUILT = {} as const satisfies Partial<Record<CoreChannel, `KERNEL-${number}`>>

type Unbuilt = keyof typeof UNBUILT

/** Handlers for every unbuilt channel, each rejecting with the issue that builds it. */
function unbuilt(): Pick<Handlers, Unbuilt> {
  const out: Record<string, () => Promise<never>> = {}
  for (const [channel, issue] of Object.entries(UNBUILT as Record<string, string>)) out[channel] = async () => { throw new NotImplemented(channel as Channel, issue) }
  return out as unknown as Pick<Handlers, Unbuilt>
}

/**
 * Builds the services and the features, starts and stops them, and joins their IPC handler maps (KERNEL-324). Each
 * feature's state, logic and channels live in its own file under `features/`, so a change to one doesn't touch this file.
 */
export class Kernel {
  readonly store: Store
  readonly approvals: Approvals
  readonly notifications: Notifications
  readonly leadUpdates: LeadUpdates
  /** The loop guard on the Lead's automatic requests to a teammate (KERNEL-125). */
  readonly nudges: Nudges
  readonly tasks: Tasks
  readonly sessions: Sessions
  readonly overlaps: Overlaps
  readonly ptys = new Ptys()
  readonly roomIcons: RoomIcons
  /** Copies of the files agents shared, and their checks (KERNEL-302). */
  readonly shared: SharedFiles
  /** App-wide and per-room variables, encrypted in `env.json` (KERNEL-247). */
  readonly envStore: EnvStore
  settings!: AppSettings
  private unlisten: () => void = () => undefined

  // ---------- features (KERNEL-324)
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
  readonly history = new History(this)
  readonly waits = new Waits(this)
  readonly chats = new Chats(this)
  readonly lead = new Lead(this)
  readonly tools = new Tools(this)
  readonly sharing = new Sharing(this)
  readonly prs = new Prs(this)
  readonly autoArchive = new AutoArchive(this)
  readonly reviews = new Reviews(this)
  readonly telemetry = new Telemetry(this)
  readonly baseWatch = new BaseWatch(this)

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
  accountReader: () => Promise<ClaudeAccount & { subscriptionType?: string }> = readAccount
  /** Whether Claude Code is signed in, read at launch before agents carry on (KERNEL-215). Tests swap it for a stub. */
  signedInReader: () => Promise<boolean> = claudeSignedIn
  /** The GitHub calls behind the PR methods. Tests swap it for a stub. */
  github: GitHub = gh

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

  /** The user's home folder: the app's, or the one a test passes. */
  get home(): string { return this.o.home ?? homedir() }

  async start() {
    // `stop()` saves cleanExit as its last write, so without it the last run crashed, was force quit or lost power (KERNEL-215).
    const clean = this.store.meta<boolean>('cleanExit') === true
    this.store.saveMeta('cleanExit', false)
    // Settings are what the user chose over the defaults of the plan Kernel last read. Nothing is saved here: only a change is (KERNEL-225).
    this.config.plan = this.store.meta<ClaudePlan>('plan') ?? 'unknown'
    const { saved, resolved } = await loadAppSettings(this.config.settingsFile, this.home, this.config.plan)
    this.config.saved = saved
    this.settings = resolved
    this.o.onSettings?.(this.settings)
    this.telemetry.start()
    await this.hooks.start()
    this.prs.start()
    void this.workspaces.countChanges()
    // No waiter outlives a restart, so nothing can answer an approval from the last run. It ends before the inbox
    // replays pending ones, and the inbox drops archived workspaces' rows and week-old settled ones (D-137).
    this.approvals.expireStale()
    this.notifications.attach()
    void this.chats.nameStuckChats().catch(() => undefined)
    this.leadUpdates.attach()
    this.account.start()
    this.tasks.attach()
    for (const r of this.store.rooms()) void this.config.remoteFor(r.path)
    // Claude Code processes a crash or a force quit left behind keep working in the worktrees the chats resume in.
    await this.sessions.endLeftovers()
    // Chats that carry on below need their agent's prompt, and a Lead chat its Kernel tools, which read the agents.
    await Promise.all(this.store.rooms().filter((r) => !r.archived).map((r) => this.team.agents(r.id).catch(() => undefined)))
    await this.lead.backfill()
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
    this.autoArchive.start()
    // After the waits, which read each room's team first, so the Lead's workspace is known.
    void this.waits.sweepWaits().catch(() => undefined).then(() => this.autoArchive.sweepMerged()).catch(() => undefined)
    this.archive.start()
    // A reset on claude.ai while Kernel was closed shows only in the real numbers, so ask at once.
    if (this.store.rooms().some((r) => r.pausedBy === 'limit')) void this.account.checkLimits()
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
  private hasStopped = false
  /** Set first thing in `stop()`. Work that finishes after it leaves the closed database and the window alone. */
  get stopped(): boolean { return this.hasStopped }

  /** Marks itself stopped first, so nothing it closes on the way out (the hook server) pushes to the window (KERNEL-214). */
  private async doStop(o: { budgetMs?: number }) {
    this.hasStopped = true
    this.unlisten()
    this.notifications.detach()
    this.leadUpdates.detach()
    this.tasks.detach()
    this.prs.stop()
    this.account.stop()
    this.team.stop()
    this.telemetry.stop()
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

  /**
   * Every IPC channel, in one map. The preload exposes these to the renderer as window.kernel.invoke. Each feature brings
   * its own channels, and `channels` throws if two answer the same one (KERNEL-324).
   */
  handlers(): Handlers {
    return channels(unbuilt(), this.app.handlers(), this.inbox.handlers(), this.checkpoints.handlers(), this.config.handlers(),
      this.hooks.handlers(), this.account.handlers(), this.integrations.handlers(), this.team.handlers(), this.rooms.handlers(),
      this.setup.handlers(), this.trust.handlers(), this.env.handlers(), this.workspaces.handlers(), this.archive.handlers(),
      this.history.handlers(), this.chats.handlers(), this.lead.handlers(), this.sharing.handlers(), this.prs.handlers(), this.telemetry.handlers())
  }

  // ---------- what tests and the app shell call on a Kernel (KERNEL-331)
  // Each forwards to its feature, plain and not async (R4). New code and new tests call the feature itself.

  readAccount(): Promise<ClaudeAccount> { return this.account.readAccount() }
  /** The app calls it when the Mac wakes. */
  checkLimits(): Promise<void> { return this.account.checkLimits() }
  checkpoint(ws: Workspace, chat: Chat): Promise<Checkpoint> { return this.checkpoints.checkpoint(ws, chat) }
  chatTabs(workspaceId: string): Chat[] { return records.chatTabs(this.store, workspaceId) }
  newChat(workspaceId: string, title: string, o: { model: ModelId; effort: Effort; plan: boolean; kind?: 'chat' | 'terminal'; terminal?: Chat['terminal'] }): Chat {
    return records.newChat(this.store, workspaceId, title, o)
  }
  workingAgents(...a: Parameters<Chats['workingAgents']>): ReturnType<Chats['workingAgents']> { return this.chats.workingAgents(...a) }
  agents(...a: Parameters<Team['agents']>): ReturnType<Team['agents']> { return this.team.agents(...a) }
  statusOf(...a: Parameters<Team['statusOf']>): ReturnType<Team['statusOf']> { return this.team.statusOf(...a) }
  addRoom(...a: Parameters<Rooms['addRoom']>): ReturnType<Rooms['addRoom']> { return this.rooms.addRoom(...a) }
  createRoom(...a: Parameters<Rooms['createRoom']>): ReturnType<Rooms['createRoom']> { return this.rooms.createRoom(...a) }
  updateRoom(...a: Parameters<Rooms['updateRoom']>): ReturnType<Rooms['updateRoom']> { return this.rooms.updateRoom(...a) }
  removeRoom(...a: Parameters<Rooms['removeRoom']>): ReturnType<Rooms['removeRoom']> { return this.rooms.removeRoom(...a) }
  pauseRoom(...a: Parameters<Rooms['pauseRoom']>): ReturnType<Rooms['pauseRoom']> { return this.rooms.pauseRoom(...a) }
  resumeRoom(...a: Parameters<Rooms['resumeRoom']>): ReturnType<Rooms['resumeRoom']> { return this.rooms.resumeRoom(...a) }
  createWorkspace(...a: Parameters<Workspaces['createWorkspace']>): ReturnType<Workspaces['createWorkspace']> { return this.workspaces.createWorkspace(...a) }
  changes(...a: Parameters<Workspaces['changes']>): ReturnType<Workspaces['changes']> { return this.workspaces.changes(...a) }
  retrySetup(...a: Parameters<Setup['retrySetup']>): ReturnType<Setup['retrySetup']> { return this.setup.retrySetup(...a) }
  envFor(...a: Parameters<Env['envFor']>): ReturnType<Env['envFor']> { return this.env.envFor(...a) }
  /** Every caller goes through here, so a test that swaps it on the instance reaches them all (R3). */
  archiveWorkspace(...a: Parameters<Archive['archiveWorkspace']>): ReturnType<Archive['archiveWorkspace']> { return this.archive.archiveWorkspace(...a) }
  restoreWorkspace(...a: Parameters<Archive['restoreWorkspace']>): ReturnType<Archive['restoreWorkspace']> { return this.archive.restoreWorkspace(...a) }
  trashEmptied(...a: Parameters<Archive['trashEmptied']>): ReturnType<Archive['trashEmptied']> { return this.archive.trashEmptied(...a) }
  deletePreview(...a: Parameters<History['deletePreview']>): ReturnType<History['deletePreview']> { return this.history.deletePreview(...a) }
  deleteWorkspaces(...a: Parameters<History['deleteWorkspaces']>): ReturnType<History['deleteWorkspaces']> { return this.history.deleteWorkspaces(...a) }
  setWait(...a: Parameters<Waits['setWait']>): ReturnType<Waits['setWait']> { return this.waits.setWait(...a) }
  leadChat(...a: Parameters<Lead['leadChat']>): ReturnType<Lead['leadChat']> { return this.lead.leadChat(...a) }
  startLeadChat(...a: Parameters<Lead['startLeadChat']>): ReturnType<Lead['startLeadChat']> { return this.lead.startLeadChat(...a) }
  askLead(...a: Parameters<Lead['askLead']>): ReturnType<Lead['askLead']> { return this.lead.askLead(...a) }
  sortOverlap(...a: Parameters<Lead['sortOverlap']>): ReturnType<Lead['sortOverlap']> { return this.lead.sortOverlap(...a) }
  closeChat(...a: Parameters<Chats['closeChat']>): ReturnType<Chats['closeChat']> { return this.chats.closeChat(...a) }
  toolsFor(...a: Parameters<Tools['toolsFor']>): ReturnType<Tools['toolsFor']> { return this.tools.toolsFor(...a) }
  sharedFile(...a: Parameters<Sharing['sharedFile']>): ReturnType<Sharing['sharedFile']> { return this.sharing.sharedFile(...a) }
  submitReview(...a: Parameters<Reviews['submitReview']>): ReturnType<Reviews['submitReview']> { return this.reviews.submitReview(...a) }
  /** Every caller goes through here, so a test that swaps it on the instance reaches them all (R3). */
  refreshPr(...a: Parameters<Prs['refreshPr']>): ReturnType<Prs['refreshPr']> { return this.prs.refreshPr(...a) }
  mergePr(...a: Parameters<Prs['mergePr']>): ReturnType<Prs['mergePr']> { return this.prs.mergePr(...a) }
  createPr(...a: Parameters<Prs['createPr']>): ReturnType<Prs['createPr']> { return this.prs.createPr(...a) }
  resolvePr(...a: Parameters<Prs['resolvePr']>): ReturnType<Prs['resolvePr']> { return this.prs.resolvePr(...a) }
  continuePr(...a: Parameters<Prs['continuePr']>): ReturnType<Prs['continuePr']> { return this.prs.continuePr(...a) }
  syncBranch(...a: Parameters<Prs['syncBranch']>): ReturnType<Prs['syncBranch']> { return this.prs.syncBranch(...a) }
}
