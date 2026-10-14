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
import type { SettingsError } from '../services/settings'

// What Kernel hands the services it builds, and its listeners on the shared bus (KERNEL-324).

export function taskDeps(k: Kernel): ConstructorParameters<typeof Tasks>[0] {
  return { store: k.store, agents: (roomId) => k.team.agentsSync(roomId) }
}

export function notificationDeps(k: Kernel): ConstructorParameters<typeof Notifications>[0] {
  return {
    store: k.store,
    settings: () => k.settings,
    agentName: (roomId, agentId) => (roomId && agentId ? k.team.agentOf(roomId, agentId)?.name : undefined),
    show: k.o.showNotification,
    inBackground: k.o.inBackground
  }
}

export function leadUpdateDeps(k: Kernel): LeadUpdateDeps {
  return {
    store: k.store,
    enabled: () => k.settings.models.leadUpdates !== false,
    target: (roomId, owner) => k.lead.leadUpdateTarget(roomId, owner),
    // With no Lead tab open, an update that needs the Lead opens one rather than being dropped (KERNEL-365).
    open: (roomId, owner) => k.lead.openUpdateTab(roomId, owner),
    isLead: (ws) => !!k.team.agentOf(ws.roomId, ws.agentId)?.lead,
    agentName: (roomId, agentId) => k.team.agentOf(roomId, agentId)?.name,
    post: (chatId, text, update) => k.sessions.post(chatId, [{ type: 'text', text }], { update }),
    holdOf: (chatId) => k.sessions.postHold(chatId),
    reviewState: (ws) => k.reviews.reviewState(ws),
    // The team's reviewer, for usage data and for telling its old workspaces from reviews (KERNEL-121, KERNEL-397).
    reviewer: (roomId) => k.team.reviewerOf(roomId),
    autoReview: () => k.settings.pr.autoReview !== false,
    // Logged as a note. `leadUpdate` marked it for the briefing sequence KERNEL-606 removed, and nothing reads it now.
    delivered: (roomId, chat, update) => {
      const ws = k.store.workspace(chat.workspaceId)
      const [one] = update.rows
      const object = update.rows.length > 1 ? `${update.rows.length} teammates` : one.prNumber ? `${one.name}'s PR #${one.prNumber}` : `${one.name}'s work`
      bus.activity({ kind: 'note', roomId, workspaceId: chat.workspaceId, agentId: ws?.agentId, text: 'heard from Kernel about', object, data: { leadUpdate: true } })
    },
    // Delivery timings reach Kernel's log, so Help, Copy diagnostics shows why an update was late. The log hears warnings
    // through the console already (KERNEL-651).
    log: k.o.log && ((level, line) => { console[level](line); if (level === 'info') k.o.log?.info(line) })
  }
}

export function overlapDeps(k: Kernel): OverlapDeps {
  return {
    workspaces: (roomId) => k.store.workspaces(roomId),
    since: async (ws) => (ws.mode === 'current' ? ws.baselineRef ?? 'HEAD' : mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef)),
    leadId: (roomId) => k.team.agentsSync(roomId).find((a) => a.lead)?.id,
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
  const onHook = (e: { hook_event_name: string }, ctx?: { roomId?: string; agentId?: string }) => k.hooks.onHook(e, ctx)
  const onPush = (e: PushEvent) => {
    // Script lines only go out as pushes, so Kernel keeps them for a window that loads later (KERNEL-340).
    keepScript(e)
    if (e.type === 'chat.running') k.chats.onRunning(e)
    // A chat that stopped running, or whose queue emptied, may take a Team update now, and a turn's end frees a slot for the
    // others. The update goes then, not at the next PR poll (KERNEL-637).
    if ((e.type === 'chat.running' && !e.running) || (e.type === 'chat.queue' && !e.queue.length)) k.leadUpdates.chatFreed()
    if (e.type === 'agent.status') k.team.onStatus(e)
    // An archived room's settings files aren't watched (KERNEL-723).
    if (e.type === 'room' && e.room.archived) k.config.unwatchRoom(e.room.id)
    // Someone signed in or out: Claude says so with `account`, Codex and account switches with `accounts`, so the next
    // team read checks pinned models again (KERNEL-634).
    if (e.type === 'account' || e.type === 'accounts') k.team.forgetOffers()
    // A held brief waits for setup or for a merge by its workspace's state, so its queue's reason follows the workspace (KERNEL-361).
    if (e.type === 'workspace') k.sessions.pushReasons()
    // A PR every review approved may merge by itself, once the user turned auto-merge on (KERNEL-556). A workspace push carries
    // each verdict, each kept approval and each change of GitHub's block, so it is the one place that sees them all.
    if (e.type === 'workspace') k.prs.considerAutoMerge(e.workspace)
    // The work merged, so the loop guard starts over for it and its reviews (KERNEL-125). Ready does too, in refreshPr.
    if (e.type === 'pr' && e.state === 'merged') k.nudges.reset(e.workspaceId, ...k.autoArchive.reviewsOf(e.workspaceId))
    // Main moved, so each Lead chat's worktree follows it once the room fetches, once for them all (KERNEL-181, KERNEL-405).
    const merged = e.type === 'pr' && e.state === 'merged' ? k.store.workspace(e.workspaceId)?.roomId : undefined
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
  // A room's settings file that stopped parsing warns in the room (KERNEL-231).
  const onSettingsError = (e: SettingsError) => k.config.settingsError(e)
  bus.on('activity', onActivity).on('hook', onHook).on('push', onPush).on('settingsError', onSettingsError)
  return () => {
    bus.off('activity', onActivity).off('hook', onHook).off('push', onPush).off('settingsError', onSettingsError)
    // The rooms' settings watchers push too, so they stop with the rest (KERNEL-723).
    k.config?.stopWatching()
  }
}
