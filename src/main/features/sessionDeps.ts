import type { Kernel } from '../kernel'
import type { SessionDeps } from '../services/sessions'
import { disabledInRoom } from '../services/settings'

/**
 * What Sessions calls back into Kernel for (KERNEL-324). A new reaction to a finished turn goes in `onTurnDone`, where the
 * order matters: the Lead hears about a turn only after Kernel has read the PR it may have opened.
 */
export function sessionDeps(k: Kernel): SessionDeps {
  return {
    store: k.store,
    approvals: k.approvals,
    settings: () => k.settings,
    agentFor: (ws) => k.team.agentsSync(ws.roomId).find((a) => a.id === ws.agentId),
    mcpFor: (ws, agent, chat) => k.tools.mcpFor(ws, agent, chat),
    disabledFor: (ws) => { const room = k.store.room(ws.roomId); return room ? disabledInRoom(room.path) : undefined },
    rulesFor: (ws, agent) => k.tools.rulesFor(ws, agent),
    roomAllow: (roomId) => k.store.room(roomId)?.allow ?? [],
    envFor: (ws) => k.env.envFor(ws),
    allowInRoom: (roomId, rule) => {
      const room = k.store.room(roomId)
      if (room && !room.allow?.includes(rule)) k.store.saveRoom({ ...room, allow: [...(room.allow ?? []), rule] })
    },
    onReply: (ws, chat) => void k.chats.nameChat(ws, chat),
    onReset: (_ws, chat, trigger) => k.chats.resetName(chat, trigger),
    onTurnDone: (ws, chat, turn) => {
      void k.checkpoints.checkpoint(ws, chat).catch(() => undefined)
      void k.chats.nameChat(ws, chat, true)
      const lead = !!k.team.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)?.lead
      const done = { ...turn, lead, queued: k.sessions.queued(chat.id).length > 0 }
      k.notifications.turnDone(ws, chat, done)
      // The Lead never opens a PR of its own, so there is nothing to refresh. A teammate's
      // update waits until Kernel has read its PR, so a PR the turn opened speaks for the turn however long GitHub takes.
      const teammate = !k.team.isLeadWorkspace(ws)
      if (teammate) k.leadUpdates.readingPr(ws.id)
      k.leadUpdates.turnDone(ws, chat, done)
      // A workspace that was still working when its work merged, or the work it reviewed merged or closed, goes now (KERNEL-114, KERNEL-131).
      if (k.autoArchive.reviewsToArchive.has(ws.id)) void k.autoArchive.archiveMarked(ws.id).catch(() => undefined)
      void k.workspaces.changes(ws.id).catch(() => undefined)
      if (teammate) void k.refreshPr(ws.id).catch(() => undefined).then(() => k.leadUpdates.readPr(ws.id)).catch(() => undefined)
      void k.overlaps.check(ws.roomId).catch(() => undefined)
      k.waits.releaseTaken(ws.id, chat.id, turn.by)
      // A sync skipped while a Lead turn ran happens once the last one ends. It does nothing while another runs (KERNEL-181).
      if (!teammate) void k.lead.syncLead(ws.roomId)
    },
    onFailure: (failure) => {
      if (failure === 'auth') k.account.signedOut()
      else if (failure === 'network') void k.account.network?.check()
    },
    // A teammate whose session died mid-turn would look busy forever. Kernel tells the Lead that handed the work off (KERNEL-124).
    onExit: (ws, _chat, reason, midTurn, resumed) => {
      if (midTurn) k.leadUpdates.crashed(k.store.workspace(ws.id) ?? ws, reason, { resumed })
      // A workspace waiting to be archived whose session died has no turn end coming to archive it (KERNEL-131).
      if (k.autoArchive.reviewsToArchive.has(ws.id)) void k.autoArchive.archiveMarked(ws.id).catch(() => undefined)
    },
    onLimits: (limits) => k.account.applyLimits(limits),
    onCutOff: (chatIds) => k.store.saveMeta('cutOff', chatIds),
    onHeld: (held) => k.store.saveMeta('held', held)
  }
}
