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
    agentFor: (ws) => k.team.agentOf(ws.roomId, ws.agentId),
    mcpFor: (ws, agent, chat) => k.tools.mcpFor(ws, agent, chat),
    codexFor: (ws, agent, chat) => ({ bin: k.providers.binary('codex').path, home: k.providers.codexHome(), personality: k.settings.providers.codex.personality, ...k.tools.codexTools(ws, agent, chat) }),
    disabledFor: (ws) => { const room = k.store.room(ws.roomId); return room ? disabledInRoom(room.path) : undefined },
    rulesFor: (ws, agent) => k.tools.rulesFor(ws, agent),
    roomAllow: (roomId) => k.store.room(roomId)?.allow ?? [],
    availability: (chat, ws, wants) => k.permissions.forChat(chat, ws, wants),
    envFor: (ws) => k.env.envFor(ws),
    allowInRoom: (roomId, rule) => {
      const room = k.store.room(roomId)
      if (room && !room.allow?.includes(rule)) k.store.saveRoom({ ...room, allow: [...(room.allow ?? []), rule] })
    },
    onReply: (ws, chat) => void k.chats.nameChat(ws, chat),
    // A reply proves the network works, so a failing DNS probe behind a proxy doesn't hold every send (KERNEL-231).
    onReached: () => k.account.network?.reached(),
    onReset: (_ws, chat, trigger) => k.chats.resetName(chat, trigger),
    onTurnDone: (ws, chat, turn) => {
      void k.checkpoints.checkpoint(ws, chat).catch(() => undefined)
      void k.chats.nameChat(ws, chat, true)
      const lead = !!k.team.agentOf(ws.roomId, ws.agentId)?.lead
      const done = { ...turn, lead, queued: k.sessions.queued(chat.id).length > 0 }
      k.notifications.turnDone(ws, chat, done)
      // A teammate's update waits until Kernel has read its PR, so a PR the turn opened speaks for the turn however long GitHub
      // takes.
      const teammate = !k.team.isLeadWorkspace(ws)
      if (teammate) k.leadUpdates.readingPr(ws.id)
      k.leadUpdates.turnDone(ws, chat, done)
      // A workspace that was still working when its work merged, or the work it reviewed merged or closed, goes now (KERNEL-114, KERNEL-131).
      if (k.autoArchive.reviewsToArchive.has(ws.id)) void k.autoArchive.archiveMarked(ws.id).catch(() => undefined)
      void k.workspaces.changes(ws.id).catch(() => undefined)
      if (teammate) void k.refreshPr(ws.id).catch(() => undefined).then(() => k.leadUpdates.readPr(ws.id)).catch(() => undefined)
      // A chat with Rowan can open a PR from its own branch too (KERNEL-405). Nobody else hears about it.
      else if (ws.prNumber) void k.refreshPr(ws.id).catch(() => undefined)
      void k.overlaps.check(ws.roomId).catch(() => undefined)
      // A teammate that was busy when main moved is told now, if it still would conflict (KERNEL-180).
      if (teammate) void k.baseWatch.check(ws.roomId, { fetch: false, only: ws.id }).catch(() => undefined)
      k.waits.releaseTaken(ws.id, chat.id, turn.by)
      // A sync skipped while this chat's turn ran happens once it ends. It does nothing while another of its tabs runs (KERNEL-181, KERNEL-405).
      if (!teammate) void k.lead.syncLead(ws.roomId, { workspaceId: ws.id })
    },
    accountFor: (provider) => k.providers.active(provider),
    claudeEnv: () => k.providers.claudeEnv(),
    onFailure: (failure, _ws, provider) => {
      if (failure === 'auth') k.account.signedOut(provider)
      else if (failure === 'network') void k.account.network?.lost()
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
