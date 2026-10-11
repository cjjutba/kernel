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

// What Kernel hands the services it builds, and its listeners on the shared bus (KERNEL-324). Members still private to
// Kernel are read with `k['name']` until their feature moves out of kernel.ts.

export function taskDeps(k: Kernel): ConstructorParameters<typeof Tasks>[0] {
  return { store: k.store, agents: (roomId) => k['agentsSync'](roomId) }
}

export function notificationDeps(k: Kernel): ConstructorParameters<typeof Notifications>[0] {
  return {
    store: k.store,
    settings: () => k.settings,
    agentName: (roomId, agentId) => (roomId ? k['agentsSync'](roomId).find((a) => a.id === agentId)?.name : undefined),
    show: k.o.showNotification,
    inBackground: k.o.inBackground
  }
}

export function leadUpdateDeps(k: Kernel): LeadUpdateDeps {
  return {
    store: k.store,
    enabled: () => k.settings.models.leadUpdates !== false,
    target: (roomId, owner) => k['leadUpdateTarget'](roomId, owner),
    isLead: (ws) => !!k['agentsSync'](ws.roomId).find((a) => a.id === ws.agentId)?.lead,
    agentName: (roomId, agentId) => k['agentsSync'](roomId).find((a) => a.id === agentId)?.name,
    post: (chatId, text, update) => k.sessions.post(chatId, [{ type: 'text', text }], { update }),
    reviewState: (ws) => k['reviewState'](ws),
    // The team's reviewer is asked to look at a PR that passed checks (KERNEL-121). Retired agents are off the team.
    reviewer: (roomId) => k['agentsSync'](roomId).find((a) => !a.lead && !a.retired && /\breview/i.test(a.role)),
    // A note, not a brief: a brief would restart the floor's briefing sequence (as sortOverlap does). The floor reads
    // `leadUpdate` to keep the Lead's next turn from replaying the hand-off walk.
    delivered: (roomId, chat, update) => {
      const ws = k.store.workspace(chat.workspaceId)
      const [one] = update.rows
      const object = update.rows.length > 1 ? `${update.rows.length} teammates` : one.prNumber ? `${one.name}'s PR #${one.prNumber}` : `${one.name}'s work`
      bus.activity({ kind: 'note', roomId, workspaceId: chat.workspaceId, agentId: ws?.agentId, text: 'heard from Kernel about', object, data: { leadUpdate: true } })
    }
  }
}

export function overlapDeps(k: Kernel): OverlapDeps {
  return {
    workspaces: (roomId) => k.store.workspaces(roomId),
    since: async (ws) => (ws.mode === 'current' ? ws.baselineRef ?? 'HEAD' : mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef)),
    leadId: (roomId) => k['agentsSync'](roomId).find((a) => a.lead)?.id,
    saved: k.store
  }
}

/**
 * Kernel's listeners on the shared bus. A push event goes through one listener that reacts in a fixed order, so a feature's
 * reaction goes in `onPush`, not in a listener of its own. Returns what removes them: a stopped kernel has a closed
 * database, so it leaves the bus, and a second kernel in the same process doesn't write to it.
 */
export function listen(k: Kernel): () => void {
  const onActivity = (e: Parameters<Store['saveActivity']>[0]) => k.store.saveActivity(e)
  const onHook = (e: { hook_event_name: string }, ctx?: { roomId?: string; agentId?: string }) => k.hooks.onHook(e, ctx)
  const onPush = (e: PushEvent) => {
    // Script lines only go out as pushes, so Kernel keeps them for a window that loads later (KERNEL-340).
    keepScript(e)
    // A turn waiting on an approval or a question is still running, so its agent still counts as working.
    // No database read here: the count looks the chats up when the quit asks for it.
    if (e.type === 'chat.running') {
      if (e.running) k['runningChats'].add(e.chatId)
      else k['runningChats'].delete(e.chatId)
    }
    if (e.type === 'agent.status') k.team.onStatus(e)
    // The work merged, so the loop guard starts over for it and its reviews (KERNEL-125). Ready does too, in refreshPr.
    if (e.type === 'pr' && e.state === 'merged') k['nudges'].reset(e.workspaceId, ...k['reviewsOf'](e.workspaceId))
    // Its reviews are done once the work merged or closed (KERNEL-131). A PR opened again keeps them.
    const reviews = e.type === 'pr' && (e.state === 'merged' || e.state === 'closed') ? k['archiveReviews'](e.workspaceId).catch(() => undefined) : undefined
    if (e.type === 'pr' && !reviews) k['unmarkReviews'](...k['reviewsOf'](e.workspaceId), e.workspaceId)
    // A merge releases the workspaces that wait for it, and a close breaks their wait (KERNEL-259). Here, not in
    // LeadUpdates, which drops events while Lead updates are off. The reviews and the waits run together, and the work
    // itself is archived once both are done (KERNEL-114).
    if (e.type === 'pr') {
      const waits = k['onTargetPr'](e.workspaceId, e.state).catch(() => undefined)
      if (e.state === 'merged') void Promise.all([reviews, waits]).then(() => k['archiveMerged'](e.workspaceId)).catch(() => undefined)
    }
  }
  bus.on('activity', onActivity).on('hook', onHook).on('push', onPush)
  return () => { bus.off('activity', onActivity).off('hook', onHook).off('push', onPush) }
}
