import { chatProvider } from '@shared/providers'
import type { Kernel } from '../kernel'
import { bus } from '../bus'
import type { SessionDeps } from '../services/sessions'
import { agentAccessInRoom, aliasesInRoom, disabledInRoom, referencesInRoom } from '../services/settings'

/**
 * What Sessions calls back into Kernel for (KERNEL-324). A new reaction to a finished turn goes in `onTurnDone`, where the
 * order matters: the Lead hears about a turn only after Kernel has read the PR it may have opened.
 */
export function sessionDeps(k: Kernel): SessionDeps {
  // Reference folders the room log already warned about, by room and path, so each warns once per run (KERNEL-748).
  const warned = new Set<string>()
  return {
    store: k.store,
    approvals: k.approvals,
    settings: () => k.settings,
    // A review chat runs its kind's agent, which isn't always its workspace's (KERNEL-549).
    agentFor: (ws, chat) => (chat && k.reviews.agentForChat(ws, chat)) || k.team.agentOf(ws.roomId, ws.agentId),
    teamOf: (roomId) => k.team.agentCache.get(roomId),
    openItems: {
      mentioned: (chat, mentioned) => k.openItems.mentioned(chat, mentioned),
      userSent: (chatId) => k.openItems.userSent(chatId),
      atStop: (chatId) => k.openItems.atStop(chatId)
    },
    roleFor: (ws, agent) => k.team.roleFor(ws, agent),
    mcpFor: (ws, agent, chat) => k.tools.mcpFor(ws, agent, chat),
    codexFor: (ws, agent, chat) => ({ bin: k.providers.binary('codex').path, home: k.providers.codexHome(), apiKey: k.providers.apiKey('codex'), personality: k.settings.providers.codex.personality, ...k.tools.codexTools(ws, agent, chat) }),
    disabledFor: (ws) => { const room = k.store.room(ws.roomId); return room ? disabledInRoom(room.path) : undefined },
    aliasesFor: (ws) => { const room = k.store.room(ws.roomId); return room ? aliasesInRoom(room.path) : undefined },
    accessFor: (ws) => { const room = k.store.room(ws.roomId); return room ? agentAccessInRoom(room.path, ws.agentId) : undefined },
    // A folder that isn't there is skipped, so the chat still starts, and the room log says so once (KERNEL-748).
    referencesFor: (ws) => {
      const room = k.store.room(ws.roomId)
      if (!room) return undefined
      const { present, missing } = referencesInRoom(room.path)
      for (const path of missing) {
        if (warned.has(`${room.id}\0${path}`)) continue
        warned.add(`${room.id}\0${path}`)
        bus.activity({ kind: 'note', roomId: room.id, actor: 'kernel', text: 'skipped a reference folder that is missing:', object: path, warn: true })
      }
      return present
    },
    onMcp: (ws, provider, servers) => k.mcp.reported(ws.roomId, provider, servers),
    rulesFor: (ws, agent, chat) => k.tools.rulesFor(ws, agent, chat),
    roomAllow: (roomId) => k.store.room(roomId)?.allow ?? [],
    availability: (chat, ws, wants) => k.permissions.forChat(chat, ws, wants),
    envFor: (ws) => k.env.envFor(ws),
    allowInRoom: (roomId, rule) => {
      const room = k.store.room(roomId)
      if (room && !room.allow?.includes(rule)) k.store.saveRoom({ ...room, allow: [...(room.allow ?? []), rule] })
    },
    roomTools: (roomId) => k.store.room(roomId)?.allowTools ?? [],
    allowToolInRoom: (roomId, rule) => {
      const room = k.store.room(roomId)
      if (room && !room.allowTools?.includes(rule)) k.store.saveRoom({ ...room, allowTools: [...(room.allowTools ?? []), rule] })
    },
    onReply: (ws, chat) => void k.chats.nameChat(ws, chat),
    // A reply proves the network works, so a failing DNS probe behind a proxy doesn't hold every send (KERNEL-231).
    onReached: () => k.account.network?.reached(),
    onReset: (_ws, chat, trigger) => k.chats.resetName(chat, trigger),
    onTurnDone: (ws, chat, turn) => {
      void k.checkpoints.checkpoint(ws, chat).catch(() => undefined)
      void k.chats.nameChat(ws, chat, true)
      // A turn the user stopped is one they were watching (KERNEL-507).
      if (!turn.interrupted) k.chats.markUnread(chat)
      const lead = !!k.team.agentOf(ws.roomId, ws.agentId)?.lead
      const done = { ...turn, lead, queued: k.sessions.queued(chat.id).length > 0 }
      k.notifications.turnDone(ws, chat, done)
      // A teammate's update waits until Kernel has read its PR, so a PR the turn opened speaks for the turn however long GitHub
      // takes.
      const teammate = !k.team.isLeadWorkspace(ws)
      if (teammate) k.leadUpdates.readingPr(ws.id)
      // A limit's cut-off says what Kernel does about it: a switch to another account, or a wait for the reset (KERNEL-777).
      k.leadUpdates.turnDone(ws, chat, done, turn.limit ? k.account.limitNews(chatProvider(chat), turn.account, chat.model) : undefined)
      // A workspace that was still working when its work merged, or the work it reviewed merged or closed, goes now (KERNEL-114, KERNEL-131).
      if (k.autoArchive.reviewsToArchive.has(ws.id)) void k.autoArchive.archiveMarked(ws.id).catch(() => undefined)
      void k.workspaces.changes(ws.id).catch(() => undefined)
      // A read that fails still lets the update go, and says why it may be missing the PR (KERNEL-637).
      if (teammate) {
        void k.refreshPr(ws.id).catch((e) => { if (!k.stopped) console.warn(`[lead-updates] could not read the PR of ${ws.id} after its turn: ${(e as Error)?.message ?? e}`) })
          .then(() => k.leadUpdates.readPr(ws.id)).catch((e) => console.warn(`[lead-updates] could not send the update for ${ws.id}: ${(e as Error)?.message ?? e}`))
      }
      // A Lead chat can open a PR from its own branch too (KERNEL-405). Nobody else hears about it.
      else if (ws.prNumber) void k.refreshPr(ws.id).catch(() => undefined)
      void k.overlaps.check(ws.roomId).catch(() => undefined)
      // A teammate that was busy when main moved is told now, if it still would conflict (KERNEL-180). One that started from a
      // stale base fetches again and catches up (KERNEL-653).
      if (teammate) void k.baseWatch.check(ws.roomId, { fetch: false, only: ws.id }).catch(() => undefined)
      void k.waits.releaseTaken(ws.id, chat.id, turn.by).catch(() => undefined)
      // A sync skipped while this chat's turn ran happens once it ends. It does nothing while another of its tabs runs (KERNEL-181, KERNEL-405).
      if (!teammate) void k.lead.syncLead(ws.roomId, { workspaceId: ws.id })
      // The footer shows usage all the time, so the account the turn ran on is read again (KERNEL-673).
      k.providers.readUsageAfterTurn(chatProvider(chat), turn.account)
    },
    accountFor: (provider) => k.providers.active(provider),
    claudeEnv: () => k.providers.claudeEnv(),
    usageReads: () => k.providers.usageReads(),
    // Undefined is the CLI's own login, which is never a key account.
    authOf: (provider, accountId) => (accountId ? k.providers.auth(provider, accountId) : 'subscription'),
    switchNote: (provider, accountId) => k.providers.switchNote(provider, accountId),
    onFailure: (failure, _ws, provider, account) => {
      if (failure === 'auth') k.account.signedOut(provider, { account })
      else if (failure === 'network') void k.account.network?.lost()
    },
    // A teammate whose session died mid-turn would look busy forever. Kernel tells the Lead that handed the work off (KERNEL-124).
    onExit: (ws, _chat, reason, midTurn, resumed) => {
      if (midTurn) k.leadUpdates.crashed(k.store.workspace(ws.id) ?? ws, reason, { resumed })
      // A workspace waiting to be archived whose session died has no turn end coming to archive it (KERNEL-131).
      if (k.autoArchive.reviewsToArchive.has(ws.id)) void k.autoArchive.archiveMarked(ws.id).catch(() => undefined)
    },
    // A teammate a limit stopped carries on, on the account its provider runs on now. The Lead hears it when it heard of the pause (KERNEL-777).
    onCarriedOn: (chatId, reason) => {
      const chat = k.store.chat(chatId)
      const ws = chat && k.store.workspace(chat.workspaceId)
      if (reason !== 'limit' || !chat || !ws) return
      const provider = chatProvider(chat)
      k.leadUpdates.limitLifted(ws, { provider, account: k.providers.label(provider, k.providers.active(provider)) })
    },
    onLimits: (limits) => k.account.applyLimits(limits),
    onCutOff: (chatIds) => k.store.saveMeta('cutOff', chatIds),
    onHeld: (held) => k.store.saveMeta('held', held),
    // A pause or another hold lifted, so a Team update the Lead couldn't take goes now (KERNEL-637).
    onFreed: () => k.leadUpdates.flushSoon()
  }
}
