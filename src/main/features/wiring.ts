import type { AnyHook } from '@shared/hookSchemas'
import type { PushEvent } from '@shared/ipc'
import type { Kernel } from '../kernel'
import type { Store } from '../db'
import { bus } from '../bus'
import type { Tasks } from '../services/tasks'
import type { Notifications } from '../services/notifications'
import type { LeadUpdateDeps } from '../services/leadUpdates'
import type { OverlapDeps } from '../services/overlap'
import { mergeBase } from '../services/worktrees'
import { keepScript } from '../services/scripts'
import type { HookContext } from '../services/hookServer'
import type { SettingsError } from '../services/settings'
import { updateRow } from './records'

// What Kernel hands the services it builds, and its listeners on the shared bus (KERNEL-324).

export function taskDeps(k: Kernel): ConstructorParameters<typeof Tasks>[0] {
  return { store: k.store, agents: (projectId) => k.team.agentsSync(projectId) }
}

export function notificationDeps(k: Kernel): ConstructorParameters<typeof Notifications>[0] {
  return {
    store: k.store,
    settings: () => k.settings,
    agentName: (projectId, agentId) => (projectId && agentId ? k.team.agentOf(projectId, agentId)?.name : undefined),
    show: k.o.showNotification,
    inBackground: k.o.inBackground
  }
}

export function leadUpdateDeps(k: Kernel): LeadUpdateDeps {
  return {
    store: k.store,
    enabled: () => k.settings.models.leadUpdates !== false,
    target: (projectId, owner) => k.lead.leadUpdateTarget(projectId, owner),
    // With no Lead tab open, an update that needs the Lead opens one rather than being dropped (KERNEL-365).
    open: (projectId, owner) => k.lead.openUpdateTab(projectId, owner),
    isLead: (ws) => !!k.team.agentOf(ws.projectId, ws.agentId)?.lead,
    // A chat with Kernel's PR reports to that chat (KERNEL-778).
    ownChat: (ws) => k.lead.buildTab(ws),
    agentName: (projectId, agentId) => k.team.agentOf(projectId, agentId)?.name,
    post: (chatId, text, update) => k.sessions.post(chatId, [{ type: 'text', text }], { update }),
    holdOf: (chatId) => k.sessions.postHold(chatId),
    reviewState: (ws) => k.reviews.reviewState(ws),
    // The team's reviewer, for usage data and for telling its old workspaces from reviews (KERNEL-121, KERNEL-397).
    reviewer: (projectId) => k.team.reviewerOf(projectId),
    autoReview: () => k.settings.pr.autoReview !== false,
    // Logged as a note. `leadUpdate` marked it for the briefing sequence KERNEL-606 removed, and nothing reads it now.
    delivered: (projectId, chat, update) => {
      const ws = k.store.workspace(chat.workspaceId)
      const [one] = update.rows
      const object = update.rows.length > 1 ? `${update.rows.length} teammates` : one.prNumber ? `${one.name}'s PR #${one.prNumber}` : `${one.name}'s work`
      bus.activity({ kind: 'note', projectId, workspaceId: chat.workspaceId, agentId: ws?.agentId, text: 'heard from Kernel about', object, data: { leadUpdate: true } })
    },
    // A review of the chat's own PR is a row in its transcript, with no turn (KERNEL-990).
    row: (chatId, update) => updateRow(k.store, chatId, update),
    opened: (chat, rows) => k.openItems.delivered(chat, rows),
    // Delivery timings reach Kernel's log, so Help, Copy diagnostics shows why an update was late. The log hears warnings
    // through the console already (KERNEL-651).
    log: k.o.log && ((level, line) => { console[level](line); if (level === 'info') k.o.log?.info(line) })
  }
}

export function overlapDeps(k: Kernel): OverlapDeps {
  return {
    workspaces: (projectId) => k.store.workspaces(projectId),
    since: async (ws) => (ws.mode === 'current' ? ws.baselineRef ?? 'HEAD' : mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef)),
    leadId: (projectId) => k.team.agentsSync(projectId).find((a) => a.lead)?.id,
    saved: k.store
  }
}

/**
 * Kernel's listeners on the shared bus. A push event goes through one listener that reacts in a fixed order, so a feature's
 * reaction goes here, calling the feature, not in a listener of its own. Returns what removes them: a stopped kernel has a closed
 * database, so it leaves the bus, and a second kernel in the same process doesn't write to it.
 */
export function listen(k: Kernel): () => void {
  const onActivity = (e: Parameters<Store['saveActivity']>[0]) => k.store.saveActivity(e)
  const onHook = (e: AnyHook, ctx?: HookContext) => k.hooks.onHook(e, ctx)
  const onPush = (e: PushEvent) => {
    // Script lines only go out as pushes, so Kernel keeps them for a window that loads later (KERNEL-340).
    keepScript(e)
    if (e.type === 'chat.running') k.chats.onRunning(e)
    // A chat whose working copy waits for a turn to end makes it now (KERNEL-1053).
    if (e.type === 'chat.running' && !e.running) k.lead.turnEnded(e.chatId)
    // A chat that stopped running, or whose queue emptied, may take a Team update now, and a turn's end frees a slot for the
    // others. The update goes then, not at the next PR poll (KERNEL-637).
    if ((e.type === 'chat.running' && !e.running) || (e.type === 'chat.queue' && !e.queue.length)) k.leadUpdates.chatFreed()
    // The evidence against each criterion follows the PR's checks, reviews and head (KERNEL-1065).
    if (e.type === 'pr.info') k.evidence.onPrInfo(e.info)
    if (e.type === 'workspace') k.evidence.onWorkspace(e.workspace)
    if (e.type === 'agent.status') k.team.onStatus(e)
    // An archived project's settings files aren't watched (KERNEL-723).
    if (e.type === 'project' && e.project.archived) k.config.unwatchProject(e.project.id)
    // Someone signed in or out: Claude says so with `account`, Codex and account switches with `accounts`, so the next
    // team read checks pinned models again (KERNEL-634).
    if (e.type === 'account' || e.type === 'accounts') k.team.forgetOffers()
    // A held brief waits for its workspace or for a merge by its workspace's state, so its queue's reason follows the workspace (KERNEL-361).
    if (e.type === 'workspace') k.sessions.pushReasons()
    // A PR every review approved may merge by itself, once the user turned auto-merge on (KERNEL-556). A workspace push carries
    // each verdict, each kept approval and each change of GitHub's block, so it is the one place that sees them all.
    if (e.type === 'workspace') k.prs.considerAutoMerge(e.workspace)
    // The work merged, so the loop guard starts over for it and its reviews (KERNEL-125). Ready does too, in refreshPr.
    if (e.type === 'pr' && e.state === 'merged') k.nudges.reset(e.workspaceId, ...k.autoArchive.reviewsOf(e.workspaceId))
    // Main moved, so each Lead chat's worktree follows it once the project fetches, once for them all (KERNEL-181, KERNEL-405).
    const merged = e.type === 'pr' && e.state === 'merged' ? k.store.workspace(e.workspaceId)?.projectId : undefined
    if (merged) void k.lead.syncLead(merged, { fetch: true })
    if (e.type === 'pr' && e.state === 'merged') bus.track({ name: 'pr.merged' })
    // A PR that passed checks gets the reviews its base branch's `[review]` asks for, started by Kernel (KERNEL-549).
    if (e.type === 'pr' && e.state === 'ready') void k.reviews.onReady(e.workspaceId).catch(() => undefined)
    // Its reviews are done once the work merged or closed (KERNEL-131). A PR opened again keeps them.
    const reviews = e.type === 'pr' && (e.state === 'merged' || e.state === 'closed') ? k.autoArchive.archiveReviews(e.workspaceId).catch(() => undefined) : undefined
    if (e.type === 'pr' && !reviews) k.autoArchive.unmarkReviews(...k.autoArchive.reviewsOf(e.workspaceId), e.workspaceId)
    // A merge releases the workspaces that wait for it, and a close breaks their wait (KERNEL-259). Here, not in
    // LeadUpdates, which drops events while Lead updates are off. The reviews and the waits run together, and the work
    // itself is archived once both are done (KERNEL-114).
    if (e.type === 'pr') {
      const waits = k.waits.onTargetPr(e.workspaceId, e.state).catch(() => undefined)
      if (e.state === 'merged') void Promise.all([reviews, waits]).then(() => k.autoArchive.archiveMerged(e.workspaceId)).catch(() => undefined)
    }
  }
  // A project's settings file that stopped parsing warns in the project (KERNEL-231).
  const onSettingsError = (e: SettingsError) => k.config.settingsError(e)
  bus.on('activity', onActivity).on('hook', onHook).on('push', onPush).on('settingsError', onSettingsError)
  return () => {
    bus.off('activity', onActivity).off('hook', onHook).off('push', onPush).off('settingsError', onSettingsError)
    // The projects' settings watchers push too, so they stop with the rest (KERNEL-723).
    k.config?.stopWatching()
  }
}

/** How long after launch every account's MCP servers are first checked (KERNEL-936). */
export const MCP_LAUNCH_CHECK_MS = 5_000

/**
 * What the app runs once `start()` resolves: a few seconds in, every account's MCP servers are checked in the background, so
 * Settings, MCP servers opens warm (KERNEL-936). Not in `listen`, which runs in the constructor, before settings load. Only
 * with `checkMcp`.
 */
export function started(k: Kernel) {
  if (!k.o.checkMcp) return
  setTimeout(() => { if (!k.stopped) void k.mcp.checkEvery().catch(() => undefined) }, MCP_LAUNCH_CHECK_MS).unref()
}

/**
 * The Mac woke. Timers ran late by however long it slept, so a usage limit that reset meanwhile is checked and the PRs are
 * read again, as when the window comes back from another app (KERNEL-388). A sign-in to an MCP server may have expired
 * meanwhile, so every account's servers are checked again (KERNEL-936).
 */
export function woke(k: Kernel): Promise<void> {
  k.prs.pollSoon()
  if (k.o.checkMcp) void k.mcp.checkEvery().catch(() => undefined)
  return k.account.checkLimits()
}
