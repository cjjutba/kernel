import type { Kernel } from '../kernel'
import type { SessionDeps } from '../services/sessions'
import { kernelServer } from '../services/kernelServer'
import { LEAD_INSTRUCTIONS } from '../services/kernelMcp'
import { reviewMcpServer } from '../services/reviewMcp'
import { teammateMcpServer } from '../services/teammateMcp'
import { LEAD_SHARING_RULE, TEAMMATE_RULE } from '../services/handoff'
import { disabledInRoom } from '../services/settings'

/**
 * What Sessions calls back into Kernel for (KERNEL-324). A new reaction to a finished turn goes in `onTurnDone`, where the
 * order matters: the Lead hears about a turn only after Kernel has read the PR it may have opened. Members still private
 * to Kernel are read with `k['name']` until their feature moves out of kernel.ts.
 */
export function sessionDeps(k: Kernel): SessionDeps {
  return {
    store: k.store,
    approvals: k.approvals,
    settings: () => k.settings,
    agentFor: (ws) => k['agentsSync'](ws.roomId).find((a) => a.id === ws.agentId),
    // With sharing on, every agent's server adds share_file (KERNEL-302). Off, each gets exactly the server it had before.
    mcpFor: (ws, agent, chat) => (k['sharing'] ? { kernel: kernelServer(k.toolsFor(ws, agent, chat), agent?.lead ? LEAD_INSTRUCTIONS : undefined) }
      : agent?.lead ? { kernel: k['leadTools'](ws.roomId, agent, chat) }
      : ws.reviewOf ? { kernel: reviewMcpServer({ submit: (review) => k.submitReview(ws.id, review) }) }
      : { kernel: teammateMcpServer(k['teammateToolDeps'](ws.id)) }),
    disabledFor: (ws) => { const room = k.store.room(ws.roomId); return room ? disabledInRoom(room.path) : undefined },
    // The Lead's rule is LEAD_RULE, which agentPrompt adds itself. Sharing adds a line after it, only while on (KERNEL-302).
    rulesFor: (ws, agent) => (agent?.lead ? (k['sharing'] ? LEAD_SHARING_RULE : undefined) : ws.reviewOf ? k['reviewRuleFor'](ws) : TEAMMATE_RULE),
    roomAllow: (roomId) => k.store.room(roomId)?.allow ?? [],
    envFor: (ws) => k.envFor(ws),
    allowInRoom: (roomId, rule) => {
      const room = k.store.room(roomId)
      if (room && !room.allow?.includes(rule)) k.store.saveRoom({ ...room, allow: [...(room.allow ?? []), rule] })
    },
    onReply: (ws, chat) => void k['nameChat'](ws, chat),
    onReset: (_ws, chat, trigger) => k['resetName'](chat, trigger),
    onTurnDone: (ws, chat, turn) => {
      void k.checkpoint(ws, chat).catch(() => undefined)
      void k['nameChat'](ws, chat, true)
      const lead = !!k['agentsSync'](ws.roomId).find((a) => a.id === ws.agentId)?.lead
      const done = { ...turn, lead, queued: k.sessions.queued(chat.id).length > 0 }
      k.notifications.turnDone(ws, chat, done)
      // The Lead works on the main checkout and never opens a PR of its own, so there is nothing to refresh. A teammate's
      // update waits until Kernel has read its PR, so a PR the turn opened speaks for the turn however long GitHub takes.
      const teammate = !k['isLeadWorkspace'](ws)
      if (teammate) k.leadUpdates.readingPr(ws.id)
      k.leadUpdates.turnDone(ws, chat, done)
      // A workspace that was still working when its work merged, or the work it reviewed merged or closed, goes now (KERNEL-114, KERNEL-131).
      if (k['reviewsToArchive'].has(ws.id)) void k['archiveMarked'](ws.id).catch(() => undefined)
      void k.changes(ws.id).catch(() => undefined)
      if (teammate) void k.refreshPr(ws.id).catch(() => undefined).then(() => k.leadUpdates.readPr(ws.id)).catch(() => undefined)
      void k.overlaps.check(ws.roomId).catch(() => undefined)
      k['releaseTaken'](ws.id, chat.id, turn.by)
    },
    onFailure: (failure) => {
      if (failure === 'auth') k['signedOut']()
      else if (failure === 'network') void k['network']?.check()
    },
    // A teammate whose session died mid-turn would look busy forever. Kernel tells the Lead that handed the work off (KERNEL-124).
    onExit: (ws, _chat, reason, midTurn, resumed) => {
      if (midTurn) k.leadUpdates.crashed(k.store.workspace(ws.id) ?? ws, reason, { resumed })
      // A workspace waiting to be archived whose session died has no turn end coming to archive it (KERNEL-131).
      if (k['reviewsToArchive'].has(ws.id)) void k['archiveMarked'](ws.id).catch(() => undefined)
    },
    onLimits: (limits) => k['applyLimits'](limits),
    onCutOff: (chatIds) => k.store.saveMeta('cutOff', chatIds),
    onHeld: (held) => k.store.saveMeta('held', held)
  }
}
