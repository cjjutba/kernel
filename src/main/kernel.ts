import { basename, join } from 'node:path'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { Server } from 'node:http'
import type { WaitsFor, PrInfo, QueuedMessage, ReviewVerdict, AgentDef, AppUpdate, AgentDraft, AgentEdit, AgentStatus, Chat, ClaudeAccount, ChatItem, ChatPart, PrState, WorkspaceSource, HookStatus, NewRoomRequest, RateLimit, Room, RoomSetupStep, TeamTemplate, Workspace, WorkspaceMode, ModelId, Effort, Decision } from '@shared/types'
import { MODELS } from '@shared/types'
import { isKernelUpdate } from '@shared/teamUpdate'
import { effortFor } from '@shared/effort'
import { NotImplemented, type Channel, type KernelApi, type PushEvent } from '@shared/ipc'
import { Store, newId } from './db'
import { bus } from './bus'
import { createAgent, draftAgent, loadAgents, restoreAgent, retireAgent, saveAgent, updateAgent, watchAgents } from './services/agents'
import { Approvals, parsePlanSteps } from './services/approvals'
import { attachmentNote, planExists, saveAttachments, savePlan } from './services/plans'
import { Tasks } from './services/tasks'
import { Notifications } from './services/notifications'
import { LeadUpdates } from './services/leadUpdates'
import { NUDGE_LIMIT, Nudges } from './services/nudges'
import { reviewMcpServer, type ReviewInput } from './services/reviewMcp'
import { teammateMcpServer, type TeammateToolDeps } from './services/teammateMcp'
import { reviewRule, TEAMMATE_RULE } from './services/handoff'
import { archiveSkip } from './services/archiveGuard'
import { firstLine } from './services/text'
import type { ReviewState } from './services/leadUpdates'
import { isNudge, PAUSE_KEEPS, Sessions, sessionEnv } from './services/sessions'
import { askTitle, titleText } from './services/titles'
import { Ptys } from './services/pty'
import type { forkSession as ForkSession, getSessionInfo as GetSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { kernelMcpServer, type KernelToolDeps } from './services/kernelMcp'
import { startHookServer } from './services/hookServer'
import { hookStatus, installHooks, KERNEL_HOOK_EVENTS, kernelHooksPresent, uninstallHooks } from './services/hooksInstaller'
import { nextFreePort, portBusy, runPreflight } from './services/preflight'
import { applySettingsPatch, loadAppSettings, loadRepoSettings, prInstructions, remoteOf, saveAppSettings, saveRepoSettings, type AppSettings, type RepoSettings } from './services/settings'
import { discoverMcp, integrationRows, saveLinearToken, storedLinearToken } from './services/integrations'
import { changedFiles, createWorktree, currentBranch, defaultBranch, diffText, branchExists, fastForward, folderGone, freeBranch, listBranches, mergeBase, onRemote, remoteRepo, removeWorktree, resolveBaseRef, restoreWorktree, stripRemote, slugify, snapshotBaseline, taskBranch, validBranchName } from './services/worktrees'
import { readAccount, signOut } from './services/account'
import { copyLocalFiles, freePort, linkNodeModules, runScript, stopAllScripts, stopScript } from './services/scripts'
import { resolveFilesToCopy } from './services/filesToCopy'
import { AVATAR_FAILED, githubAvatar, githubOwner, readImage, RoomIcons } from './services/roomIcons'
import { agentFiles, assertFreeFolder, cloneRepo, copyTemplate, ensureRepoSettings, expandHome, initGit, inspectFolder, installCommand, listRepos, recentFolders, seatStarterTeam, copyAgentFiles, tildify } from './services/rooms'
import { exec, git } from './services/exec'
import { discoverSkills, listTree, readWorkspaceFile, searchFiles } from './services/files'
import { commitHunks, listHunks } from './services/hunks'
import { allGreen, gh, ghUser as ghUserName, openIssues, openPrs, prNote, resolveFile, type GitHub } from './services/github'
import { getIssue, getScope, linearToken, listIssues, moveToStarted, planParts, searchIssues } from './services/linear'
import { Overlaps } from './services/overlap'
import { checkpointTitle, clock, listCheckpoints, revertTo, snapshot } from './services/checkpoints'
import { blockingLimit, NetworkMonitor, terminalScript } from './services/health'
import { discardChanges, gitStatus, pushBranch, unpushedCommits } from './services/archive'
import { isMerged, joinLabels, waitLabel, waitMet } from './services/waits'

const COPY = 'fork:'

/**
 * The name a chat opened from the tab row starts with. It gives way to Claude Code's title for the session, or to the one
 * Kernel picks at the end of a turn, and comes back after /clear (`nameChat`, KERNEL-202).
 */
const NEW_CHAT = 'New chat'
/** The Lead's first tab before anyone writes in it. Like "New chat", it gives way to a real name. */
const LEAD_CHAT = 'Lead'
/** The finished-turn counts at which Kernel names an auto-named chat again from the whole conversation (KERNEL-202). */
const RENAME_AT = [1, 3, 10, 30]

/** A workspace's brief waiting for setup, and the Lead's messages that go after it (KERNEL-118, KERNEL-128). */
interface SetupHold { chatId?: string; brief?: ChatPart[]; from?: 'lead'; later: ChatPart[][] }

/** While a usage window is rejected, how often Kernel checks whether it lifted. Claude Code answers the usage call from a snapshot under a minute old, so this waits longer than that. */
const LIMIT_RECHECK_MS = 90_000

/** What the "Notify me" notification calls each window. Claude Code calls `seven_day_overage_included` the Fable limit. */
const LIMIT_NAME: Record<RateLimit['type'], string> = {
  five_hour: '5-hour limit', seven_day: 'weekly limit', seven_day_opus: 'Opus limit', seven_day_sonnet: 'Sonnet limit', seven_day_overage_included: 'Fable limit', overage: 'extra usage limit'
}

/** How a hook from an outside session moves its agent on the floor. */
const HOOK_STATUS: Record<string, AgentStatus> = { UserPromptSubmit: 'working', PreToolUse: 'working', PermissionRequest: 'needs', Stop: 'idle', SessionEnd: 'idle' }

/** A composer message: `parts` in order when they carry text (chips sit inline), else `text` first and the parts after it. */
const messageOf = (text: string, parts: ChatPart[] = []): ChatPart[] =>
  parts.some((p) => p.type === 'text') ? parts : [...(text ? [{ type: 'text' as const, text }] : []), ...parts]

type CoreChannel = Exclude<Channel, `system.${string}`>
export type Handlers = { [C in CoreChannel]: (req: KernelApi[C]['req']) => Promise<KernelApi[C]['res']> }

/**
 * Channels no lane has built yet, and the issue that builds each. They reject with NotImplemented.
 * A lane that builds one deletes its line here and adds the handler to the map in `handlers()`.
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

export class Kernel {
  readonly store: Store
  readonly approvals: Approvals
  readonly notifications: Notifications
  readonly leadUpdates: LeadUpdates
  /** The loop guard on the Lead's automatic requests to a teammate (KERNEL-125). */
  private nudges: Nudges
  /**
   * Workspaces whose brief hasn't gone out yet: the chat and brief, and the Lead's messages that follow it (KERNEL-118).
   * Saved under the meta key `setups`, so a quit during setup doesn't lose the brief (KERNEL-128).
   */
  private setups = new Map<string, SetupHold>()
  /**
   * Review workspaces whose reviewed work merged or closed and that Kernel hasn't archived yet, most often because they
   * were working. They go when their turn ends. Saved under the meta key `reviewsToArchive`, so a quit doesn't keep them
   * open, and only these are swept at start, so a review the user restored stays restored.
   */
  private reviewsToArchive = new Set<string>()
  /** Archives under way, so a second call for the same workspace waits for the first. */
  private archiving = new Map<string, Promise<void>>()
  /** Each room's own `workspace.remote` by path, for the review rule, which can't wait on a file read (`remoteFor`). */
  private roomRemotes = new Map<string, string | undefined>()
  /** The exit code of a workspace's last failed setup, or null when it was stopped. Cleared when setup passes. */
  private setupFailures = new Map<string, number | null>()
  readonly tasks: Tasks
  readonly sessions: Sessions
  readonly overlaps: Overlaps
  readonly ptys = new Ptys()
  readonly roomIcons: RoomIcons
  /** Fetches a GitHub owner's avatar for a room icon. Tests swap it for one with gh and fetch stubbed. */
  avatar: (owner: string) => Promise<Buffer> = (owner) => githubAvatar(owner, { fetch: this.o.fetch })
  /** The SDK call behind a fork. Tests swap it for a stub. */
  forkSession: typeof ForkSession = async (id, o) => (await import('@anthropic-ai/claude-agent-sdk')).forkSession(id, o)
  /** The SDK call that reads a session's title from its transcript. Tests swap it for a stub. */
  sessionInfo: typeof GetSessionInfo = async (id, o) => (await import('@anthropic-ai/claude-agent-sdk')).getSessionInfo(id, o)
  /** The Haiku request that names a chat from its conversation (KERNEL-202). Tests swap it for a stub. */
  titleFor: typeof askTitle = askTitle
  settings!: AppSettings
  private hookServer?: Server
  private agentCache = new Map<string, AgentDef[]>()
  private agentWatchers = new Map<string, () => void>()
  private statuses = new Map<string, Record<string, AgentStatus>>()
  private prTimer?: NodeJS.Timeout
  /** When each hook event last arrived from a real session. The test event is not counted. */
  private hookSeen = new Map<string, number>()
  private unlisten: () => void = () => undefined
  private network?: NetworkMonitor
  /** One timer per rejected usage window, at its reset time. */
  private limitTimers = new Map<RateLimit['type'], { at: number; timer: NodeJS.Timeout }>()
  /** The last account read, so a sign-out keeps the name on the account menu. */
  private account?: import('@shared/types').ClaudeAccount
  /** Windows the user asked to hear about when they reset ("Notify me"). */
  private notifyReset = new Set<RateLimit['type']>()
  /** Runs `checkLimits` while any window is rejected. */
  private limitCheck?: NodeJS.Timeout
  private limitChecking?: Promise<void>
  /** Waits being released, so a merge seen twice (push and poll) sends the brief once (KERNEL-259). */
  private waitReleases = new Map<string, Promise<void>>()
  /**
   * Started teammates whose rebase message Kernel sent or queued in this run. A queue doesn't survive a quit, so the
   * workspace keeps `waitsFor.releasing` until a turn Kernel started there ends, and a restart sends the message again.
   */
  private releaseSent = new Set<string>()

  constructor(private o: {
    dataDir: string; home?: string; claudeSettingsFile?: string; starterDir?: string; showNotification?: (n: import('@shared/types').Notification, o: { silent: boolean }) => void; inBackground?: () => boolean
    /** Can this machine reach Claude? The app passes a DNS probe; tests leave it out, so they never go offline. */
    probeNetwork?: () => Promise<boolean>
    /** Re-reads the user's PATH before each preflight, so "Check again" finds a CLI installed after launch. Tests leave it out. */
    refreshPath?: () => Promise<void>
    /** Kernel's version, for Settings > About. */
    version?: string
    /** Called with the settings at start and after every change, for the parts only the app shell can do (open at login). */
    onSettings?: (s: AppSettings) => void
    /** Auto-update (src/main/updater.ts). Only a packaged app has one; without it Kernel reports no update. */
    updater?: { get(): AppUpdate; check(): Promise<AppUpdate>; install(): void }
    /** What Linear calls and the GitHub avatar download go through. Tests pass a stub; the app leaves it out. */
    fetch?: typeof fetch
  }) {
    this.store = new Store(join(o.dataDir, 'kernel.db'))
    this.roomIcons = new RoomIcons(o.dataDir)
    this.approvals = new Approvals(this.store)
    this.tasks = new Tasks({ store: this.store, agents: (roomId) => this.agentsSync(roomId) })
    this.notifications = new Notifications({
      store: this.store,
      settings: () => this.settings,
      agentName: (roomId, agentId) => (roomId ? this.agentsSync(roomId).find((a) => a.id === agentId)?.name : undefined),
      show: o.showNotification,
      inBackground: o.inBackground
    })
    this.sessions = new Sessions({
      store: this.store,
      approvals: this.approvals,
      settings: () => this.settings,
      agentFor: (ws) => this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId),
      mcpFor: (ws, agent, chat) => (agent?.lead ? { kernel: this.leadTools(ws.roomId, agent, chat) }
        : ws.reviewOf ? { kernel: reviewMcpServer({ submit: (review) => this.submitReview(ws.id, review) }) }
        : { kernel: teammateMcpServer(this.teammateToolDeps(ws.id)) }),
      // The Lead's rule is LEAD_RULE, which agentPrompt adds itself.
      rulesFor: (ws, agent) => (agent?.lead ? undefined : ws.reviewOf ? this.reviewRuleFor(ws) : TEAMMATE_RULE),
      roomAllow: (roomId) => this.store.room(roomId)?.allow ?? [],
      allowInRoom: (roomId, rule) => {
        const room = this.store.room(roomId)
        if (room && !room.allow?.includes(rule)) this.store.saveRoom({ ...room, allow: [...(room.allow ?? []), rule] })
      },
      onReply: (ws, chat) => void this.nameChat(ws, chat),
      onReset: (_ws, chat, trigger) => this.resetName(chat, trigger),
      onTurnDone: (ws, chat, turn) => {
        void this.checkpoint(ws, chat).catch(() => undefined)
        void this.nameChat(ws, chat, true)
        const lead = !!this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)?.lead
        const done = { ...turn, lead, queued: this.sessions.queued(chat.id).length > 0 }
        this.notifications.turnDone(ws, chat, done)
        // The Lead works on the main checkout and never opens a PR of its own, so there is nothing to refresh. A teammate's
        // update waits until Kernel has read its PR, so a PR the turn opened speaks for the turn however long GitHub takes.
        const teammate = !this.isLeadWorkspace(ws)
        if (teammate) this.leadUpdates.readingPr(ws.id)
        this.leadUpdates.turnDone(ws, chat, done)
        // A review workspace that was still working when its work merged or closed goes now (KERNEL-131).
        if (this.reviewsToArchive.has(ws.id) && ws.reviewOf) void this.archiveReviews(ws.reviewOf, ws.id).catch(() => undefined)
        void this.changes(ws.id).catch(() => undefined)
        if (teammate) void this.refreshPr(ws.id).catch(() => undefined).then(() => this.leadUpdates.readPr(ws.id)).catch(() => undefined)
        void this.overlaps.check(ws.roomId).catch(() => undefined)
        this.releaseTaken(ws.id, chat.id, turn.by)
      },
      onFailure: (failure) => {
        if (failure === 'auth') this.signedOut()
        else if (failure === 'network') void this.network?.check()
      },
      // A teammate whose session died mid-turn would look busy forever. Kernel tells the Lead that handed the work off (KERNEL-124).
      onExit: (ws, _chat, reason, midTurn, resumed) => {
        if (midTurn) this.leadUpdates.crashed(this.store.workspace(ws.id) ?? ws, reason, { resumed })
        // A review waiting to be archived whose session died has no turn end coming to archive it (KERNEL-131).
        if (this.reviewsToArchive.has(ws.id) && ws.reviewOf) void this.archiveReviews(ws.reviewOf, ws.id).catch(() => undefined)
      },
      onLimits: (limits) => this.applyLimits(limits),
      onCutOff: (chatIds) => this.store.saveMeta('cutOff', chatIds),
      onHeld: (held) => this.store.saveMeta('held', held)
    })
    this.nudges = new Nudges(this.store)
    this.leadUpdates = new LeadUpdates({
      store: this.store,
      enabled: () => this.settings.models.leadUpdates !== false,
      target: (roomId, owner) => this.leadUpdateTarget(roomId, owner),
      isLead: (ws) => !!this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)?.lead,
      agentName: (roomId, agentId) => this.agentsSync(roomId).find((a) => a.id === agentId)?.name,
      post: (chatId, text, update) => this.sessions.post(chatId, [{ type: 'text', text }], { update }),
      reviewState: (ws) => this.reviewState(ws),
      // The team's reviewer is asked to look at a PR that passed checks (KERNEL-121). Retired agents are off the team.
      reviewer: (roomId) => this.agentsSync(roomId).find((a) => !a.lead && !a.retired && /\breview/i.test(a.role)),
      // A note, not a brief: a brief would restart the floor's briefing sequence (as sortOverlap does). The floor reads
      // `leadUpdate` to keep the Lead's next turn from replaying the hand-off walk.
      delivered: (roomId, chat, update) => {
        const ws = this.store.workspace(chat.workspaceId)
        const [one] = update.rows
        const object = update.rows.length > 1 ? `${update.rows.length} teammates` : one.prNumber ? `${one.name}'s PR #${one.prNumber}` : `${one.name}'s work`
        bus.activity({ kind: 'note', roomId, workspaceId: chat.workspaceId, agentId: ws?.agentId, text: 'heard from Kernel about', object, data: { leadUpdate: true } })
      }
    })
    this.overlaps = new Overlaps({
      workspaces: (roomId) => this.store.workspaces(roomId),
      since: async (ws) => (ws.mode === 'current' ? ws.baselineRef ?? 'HEAD' : mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef)),
      leadId: (roomId) => this.agentsSync(roomId).find((a) => a.lead)?.id,
      saved: this.store
    })
    const onActivity = (e: Parameters<Store['saveActivity']>[0]) => this.store.saveActivity(e)
    const onHook = (e: { hook_event_name: string }, ctx?: { roomId?: string; agentId?: string }) => {
      this.hookSeen.set(e.hook_event_name, Date.now())
      // Only sessions Kernel did not start reach here (the big terminal, or Claude Code run by hand), so the floor learns their status from the hooks.
      const status = HOOK_STATUS[e.hook_event_name]
      if (!status || !ctx?.roomId || !ctx.agentId) return
      if (this.statuses.get(ctx.roomId)?.[ctx.agentId] === 'paused') return
      bus.push({ type: 'agent.status', roomId: ctx.roomId, agentId: ctx.agentId, status })
    }
    const onPush = (e: PushEvent) => {
      if (e.type === 'agent.status') this.statuses.set(e.roomId, { ...(this.statuses.get(e.roomId) ?? {}), [e.agentId]: e.status })
      // The work merged, so the loop guard starts over for it and its reviews (KERNEL-125). Ready does too, in refreshPr.
      if (e.type === 'pr' && e.state === 'merged') this.nudges.reset(e.workspaceId, ...this.reviewsOf(e.workspaceId))
      // Its reviews are done once the work merged or closed (KERNEL-131). A PR opened again keeps them.
      if (e.type === 'pr' && (e.state === 'merged' || e.state === 'closed')) void this.archiveReviews(e.workspaceId).catch(() => undefined)
      else if (e.type === 'pr') this.unmarkReviews(...this.reviewsOf(e.workspaceId))
      // A merge releases the workspaces that wait for it, and a close breaks their wait (KERNEL-259). Here, not in
      // LeadUpdates, which drops events while Lead updates are off.
      if (e.type === 'pr') void this.onTargetPr(e.workspaceId, e.state).catch(() => undefined)
    }
    bus.on('activity', onActivity).on('hook', onHook).on('push', onPush)
    // A stopped kernel has a closed database. Leave the shared bus so a second kernel in the same process doesn't write to it.
    this.unlisten = () => { bus.off('activity', onActivity).off('hook', onHook).off('push', onPush) }
  }

  private get home() { return this.o.home ?? homedir() }
  private get settingsFile() { return join(this.o.dataDir, 'settings.json') }

  async start() {
    this.settings = await loadAppSettings(this.settingsFile, this.home)
    await saveAppSettings(this.settingsFile, this.settings)
    this.o.onSettings?.(this.settings)
    await this.listenHooks(this.settings.hookPort)
    this.prTimer = setInterval(() => void this.pollPrs(), 45_000)
    void this.countChanges()
    // No waiter outlives a restart, so nothing can answer an approval from the last run. It ends before the inbox
    // replays pending ones, and the inbox drops archived workspaces' rows and week-old settled ones (D-137).
    this.approvals.expireStale()
    this.notifications.attach()
    this.backfillLeadChats()
    void this.nameStuckChats().catch(() => undefined)
    this.leadUpdates.attach()
    if (this.o.probeNetwork) {
      this.network = new NetworkMonitor({ probe: this.o.probeNetwork, onChange: (online) => this.setOnline(online) })
      this.network.start()
    }
    this.tasks.attach()
    for (const r of this.store.rooms()) void this.remoteFor(r.path)
    // A room paused before the app quit is still paused: its agents wait and its sends are held. The saved limits decide
    // a limit pause: one that reset while Kernel was closed lifts now, and the chats the limit stopped carry on.
    for (const r of this.store.rooms()) if (r.paused) this.sessions.pause(r.id)
    this.sessions.restore(this.store.meta<RateLimit[]>('limits') ?? [], this.store.meta<string[]>('cutOff') ?? [], this.store.meta<Record<string, QueuedMessage[]>>('held') ?? {})
    this.recoverSetups()
    for (const id of this.store.meta<string[]>('reviewsToArchive') ?? []) this.reviewsToArchive.add(id)
    void this.sweepReviews()
    void this.sweepWaits().catch(() => undefined)
    // A reset on claude.ai while Kernel was closed shows only in the real numbers, so ask at once.
    if (this.store.rooms().some((r) => r.pausedBy === 'limit')) void this.checkLimits()
  }

  /** Starts the hook server on `port`. A taken port is not fatal: preflight reports it and offers the next one. */
  private async listenHooks(port: number): Promise<boolean> {
    try {
      this.hookServer = await startHookServer({
        port,
        approvals: this.approvals,
        approvalTimeoutMs: () => this.settings.permissions.approvalTimeoutSec * 1000,
        isManaged: (id) => this.sessions.isManaged(id),
        resolve: (cwd) => this.resolveCwd(cwd)
      })
      // A server that closes or errors on its own takes the floor and the logs with it (WorkspaceHooksDown.png).
      const server = this.hookServer
      server.on('close', () => { if (this.hookServer === server) void this.pushHooks() })
      server.on('error', () => void this.pushHooks())
      return true
    } catch { return false }
  }

  /** Moves the hook server to `port`, saves it, and rewrites the hooks if they were installed. Returns the status after. */
  private async restartHooks(port: number): Promise<HookStatus> {
    // A busy new port must not take down the server that works. Check before closing.
    if (port !== this.settings.hookPort && (await portBusy(port))) throw new Error(`Port ${port} is in use. Pick another port and try again.`)
    // Any Kernel entry counts, so an old http install moves to the command form. Hooks are never added where there were none.
    const wasInstalled = await kernelHooksPresent(this.claudeSettings).catch(() => false)
    await new Promise<void>((r) => (this.hookServer?.listening ? this.hookServer.close(() => r()) : r()))
    this.hookServer = undefined
    if (!(await this.listenHooks(port))) throw new Error(`Port ${port} is in use. Pick another port and try again.`)
    if (port !== this.settings.hookPort) {
      this.settings = { ...this.settings, hookPort: port }
      await saveAppSettings(this.settingsFile, this.settings)
    }
    if (wasInstalled) await installHooks(this.claudeSettings, port, this.settings.permissions.approvalTimeoutSec)
    return this.pushHooks()
  }

  /**
   * Settings > any app page. Saves to settings.json and applies at once: running sessions read the permission lists on their
   * next tool call, the mode moves to them now, a higher limit on agents working at once starts what was waiting, and a new
   * approval timeout is read per request and rewritten into the installed hooks.
   */
  private async setSettings(patch: Parameters<typeof applySettingsPatch>[1]): Promise<AppSettings> {
    const before = this.settings
    this.settings = applySettingsPatch(before, patch)
    await saveAppSettings(this.settingsFile, this.settings)
    this.sessions.applySettings(before)
    this.o.onSettings?.(this.settings)
    // The server reads the timeout per request. Only the copy in the installed hooks needs rewriting.
    if (before.permissions.approvalTimeoutSec !== this.settings.permissions.approvalTimeoutSec && (await kernelHooksPresent(this.claudeSettings).catch(() => false))) await installHooks(this.claudeSettings, this.settings.hookPort, this.settings.permissions.approvalTimeoutSec)
    return this.settings
  }

  /** The activity log as plain text, one line per event, saved in the data folder. */
  private async exportLogs(): Promise<{ path: string }> {
    const dir = join(this.o.dataDir, 'logs')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `kernel-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    const lines = this.store.activity(undefined, 5000).reverse().map((e) => `${new Date(e.ts).toISOString()} ${[e.actor, e.text, e.object].filter(Boolean).join(' ')}`)
    await writeFile(path, lines.join('\n') + '\n')
    return { path }
  }

  private async pushHooks(): Promise<HookStatus> {
    const status = await this.hooksStatus()
    bus.push({ type: 'hooks', status })
    return status
  }

  // ---------- failures (KERNEL-28)

  /** Main's view of the network. Offline holds every room like a pause; back online sends what queued. */
  private setOnline(online: boolean) {
    bus.push({ type: 'online', online })
    if (online) this.sessions.releaseAll('offline')
    else this.sessions.holdAll('offline')
  }

  /** Reads `claude auth status`. Tests swap it for a stub. */
  accountReader: () => Promise<ClaudeAccount> = readAccount
  private authTimer?: NodeJS.Timeout

  /**
   * A session reported an auth failure: Claude Code is signed out. Everything waits until the CLI is signed in again,
   * by Sign in here or by `claude /login` in a terminal, which a check every 10 seconds picks up.
   */
  private signedOut() {
    this.sessions.holdAll('auth')
    bus.push({ type: 'account', account: { ...this.account, signedIn: false } })
    if (this.authTimer) return
    this.authTimer = setInterval(() => void this.readAccount().catch(() => undefined), 10_000)
    this.authTimer.unref?.()
  }

  /** Every read of the account can end a sign-out: a signed-in answer lifts the hold and tells the renderer. */
  async readAccount() {
    const account = await this.accountReader()
    if (!account.signedIn) return account
    this.account = account
    if (this.sessions.heldFor().includes('auth')) {
      clearInterval(this.authTimer); this.authTimer = undefined
      this.sessions.releaseAll('auth')
      bus.push({ type: 'account', account })
    }
    return account
  }

  /** Runs Claude Code's own login (it opens the browser), then reads the account back. */
  async signIn() {
    await exec('claude', ['auth', 'login'], { timeoutMs: 5 * 60_000 })
    const account = await this.readAccount()
    bus.push({ type: 'account', account })
    if (!account.signedIn) throw new Error('Sign in did not finish. Open a terminal and run claude /login.')
    return account
  }

  /**
   * A 5-hour or weekly rejection pauses every room by `limit` (FloorLimit.png); its end resumes them, and the chats it
   * stopped mid-turn carry on (`Sessions.carryOn`). The limits are saved, so a restart keeps the pause. Each rejected
   * window gets a timer at its reset time, which marks it allowed again. While any window is rejected, `checkLimits`
   * also runs every LIMIT_RECHECK_MS. A window lifting by any route sends "Notify me".
   */
  private applyLimits(limits: RateLimit[]) {
    const now = Date.now()
    this.store.saveMeta('limits', limits)
    const rooms = this.store.rooms().filter((r) => !r.archived)
    if (blockingLimit(limits, now)) { for (const r of rooms) if (!r.paused) this.pauseRoom(r.id, 'limit') }
    else for (const r of rooms) if (r.paused && r.pausedBy === 'limit') this.resumeRoom(r.id, 'limit')
    for (const l of limits) {
      const at = l.resetsAt ? l.resetsAt * 1000 : undefined
      const held = this.limitTimers.get(l.type)
      if (l.status !== 'rejected' || !at) { if (held) { clearTimeout(held.timer); this.limitTimers.delete(l.type) } continue }
      if (held?.at === at) continue
      if (held) clearTimeout(held.timer)
      const timer = setTimeout(() => this.limitReset(l.type), Math.min(Math.max(0, at - now), 2 ** 31 - 1))
      timer.unref?.()
      this.limitTimers.set(l.type, { at, timer })
    }
    for (const type of this.notifyReset) {
      if (limits.some((l) => l.type === type && l.status === 'rejected')) continue
      this.notifyReset.delete(type)
      this.o.showNotification?.({ id: `limit-${type}-${now}`, kind: 'system', title: `Your ${LIMIT_NAME[type]} reset`, sub: 'Agents can run again.', needsYou: false, read: false, createdAt: now }, { silent: false })
    }
    const rejected = limits.some((l) => l.status === 'rejected')
    if (rejected && !this.limitCheck) { this.limitCheck = setInterval(() => void this.checkLimits(), LIMIT_RECHECK_MS); this.limitCheck.unref?.() }
    if (!rejected && this.limitCheck) { clearInterval(this.limitCheck); this.limitCheck = undefined }
  }

  private limitReset(type: RateLimit['type']) {
    const held = this.limitTimers.get(type)
    if (held) clearTimeout(held.timer)
    this.limitTimers.delete(type)
    this.sessions.resetLimit(type)
  }

  /**
   * A rejected window can lift without Kernel hearing: its timer fires late after the Mac slept, or the limit is reset
   * on claude.ai. Lift what the clock says has reset, then ask Claude Code for the real numbers. While a limit pauses
   * the rooms and no session is live, a short session asks. Runs every LIMIT_RECHECK_MS while a window is rejected, and when the Mac wakes.
   */
  checkLimits(): Promise<void> {
    this.limitChecking ??= (async () => {
      for (const [type, t] of [...this.limitTimers]) if (t.at <= Date.now()) this.limitReset(type)
      const paused = this.store.rooms().some((r) => r.pausedBy === 'limit')
      await this.sessions.usage({ probeIn: paused ? this.o.dataDir : undefined })
    })().catch(() => undefined).finally(() => { this.limitChecking = undefined })
    return this.limitChecking
  }

  /**
   * Send now in a room a limit paused sends the message anyway. If the limit is real, Claude Code answers with it and
   * the room stays paused; if it lifted, the answer's rate_limit_event lifts it in Kernel too.
   */
  private async sendNow(chatId: string, id: string) {
    const ws = this.mustWs(this.mustChat(chatId).workspaceId)
    // A brief held for a merge goes now, without waiting (KERNEL-259). One held because setup failed still waits for Run again.
    if (ws.status === 'ready' && ws.waitsFor?.held) {
      await this.sessions.sendNow(chatId, id)
      await this.releaseWait(ws.id, { now: true })
      return this.sessions.queued(chatId)
    }
    const room = this.store.room(ws.roomId)
    return this.sessions.sendNow(chatId, id, { pastPause: room?.pausedBy === 'limit' })
  }

  /** Opens Terminal.app in `cwd` and runs `command` there. */
  async openTerminal(cwd: string, command?: string) {
    const r = await exec('osascript', ['-e', terminalScript(cwd, command)], { timeoutMs: 15_000 })
    if (r.code !== 0) throw new Error(`Could not open Terminal: ${r.stderr.trim() || 'osascript failed'}`)
  }

  /** Throws away uncommitted changes, after a checkpoint so they can still come back from the drawer. */
  async discard(workspaceId: string) {
    const ws = this.mustWs(workspaceId)
    if (ws.mode === 'current') throw new Error('Discard is off on the current branch, because it would throw away your own changes too. Revert to a checkpoint instead.')
    const chats = this.store.chats(workspaceId)
    if (chats.some((c) => this.sessions.isRunning(c.id))) throw new Error('The agent is still working. Stop it first, then discard.')
    const chat = chats.find((c) => c.kind !== 'terminal')
    if (chat) await snapshot(ws, { chatId: chat.id, title: 'Before discarding changes' }).then((c) => bus.push({ type: 'checkpoint', checkpoint: c }))
    await discardChanges(ws.path)
    bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId, agentId: ws.agentId, actor: 'you', text: 'discarded the changes in', object: ws.name })
  }

  private async hooksStatus(): Promise<HookStatus> {
    const installed = new Set(await hookStatus(this.claudeSettings).catch(() => [] as string[]))
    return {
      port: this.settings.hookPort,
      listening: !!this.hookServer?.listening,
      installed: KERNEL_HOOK_EVENTS.every((e) => installed.has(e)),
      events: KERNEL_HOOK_EVENTS.map((name) => ({ name, installed: installed.has(name), lastSeen: this.hookSeen.get(name) }))
    }
  }

  async stop() {
    this.stopped = true
    this.unlisten()
    this.notifications.detach()
    this.leadUpdates.detach()
    this.tasks.detach()
    clearInterval(this.prTimer)
    this.network?.stop()
    clearInterval(this.authTimer)
    for (const t of this.limitTimers.values()) clearTimeout(t.timer)
    this.limitTimers.clear()
    clearInterval(this.limitCheck)
    this.limitCheck = undefined
    for (const close of this.agentWatchers.values()) close()
    this.agentWatchers.clear()
    this.sessions.stopAll()
    this.ptys.killAll()
    stopAllScripts()
    await new Promise<void>((r) => (this.hookServer ? this.hookServer.close(() => r()) : r()))
    this.store.db.close()
  }

  // ---------- rooms and agents

  async addRoom(path: string, name?: string): Promise<Room> {
    const existing = this.store.rooms().find((r) => r.path === path)
    if (existing) return existing
    const remote = await this.remoteFor(path)
    const room: Room = { id: newId(), name: name ?? basename(path), path, repo: await remoteRepo(path, remote), defaultBranch: await defaultBranch(path, remote).catch(() => 'main'), paused: false, createdAt: Date.now() }
    this.store.saveRoom(room)
    await this.agents(room.id)
    return room
  }

  // ---------- new rooms

  /**
   * Creates the room's record and returns it at once. The slow part (clone, install, seating agents) runs behind it
   * and reports through `room.setup` push events, which RoomSetup.png draws.
   */
  async createRoom(req: NewRoomRequest): Promise<Room> {
    const name = req.name.trim()
    if (!name) throw new Error('Give the room a name.')
    let path: string
    if (req.source === 'folder') {
      path = expandHome(req.from, this.home)
      const info = await inspectFolder(path, this.home)
      if (!info.git && !req.initGit) throw new Error(`${tildify(path, this.home)} is not a git repository. Initialize git to use it.`)
    } else {
      path = expandHome(req.cloneTo ?? join(this.home, 'Projects', slugify(req.source === 'repo' ? basename(req.from) : name)), this.home)
      await assertFreeFolder(path, this.home)
    }
    const taken = this.store.rooms().find((r) => r.path === path)
    if (taken) throw new Error(`${tildify(path, this.home)} is already the room ${taken.name}.`)
    const room: Room = {
      id: newId(), name, desc: req.desc?.trim() || undefined, kind: req.source, path,
      repo: req.source === 'repo' ? req.from : undefined, defaultBranch: req.baseBranch || 'main', paused: false, createdAt: Date.now()
    }
    this.store.saveRoom(room)
    bus.push({ type: 'room', room })
    void this.setupRoom(room, req).catch(() => undefined)
    return room
  }

  /** The six steps of RoomSetup.png. A failed step records its error and the next ones still run, except when there is no checkout. */
  private async setupRoom(room: Room, req: NewRoomRequest) {
    const worktrees = join(this.settings.worktreeRoot, slugify(room.name))
    const steps: RoomSetupStep[] = [
      { id: 'clone', title: req.source === 'repo' ? `Clone ${req.from}` : req.source === 'scratch' ? `Copy ${req.from}` : 'Use your folder', detail: tildify(room.path, this.home), state: 'wait' },
      { id: 'worktrees', title: 'Create the worktree folder', detail: tildify(worktrees, this.home), state: 'wait' },
      { id: 'install', title: 'Install dependencies', detail: 'Checking the lockfile', state: 'wait' },
      { id: 'copy', title: 'Copy local files', detail: '', state: 'wait' },
      { id: 'hooks', title: 'Install hooks', detail: `${KERNEL_HOOK_EVENTS.length} events to localhost:${this.settings.hookPort}`, state: 'wait' },
      { id: 'agents', title: 'Seat agents', detail: '', state: 'wait' }
    ]
    const publish = () => bus.push({ type: 'room.setup', roomId: room.id, steps: steps.map((s) => ({ ...s })) })
    const update = (id: RoomSetupStep['id'], patch: Partial<RoomSetupStep>) => { Object.assign(steps.find((s) => s.id === id)!, patch); publish() }
    const step = async (id: RoomSetupStep['id'], fn: () => Promise<Partial<RoomSetupStep> | void>) => {
      const started = Date.now()
      update(id, { state: 'run', meta: 'running', error: undefined })
      try {
        const done = (await fn()) ?? {}
        update(id, { state: 'ok', meta: Date.now() - started >= 1500 ? `${Math.round((Date.now() - started) / 1000)}s` : undefined, ...done })
        return true
      } catch (e) {
        update(id, { state: 'fail', meta: undefined, error: (e as Error).message })
        return false
      }
    }
    publish()

    const checkedOut = await step('clone', async () => {
      if (req.source === 'repo') await cloneRepo(req.from, room.path)
      else if (req.source === 'scratch') await copyTemplate(req.from, room.path)
      else if (req.initGit && !(await inspectFolder(room.path, this.home)).git) await initGit(room.path)
      const remote = await this.remoteFor(room.path)
      const next: Room = { ...room, repo: room.repo ?? (await remoteRepo(room.path, remote)), defaultBranch: req.baseBranch || (await defaultBranch(room.path, remote).catch(() => 'main')) }
      this.store.saveRoom(next)
      bus.push({ type: 'room', room: next })
    })
    if (!checkedOut) return

    await step('worktrees', async () => {
      await mkdir(worktrees, { recursive: true })
      await ensureRepoSettings(room.path)
    })
    await step('install', async () => {
      const { command, reason } = await installCommand(room.path)
      if (!command) return { detail: reason ?? 'Nothing to install' }
      update('install', { detail: command })
      const r = await exec('sh', ['-c', command], { cwd: room.path, timeoutMs: 600_000 })
      if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join('\n') || `${command} failed`)
    })
    await step('copy', async () => {
      const present = (await resolveFilesToCopy(room.path, (await loadRepoSettings(room.path)).files.copy)).map((f) => f.path)
      if (!present.length) return { detail: 'No local files to copy' }
      return { detail: present.length > 5 ? `${present.slice(0, 5).join(', ')} and ${present.length - 5} more` : present.join(', ') }
    })
    await step('hooks', async () => {
      const status = await this.hooksStatus()
      if (!status.installed) throw new Error('Kernel hooks are not in your Claude settings yet. Open Check hooks in the sidebar to install them.')
    })
    await step('agents', async () => {
      let files = await agentFiles(room.path)
      if (!files.length) {
        if (!this.o.starterDir) throw new Error('No starter team found. Add agent files to .claude/agents.')
        await seatStarterTeam(this.o.starterDir, room.path, req.team)
        files = await agentFiles(room.path)
      }
      const list = await this.agents(room.id)
      bus.push({ type: 'agents', roomId: room.id, agents: list })
      for (const a of list) bus.push({ type: 'agent.status', roomId: room.id, agentId: a.id, status: 'idle' })
      return { detail: list.length ? `${list.map((a) => a.name).join(', ')} from .claude/agents` : 'No agents in .claude/agents' }
    })
  }

  /**
   * Pause a room: every agent finishes the step it is on, then waits, and sends are held until Resume.
   * `by` is who asked. A limit pause (`limit`) is lifted by whoever detects the reset, with `resumeRoom`.
   */
  pauseRoom(roomId: string, by: 'you' | 'limit'): Room {
    const room = this.store.saveRoom({ ...this.mustRoom(roomId), paused: true, pausedBy: by })
    this.sessions.pause(roomId)
    // Someone who needs the user, is blocked or is offline keeps saying so.
    const now = this.statusOf(roomId)
    for (const a of this.agentsSync(roomId)) if (!PAUSE_KEEPS.has(now[a.id])) bus.push({ type: 'agent.status', roomId, agentId: a.id, status: 'paused' })
    bus.push({ type: 'room', room })
    bus.activity({ kind: 'room.paused', roomId, actor: by === 'you' ? 'you' : 'kernel', text: by === 'you' ? 'paused' : 'paused the room for', object: by === 'you' ? room.name : 'a usage limit' })
    return room
  }

  resumeRoom(roomId: string, by: 'you' | 'limit' = 'you'): Room {
    const { pausedBy: _by, ...rest } = this.mustRoom(roomId)
    const room = this.store.saveRoom({ ...rest, paused: false })
    const before = this.statusOf(roomId)
    this.sessions.resume(roomId)
    // A running chat in plan mode is planning, as it was before the pause.
    const running = (agentId: string) => this.store.workspaces(roomId).filter((w) => w.agentId === agentId).flatMap((w) => this.store.chats(w.id)).filter((c) => this.sessions.isRunning(c.id))
    const resumed = (agentId: string): AgentStatus => { const r = running(agentId); return !r.length ? 'idle' : r.some((c) => !c.plan) ? 'working' : 'planning' }
    for (const a of this.agentsSync(roomId)) if (before[a.id] === 'paused') bus.push({ type: 'agent.status', roomId, agentId: a.id, status: resumed(a.id) })
    bus.push({ type: 'room', room })
    bus.activity({ kind: 'room.resumed', roomId, actor: by === 'you' ? 'you' : 'kernel', text: by === 'you' ? 'resumed' : 'resumed after the usage limit reset', object: by === 'you' ? room.name : undefined })
    return room
  }

  /** Empty room: write a team into .claude/agents and seat it. Refuses a room that already has agents. */
  async seedAgents(roomId: string, template: TeamTemplate): Promise<AgentDef[]> {
    const room = this.mustRoom(roomId)
    if ((await agentFiles(room.path)).length) throw new Error('This room already has agents.')
    if (template.kind === 'copy') {
      const from = this.mustRoom(template.fromRoomId)
      if (from.id === room.id) throw new Error('Pick a different room to copy from.')
      if (!(await copyAgentFiles(from.path, room.path))) throw new Error(`${from.name} has no agents to copy.`)
    } else {
      if (!this.o.starterDir) throw new Error('No starter team found. Add agent files to .claude/agents.')
      await seatStarterTeam(this.o.starterDir, room.path, template.kind === 'pair' ? ['kai'] : ['kai', 'noor', 'ivy', 'theo'])
    }
    const list = await this.agents(roomId)
    bus.push({ type: 'agents', roomId, agents: list })
    for (const a of list) bus.push({ type: 'agent.status', roomId, agentId: a.id, status: room.paused ? 'paused' : 'idle' })
    return list
  }

  async updateRoom(roomId: string, patch: Partial<Pick<Room, 'name' | 'desc' | 'hidden' | 'archived' | 'desks' | 'allow'>>): Promise<Room> {
    const before = this.mustRoom(roomId)
    // Archiving a room (Settings > Room) stops every agent and archives its open workspaces. The record and the folder stay.
    if (patch.archived && !before.archived) {
      // A workspace that fails to archive keeps the room open, and the error names it, so nothing is half archived without the user knowing.
      const failed: string[] = []
      for (const ws of this.store.workspaces(roomId).filter((w) => w.status !== 'archived')) {
        try { await this.archiveWorkspace(ws.id) } catch (e) { this.sessions.stopWorkspace(ws.id); failed.push(`${ws.name}: ${(e as Error).message}`) }
      }
      if (failed.length) throw new Error(`Could not archive ${failed.length === 1 ? 'a workspace' : `${failed.length} workspaces`}, so ${before.name} stays open. ${failed.join(' ')}`)
    }
    const room = this.store.saveRoom({ ...before, ...patch })
    bus.push({ type: 'room', room })
    return room
  }

  /**
   * Sets the room icon (KERNEL-241). The new file is saved before the room points at it and the old file goes after,
   * so a failed avatar fetch or a rejected image leaves the room as it was.
   */
  async setRoomIcon(roomId: string, icon: KernelApi['rooms.setIcon']['req']['icon']): Promise<Room> {
    const before = this.mustRoom(roomId)
    let next: Room['icon']
    if (icon.kind === 'github') {
      const owner = githubOwner(before.repo)
      if (!owner) throw new Error(AVATAR_FAILED)
      next = await this.roomIcons.save(roomId, 'github', await this.avatar(owner), before.icon)
    } else if (icon.kind === 'image') {
      next = await this.roomIcons.save(roomId, 'image', await readImage(icon.path), before.icon)
    }
    // Read again after the download: the room may have gone, or another change may have landed meanwhile.
    const now = this.store.room(roomId)
    if (!now) { await this.roomIcons.remove(next); throw new Error(`Unknown room ${roomId}`) }
    const { icon: old, ...rest } = now
    const room = this.store.saveRoom(next ? { ...rest, icon: next } : rest)
    if (old?.file !== next?.file) await this.roomIcons.remove(old)
    bus.push({ type: 'room', room })
    return room
  }

  /**
   * Forgets a room: stops its agents and scripts, archives its workspaces and deletes Kernel's record of them.
   * The folder, its git history and .claude/agents are never touched. Worktrees are removed only when asked.
   */
  /**
   * Removes a room (ConfirmRemoveRoom.png): every open workspace is archived for real, with its archive script, its setup
   * stopped and its branch kept when it has unpushed commits, then Kernel forgets the room (D-028). Worktree folders go
   * only when "Also delete the worktrees" is ticked. If a workspace fails to archive, the error names it and the room stays.
   */
  async removeRoom(roomId: string, deleteWorktrees: boolean) {
    const room = this.mustRoom(roomId)
    const failed: string[] = []
    for (const ws of this.store.workspaces(roomId).filter((w) => w.status !== 'archived')) {
      try { await this.archiveWorkspace(ws.id, undefined, { keepWorktree: !deleteWorktrees }) } catch (e) { this.sessions.stopWorkspace(ws.id); failed.push(`${ws.name}: ${(e as Error).message}`) }
    }
    if (failed.length) throw new Error(`Could not archive ${failed.length === 1 ? 'a workspace' : `${failed.length} workspaces`}, so ${room.name} stays. ${failed.join(' ')}`)
    this.overlaps.forget(roomId)
    this.store.deleteRoom(roomId)
    await this.roomIcons.remove(room.icon)
    this.agentWatchers.get(roomId)?.()
    this.agentWatchers.delete(roomId)
    this.agentCache.delete(roomId)
    this.statuses.delete(roomId)
  }

  async agents(roomId: string): Promise<AgentDef[]> {
    const room = this.mustRoom(roomId)
    const list = await loadAgents(room.path)
    this.agentCache.set(roomId, list)
    this.watchTeam(roomId)
    return list
  }

  /** Files in .claude/agents changed from outside Kernel (or from here). Reload, and tell the renderer when the team differs. */
  private watchTeam(roomId: string) {
    if (this.agentWatchers.has(roomId)) return
    const room = this.store.room(roomId)
    if (!room) return
    this.agentWatchers.set(roomId, watchAgents(room.path, () => {
      void (async () => {
        if (!this.store.room(roomId)) return
        const was = this.agentCache.get(roomId)
        const before = JSON.stringify(was)
        const list = await this.agents(roomId)
        if (JSON.stringify(list) !== before) this.announceTeam(roomId, list, was)
      })().catch(() => undefined)
    }))
  }

  /** `was` is the team before the change: whoever is new walks in. Leave it out to announce no one. */
  private announceTeam(roomId: string, list: AgentDef[], was?: AgentDef[]) {
    const had = new Set((was ?? list).map((a) => a.id))
    const room = this.mustRoom(roomId)
    const known = this.statuses.get(roomId) ?? {}
    bus.push({ type: 'agents', roomId, agents: list })
    for (const a of list) {
      if (known[a.id]) continue
      bus.push({ type: 'agent.status', roomId, agentId: a.id, status: room.paused ? 'paused' : 'idle' })
      // A new agent file, from hire_agent, New agent or a file added outside Kernel, walks in from the door (FloorHired.png).
      if (!a.retired && !had.has(a.id)) bus.activity({ kind: 'agent.joined', roomId, agentId: a.id, text: 'joined from', object: a.file })
    }
  }

  /** AgentProfile > Save changes. Rewrites the file and reloads the room's team, so the next turn uses the new model, effort and tools. */
  async saveAgentEdit(roomId: string, agentId: string, patch: AgentEdit): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    const saved = await updateAgent(room.path, agentId, patch)
    this.announceTeam(roomId, await this.agents(roomId))
    return saved
  }

  /** New agent > Create agent. The file joins .claude/agents and the agent takes a desk (the next free one, or the end of `room.desks`). */
  async hireFromDraft(roomId: string, draft: AgentDraft): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    const was = this.agentCache.get(roomId) ?? await this.agents(roomId)
    const def = await createAgent(room.path, draft)
    if (room.desks && !room.desks.includes(def.id)) await this.updateRoom(roomId, { desks: [...room.desks, def.id] })
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list, was)
    return list.find((a) => a.id === def.id) ?? def
  }

  /**
   * Retire: the file moves to .claude/retired-agents (D-003), open workspaces go to `handoffTo` or the Lead, and the desk frees up.
   * A turn already running keeps its own copy of the agent and finishes. The Lead cannot be retired, because nobody would plan.
   */
  async retire(roomId: string, agentId: string, handoffTo?: string): Promise<void> {
    const room = this.mustRoom(roomId)
    const team = await this.agents(roomId)
    const agent = team.find((a) => a.id === agentId)
    if (!agent) throw new Error(`${agentId} is not on this team.`)
    if (agent.lead) throw new Error(`${agent.name} leads this room. Mark another agent with "lead: true" first.`)
    const heir = team.find((a) => a.id === (handoffTo ?? '') && a.id !== agentId) ?? team.find((a) => a.lead)
    await retireAgent(room.path, agentId)
    for (const ws of this.store.workspaces(roomId)) {
      if (ws.agentId === agentId && ws.status !== 'archived' && heir) this.saveWs({ ...ws, agentId: heir.id })
    }
    if (room.desks?.includes(agentId)) await this.updateRoom(roomId, { desks: room.desks.filter((d) => d !== agentId) })
    const statuses = this.statuses.get(roomId)
    if (statuses) delete statuses[agentId]
    const list = await this.agents(roomId)
    bus.push({ type: 'agents', roomId, agents: list })
    bus.activity({ kind: 'agent.retired', roomId, agentId, actor: 'you', text: 'retired', object: agent.name })
  }

  async restore(roomId: string, agentId: string): Promise<AgentDef> {
    const room = this.mustRoom(roomId)
    await restoreAgent(room.path, agentId)
    const list = await this.agents(roomId)
    this.announceTeam(roomId, list)
    const def = list.find((a) => a.id === agentId)
    if (!def) throw new Error(`${agentId} could not be restored.`)
    return def
  }

  private agentsSync(roomId: string) { return this.agentCache.get(roomId) ?? [] }

  statusOf(roomId: string): Record<string, AgentStatus> {
    const s = { ...(this.statuses.get(roomId) ?? {}) }
    for (const a of this.agentsSync(roomId)) s[a.id] ??= this.mustRoom(roomId).paused ? 'paused' : 'idle'
    return s
  }

  // ---------- workspaces

  async createWorkspace(roomId: string, o: { prompt: string; parts?: ChatPart[]; source?: WorkspaceSource; agentId?: string; mode?: WorkspaceMode; baseRef?: string; title?: string; branch?: string; model?: ModelId; effort?: Effort; plan?: boolean; taskFor?: (ws: Workspace) => string | undefined; leadChatId?: string; reviewOf?: string; waitFor?: string[] }): Promise<Workspace> {
    const room = this.mustRoom(roomId)
    const repo = await loadRepoSettings(room.path)
    const s = this.settings
    const agents = await this.agents(roomId)
    const agent = agents.find((a) => a.id === o.agentId) ?? agents.find((a) => a.lead) ?? agents[0]
    if (!agent) throw new Error('This room has no agents. Add one to .claude/agents first.')
    // A review gets its own worktree started from the work it reviews (KERNEL-130).
    // The branch the author is on now, which may not be the one the workspace started on (KERNEL-68).
    const reviewed = o.reviewOf && this.store.workspace(o.reviewOf) ? await this.syncBranch(o.reviewOf) : undefined
    if (o.reviewOf && (!reviewed || reviewed.roomId !== roomId || reviewed.status === 'archived')) throw new Error('The workspace to review is not open in this room.')
    const mode = reviewed ? 'worktree' : o.mode ?? repo.workspace.mode ?? s.workspace.mode
    if (o.waitFor?.length && (mode === 'current' || reviewed)) throw new Error(reviewed ? 'A review never waits for another PR.' : "A workspace on the main checkout can't wait for a PR. Pass mode worktree.")
    const title = o.title ?? o.prompt.split(/\s+/).slice(0, 6).join(' ')
    const remote = await this.remoteFor(room.path, repo)
    // `origin/` in a base from Settings, the Lead or a PR means the room's remote. A branch picked from the list is a real ref.
    const wanted = o.baseRef ?? repo.workspace.baseRef ?? s.workspace.baseRef
    const baseRef = reviewed ? await this.reviewBase(room.path, reviewed.branch, remote)
      : await resolveBaseRef(room.path, o.source?.kind === 'branch' ? wanted : onRemote(wanted, remote), { fetch: mode === 'worktree', strict: o.source?.kind === 'pr' || o.source?.kind === 'branch', remote })
    const taken = new Set(this.store.workspaces().filter((w) => w.status !== 'archived').map((w) => w.port))
    const port = await freePort(4300, taken)

    let path: string, branch: string, baselineRef: string | undefined
    if (mode === 'worktree') {
      // The Lead can name the branch, for a repo that names branches after its issues (KERNEL-68). A taken name gets a suffix.
      if (o.branch && !reviewed && !(await validBranchName(room.path, o.branch))) throw new Error(`${o.branch} is not a valid branch name.`)
      branch = reviewed ? await freeBranch(room.path, `${reviewed.branch}-review`) : await freeBranch(room.path, o.branch || taskBranch(repo.workspace.branchPattern ?? s.workspace.branchPattern, o.source?.kind === 'issue' ? o.source.title : title, o.source?.kind === 'issue' ? o.source.id : undefined))
      path = await createWorktree({ repo: room.path, root: join(s.worktreeRoot, slugify(room.name)), branch, baseRef })
      await copyLocalFiles(room.path, path, repo.files.copy)
      if (repo.files.symlinkNodeModules) await linkNodeModules(room.path, path)
    } else {
      if (s.workspace.oneCurrentBranchPerRoom && this.store.workspaces(roomId).some((w) => w.mode === 'current' && w.status !== 'archived' && w.agentId !== agent.id))
        throw new Error('Another workspace is already working on the current branch in this room.')
      path = room.path
      branch = await currentBranch(room.path)
      if (s.workspace.baselineCurrentBranch) baselineRef = (await snapshotBaseline(room.path)).ref
    }

    // The Lead chat goes in the first record, so it's there before the teammate's first turn can end (KERNEL-105).
    const ws: Workspace = { id: newId(), roomId, name: slugify(title), branch, baseRef, path, mode, agentId: agent.id, port, status: 'setup', baselineRef, source: o.source, title, leadChatId: o.leadChatId, ...(reviewed ? { reviewOf: reviewed.id } : {}), ...(o.waitFor?.length ? { waitsFor: { on: o.waitFor, held: true } } : {}), prState: 'none', createdAt: Date.now() }
    this.store.saveWorkspace(ws)
    // Until its brief has gone out, the Lead's messages to it wait here (KERNEL-118).
    this.setSetup(ws.id, { later: [] })
    bus.push({ type: 'workspace', workspace: ws })
    bus.activity({ kind: 'workspace.created', roomId, workspaceId: ws.id, agentId: agent.id, text: 'started', object: ws.name })
    // A Linear issue goes to In Progress. A GitHub issue ("#41") is left to GitHub.
    if (o.source?.kind === 'issue' && o.source.id && !o.source.id.startsWith('#')) void this.startIssue(ws, o.source.id)
    // Rowan's hand-off: the board task this workspace builds moves to Building now, not when the turn ends.
    const taskId = o.taskFor?.(ws)
    if (taskId) { ws.taskId = taskId; this.saveWs(ws) }

    const chat = this.newChat(ws.id, title, { model: o.model ?? this.modelFor(agent), effort: o.effort ?? agent.effort ?? s.models.effort, plan: o.plan ?? (agent.lead && s.models.leadPlanMode) })
    const parts = messageOf(o.prompt, o.parts)
    // A brief from the Lead's hand-off is the Lead's message in the teammate's chat, not the user's (KERNEL-116).
    const from = o.leadChatId ? 'lead' as const : undefined
    this.setSetup(ws.id, { ...this.setups.get(ws.id), chatId: chat.id, brief: parts, ...(from ? { from } : {}), later: this.setups.get(ws.id)?.later ?? [] })
    let ready: boolean
    try { ready = await this.runSetup(ws, room, repo.scripts.setup) } catch (e) { this.setSetup(ws.id, undefined); throw e }
    // Archived while setup ran: archive stopped the script, and the workspace stays archived.
    if (this.mustWs(ws.id).status === 'archived') { this.setSetup(ws.id, undefined); return this.mustWs(ws.id) }
    // The Lead's messages sent before the brief went out follow it, never go before it (KERNEL-118). Messages that
    // arrive while the brief is sent are still caught here, and the mark goes only once the list is empty.
    const after = async (send: (m: ChatPart[]) => Promise<unknown> | void) => {
      for (let held = this.setups.get(ws.id); held?.later.length; held = this.setups.get(ws.id)) { const m = held.later.shift()!; this.saveSetups(); await send(m) }
      this.setSetup(ws.id, undefined)
    }
    // The first prompt waits in the chat's queue until setup passes (WorkspaceSetupFailed.png, "Run again").
    if (!ready) {
      this.sessions.hold(chat.id, parts, { from })
      await after((m) => this.sessions.hold(chat.id, m, { from: 'lead' }))
      const failed = this.updateWs(ws.id, { status: 'failed' })
      // The Lead's create_workspace says so in its result while the Lead's turn still waits for it, so this event doesn't
      // wake the Lead a second time (KERNEL-126). A setup that was stopped, by archive or quit, isn't a failure to report.
      const code = this.setupFailures.get(ws.id)
      if (code !== null && failed.status !== 'archived') this.leadUpdates.setup(failed, false, { told: !!o.leadChatId && this.sessions.isRunning(o.leadChatId), code })
      return failed
    }
    // Read again: wait_for_merge may have set or cleared the wait while setup ran (KERNEL-259).
    const wait = this.mustWs(ws.id).waitsFor
    if (wait?.held && wait.on.length) {
      // The brief and the Lead's messages wait in the chat, and only then does the workspace count as ready, so a quit
      // between them finds a ready waiter that Sessions.restore holds again. No checkpoint, run script or turn yet.
      const base = await this.head(ws.path)
      this.sessions.hold(chat.id, parts, { from })
      await after((m) => this.sessions.hold(chat.id, m, { from: 'lead' }))
      const now = this.mustWs(ws.id)
      if (now.status === 'archived') return now
      const held = this.updateWs(ws.id, { status: 'ready', waitsFor: { ...(now.waitsFor ?? wait), held: true, ...(base ? { base } : {}) } })
      const label = this.waitLabelOf(held)
      this.note(ws.id, `Waiting for ${label} to merge. Kernel sends this brief then. Send now starts it sooner.`)
      // The Lead reads it in create_workspace's result while its turn still waits for it (KERNEL-126's pattern).
      this.leadUpdates.waits(held, 'wait.started', { on: held.waitsFor!.on, label, held: true, ...(o.leadChatId && this.sessions.isRunning(o.leadChatId) ? { told: true } : {}) })
      // Something it waits for may have merged while setup ran.
      void this.settleWait(ws.id).catch(() => undefined)
      return held
    }
    return this.setupDone(ws, room, chat, o.prompt, async () => {
      // A wait set while the brief was on its way is now a started teammate's (KERNEL-259).
      const late = this.mustWs(ws.id).waitsFor
      if (late?.held) this.updateWs(ws.id, { waitsFor: { ...late, held: false } })
      await this.sessions.send(chat.id, parts, { from })
      await after((m) => this.sessions.send(chat.id, m, { from: 'lead' }))
    })
  }

  /** Setup passed: the workspace is ready, the run script starts, the start-of-chat checkpoint is taken, and the agent gets its prompt. */
  private async setupDone(ws: Workspace, room: Room, chat: Chat, prompt: string, start: () => Promise<void>) {
    const repo = await loadRepoSettings(room.path)
    if (this.mustWs(ws.id).status === 'archived') return this.mustWs(ws.id)
    // The start of chat: reverting to it undoes everything the agent did. Taken before the workspace counts as ready, so
    // ready and the brief going out happen together: a quit between them would leave a ready workspace whose held brief
    // Kernel no longer restores.
    const start0 = await snapshot(ws, { chatId: chat.id, title: prompt, start: true }).catch(() => undefined)
    const done = this.updateWs(ws.id, { status: 'ready' })
    if (done.status === 'archived') return done
    if (start0) bus.push({ type: 'checkpoint', checkpoint: start0 })
    if (this.settings.scripts.runAfterSetup && repo.scripts.run) void runScript({ workspaceId: ws.id, kind: 'run', script: repo.scripts.run, cwd: ws.path, port: ws.port, root: room.path })
    await start()
    return done
  }

  /** Workspaces whose setup is rerunning, so a second Run again doesn't start it twice. */
  private settingUp = new Set<string>()

  /** "Run again" on a failed setup: rerun the script, and when it passes send the prompt that was waiting. */
  async retrySetup(workspaceId: string): Promise<Workspace> {
    if (this.settingUp.has(workspaceId)) return this.mustWs(workspaceId)
    this.settingUp.add(workspaceId)
    try { return await this.rerunSetup(workspaceId) } finally { this.settingUp.delete(workspaceId) }
  }

  private async rerunSetup(workspaceId: string): Promise<Workspace> {
    const ws = this.mustWs(workspaceId)
    const room = this.mustRoom(ws.roomId)
    const repo = await loadRepoSettings(room.path)
    const chat = this.store.chats(ws.id).find((c) => c.kind !== 'terminal')
    if (repo.scripts.setup) {
      const code = await runScript({ workspaceId: ws.id, kind: 'setup', script: repo.scripts.setup, cwd: ws.path, port: ws.port, root: room.path })
      if (!this.setupPassed(ws, code)) {
        // Run again failed too, and nothing told the Lead (KERNEL-126). A stopped run, by archive or quit, isn't news.
        const now = this.mustWs(workspaceId)
        if (code !== null && now.status !== 'archived') this.leadUpdates.setup(now, false, { code })
        return now
      }
    } else this.setupFailures.delete(ws.id)
    const passed = (w: Workspace) => { const now = this.mustWs(w.id); if (now.status === 'ready') this.leadUpdates.setup(now, true); return now }
    // A brief that waits for a PR stays held: the workspace is ready and keeps waiting (KERNEL-259).
    const wait = this.mustWs(ws.id).waitsFor
    if (wait?.held && chat) {
      if (waitMet(wait, this.store.workspaces(ws.roomId))) {
        this.updateWs(ws.id, { status: 'ready' })
        await this.releaseWait(ws.id)
        return passed(this.mustWs(ws.id))
      }
      const base = await this.head(ws.path)
      const held = this.updateWs(ws.id, { status: 'ready', waitsFor: { ...wait, ...(base ? { base } : {}) } })
      if (held.status === 'ready') this.leadUpdates.setup(held, true, { wait: { on: wait.on, label: this.waitLabelOf(held), held: true } })
      return held
    }
    return passed(await this.startBrief(ws, room, chat))
  }

  /**
   * Sends a held brief (KERNEL-259): reruns setup first when asked, then `setupDone` takes the start checkpoint at HEAD,
   * marks the workspace ready, and releases the chat's queue in the same tick as it clears the wait, so nothing saved
   * shows a waiting workspace whose brief went out. Run again's tail and a released wait share it. A setup that fails
   * here leaves the workspace failed, with no wait, so Run again works as it always has.
   */
  private async startBrief(ws: Workspace, room: Room, chat: Chat | undefined, o: { setup?: boolean; released?: WaitsFor } = {}): Promise<Workspace> {
    const script = o.setup && this.settings.scripts.setupOnCreate ? (await loadRepoSettings(room.path)).scripts.setup : undefined
    if (script) {
      const code = await runScript({ workspaceId: ws.id, kind: 'setup', script, cwd: ws.path, port: ws.port, root: room.path })
      if (!this.setupPassed(ws, code)) {
        const failed = this.updateWs(ws.id, { status: 'failed', waitsFor: undefined })
        if (code !== null && failed.status !== 'archived') this.leadUpdates.setup(failed, false, { code })
        return failed
      }
    }
    // The wait this release ends goes. One set while the brief was on its way stays, for a teammate that has now started.
    const settle = () => {
      const w = this.mustWs(ws.id).waitsFor
      if (w) this.updateWs(ws.id, { waitsFor: o.released && w.on.join() === o.released.on.join() ? undefined : { on: w.on, held: false } })
    }
    if (!chat) { settle(); return this.updateWs(ws.id, { status: 'ready' }) }
    const first = this.sessions.queued(chat.id)[0]?.parts.find((p) => p.type === 'text')
    return this.setupDone(ws, room, chat, first?.type === 'text' ? first.text : ws.title ?? ws.name, async () => { settle(); this.sessions.release(chat.id) })
  }

  private async runSetup(ws: Workspace, room: Room, script?: string): Promise<boolean> {
    if (!script || !this.settings.scripts.setupOnCreate) return true
    const code = await runScript({ workspaceId: ws.id, kind: 'setup', script, cwd: ws.path, port: ws.port, root: room.path })
    return this.setupPassed(ws, code)
  }

  /** The last line of a failed setup log says so, the way the canvas draws it (WorkspaceSetupFailed.png). */
  private setupPassed(ws: Workspace, code: number | null) {
    if (code === 0) { this.setupFailures.delete(ws.id); return true }
    this.setupFailures.set(ws.id, code)
    bus.push({ type: 'script.output', workspaceId: ws.id, kind: 'setup', line: code === null ? 'Setup was stopped' : `Setup failed with exit code ${code}`, stream: 'stderr' })
    return false
  }

  /** One archive per workspace at a time: a second call while one runs waits for it, instead of removing the worktree twice. */
  async archiveWorkspace(id: string, deleteBranch?: boolean, o: { keepWorktree?: boolean } = {}): Promise<void> {
    const running = this.archiving.get(id)
    if (running) return running
    const next = this.archiveNow(id, deleteBranch, o).finally(() => this.archiving.delete(id))
    this.archiving.set(id, next)
    return next
  }

  private async archiveNow(id: string, deleteBranch?: boolean, o: { keepWorktree?: boolean } = {}) {
    this.setupFailures.delete(id)
    // The branch the work is on now: archive deletes it, and restore brings it back.
    const ws = await this.syncBranch(id)
    const room = this.mustRoom(ws.roomId)
    this.sessions.stopWorkspace(id)
    this.ptys.killWorkspace(id, this.store.chats(id).map((c) => c.id))
    stopScript(id, 'run')
    // A setup still running would finish after the archive and report on a workspace that is gone.
    stopScript(id, 'setup')
    const repo = await loadRepoSettings(room.path)
    // A folder deleted outside Kernel has nothing to run the script in, and counts as removed (KERNEL-109).
    const gone = await folderGone(ws.path)
    if (!gone && repo.scripts.archive && this.settings.scripts.archiveOnArchive) await runScript({ workspaceId: id, kind: 'archive', script: repo.scripts.archive, cwd: ws.path, port: ws.port, root: room.path })
    // Commits that never left this machine live only on the branch, so it stays whatever was asked. So does a branch
    // whose commits can't be counted: an unknown count is not zero (KERNEL-70).
    // A kept worktree still has its branch checked out, so the branch stays with it.
    const wanted = ws.mode === 'worktree' && !o.keepWorktree && (deleteBranch ?? this.settings.workspace.deleteBranchOnArchive)
    const unpushed = wanted ? await unpushedCommits(room.path, ws.branch, ws.baseRef, await this.remoteFor(room.path, repo)) : 0
    if (wanted && unpushed === null) bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'kept the branch because its commits could not be counted:', object: ws.branch, warn: true })
    if (ws.mode === 'worktree' && !o.keepWorktree) await removeWorktree(room.path, ws.path, { force: true, deleteBranch: wanted && unpushed === 0 ? ws.branch : undefined })
    // Archiving a waiter ends its wait (KERNEL-259).
    const archived = this.updateWs(id, { status: 'archived', archivedAt: Date.now(), waitsFor: undefined }, { archived: true })
    this.releaseSent.delete(id)
    // Work archived without merging never will, so whoever waits for it is stuck. A closed PR already said so.
    if (archived.prState !== 'merged' && archived.prState !== 'closed') for (const w of this.waitersOn(id)) this.breakWait(w, archived, 'archived')
    // Only once it is archived: an archive that fails keeps the brief for Run again.
    this.sessions.dropHeld(id)
    // Nothing in an archived workspace can still be answered or merged from the inbox (D-137).
    this.approvals.expireWorkspace(id)
    this.notifications.forgetWorkspace(id)
    bus.activity({ kind: 'workspace.archived', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'archived', object: ws.name })
    void this.overlaps.check(ws.roomId).catch(() => undefined)
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
      await restoreWorktree({ repo: room.path, path, branch: ws.branch, remote: await this.remoteFor(room.path, repo) })
      await copyLocalFiles(room.path, path, repo.files.copy)
      if (repo.files.symlinkNodeModules) await linkNodeModules(room.path, path)
    } else if (this.settings.workspace.oneCurrentBranchPerRoom && this.store.workspaces(ws.roomId).some((w) => w.mode === 'current' && w.status !== 'archived' && w.agentId !== ws.agentId)) {
      throw new Error('Another workspace is already working on the current branch in this room.')
    }
    // Another workspace may have taken this port while it was archived.
    const taken = new Set(this.store.workspaces().filter((w) => w.status !== 'archived').map((w) => w.port))
    const port = taken.has(ws.port) ? await freePort(4300, taken) : ws.port
    const back = this.updateWs(id, { archivedAt: undefined, port, status: 'ready' }, { archived: true })
    // A review the user brings back stays, even though the work it reviewed is done (KERNEL-136).
    this.unmarkReviews(id)
    bus.activity({ kind: 'workspace.restored', roomId: ws.roomId, workspaceId: id, agentId: ws.agentId, text: 'restored', object: ws.name })
    return back
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
  async changes(id: string) {
    const ws = this.mustWs(id)
    const files = ws.mode === 'current'
      ? await changedFiles(ws.path, ws.baselineRef ?? 'HEAD')
      : await changedFiles(ws.path, await mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef))
    const stat = { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) }
    const old = this.mustWs(id).stat
    if (!old || old.files !== stat.files || old.added !== stat.added || old.removed !== stat.removed) this.updateWs(id, { stat })
    return files
  }

  /** A plan's file for Open in editor, written again from the approval when it is missing (D-092). */
  async planFile(id: string): Promise<{ path: string; relative: string }> {
    const a = this.store.approvals().find((x) => x.id === id)
    const text = a ? String(a.detail || (a.input as { plan?: unknown } | undefined)?.plan || '') : ''
    if (!a || !text.trim()) throw new Error('This plan has no text to save.')
    const ws = a.workspaceId ? this.store.workspace(a.workspaceId) : undefined
    if (!ws || !(await stat(ws.path).then(() => true, () => false))) throw new Error('Its workspace folder is gone. Copy the plan instead.')
    if (a.planFile && (await planExists(ws.path, a.planFile))) return { path: join(ws.path, a.planFile), relative: a.planFile }
    const relative = await savePlan(ws.path, text, { fallback: a.title, reuse: a.planFile })
    if (relative !== a.planFile) this.approvals.update(a.id, { planFile: relative })
    return { path: join(ws.path, relative), relative }
  }

  /**
   * A plan's change request with images: saves them in the workspace and names their paths in the message (D-134).
   * A plan is ExitPlanMode or the Lead's `request_plan_approval`, the same test as the composer's `isPlanApproval`.
   */
  async withAttachments(id: string, decision: Decision): Promise<Decision> {
    if (decision.behavior !== 'deny' || !decision.images?.length) return decision
    const { images, ...rest } = decision
    const a = this.store.approvals().find((x) => x.id === id)
    if (!a || (a.kind !== 'plan' && a.toolName !== 'ExitPlanMode') || !this.approvals.isPending(id)) return rest
    const ws = a.workspaceId ? this.store.workspace(a.workspaceId) : undefined
    if (!ws || !(await stat(ws.path).then(() => true, () => false))) throw new Error("The workspace folder is gone, so the images can't be saved.")
    return { ...rest, message: attachmentNote(rest.message, await saveAttachments(ws.path, images)) }
  }

  async diff(id: string, file?: string) {
    const ws = this.mustWs(id)
    const since = ws.mode === 'current' ? ws.baselineRef ?? 'HEAD' : await mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef)
    return diffText(ws.path, since, file)
  }

  async hunks(id: string, path?: string) {
    const ws = this.mustWs(id)
    return listHunks(ws.path, { baselineRef: ws.mode === 'current' ? ws.baselineRef : undefined }, path)
  }

  // ---------- checkpoints

  /** Save the worktree after a turn, titled with the prompt that started the turn. */
  async checkpoint(ws: Workspace, chat: Chat) {
    const items = this.store.items(chat.id)
    const user = [...items].reverse().find((i) => i.kind === 'user')
    // A turn Kernel's team update started is titled for what it is, not for the update's first line (KERNEL-116).
    const text = user?.kind !== 'user' ? '' : isKernelUpdate(user) ? 'Team update' : user.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'skill' ? `/${p.name}` : p.name)).join(' ')
    const c = await snapshot(ws, { chatId: chat.id, title: text || chat.title })
    bus.push({ type: 'checkpoint', checkpoint: c })
    return c
  }

  /** Restore a workspace's files to a checkpoint. Later changes go to a backup branch, and the chat gets a note saying so. */
  async revertCheckpoint(workspaceId: string, checkpointId: string): Promise<{ backupBranch: string }> {
    const ws = this.mustWs(workspaceId)
    // Current-branch workspaces share the checkout with the Lead and each other, so any agent working in the same folder blocks a revert.
    const sharing = this.store.workspaces().filter((w) => w.path === ws.path && w.status !== 'archived')
    if (sharing.some((w) => this.store.chats(w.id).some((c) => this.sessions.isRunning(c.id)))) throw new Error('An agent is still working in this workspace. Stop it, then revert.')
    const r = await revertTo(ws, checkpointId)
    bus.push({ type: 'checkpoint', checkpoint: r.checkpoint })
    const time = clock(r.checkpoint.ts)
    const tabs = this.chatTabs(ws.id).filter((c) => c.kind !== 'terminal')
    const chat = tabs.find((c) => c.id === r.checkpoint.chatId) ?? tabs[0]
    const what = r.checkpoint.start ? 'the start of the chat' : `${time}, "${checkpointTitle(r.checkpoint.title)}"`
    if (chat) {
      const item: ChatItem = { kind: 'note', id: newId(), ts: Date.now(), text: `Reverted files to ${what}. Later changes are saved on ${r.backupBranch}.` }
      this.store.saveItem(chat.id, item)
      bus.push({ type: 'chat.item', chatId: chat.id, item })
    }
    bus.activity({ kind: 'checkpoint.reverted', actor: 'you', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: `reverted files to ${time} in`, object: ws.name, data: { backupBranch: r.backupBranch } })
    return { backupBranch: r.backupBranch }
  }

  // ---------- chats

  chatTabs(workspaceId: string): Chat[] { return this.store.chats(workspaceId).filter((c) => !c.closed) }

  private mustChat(chatId: string): Chat {
    const c = this.store.chat(chatId)
    if (!c) throw new Error('That chat no longer exists.')
    return c
  }

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

  private saveChat(chat: Chat): Chat {
    this.store.saveChat(chat)
    bus.push({ type: 'chat', chat })
    return chat
  }

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

  /** Starts the pty for a big terminal chat, or the workspace's plain shell (`shell:<workspaceId>`), the first time it is used. */
  private ensurePty(id: string, size?: { cols: number; rows: number }) {
    if (this.ptys.has(id)) return
    const plain = id.startsWith('shell:')
    const chat = plain ? undefined : this.mustChat(id)
    if (chat && (chat.kind !== 'terminal' || chat.closed)) throw new Error('That tab is not a terminal.')
    const ws = this.mustWs(plain ? id.slice('shell:'.length) : chat!.workspaceId)
    this.ptys.start(id, {
      cwd: ws.path,
      env: sessionEnv(process.env, { KERNEL_PORT: String(ws.port), KERNEL_WORKSPACE_ID: ws.id }, { agentTeams: this.settings.models.agentTeams }),
      command: plain ? undefined : 'claude',
      ...size
    })
  }

  /** A chat opened with a placeholder name ("New chat", the Lead's "Lead") is auto-named. A workspace's title or a fork's is not (KERNEL-202). */
  newChat(workspaceId: string, title: string, o: { model: ModelId; effort: Effort; plan: boolean; kind?: 'chat' | 'terminal' }): Chat {
    const kind = o.kind ?? 'chat'
    const auto = kind === 'chat' && (title === NEW_CHAT || title === LEAD_CHAT)
    return this.store.saveChat({ id: newId(), workspaceId, title, kind, model: o.model, effort: o.effort, plan: o.plan, ...(auto ? { autoTitle: { turns: 0 } } : {}), createdAt: Date.now() })
  }

  private modelFor(agent: AgentDef): ModelId {
    const m = this.settings.models
    if (agent.model?.startsWith('claude-')) return agent.model as ModelId
    const alias = MODELS.find((x) => x.id.split('-')[1] === agent.model?.toLowerCase())
    if (alias) return alias.id
    if (agent.lead) return m.lead
    if (/qa/i.test(agent.role)) return m.qa
    if (/review/i.test(agent.role)) return m.reviewer
    return m.engineers
  }

  /** The Lead lives in a room-level workspace on the main checkout, made the first time it is needed. */
  private async leadWorkspace(roomId: string): Promise<{ ws: Workspace; lead: AgentDef }> {
    const agents = await this.agents(roomId)
    const lead = agents.find((a) => a.lead)
    if (!lead) throw new Error('No lead agent. Mark one agent with "lead: true".')
    let ws = this.store.workspaces(roomId).find((w) => w.agentId === lead.id && w.mode === 'current' && w.status !== 'archived')
    if (!ws) {
      const room = this.mustRoom(roomId)
      ws = this.saveWs({ id: newId(), roomId, name: 'lead', branch: await currentBranch(room.path), baseRef: room.defaultBranch, path: room.path, mode: 'current', agentId: lead.id, port: await freePort(4300), status: 'ready', prState: 'none', createdAt: Date.now() })
    }
    return { ws, lead }
  }

  /** The Lead's first open chat. Floor briefs go there. */
  async leadChat(roomId: string): Promise<Chat> {
    const { ws, lead } = await this.leadWorkspace(roomId)
    return this.chatTabs(ws.id).find((c) => c.kind !== 'terminal') ?? this.newChat(ws.id, LEAD_CHAT, { model: this.modelFor(lead), effort: lead.effort ?? this.settings.models.effort, plan: this.settings.models.leadPlanMode })
  }

  /**
   * A message to the Lead in a chat of its own (KERNEL-148). It always adds a tab, like the tab row's +: an unused tab may
   * hold a draft the engine can't see, since the composer keeps it (D-133, KERNEL-242). The first message names the chat.
   */
  async startLeadChat(roomId: string, o: { prompt: string; parts?: ChatPart[]; model?: ModelId; effort?: Effort; plan?: boolean }): Promise<Chat> {
    const { ws, lead } = await this.leadWorkspace(roomId)
    const pick = { model: o.model ?? this.modelFor(lead), effort: o.effort ?? lead.effort ?? this.settings.models.effort, plan: o.plan ?? this.settings.models.leadPlanMode }
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
        // The issue the task builds (D-140). Linear's branch name unless the Lead named one.
        const linked = issue ? await this.issueSource(issue, o.title ?? firstLine(o.prompt)) : undefined
        const branch = o.branch || linked?.branchName
        // A review is not a task of the plan, so it takes no plan step or Board task (KERNEL-130).
        const ws = await this.createWorkspace(roomId, { ...o, ...(linked ? { source: linked.source } : {}), ...(branch ? { branch } : {}), mode: o.mode, leadChatId: chat.id, taskFor: o.reviewOf ? undefined : (w) => this.tasks.link(roomId, o.agentId, w.id, { approvalIds })?.id })
        if (!o.reviewOf) this.linkPlanStep(roomId, o.agentId, ws.id, chat.id)
        if (ws.status !== 'failed') return ws
        const code = this.setupFailures.get(ws.id)
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
      isRunning: (id) => this.working(id),
      // The sidebar's check before a one-click archive. A current-branch workspace removes no files, and neither does a
      // worktree whose folder is already gone (KERNEL-109).
      unsaved: (id) => this.unsavedOf(id),
      planApproved: () => this.sessions.handoffs.approved(chat.id),
      handedOff: () => this.sessions.handoffs.done(chat.id),
      hireAgent: async (a) => {
        const was = this.agentCache.get(roomId) ?? await this.agents(roomId)
        const file = await saveAgent(this.mustRoom(roomId).path, a)
        this.announceTeam(roomId, await this.agents(roomId), was)
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
    const held = this.setups.get(ws.id)
    if (held) { held.later.push(parts); this.saveSetups(); return { ok: true, sent: false, note: `${name}'s workspace is still setting up, so the message waits behind the brief.` } }
    let chat = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
    const opened = !chat
    if (!chat) chat = this.saveChat(this.newChat(ws.id, NEW_CHAT, { model: agent ? this.modelFor(agent) : this.settings.models.engineers, effort: agent?.effort ?? this.settings.models.effort, plan: false }))
    const { queued, why } = await this.sessions.send(chat.id, parts, { from: 'lead' })
    if (!queued) return { ok: true, sent: true, note: opened ? `Opened a new chat in ${name}'s workspace and sent it.` : 'Sent.' }
    const waiting = this.store.workspace(ws.id)
    const note = why === 'running' ? `${name} is mid-turn, so the message goes out when that turn ends.`
      : why === 'setup' && waiting?.status === 'ready' && waiting.waitsFor?.held ? `${name} waits for ${this.waitLabelOf(waiting)} to merge, so this goes out after the brief. To start ${name} now, call wait_for_merge with an empty list.`
      : why === 'setup' ? (this.settingUp.has(ws.id) ? `${name}'s workspace is setting up again, so the message waits behind the brief.` : `Setup failed in ${name}'s workspace, so the message waits until the user clicks Run again.`)
      : why === 'paused' ? 'The room is paused, so the message goes out when the user resumes it.'
      : why === 'offline' ? 'Kernel is offline or signed out, so the message goes out once it is back.'
      : why === 'capacity' ? 'Every agent slot in Settings, Models is in use, so the message goes out when one frees up.'
      : 'The message waits in the queue.'
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

  /** The GitHub calls behind the PR methods. Tests swap it for a stub. */
  github: GitHub = gh
  /** Workspaces whose merge Kernel is running, so the poll doesn't overwrite `merging`. */
  private merging = new Set<string>()
  /** The method of a merge Kernel ran, until the PR is seen merged, so the note says how it landed. */
  private mergedWith = new Map<string, AppSettings['pr']['mergeMethod']>()

  /** PR instructions and notes go to the workspace's first chat. */
  private prChat(id: string): Chat | undefined {
    const chats = this.chatTabs(id)
    return chats.find((c) => c.kind !== 'terminal') ?? chats[0]
  }

  /**
   * The sidebar's check before a one-click archive: whether archiving would lose uncommitted work. A current-branch
   * workspace removes no files, and neither does a worktree whose folder is already gone (KERNEL-109).
   */
  private async unsavedOf(id: string): Promise<'dirty' | 'unknown' | false> {
    try {
      const ws = await this.syncBranch(id)
      if (ws.mode !== 'worktree') return false
      if (await folderGone(ws.path)) return false
      return (await gitStatus(ws.path, ws.branch, ws.baseRef, await this.remoteOfWs(ws))).dirty.files ? 'dirty' : false
    } catch { return 'unknown' }
  }

  /**
   * A workspace's agent is working, or has a message waiting to start a turn. One whose setup failed isn't: its held
   * brief waits for the user to click Run again, not for a turn. Nor is one whose brief waits for a merge (KERNEL-259).
   */
  private working(id: string) {
    const ws = this.store.workspace(id)
    if (ws?.status === 'failed' || ws?.waitsFor?.held) return false
    return this.chatTabs(id).some((c) => this.sessions.isRunning(c.id) || this.sessions.queued(c.id).length > 0)
  }

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
    for (const r of reviews) this.markReview(r.id)
    for (const r of reviews) {
      // A review with a turn running, or a message about to start one, goes when that turn ends.
      if (this.working(r.id)) continue
      const keep = (reason: string) => {
        this.unmarkReviews(r.id)
        bus.activity({ kind: 'note', roomId: r.roomId, workspaceId: r.id, agentId: r.agentId, actor: 'kernel', text: 'kept the review workspace', object: r.name, warn: true, quote: `The work it reviewed is done, but it wasn't archived: ${/[.!?…]$/.test(reason) ? reason : reason + '.'}` })
      }
      const why = await archiveSkip(r, { isOwnLead: (w) => this.isLeadWorkspace(w), isRunning: (id) => this.working(id), latestPr: async (w) => w, unsaved: (id) => this.unsavedOf(id) })
      if (why === 'its agent is still working') continue
      if (why) { keep(why); continue }
      // Checked again after the git call: a message may have started a turn meanwhile, the user may have restored it,
      // or another archive got there first.
      if (this.working(r.id) || !this.reviewsToArchive.has(r.id)) continue
      if (this.store.workspace(r.id)?.status === 'archived') { this.unmarkReviews(r.id); continue }
      try { await this.archiveWorkspace(r.id); this.unmarkReviews(r.id) } catch (e) { keep(firstLine(e instanceof Error ? e.message : String(e))) }
    }
  }

  /**
   * At start: the reviews Kernel meant to archive when it quit, as one whose turn was still running, are archived now
   * (KERNEL-131). Work that merged or closed while Kernel was closed reaches `archiveReviews` through the first PR poll,
   * since its saved PR state is still open.
   */
  private async sweepReviews() {
    for (const id of [...this.reviewsToArchive]) {
      const r = this.store.workspace(id)
      if (!r?.reviewOf || r.status === 'archived') { this.unmarkReviews(id); continue }
      await this.archiveReviews(r.reviewOf, id).catch(() => undefined)
    }
  }

  // ---------- waits (KERNEL-259)

  /** The open workspaces that wait for `id`. */
  private waitersOn(id: string) { return this.store.workspaces().filter((w) => w.status !== 'archived' && w.waitsFor?.on.includes(id)) }

  private nameOf(ws: Workspace) { return this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)?.name ?? ws.agentId }

  /** "PR #164 by Noor and PR #170 by Ivy": what the workspace waits for. */
  private waitLabelOf(ws: Workspace) {
    const targets = (ws.waitsFor?.on ?? []).map((id) => this.store.workspace(id)).filter((t): t is Workspace => !!t)
    return joinLabels(targets.map((t) => waitLabel(t, this.nameOf(t)))) || 'another PR'
  }

  private async head(path: string) {
    const r = await exec('git', ['-C', path, 'rev-parse', 'HEAD'])
    return r.code === 0 ? r.stdout.trim() : undefined
  }

  /** A PR merged or closed. Its own wait ends, its waiters whose targets all merged go on, and a close breaks their wait. */
  private async onTargetPr(id: string, state: PrState) {
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
  private breakWait(w: Workspace, target: Workspace, gone: 'closed' | 'archived') {
    if (!w.waitsFor || w.waitsFor.releasing) return
    this.leadUpdates.waits(w, 'wait.broken', { on: w.waitsFor.on, label: waitLabel(target, this.nameOf(target)), held: w.waitsFor.held, target: target.id, gone })
  }

  /** Releases the wait when everything it is on has merged. */
  private async settleWait(id: string) {
    const ws = this.store.workspace(id)
    if (ws?.waitsFor && ws.status !== 'archived' && waitMet(ws.waitsFor, this.store.workspaces(ws.roomId))) await this.releaseWait(id)
  }

  /**
   * At start, once each room's team is read: a merge saved just before a quit never emits again, so its waiters go now,
   * and rebase messages a quit lost go again. A merge made while Kernel was closed reaches them through the first poll.
   */
  private async sweepWaits() {
    for (const r of this.store.rooms()) { if (this.stopped) return; await this.agents(r.id).catch(() => undefined) }
    if (!this.stopped) await this.retryWaits()
  }

  private async retryWaits() {
    for (const ws of this.store.workspaces()) {
      if (this.stopped) return
      if (!ws.waitsFor || ws.status === 'archived') continue
      if (ws.waitsFor.releasing) await this.deliverRelease(ws.id).catch(() => undefined)
      else await this.settleWait(ws.id).catch(() => undefined)
    }
  }

  /** One release per workspace at a time, as with archives. `now` starts a held brief without waiting for the merge. */
  private releaseWait(id: string, o: { now?: boolean } = {}): Promise<void> {
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
      this.leadUpdates.waits(ws, 'wait.released', { on: wait.on, label, held: false })
      await this.deliverRelease(id)
      return
    }
    const room = this.mustRoom(ws.roomId)
    const chat = this.store.chats(id).find((c) => c.kind !== 'terminal' && this.sessions.queued(c.id).length > 0) ?? this.prChat(id)
    const before = await this.head(ws.path)
    // Onto the remote's copy of the base, even when the workspace started from the local branch, which a merge on
    // GitHub doesn't move. Only a fast-forward on a clean tree: anything else is the agent's to rebase.
    const remote = await this.remoteFor(room.path)
    const base = stripRemote(ws.baseRef, remote)
    let forwarded = true
    if (!now && ws.mode === 'worktree') {
      // A failed fetch leaves the remote's copy where it was, and a fast-forward to it would claim a merge it doesn't have.
      const fetched = await exec('git', ['-C', ws.path, 'fetch', '--quiet', remote], { timeoutMs: 30_000 }).then((r) => r.code === 0, () => false)
      forwarded = fetched && await fastForward(ws.path, `${remote}/${base}`)
    }
    const after = await this.head(ws.path)
    // Archived, started or changed while git ran.
    const current = this.mustWs(id)
    if (current.status !== 'ready' || !current.waitsFor?.held) return
    if (!now && !waitMet(current.waitsFor, this.store.workspaces(current.roomId))) return
    if (now) this.note(id, `Started without waiting for ${label}.`)
    else {
      if (!forwarded && chat) this.sessions.hold(chat.id, [{ type: 'text', text: `${label} merged after your branch started. Rebase onto ${remote}/${base} before you build on it.` }], { from: 'kernel' })
      this.note(id, forwarded ? `${label} merged. Your branch now starts from it.` : `${label} merged. Kernel couldn't move your branch onto it, so a message after the brief asks for a rebase.`)
      this.leadUpdates.waits(current, 'wait.released', { on: wait.on, label, held: true })
    }
    // Setup runs again only when the files under it changed.
    await this.startBrief(current, room, chat, { setup: !!after && after !== (wait.base ?? before), released: current.waitsFor })
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
    const remote = await this.remoteOfWs(this.mustWs(id))
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
  private releaseTaken(id: string, chatId: string, by: string) {
    const ws = this.store.workspace(id)
    if (by !== 'kernel' || !ws?.waitsFor?.releasing || !this.releaseSent.has(id) || this.prChat(id)?.id !== chatId) return
    if (this.sessions.queued(chatId).some((q) => q.from === 'kernel')) return
    this.releaseSent.delete(id)
    this.updateWs(id, { waitsFor: undefined })
  }

  /**
   * The Lead's wait_for_merge: `on` replaces what the workspace waits for, with targets that merged already left out.
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
    this.leadUpdates.waits(next, 'wait.started', { on: left, label, held, ...(o.told === false ? {} : { told: true }), ...(o.why ? { why: o.why } : {}) })
    return next
  }

  /** What a teammate's wait_for_merge reads and calls (KERNEL-262). */
  private teammateToolDeps(id: string): TeammateToolDeps {
    return {
      workspace: () => this.mustWs(id),
      workspaces: () => this.store.workspaces(this.mustWs(id).roomId),
      isLead: (w) => this.isLeadWorkspace(w),
      nameOf: (w) => this.nameOf(w),
      setWait: (on, why) => this.setWait(id, on, { told: false, why })
    }
  }

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
    const remote = remoteOf({ workspace: { remote: room && this.roomRemotes.get(room.path) } }, this.settings)
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

  private setSetup(id: string, hold: SetupHold | undefined) {
    if (hold) this.setups.set(id, hold)
    else this.setups.delete(id)
    this.saveSetups()
  }

  private saveSetups() { this.store.saveMeta('setups', Object.fromEntries(this.setups)) }

  /**
   * A workspace still in setup when Kernel quit has no script running any more (KERNEL-128). It counts as failed, with a
   * note saying why, and its brief, and whatever the Lead sent after it, wait in the chat for Run again. So does one whose
   * setup had just passed when Kernel quit, before its brief went out.
   */
  private recoverSetups() {
    const saved = this.store.meta<Record<string, SetupHold>>('setups') ?? {}
    for (const ws of this.store.workspaces()) {
      const hold = saved[ws.id]
      const chat = (hold?.chatId && this.store.chat(hold.chatId)) || this.store.chats(ws.id).find((c) => c.kind !== 'terminal')
      const unsent = ws.status === 'ready' && !!hold?.brief && !!chat && !this.store.items(chat.id).some((i) => i.kind === 'user')
      if (ws.status !== 'setup' && !unsent) continue
      if (chat && hold?.brief) this.sessions.hold(chat.id, hold.brief, hold.from ? { from: hold.from } : {})
      if (chat) for (const m of hold?.later ?? []) this.sessions.hold(chat.id, m, { from: 'lead' })
      this.updateWs(ws.id, { status: 'failed' })
      this.note(ws.id, 'Setup stopped when Kernel quit. Click Run again.')
    }
    this.setups.clear()
    this.saveSetups()
  }

  private note(workspaceId: string, text: string) {
    const chat = this.prChat(workspaceId)
    if (!chat) return
    const item: ChatItem = { kind: 'note', id: newId(), ts: Date.now(), text }
    this.store.saveItem(chat.id, item)
    bus.push({ type: 'chat.item', chatId: chat.id, item })
  }

  private setPrState(ws: Workspace, prState: PrState) {
    const before = this.mustWs(ws.id).prState
    const next = this.updateWs(ws.id, { prState })
    if (next.prState !== before) bus.push({ type: 'pr', workspaceId: ws.id, state: prState })
    return next
  }

  /**
   * The git remote a room fetches from and pushes to: the room's, then the app's, then origin (`remoteOf`, KERNEL-190).
   * Pass `repo` when the room's settings are already loaded.
   */
  private async remoteFor(path: string, repo?: RepoSettings): Promise<string> {
    const r = repo ?? await loadRepoSettings(path)
    this.roomRemotes.set(path, r.workspace.remote)
    return remoteOf(r, this.settings)
  }

  private remoteOfWs(ws: Workspace) { return this.remoteFor(this.mustRoom(ws.roomId).path) }

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
    const info = await this.github.info(ws.path, ws.branch, id, { remote: await this.remoteOfWs(ws) })
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
    const info = await this.github.info(ws.path, ws.branch, id, { remote: await this.remoteOfWs(ws) })
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
    const remote = await this.remoteOfWs(asked)
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
      if (text) this.note(id, text)
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
      const info = await this.github.info(ws.path, ws.branch, id, { remote: await this.remoteOfWs(ws) })
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
   * Follows the branch a worktree workspace is really on. An agent may switch or create branches in its worktree, often
   * to use the issue's branch name, and PRs, merge, push, archive and restore must use the branch the work is on
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
    const remote = await this.remoteFor(room.path)
    if (ws.baseRef.startsWith(`${remote}/`)) await exec('git', ['-C', ws.path, 'fetch', '--quiet', remote], { timeoutMs: 30000 })
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

  /** Diff totals for every live workspace, once at launch, so the sidebar has them before any turn ends. */
  private async countChanges() {
    for (const ws of this.store.workspaces()) if (ws.status !== 'archived' && ws.status !== 'setup') await this.changes(ws.id).catch(() => undefined)
  }

  private async pollPrs() {
    for (const ws of this.store.workspaces()) if (ws.status !== 'archived' && !['none', 'merged', 'closed'].includes(ws.prState)) await this.refreshPr(ws.id).catch(() => undefined)
    // Updates held for a busy or paused Lead go out once it can take them.
    this.leadUpdates.flushAll()
    // A rebase message that couldn't go out, or a release that failed, tries again (KERNEL-259). After the flush, since a
    // release can fetch and rerun setup.
    await this.retryWaits()
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

  private resolveCwd(cwd: string) {
    const ws = this.store.workspaces().filter((w) => w.status !== 'archived').sort((a, b) => b.path.length - a.path.length).find((w) => cwd === w.path || cwd.startsWith(w.path + '/'))
    if (ws) return { roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId }
    const room = this.store.rooms().find((r) => cwd === r.path || cwd.startsWith(r.path + '/'))
    return room ? { roomId: room.id } : {}
  }

  private saveWs(ws: Workspace) { this.store.saveWorkspace(ws); bus.push({ type: 'workspace', workspace: ws }); return ws }

  /**
   * Saves a change to the workspace as it is in the store now, never a copy read before an await, which would put back
   * whatever changed meanwhile (KERNEL-70). An archived workspace only changes through archive and restore, so a slow
   * PR refresh or setup that finishes late leaves it archived. A key set to undefined is dropped when it is stored.
   */
  private updateWs(id: string, patch: Partial<Workspace>, o: { archived?: boolean } = {}): Workspace {
    const cur = this.mustWs(id)
    if (cur.status === 'archived' && !o.archived) return cur
    return this.saveWs({ ...cur, ...patch })
  }
  /** The Linear token every Linear call uses: the one saved in Settings > Integrations, else LINEAR_API_KEY. */
  private async linearKey() { return (await storedLinearToken(this.o.dataDir)) ?? linearToken() }
  private get linearFetch(): typeof fetch { return this.o.fetch ?? fetch }

  /**
   * A workspace started on a Linear issue: move the issue to In Progress (D-140). Nobody waits for it, and a failure is
   * one note in the log, never a failed workspace. Without a token there is nothing to do.
   */
  private async startIssue(ws: Workspace, key: string) {
    try {
      const token = await this.linearKey()
      if (token) await moveToStarted(token, key, this.linearFetch)
    } catch (e) {
      bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: `could not move ${key} to In Progress in Linear:`, object: (e as Error).message, warn: true })
    }
  }

  /** create_workspace's `issue`: the source to save and Linear's branch name, or the task title when Linear doesn't answer. */
  private async issueSource(key: string, title: string): Promise<{ source: WorkspaceSource; branchName?: string }> {
    if (key.startsWith('#')) return { source: { kind: 'issue', id: key, title } }
    try {
      const issue = await getIssue(await this.linearKey(), key, this.linearFetch)
      return { source: { kind: 'issue', id: issue.id, title: issue.title, url: issue.url }, branchName: issue.branchName }
    } catch { return { source: { kind: 'issue', id: key, title } } }
  }

  private mustRoom(id: string) { const r = this.store.room(id); if (!r) throw new Error(`Unknown room ${id}`); return r }
  private mustWs(id: string) { const w = this.store.workspace(id); if (!w) throw new Error(`Unknown workspace ${id}`); return w }
  private isLeadWorkspace(ws: Workspace) { return ws.mode === 'current' && !!this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)?.lead }

  /** Every IPC channel, in one map. The preload exposes these to the renderer as window.kernel.invoke. */
  handlers(): Handlers {
    return {
      ...unbuilt(),
      'update.get': async () => this.o.updater?.get() ?? { status: 'idle', current: this.o.version ?? '0.0.0' },
      'update.check': async () => this.o.updater?.check() ?? { status: 'idle', current: this.o.version ?? '0.0.0' },
      'update.install': async () => { if (!this.o.updater) throw new Error('No update to install'); this.o.updater.install(); return { ok: true } },
      'preflight.run': async () => this.preflight(),
      'preflight.fix': async ({ id }) => {
        // Through setSettings, so it is saved and applied like the Models page toggle.
        if (id === 'teams') await this.setSettings({ models: { agentTeams: true } })
        else if (id === 'hooks') await this.restartHooks(await nextFreePort(this.settings.hookPort + 1))
        return this.preflight()
      },
      'hooks.status': async () => this.hooksStatus(),
      'hooks.restart': async ({ port }) => this.restartHooks(port ?? this.settings.hookPort),
      'hooks.test': async () => {
        // /health answers from the same server that receives hooks, and records nothing.
        const res = await fetch(`http://127.0.0.1:${this.settings.hookPort}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
        if (!res?.ok) throw new Error(`No reply from the hook server on port ${this.settings.hookPort}.`)
        return this.hooksStatus()
      },
      'hooks.uninstall': async () => { await uninstallHooks(this.claudeSettings); return this.pushHooks() },
      'hooks.install': async ({ port }) => ({ path: this.claudeSettings, events: await installHooks(this.claudeSettings, port, this.settings.permissions.approvalTimeoutSec) }),
      'rooms.list': async () => this.store.rooms(),
      'rooms.add': async ({ path, name }) => this.addRoom(path, name),
      'rooms.create': async (req) => this.createRoom(req),
      'rooms.update': async ({ roomId, patch }) => this.updateRoom(roomId, patch),
      'rooms.setIcon': async ({ roomId, icon }) => this.setRoomIcon(roomId, icon),
      'rooms.icon': async ({ roomId }) => this.roomIcons.dataUrl(this.mustRoom(roomId).icon),
      'rooms.remove': async ({ roomId, deleteWorktrees }) => { await this.removeRoom(roomId, deleteWorktrees); return { ok: true } },
      'rooms.inspectFolder': async ({ path }) => inspectFolder(path, this.home),
      'rooms.recentFolders': async () => recentFolders(this.store.rooms().map((r) => r.path), this.home),
      'github.repos': async ({ query }) => listRepos(query),
      'rooms.setPaused': async ({ roomId, paused }) => (paused ? this.pauseRoom(roomId, 'you') : this.resumeRoom(roomId)),
      'agents.seed': async ({ roomId, template }) => this.seedAgents(roomId, template),
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
      'agents.list': async ({ roomId, retired }) => (retired ? loadAgents(this.mustRoom(roomId).path, { retired: true }) : this.agents(roomId)),
      'agents.save': async ({ roomId, agentId, patch }) => this.saveAgentEdit(roomId, agentId, patch),
      'agents.draft': async ({ description, name, model }) => draftAgent({ description, name, model }),
      'agents.create': async ({ roomId, draft }) => this.hireFromDraft(roomId, draft),
      'agents.retire': async ({ roomId, agentId, handoffTo }) => { await this.retire(roomId, agentId, handoffTo); return { ok: true } },
      'agents.restore': async ({ roomId, agentId }) => this.restore(roomId, agentId),
      'agents.status': async ({ roomId }) => this.statusOf(roomId),
      'git.branches': async ({ roomId }) => { const { path } = this.mustRoom(roomId); return listBranches(path, await this.remoteFor(path)) },
      'github.prs': async ({ roomId, query }) => openPrs(this.mustRoom(roomId).path, query),
      'github.issues': async ({ roomId, query }) => openIssues(this.mustRoom(roomId).path, query),
      'issues.list': async ({ query }) => searchIssues(await this.linearKey(), query, this.linearFetch),
      'linear.issues': async ({ filter }) => listIssues(await this.linearKey(), filter, this.linearFetch),
      'linear.issue': async ({ id }) => getIssue(await this.linearKey(), id, this.linearFetch),
      'linear.scope': async () => getScope(await this.linearKey(), this.linearFetch),
      'linear.plan': async ({ id, roomId }) => {
        const issue = await getIssue(await this.linearKey(), id, this.linearFetch)
        const chat = await this.startLeadChat(roomId, { prompt: '', parts: planParts(issue), plan: true })
        return { chatId: chat.id, workspaceId: chat.workspaceId }
      },
      'workspaces.list': async ({ roomId }) => this.store.workspaces(roomId),
      // Workspaces you start yourself follow "Start new workspaces in plan mode". The Lead's hand-offs call createWorkspace directly (KERNEL-74).
      'workspaces.create': async ({ roomId, ...o }) => this.createWorkspace(roomId, { ...o, plan: o.plan ?? this.settings.models.workspacePlanMode }),
      'workspaces.restore': async ({ workspaceId }) => this.restoreWorkspace(workspaceId),
      'lead.ask': async ({ roomId, text }) => this.askLead(roomId, text),
      'lead.open': async ({ roomId }) => this.mustWs((await this.leadChat(roomId)).workspaceId),
      'lead.start': async ({ roomId, ...o }) => this.startLeadChat(roomId, o),
      'account.get': async () => this.readAccount(),
      'account.signOut': async () => signOut(),
      'workspaces.archive': async ({ workspaceId, deleteBranch, push }) => {
        if (push) { const ws = await this.syncBranch(workspaceId); await pushBranch(ws.path, ws.branch, await this.remoteOfWs(ws)) }
        await this.archiveWorkspace(workspaceId, deleteBranch)
        return { ok: true }
      },
      'workspaces.gitStatus': async ({ workspaceId }) => { const ws = await this.syncBranch(workspaceId); return gitStatus(ws.path, ws.branch, ws.baseRef, await this.remoteOfWs(ws)) },
      'workspaces.discard': async ({ workspaceId }) => { await this.discard(workspaceId); return { ok: true } },
      'chats.compact': async ({ chatId }) => { await this.sessions.compact(chatId); return { ok: true } },
      'usage.notifyOnReset': async ({ type }) => {
        if (!this.limitTimers.has(type)) throw new Error('Kernel does not know when this limit resets, so it cannot tell you. Check /usage.')
        this.notifyReset.add(type)
        return { ok: true }
      },
      'account.signIn': async () => this.signIn(),
      'app.openTerminal': async ({ cwd, command }) => { await this.openTerminal(cwd, command); return { ok: true } },
      'app.checkOnline': async () => ({ online: this.network ? await this.network.check() : true }),
      'workspaces.changes': async ({ workspaceId }) => this.changes(workspaceId),
      'workspaces.diff': async ({ workspaceId, file }) => this.diff(workspaceId, file),
      'workspaces.tree': async ({ workspaceId }) => listTree(this.mustWs(workspaceId).path, await this.changes(workspaceId).catch(() => [])),
      'workspaces.readFile': async ({ workspaceId, path }) => readWorkspaceFile(this.mustWs(workspaceId).path, path),
      'chats.list': async ({ workspaceId }) => this.chatTabs(workspaceId),
      'chats.rename': async ({ chatId, title }) => this.renameChat(chatId, title),
      'chats.close': async ({ chatId }) => { this.closeChat(chatId); return { ok: true } },
      'chats.fork': async ({ chatId, itemId }) => this.forkChat(chatId, itemId),
      'terminal.write': async ({ chatId, data }) => { this.ensurePty(chatId); this.ptys.write(chatId, data); return { ok: true } },
      'terminal.resize': async ({ chatId, cols, rows }) => { this.ensurePty(chatId, { cols, rows }); this.ptys.resize(chatId, cols, rows); return { ok: true } },
      'chats.create': async ({ workspaceId, kind }) => {
        // Right after a restart nothing may have read the team yet, and the agent's effort is the fallback.
        const { roomId } = this.mustWs(workspaceId)
        if (!this.agentCache.has(roomId)) await this.agents(roomId)
        const model = this.store.chats(workspaceId)[0]?.model ?? this.settings.models.engineers
        return this.newChat(workspaceId, kind === 'terminal' ? 'Terminal (claude)' : NEW_CHAT, { model, effort: this.openedEffort(workspaceId, model), plan: false, kind })
      },
      'chats.items': async ({ chatId }) => this.store.items(chatId),
      'checkpoints.list': async ({ workspaceId }) => listCheckpoints(this.mustWs(workspaceId)),
      'checkpoints.revert': async ({ workspaceId, checkpointId }) => this.revertCheckpoint(workspaceId, checkpointId),
      'workspaces.files': async ({ workspaceId, query, limit }) => searchFiles(this.mustWs(workspaceId).path, query, limit),
      'workspaces.hunks': async ({ workspaceId, path }) => this.hunks(workspaceId, path),
      'workspaces.commit': async ({ workspaceId, hunkIds, message }) => {
        const picked = (await this.hunks(workspaceId)).filter((h) => hunkIds.includes(h.id))
        if (picked.length !== hunkIds.length) throw new Error('Those changes moved on. Open the card again and pick again.')
        await commitHunks(this.mustWs(workspaceId).path, picked, message?.trim() || `Update ${[...new Set(picked.map((h) => h.path))].join(', ')}`)
        return { ok: true }
      },
      'skills.list': async ({ roomId }) => {
        const off = (await loadRepoSettings(this.mustRoom(roomId).path)).disabled?.skills ?? []
        return (await discoverSkills(this.mustRoom(roomId).path, this.home)).map((s) => ({ ...s, enabled: !off.includes(s.name) }))
      },
      'commands.list': async () => this.sessions.commands(this.home),
      'chats.queue': async ({ chatId }) => this.sessions.queued(chatId),
      'chats.queueReason': async ({ chatId }) => this.sessions.queueReason(chatId) ?? null,
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
      'notifications.list': async () => this.notifications.list(),
      'notifications.read': async ({ ids }) => this.notifications.read(ids),
      'approvals.list': async ({ roomId }) => this.store.approvals({ roomId }),
      'approvals.decide': async ({ id, decision }) => { const a = this.approvals.decide(id, await this.withAttachments(id, decision)); if (!a) throw new Error('This request already timed out or was answered.'); return a },
      'approvals.planFile': async ({ id }) => this.planFile(id),
      'pr.create': async ({ workspaceId, draft }) => this.createPr(workspaceId, draft),
      'pr.refresh': async ({ workspaceId }) => this.refreshPr(workspaceId),
      'pr.merge': async ({ workspaceId }) => this.mergePr(workspaceId),
      'pr.resolve': async ({ workspaceId }) => { await this.resolvePr(workspaceId); return { ok: true } },
      'pr.get': async ({ workspaceId }) => this.getPr(workspaceId),
      'pr.continue': async ({ workspaceId }) => this.continuePr(workspaceId),
      'pr.ready': async ({ workspaceId }) => this.readyPr(workspaceId),
      'pr.reopen': async ({ workspaceId }) => this.reopenPr(workspaceId),
      'scripts.run': async ({ workspaceId, kind }) => {
        const ws = this.mustWs(workspaceId); const room = this.mustRoom(ws.roomId); const repo = await loadRepoSettings(room.path)
        const script = repo.scripts[kind]
        if (!script) throw new Error(`No ${kind} script in .kernel/settings.toml`)
        if (kind === 'setup' && ws.status === 'failed') { void this.retrySetup(workspaceId).catch(() => undefined); return { ok: true } }
        void runScript({ workspaceId, kind, script, cwd: ws.path, port: ws.port, root: room.path })
        return { ok: true }
      },
      'scripts.stop': async ({ workspaceId }) => { stopScript(workspaceId, 'run'); return { ok: true } },
      'tasks.list': async ({ roomId }) => this.tasks.list(roomId),
      'activity.recent': async ({ roomId, limit }) => this.store.activity(roomId, limit),
      'rooms.lastActivity': async ({ roomId }) => this.store.lastActivity(roomId),
      'usage.get': async () => this.sessions.usage(),
      'settings.get': async () => this.settings,
      'settings.set': async ({ patch }) => this.setSettings(patch),
      'app.info': async () => ({ version: this.o.version ?? '0.1.0', dataDir: this.o.dataDir }),
      'app.exportLogs': async () => this.exportLogs(),
      'settings.room': async ({ roomId }) => loadRepoSettings(this.mustRoom(roomId).path),
      'settings.setRoom': async ({ roomId, patch, shared }) => {
        const { path } = this.mustRoom(roomId)
        const next = await saveRepoSettings(path, patch, shared)
        this.roomRemotes.set(path, next.workspace.remote)
        return next
      },
      'files.preview': async ({ roomId, patterns }) => {
        const { path } = this.mustRoom(roomId)
        return resolveFilesToCopy(path, patterns ?? (await loadRepoSettings(path)).files.copy)
      },
      'mcp.list': async ({ roomId }) => {
        const room = roomId ? this.mustRoom(roomId) : undefined
        const off = room ? (await loadRepoSettings(room.path)).disabled?.mcp ?? [] : []
        return discoverMcp(room?.path ?? this.home, this.home, off)
      },
      'integrations.list': async () => this.integrations(),
      'integrations.connect': async ({ id, token }) => {
        if (id === 'linear') {
          const clean = (token ?? '').trim()
          if (clean) await searchIssues(clean, '', this.linearFetch)
          await saveLinearToken(this.o.dataDir, clean)
        } else if (id === 'github') throw new Error('GitHub signs in through the GitHub CLI. Run gh auth login in a terminal.')
        else throw new Error(`${id === 'vercel' ? 'Vercel' : 'Remote Control'} is not available yet.`)
        return (await this.integrations()).find((i) => i.id === id)!
      }
    }
  }

  private async integrations() {
    const [ghUser, linear] = await Promise.all([ghUserName().catch(() => null), this.linearKey()])
    return integrationRows({ ghUser, linear: !!linear })
  }

  private async preflight() {
    await this.o.refreshPath?.()
    return runPreflight({ hookPort: this.settings.hookPort, hookServerUp: !!this.hookServer?.listening, agentTeams: this.settings.models.agentTeams })
  }

  private get claudeSettings() { return this.o.claudeSettingsFile ?? join(this.home, '.claude', 'settings.json') }
}
