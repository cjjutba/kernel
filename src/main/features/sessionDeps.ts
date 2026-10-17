import { chatProvider } from '@shared/providers'
import type { Chat, Workspace } from '@shared/types'
import type { Kernel } from '../kernel'
import { bus } from '../bus'
import type { SessionDeps, TurnBy } from '../services/sessions'
import { agentAccessInProject, aliasesInProject, disabledInProject, referencesInProject } from '../services/settings'

/**
 * What Sessions calls back into Kernel for (KERNEL-324). A new reaction to a finished turn goes in `onTurnDone`, where the
 * order matters: the Lead hears about a turn only after Kernel has read the PR it may have opened.
 */
export function sessionDeps(k: Kernel): SessionDeps {
  // Reference folders the project log already warned about, by project and path, so each warns once per run (KERNEL-748).
  const warned = new Set<string>()
  return {
    store: k.store,
    approvals: k.approvals,
    settings: () => k.settings,
    // A review chat runs its kind's agent, which isn't always its workspace's (KERNEL-549).
    agentFor: (ws, chat) => (chat && k.reviews.agentForChat(ws, chat)) || k.team.agentOf(ws.projectId, ws.agentId),
    teamOf: (projectId) => k.team.agentCache.get(projectId),
    openItems: {
      mentioned: (chat, mentioned) => k.openItems.mentioned(chat, mentioned),
      userSent: (chatId) => k.openItems.userSent(chatId),
      atStop: (chatId) => k.openItems.atStop(chatId)
    },
    roleFor: (ws, agent) => k.team.roleFor(ws, agent),
    mcpFor: (ws, agent, chat) => k.tools.mcpFor(ws, agent, chat),
    // The chat's account's home and key, which can be another than the one in use (KERNEL-843). Codex's own login is ~/.codex.
    codexFor: (ws, agent, chat, account) => ({ bin: k.providers.binary('codex').path, home: account ? k.providers.codexHome(account) : undefined, apiKey: account ? k.providers.apiKey('codex', account) : undefined, personality: k.settings.providers.codex.personality, ...k.tools.codexTools(ws, agent, chat) }),
    disabledFor: (ws) => { const project = k.store.project(ws.projectId); return project ? disabledInProject(project.path) : undefined },
    aliasesFor: (ws) => { const project = k.store.project(ws.projectId); return project ? aliasesInProject(project.path) : undefined },
    accessFor: (ws) => { const project = k.store.project(ws.projectId); return project ? agentAccessInProject(project.path, ws.agentId) : undefined },
    // A folder that isn't there is skipped, so the chat still starts, and the project log says so once (KERNEL-748).
    referencesFor: (ws) => {
      const project = k.store.project(ws.projectId)
      if (!project) return undefined
      const { present, missing } = referencesInProject(project.path)
      for (const path of missing) {
        if (warned.has(`${project.id}\0${path}`)) continue
        warned.add(`${project.id}\0${path}`)
        bus.activity({ kind: 'note', projectId: project.id, actor: 'kernel', text: 'skipped a reference folder that is missing:', object: path, warn: true })
      }
      return present
    },
    onMcp: (ws, provider, servers, account) => k.mcp.reported(ws.projectId, provider, servers, { account }),
    rulesFor: (ws, agent, chat) => k.tools.rulesFor(ws, agent, chat),
    projectAllow: (projectId) => k.store.project(projectId)?.allow ?? [],
    availability: (chat, ws, wants) => k.permissions.forChat(chat, ws, wants),
    envFor: (ws) => k.env.envFor(ws),
    allowInProject: (projectId, rule) => {
      const project = k.store.project(projectId)
      if (project && !project.allow?.includes(rule)) k.store.saveProject({ ...project, allow: [...(project.allow ?? []), rule] })
    },
    projectTools: (projectId) => k.store.project(projectId)?.allowTools ?? [],
    allowToolInProject: (projectId, rule) => {
      const project = k.store.project(projectId)
      if (project && !project.allowTools?.includes(rule)) k.store.saveProject({ ...project, allowTools: [...(project.allowTools ?? []), rule] })
    },
    buildOpen: (chatId) => k.lead.buildOpen(chatId),
    onBuildPlanApproved: (chatId) => k.lead.recordGoAhead(chatId, 'plan approved'),
    onReply: (ws, chat) => void k.chats.nameChat(ws, chat),
    // A reply proves the network works, so a failing DNS probe behind a proxy doesn't hold every send (KERNEL-231).
    onReached: () => k.account.network?.reached(),
    onReset: (_ws, chat, trigger) => k.chats.resetName(chat, trigger),
    onTurnDone: (ws, chat, turn) => k.chats.turnFinished(ws, chat, turn),
    accountFor: (provider, chat) => k.placement.accountFor(provider, chat),
    // `cli` is the CLI's own login, as CLI_ACCOUNT in features/providers.ts.
    claudeEnv: (account) => k.providers.claudeEnv(account ?? 'cli'),
    startedOn: (chat) => k.placement.startedOn(chat.id),
    usageReads: () => k.providers.usageReads(),
    // Undefined is the CLI's own login, which is never a key account.
    authOf: (provider, accountId) => (accountId ? k.providers.auth(provider, accountId) : 'subscription'),
    moveNote: (chat, from) => k.placement.moved(chat, from),
    movePlan: (chat, to) => k.moves.plan(chat, to),
    onMoveHold: (chat, held) => k.moves.held(chat, held),
    coldSize: (chat) => k.placement.coldSize(chat),
    emailOf: (provider, accountId) => k.providers.emailOf(provider, accountId),
    turnNote: (chat) => [k.checkpoints.turnNote(chat.id), k.lead.turnNote(chat.workspaceId)].filter(Boolean).join('\n\n') || undefined,
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
    seatsBusy: (chatId) => k.teammateSeats.busy(chatId),
    onFreed: () => { k.leadUpdates.flushSoon(); k.teammateSeats.startWaiting() }
  }
}
