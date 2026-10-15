import { EFFORTS, isRunName, MODELS } from '@shared/types'
import type { AgentDef, Approval, Chat, ClaudeAccount, GithubIssue, HookStatus, LinearIssue, Provider, ProviderStatus, ReviewKind, RoomSettings, Workspace } from '@shared/types'
import type { Fixture } from '../../fixtures'
import type { PushEvent } from '@shared/ipc'
import { localUrlIn } from '@shared/previewUrl'
import { isLeadWorkspace } from '@shared/leadWorkspace'
import { KERNEL_FILE } from '@shared/team'
import { join, matchesGlob } from 'node:path'
import type { Handlers } from './kernel'
import { bus } from './bus'
import { applySettingsPatch, DEFAULT_SETTINGS, previewUrlsOf, reviewOf } from './services/settings'
import { CODEX_AUTO } from './features/permissions'
import { chatMode } from './services/permissions'
import { agentFromFile, draftAgent } from './services/agents'
import { isPattern } from './services/filesToCopy'
import { mustBeInside, OPEN_APPS } from './services/openApps'
import { presetList, resolvePreset, terminalTitle } from './services/terminalPresets'

const ok = { ok: true } as const
const fixtureAccount: ClaudeAccount = { signedIn: true, name: 'Sam Rivera', login: 'samrivera', plan: 'Claude Max' }

/**
 * Fixture mode (KERNEL_FIXTURES): every IPC channel answered from one fixture, with no database, hook server or sessions.
 * Reads serve the fixture. Writes return a plausible value and change nothing, so a screenshot shows the same state every time.
 */
export function fixtureHandlers(f: Fixture): Handlers {
  const chat = (id: string): Chat => {
    const c = f.chats.find((x) => x.id === id)
    if (!c) throw new Error(`Unknown chat ${id}`)
    return c
  }
  const workspace = (id: string): Workspace => {
    const w = f.workspaces.find((x) => x.id === id)
    if (!w) throw new Error(`Unknown workspace ${id}`)
    return w
  }
  const room = (id: string) => {
    const r = f.rooms.find((x) => x.id === id)
    if (!r) throw new Error(`Unknown room ${id}`)
    return r
  }
  const agentOf = (roomId: string, id: string): AgentDef => {
    const a = f.agents[roomId]?.find((x) => x.id === id)
    if (!a) throw new Error(`Unknown agent ${id}`)
    return a
  }
  /** The fixture's personal and plugin agents, once each, as `agents.listGlobal` gives them with no room (KERNEL-640). */
  const globalAgents = (): AgentDef[] => {
    const all = Object.values(f.agents).flat().filter((a) => a.origin === 'personal' || a.origin === 'plugin')
    return [...new Map(all.map((a) => [a.id, a])).values()].sort((a, b) => Number(a.origin === 'plugin') - Number(b.origin === 'plugin'))
  }
  /** The workspace of the room's newest open Lead chat, the one `lead.open` finds (KERNEL-405). */
  const leadWs = (roomId: string) => {
    const lead = f.agents[roomId]?.find((a) => a.lead)
    return f.workspaces.filter((w) => w.roomId === roomId && isLeadWorkspace(w, lead?.id)).at(-1)
  }
  let settings = f.settings ?? DEFAULT_SETTINGS('/Users/you')
  const hooks: HookStatus = f.hooks ?? { port: settings.hookPort, listening: true, installed: true, events: [] }
  const update = f.update ?? { status: 'idle' as const, current: '0.1.0' }
  const account = f.account ?? fixtureAccount
  const roomSettings = (roomId: string): RoomSettings => {
    const rs = f.roomSettings?.[roomId] ?? { scripts: {}, files: { copy: ['.env', '.env.local'] }, workspace: {} }
    // Like the engine, `run` comes first, from `[scripts] run`.
    const runScripts = rs.runScripts ?? (rs.scripts.run ? [{ name: 'run', command: rs.scripts.run }] : [])
    return { ...rs, runScripts, disabled: { skills: [], mcp: [], ...rs.disabled }, preview: { urls: rs.preview?.urls ?? [] }, env: { files: rs.env?.files ?? [] }, references: rs.references ?? [], review: rs.review ?? reviewOf(undefined), merge: rs.merge ?? { alwaysReview: [] }, sources: rs.sources ?? {} }
  }
  /** A provider's status table: the fixture's, else Kernel's bundled copy, signed in (KERNEL-406). */
  const status = (provider: Provider): ProviderStatus => f.providerStatus?.[provider] ?? { provider, source: 'bundled', signedIn: true, configFile: '' }
  /** Queued messages a fixture run removed, so Remove and Stop leave them out of the next read. */
  const unqueued = new Set<string>()
  const queue = (chatId: string) => (f.queue?.[chatId] ?? []).filter((q) => !unqueued.has(q.id))
  const decided = (a: Approval, d: Parameters<Handlers['approvals.decide']>[0]['decision']): Approval =>
    d.behavior === 'answer' ? { ...a, status: 'answered', answer: d.text } : { ...a, status: d.behavior === 'allow' ? 'allowed' : 'denied' }

  const handlers: Handlers = {
    'preflight.run': async () => f.preflight,
    'preflight.fix': async () => { if (f.preflightFixError) throw new Error(f.preflightFixError); return f.preflight },
    'hooks.install': async () => ({ path: '(fixture)', events: [] }),
    'hooks.uninstall': async () => f.hooks ?? { port: 7420, listening: true, installed: false, events: [] },
    'hooks.turnOn': async () => ({ ...hooks, problem: undefined }),
    'hooks.status': async () => hooks,
    'github.status': async () => f.github ?? {},
    'hooks.test': async () => hooks,
    'hooks.restart': async () => hooks,
    'rooms.list': async () => f.rooms,
    'rooms.add': async ({ path, name }) => f.rooms.find((r) => r.path === path) ?? { id: 'fixture-room', name: name ?? path.split('/').pop() ?? path, path, defaultBranch: 'main', paused: false, createdAt: Date.now() },
    'rooms.create': async ({ name, desc, source, from }) => ({ id: 'fixture-room', name, desc, kind: source, path: from, defaultBranch: 'main', paused: false, createdAt: Date.now() }),
    'rooms.update': async ({ roomId, patch }) => ({ ...room(roomId), ...patch }),
    'rooms.setIcon': async ({ roomId, icon }) => {
      const { icon: _old, ...r } = room(roomId)
      return icon.kind === 'letter' ? r : { ...r, icon: { kind: icon.kind, file: `${roomId}-fixture.png`, at: Date.now() } }
    },
    'rooms.icon': async ({ roomId }) => (room(roomId).icon ? f.roomIcons?.[roomId] ?? null : null),
    'rooms.remove': async () => ok,
    'rooms.setPaused': async ({ roomId, paused }) => ({ ...room(roomId), paused }),
    'rooms.brief': async ({ roomId, agentId }) => {
      const lead = f.agents[roomId]?.find((a) => a.lead)
      const ws = f.workspaces.find((w) => w.roomId === roomId && w.agentId === (agentId ?? lead?.id) && w.status !== 'archived')
      const c = ws && f.chats.find((x) => x.workspaceId === ws.id)
      if (!ws || !c) throw new Error('This fixture has no chat for that agent.')
      return { chatId: c.id, workspaceId: ws.id }
    },
    'rooms.overlaps': async ({ roomId }) => (f.overlaps ?? []).filter((o) => o.roomId === roomId),
    'rooms.resolveOverlap': async () => ok,
    'rooms.inspectFolder': async ({ path }) => f.folders?.find((x) => x.path === path) ?? { path, git: true, branch: 'main', dirty: 0 },
    'rooms.recentFolders': async () => f.folders ?? [],
    'rooms.pushCheck': async ({ roomId }) => f.pushChecks?.[roomId] ?? null,
    'rooms.scriptTrust': async () => null,
    'rooms.trust': async () => ok,
    'github.repos': async ({ query }) => (f.repos ?? []).filter((r) => !query || r.fullName.includes(query)),
    'agents.list': async ({ roomId, retired }) => (f.agents[roomId] ?? []).filter((a) => !!a.retired === !!retired),
    'agents.status': async ({ roomId }) => f.status[roomId] ?? {},
    'agents.save': async ({ roomId, agentId, patch }) => ({ ...agentOf(roomId, agentId), ...patch }),
    'agents.listGlobal': async () => globalAgents(),
    'agents.saveGlobal': async ({ agentId, patch }) => {
      const a = globalAgents().find((x) => x.id === agentId)
      if (!a) throw new Error(`${agentId} is not in ~/.claude/agents.`)
      return { ...a, ...patch }
    },
    'agents.draft': async ({ description, name, model }) => draftAgent({ description, name, model }),
    'agents.create': async ({ roomId, draft, scope }) => {
      if (roomId) return { ...agentFromFile(draft.file, draft.text), joinedAt: Date.now() }
      if (scope === 'team') throw new Error("A team agent is saved in a room's repo. Open a room to add one.")
      return { ...agentFromFile(`~/.claude/agents/${draft.id}.md`, draft.text), origin: 'personal', joinedAt: Date.now() }
    },
    'agents.retire': async () => ok,
    'agents.restore': async ({ roomId, agentId }) => ({ ...agentOf(roomId, agentId), retired: false }),
    'agents.seed': async ({ roomId }) => f.agents[roomId] ?? [],
    'agents.setTeam': async ({ roomId }) => f.agents[roomId] ?? [],
    'agents.customize': async ({ roomId, agentId }) => ({ ...agentOf(roomId, agentId), file: join('.claude', 'agents', KERNEL_FILE) }),
    'agents.resetLead': async ({ roomId }) => (f.agents[roomId] ?? []).filter((a) => !a.retired),
    'agents.moveLead': async ({ roomId }) => (f.agents[roomId] ?? []).filter((a) => !a.retired),
    'agents.addStarter': async ({ id }) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), role: '', description: '', lead: false, prompt: '', file: join('.claude', 'agents', `${id}.md`), joinedAt: Date.now() }),
    'workspaces.list': async ({ roomId }) => f.workspaces.filter((w) => !roomId || w.roomId === roomId),
    'workspaces.create': async () => { throw new Error('Fixture mode does not create workspaces.') },
    'workspaces.fork': async () => { throw new Error('Fixture mode does not create workspaces.') },
    'workspaces.archive': async () => ok,
    'workspaces.restore': async ({ workspaceId }) => ({ ...workspace(workspaceId), status: 'ready' }),
    'workspaces.deletePreview': async ({ workspaceIds }) => f.deletePreview ?? { workspaces: workspaceIds.length, skipped: [], unpushedBranches: 0, transcriptBytes: 640 * 1024 * 1024 },
    'workspaces.delete': async ({ workspaceIds }) => ({ deleted: workspaceIds, skipped: [], keptBranches: 0, freedBytes: 0 }),
    'workspaces.gitStatus': async ({ workspaceId }) => {
      if (f.gitStatus?.[workspaceId]) return f.gitStatus[workspaceId]
      const files = f.changes[workspaceId] ?? []
      return { branch: workspace(workspaceId).branch, ahead: 0, behind: 0, dirty: { files: files.length, added: files.reduce((n, c) => n + c.added, 0), removed: files.reduce((n, c) => n + c.removed, 0) } }
    },
    'workspaces.changes': async ({ workspaceId }) => f.changes[workspaceId] ?? [],
    'workspaces.diff': async ({ workspaceId }) => f.diffs[workspaceId] ?? '',
    'workspaces.commits': async ({ workspaceId }) => f.commits?.[workspaceId] ?? [],
    'workspaces.compareBranches': async ({ workspaceId }) => [...new Set([workspace(workspaceId).baseRef, ...(f.branches ?? [])])],
    'workspaces.tree': async ({ workspaceId }) => f.tree?.[workspaceId] ?? [],
    'workspaces.files': async ({ workspaceId, query, limit = 8 }) => (f.tree?.[workspaceId] ?? []).filter((e) => e.path.toLowerCase().includes(query.toLowerCase())).slice(0, limit),
    'workspaces.readFile': async ({ workspaceId, path }) => f.fileText?.[workspaceId]?.[path] ?? '',
    'workspaces.readImage': async ({ workspaceId, path, at }) => f.images?.[workspaceId]?.[`${at}:${path}`] ?? null,
    'workspaces.hunks': async ({ workspaceId, path }) => (f.hunks?.[workspaceId] ?? []).filter((h) => !path || h.path === path),
    'workspaces.commit': async () => ok,
    'workspaces.discard': async () => ok,
    'git.branches': async ({ roomId }) => f.branches ?? [...new Set(f.workspaces.filter((w) => w.roomId === roomId).map((w) => w.branch))],
    // Newest first, a few days apart, so the branch menu shows ages.
    'git.branchList': async ({ roomId }) => (f.branches ?? [...new Set(f.workspaces.filter((w) => w.roomId === roomId).map((w) => w.branch))]).map((name, i) => ({ name, committedAt: Date.now() - (i * 3 + 1) * 86_400_000 })),
    'github.prs': async ({ query }) => (f.openPrs ?? []).filter((p) => !query || `#${p.number} ${p.title} ${p.author ?? ''}`.toLowerCase().includes(query.toLowerCase())),
    'github.issues': async ({ query }) => (f.issues ?? []).filter((i) => i.source === 'github' && (!query || `${i.id} ${i.title}`.toLowerCase().includes(query.toLowerCase()))),
    'issues.list': async ({ roomId, query }) => (f.issues?.filter((i) => i.source !== 'github') ?? (f.tasks?.[roomId] ?? []).map((t) => ({ id: t.id, title: t.title }))).filter((i) => !query || `${i.id} ${i.title}`.toLowerCase().includes(query.toLowerCase())),
    'issues.next': async ({ roomId }) => f.issues?.filter((i) => i.source !== 'github') ?? (f.tasks?.[roomId] ?? []).map((t) => ({ id: t.id, title: t.title })),
    'issues.taken': async () => f.issueTaken ?? { findings: [], notes: [] },
    'issues.tracker': async ({ roomId }) => f.trackers?.[roomId] ?? { kind: 'linear' },
    'github.issueList': async ({ roomId, query }) => (f.githubIssues?.[roomId] ?? [])
      .filter((i) => !query || `${i.id} ${i.title} ${i.author ?? ''}`.toLowerCase().includes(query.replace(/^#/, '').toLowerCase()))
      .map(({ body: _b, comments: _c, ...issue }): GithubIssue => issue),
    'github.issue': async ({ roomId, id }) => {
      const issue = f.githubIssues?.[roomId]?.find((i) => i.id === id)
      if (!issue) throw new Error(`Unknown issue ${id}`)
      return issue
    },
    'linear.issues': async ({ filter }) => (f.linear?.issues ?? []).filter((i) => {
      const q = filter.query?.trim().toLowerCase()
      return (!filter.mine || i.assignee?.me) && (!filter.teamId || i.team.id === filter.teamId) && (!filter.projectId || i.project?.id === filter.projectId)
        && (!filter.cycleId || i.cycle?.id === filter.cycleId) && (!q || `${i.id} ${i.title}`.toLowerCase().includes(q))
    }).map(({ description: _d, comments: _c, ...issue }): LinearIssue => issue),
    'linear.issue': async ({ id }) => {
      const issue = f.linear?.issues?.find((i) => i.id === id)
      if (!issue) throw new Error(`Unknown issue ${id}`)
      return issue
    },
    'linear.scope': async () => f.linear?.scope ?? { teams: [], projects: [], cycles: [] },
    'linear.plan': async ({ roomId }) => {
      const ws = leadWs(roomId)
      const c = ws && f.chats.find((x) => x.workspaceId === ws.id)
      if (!ws || !c) throw new Error('This fixture has no chat with Kernel.')
      return { chatId: c.id, workspaceId: ws.id }
    },
    'chats.list': async ({ workspaceId }) => f.chats.filter((c) => c.workspaceId === workspaceId),
    'chats.create': async ({ workspaceId, kind, preset }) => {
      const first = f.chats.find((c) => c.workspaceId === workspaceId)
      if (!first) throw new Error(`Unknown workspace ${workspaceId}`)
      const base = { ...first, id: `fixture-chat-${Date.now()}`, sessionId: undefined, plan: false, terminal: undefined, autoTitle: undefined }
      if (kind !== 'terminal') return { ...base, kind: 'chat', title: 'New chat' }
      if (!settings.terminal.enabled) throw new Error('Big terminal tabs are off. Turn them on in Settings, Big terminal.')
      const term = resolvePreset(presetList(settings.terminal, f.terminalClis ?? []), settings.terminal, workspace(workspaceId).mode, preset)
      return { ...base, kind: 'terminal', title: terminalTitle(term.preset), terminal: term.terminal }
    },
    'chats.items': async ({ chatId }) => f.items[chatId] ?? [],
    'chats.send': async () => {
      for (const step of f.afterSend ?? []) setTimeout(() => step.events.forEach((e) => bus.push(e)), step.afterMs)
      return { queued: false }
    },
    'chats.interrupt': async ({ chatId }) => {
      bus.push({ type: 'chat.running', chatId, running: false })
      return ok
    },
    'chats.configure': async ({ chatId, ...patch }) => ({ ...chat(chatId), ...patch }),
    'chats.rename': async ({ chatId, title }) => ({ ...chat(chatId), title }),
    'chats.close': async () => ok,
    'chats.markRead': async () => ok,
    'chats.fork': async ({ chatId, itemId }) => {
      const c = chat(chatId)
      return { ...c, id: `fixture-fork-${Date.now()}`, title: `Fork of ${c.title}`, sessionId: undefined, forkOf: { chatId, itemId: itemId ?? (f.items[chatId]?.at(-1)?.id ?? '') } }
    },
    'chats.retry': async () => ok,
    'chats.compact': async () => ok,
    'chats.restart': async () => ok,
    'chats.queue': async ({ chatId }) => queue(chatId),
    'chats.queueReason': async () => null,
    'chats.moveNotice': async ({ chatId }) => f.moveNotices?.[chatId] ?? null,
    'chats.moveChoice': async ({ chatId, choice }) => ({ ...chat(chatId), moveChoice: { choice, at: Date.now() } }),
    // A fixture has no process and reads no policy, so every mode is available and nothing waits for a turn.
    'chats.runMode': async ({ chatId }) => {
      const c = chat(chatId)
      const ws = workspace(c.workspaceId)
      return chatMode(c, ws, room(ws.roomId), settings, { auto: true, bypass: true }, f.agents[ws.roomId]?.find((a) => a.id === ws.agentId))
    },
    // A fixture's running chats, retries, script lines and terminal output come from its push events.
    'chats.live': async () => ({ running: [], retry: {} }),
    'chats.unqueue': async ({ chatId, id }) => {
      unqueued.add(id)
      return queue(chatId)
    },
    'chats.sendNow': async ({ chatId, id }) => queue(chatId).filter((q) => q.id !== id),
    'skills.list': async () => f.skills ?? [],
    'commands.list': async () => [],
    'terminal.write': async () => ok,
    'terminal.resize': async () => ok,
    'terminal.replay': async () => ok,
    'checkpoints.list': async ({ workspaceId }) => f.checkpoints?.[workspaceId] ?? [],
    'checkpoints.preview': async ({ workspaceId, checkpointId }) => f.checkpointPreviews?.[workspaceId]?.[checkpointId] ?? { files: [], stat: { files: 0, added: 0, removed: 0 }, commitsAhead: 0, pushed: false, conflicts: [] },
    'checkpoints.revert': async ({ workspaceId }) => ({ backupBranch: `backup/${workspace(workspaceId).name}` }),
    'approvals.list': async ({ roomId }) => f.approvals.filter((a) => !roomId || a.roomId === roomId).sort((a, b) => b.createdAt - a.createdAt),
    'approvals.decide': async ({ id, decision }) => {
      const a = f.approvals.find((x) => x.id === id)
      if (!a) throw new Error('This request already timed out or was answered.')
      const done = decided(a, decision)
      // The engine pushes the decided plan and takes the chat out of plan mode, as `pnpm shots --motion` needs to see Approve do (KERNEL-831).
      if (a.kind === 'plan' && decision.behavior === 'allow') {
        bus.push({ type: 'approval', approval: done })
        const chat = f.chats.find((c) => c.id === a.chatId)
        if (chat) bus.push({ type: 'chat', chat: { ...chat, plan: false } })
      }
      return done
    },
    'approvals.planFile': async ({ id }) => {
      const a = f.approvals.find((x) => x.id === id)
      const ws = a?.workspaceId ? workspace(a.workspaceId) : undefined
      if (!a?.planFile || !ws) throw new Error('This plan has no file.')
      return { path: join(ws.path, a.planFile), relative: a.planFile }
    },
    'tasks.list': async ({ roomId }) => f.tasks?.[roomId] ?? [],
    'notifications.list': async () => f.notifications ?? [],
    'notifications.playSound': async () => ({ ok: true }),
    'notifications.read': async ({ ids }) => (f.notifications ?? []).map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read: true } : n)),
    'lead.open': async ({ roomId }) => {
      if (!f.agents[roomId]?.some((a) => a.lead)) throw new Error('This fixture has no Kernel.')
      return leadWs(roomId) ?? null
    },
    'lead.start': async () => {
      const started = f.chats.find((c) => c.id === f.leadStart)
      if (!started) throw new Error('Fixture mode does not start chats.')
      return started
    },
    'lead.prefetch': async () => ({ ok: true }),
    'lead.setMode': async ({ workspaceId, mode }) => {
      const ws = f.workspaces.find((w) => w.id === workspaceId)
      if (!ws) throw new Error('This fixture has no such workspace.')
      ws.leadMode = mode
      return ws
    },
    'lead.linkIssue': async ({ workspaceId, issue }) => {
      const ws = f.workspaces.find((w) => w.id === workspaceId)
      if (!ws) throw new Error('This fixture has no such workspace.')
      ws.source = { kind: 'issue', id: issue, title: ws.title ?? issue }
      return ws
    },
    'threads.list': async ({ roomId }) => (f.threads ?? []).filter((t) => !roomId || t.roomId === roomId),
    'threads.rename': async () => { throw new Error('Fixture mode does not rename chats.') },
    'threads.archivePreview': async ({ threadId }) => {
      const t = f.threads?.find((x) => x.id === threadId)
      const rows = f.workspaces.filter((w) => w.threadId === threadId && w.status !== 'archived')
      // A workspace runs while a chat in it does, as the fixture's pushes say.
      const running = (wsId: string) => f.push.some((e) => e.type === 'chat.running' && e.running && f.chats.some((c) => c.id === e.chatId && c.workspaceId === wsId))
      return { threadId, title: t?.title ?? '', workspaces: [...rows.filter((w) => !w.lead), ...rows.filter((w) => w.lead)].map((w) => ({ id: w.id, name: w.name, own: !!w.lead, running: running(w.id), ...(w.prNumber && !['none', 'merged', 'closed'].includes(w.prState) ? { pr: w.prNumber } : {}), dirty: w.stat?.files ?? 0, unpushed: 0 })) }
    },
    'threads.archive': async () => { throw new Error('Fixture mode does not archive chats.') },
    'openItems.list': async ({ threadId }) => (f.openItems ?? []).filter((i) => i.threadId === threadId),
    'openItems.dismiss': async () => ({ ok: true }),
    'pr.get': async ({ workspaceId }) => f.prs?.[workspaceId] ?? null,
    'pr.create': async ({ workspaceId }) => workspace(workspaceId),
    'pr.refresh': async ({ workspaceId }) => workspace(workspaceId),
    'pr.merge': async ({ workspaceId }) => workspace(workspaceId),
    'reviews.overrule': async ({ workspaceId }) => workspace(workspaceId),
    'pr.resolve': async () => ({ ok: true }),
    'pr.update': async () => ({ ok: true }),
    'pr.ready': async ({ workspaceId }) => workspace(workspaceId),
    'pr.reopen': async ({ workspaceId }) => workspace(workspaceId),
    'pr.continue': async ({ workspaceId }) => ({ ...workspace(workspaceId), prState: 'none', prNumber: undefined, prUrl: undefined }),
    'pr.pendingAll': async () => ({}),
    'scripts.run': async () => ok,
    'scripts.stop': async () => ok,
    'scripts.replay': async () => ok,
    'scripts.resize': async () => ok,
    'scripts.skipSetup': async () => ok,
    'scripts.suggest': async ({ roomId }) => f.scriptSuggestions?.[roomId] ?? [],
    'scripts.askLead': async () => { throw new Error('Fixture mode does not start chats.') },
    'activity.recent': async ({ roomId, limit = 50 }) => f.activity.filter((e) => !roomId || e.roomId === roomId).sort((a, b) => b.ts - a.ts).slice(0, limit),
    'rooms.lastActivity': async ({ roomId }) => {
      const last: Record<string, number> = {}
      for (const e of f.activity) if (e.roomId === roomId && e.agentId) last[e.agentId] = Math.max(last[e.agentId] ?? 0, e.ts)
      return last
    },
    'usage.get': async (_req?: { force?: boolean } | void) => f.usage,
    'usage.notifyOnReset': async () => ok,
    'account.get': async () => account,
    'account.signIn': async () => account,
    'account.signOut': async () => ({ signedIn: false }),
    'providers.status': async ({ provider }) => status(provider),
    'providers.setPath': async ({ provider }) => status(provider),
    'providers.signIn': async ({ provider }) => status(provider),
    'providers.openConfig': async () => ok,
    'accounts.list': async () => f.accounts ?? [],
    'accounts.add': async () => {
      const step = f.push.find((e) => e.type === 'account.add')
      if (!step) throw new Error('Adding an account needs the real app.')
      if (step.type === 'account.add' && step.add.step === 'failed') throw new Error(step.add.error ?? 'Could not add the account.')
      bus.push(step)
      return new Promise<never>(() => undefined)
    },
    'accounts.addKey': async () => { throw new Error('Adding an account needs the real app.') },
    'accounts.code': async () => ok,
    'accounts.cancelAdd': async () => ok,
    'accounts.switch': async () => f.accounts ?? [],
    'accounts.previewSwitch': async ({ provider, accountId }) => f.movePreview ?? { provider, from: (f.accounts ?? []).find((a) => a.provider === provider && a.active)?.id ?? 'cli', to: accountId, chats: [] },
    'accounts.signOut': async () => f.accounts ?? [],
    'accounts.remove': async () => f.accounts ?? [],
    'accounts.checkMcp': async () => f.accounts ?? [],
    'accounts.mcpSignIn': async () => f.accounts ?? [],
    'accounts.mcpSignInAll': async ({ accountId }) => ({ accountId, servers: [], done: [], failed: [], finished: true }),
    'accounts.mcpIgnore': async () => f.mcpAccounts ?? [],
    'accounts.mcpSetUp': async ({ accountId }) => ({ accountId, servers: [], done: [], failed: [], finished: true }),
    'accounts.rename': async ({ accountId, label }) => (f.accounts ?? []).map((a) => (a.id === accountId ? { ...a, label: label.trim() || a.email || a.label } : a)),
    'models.list': async ({ provider }) => f.models?.[provider] ?? (provider === 'claude' ? MODELS.map((m) => ({ provider, id: m.id, label: m.label, legacy: !!m.legacy, efforts: EFFORTS.map((e) => e.id), defaultEffort: 'high' as const })) : []),
    'terminal.presets': async () => presetList(settings.terminal, f.terminalClis ?? []),
    'settings.get': async () => settings,
    'settings.set': async ({ patch }) => {
      if (process.env.KERNEL_SLOW_SETTINGS) await new Promise(() => undefined)
      return (settings = applySettingsPatch(settings, patch))
    },
    'settings.room': async ({ roomId }) => roomSettings(roomId),
    // Auto works on Claude and not on Codex, as on an account that runs it (KERNEL-447).
    'permissions.availability': async () => ({ claude: { auto: true, bypass: true }, codex: { auto: false, bypass: true, reason: CODEX_AUTO } }),
    'settings.setRoom': async ({ roomId, patch, shared }) => {
      // Keeps the change for the life of the fixture, so a toggle in a screenshot run behaves like the real thing. Any group
      // the patch names is applied the same way, and the sources follow the file it was written to. `runScripts` is a list
      // here and a table in the patch, so it is applied by name, with `run` kept as `[scripts] run`.
      const cur = roomSettings(roomId)
      const next: Record<string, unknown> = { ...cur }
      const sources = { ...cur.sources }
      const file = shared ? 'shared' : 'local'
      const other = shared ? 'local' : 'shared'
      const runs = new Map(cur.runScripts.map((r) => [r.name, r.command]))
      // `RUN` and `Run` are `run`, as in the engine.
      if (patch.runScripts) patch = { ...patch, runScripts: Object.fromEntries(Object.entries(patch.runScripts).map(([k, v]) => [isRunName(k) ? 'run' : k, v])) }
      // A preview list with no entry left removes the key, as in the engine (KERNEL-246).
      if (patch.preview?.urls) {
        const urls = previewUrlsOf(patch.preview.urls)
        patch = { ...patch, preview: { urls: urls.length ? urls : null } }
      }
      for (const [group, values] of Object.entries(patch)) {
        const g = group === 'runScripts' ? Object.fromEntries(runs) : { ...(cur as unknown as Record<string, Record<string, unknown> | undefined>)[group] }
        for (const [k, v] of Object.entries(values ?? {})) {
          const path = `${group}.${k}`
          // Removing a key from one file leaves the other file's, as the engine does. The fixture keeps the value it shows.
          if (v === null) {
            if (sources[path] === 'override' || sources[path] === other) sources[path] = other
            else { delete g[k]; delete sources[path] }
          } else {
            g[k] = v
            sources[path] = sources[path] && sources[path] !== file ? 'override' : file
          }
        }
        if (group === 'runScripts') {
          runs.clear()
          for (const [k, v] of Object.entries(g)) if (typeof v === 'string') runs.set(k, v)
        } else next[group] = g
      }
      // `run` is one value with two names: whichever the patch set wins, and its source follows.
      const [from, to] = patch.runScripts && 'run' in patch.runScripts ? ['runScripts.run', 'scripts.run'] : ['scripts.run', 'runScripts.run']
      if (sources[from]) sources[to] = sources[from]
      else delete sources[to]
      const run = from === 'runScripts.run' ? runs.get('run') : (next.scripts as RoomSettings['scripts']).run
      next.scripts = { ...(next.scripts as RoomSettings['scripts']), run }
      next.runScripts = [...(run ? [{ name: 'run', command: run }] : []), ...[...runs].filter(([n]) => n !== 'run').map(([name, command]) => ({ name, command }))]
      f.roomSettings = { ...(f.roomSettings ?? {}), [roomId]: { ...next, sources } as RoomSettings }
      return roomSettings(roomId)
    },
    // Keeps the change for the life of the fixture, as `settings.setRoom` does. `null` puts the default back.
    'settings.setReview': async ({ roomId, review }) => {
      const cur = roomSettings(roomId)
      const defaults = reviewOf(undefined)
      const next = structuredClone(cur.review ?? defaults)
      if (review.rounds !== undefined) next.rounds = review.rounds ?? defaults.rounds
      for (const [kind, own] of Object.entries(review.kinds ?? {}) as [ReviewKind, Record<string, unknown>][]) {
        const k = next.kinds[kind] as unknown as Record<string, unknown>
        for (const [key, v] of Object.entries(own)) if (v !== undefined) k[key] = v ?? (defaults.kinds[kind] as unknown as Record<string, unknown>)[key]
      }
      f.roomSettings = { ...(f.roomSettings ?? {}), [roomId]: { ...cur, review: next } }
      return roomSettings(roomId)
    },
    // Keeps the list for the life of the fixture, as the engine's writer does: trimmed, without blanks or repeats.
    'settings.setAlwaysReview': async ({ roomId, paths }) => {
      f.roomSettings = { ...(f.roomSettings ?? {}), [roomId]: { ...roomSettings(roomId), merge: { alwaysReview: [...new Set(paths.map((p) => p.trim()).filter(Boolean))] } } }
      return roomSettings(roomId)
    },
    'files.preview': async ({ roomId, patterns }) => {
      const { copy, exclude = [] } = roomSettings(roomId).files
      const named = (list: string[], path: string) => list.some((e) => (isPattern(e) ? matchesGlob(path, e) : path === e))
      return (f.localFiles?.[roomId] ?? []).filter((file) => named(patterns ?? copy, file.path) && !named(exclude, file.path))
        .sort((a, b) => a.path.localeCompare(b.path))
    },
    'files.production': async ({ roomId }) => f.production?.[roomId] ?? [],
    'files.keepCopying': async ({ roomId, hints }) => ({ ...room(roomId), keepCopying: hints.map((h) => `${h.path}:${h.name}`) }),
    'shared.list': async ({ roomId, workspaceId, limit }) => (f.shared ?? [])
      .filter((x) => (!roomId || x.roomId === roomId) && (!workspaceId || x.workspaceId === workspaceId))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit ?? undefined),
    'shared.read': async ({ sharedId, version }) => {
      const file = f.shared?.find((x) => x.id === sharedId)
      const v = file?.versions.find((x) => x.n === version)
      if (!file || !v) throw new Error('That shared file or version is gone.')
      const data = f.sharedData?.[sharedId]?.[version]
      return { kind: file.kind, mime: v.mime, ...(data?.text !== undefined ? { text: data.text } : {}), ...(data?.dataUrl ? { dataUrl: data.dataUrl } : {}) }
    },
    'shared.thumb': async ({ sharedId, version }) => f.sharedData?.[sharedId]?.[version]?.thumb ?? null,
    'shared.reveal': async () => ok,
    'shared.open': async () => ok,
    // Nothing is sent: the answer names the chat it would go to, the version's or the workspace's first (KERNEL-310).
    'shared.comment': async ({ sharedId, version }) => {
      const file = f.shared?.find((x) => x.id === sharedId)
      if (!file?.versions.some((x) => x.n === version)) throw new Error('That shared file or version is gone.')
      if (file.kind === 'pdf') throw new Error('PDFs take no comments.')
      const chatId = file.versions.find((x) => x.n === version)?.chatId ?? f.chats.find((c) => c.workspaceId === file.workspaceId && c.kind !== 'terminal')?.id ?? ''
      return { chatId, workspaceId: file.workspaceId, queued: false }
    },
    'shared.comments': async ({ sharedId }) => (f.sharedComments ?? []).filter((c) => c.sharedId === sharedId).sort((a, b) => a.at - b.at),
    // Names only: a fixture holds no values, so there is nothing to reveal (KERNEL-247).
    'env.get': async ({ roomId }) => {
      const scope = roomId ? f.env?.rooms?.[roomId] : { names: f.env?.app }
      return { names: [...(scope?.names ?? [])].sort(), files: roomId ? scope?.files ?? roomSettings(roomId).env.files.map((path) => ({ path, missing: false })) : [] }
    },
    'env.set': async () => ok,
    'env.reveal': async () => { throw new Error('Fixture mode has no values to show.') },
    'mcp.accounts': async () => f.mcpAccounts ?? [],
    'mcp.recheck': async () => f.mcpAccounts ?? [],
    'mcp.list': async ({ provider = 'claude' }) => (f.mcp ?? []).filter((m) => (m.provider ?? 'claude') === provider),
    'integrations.list': async () => f.integrations ?? [],
    'integrations.connect': async ({ id }) => ({ id, name: id, connected: true, detail: '' }),
    'update.get': async () => update,
    'update.check': async () => update,
    'update.install': async () => ok,
    'app.exportLogs': async () => ({ path: '(fixture)' }),
    'app.info': async () => ({ version: '0.1.0', dataDir: join('~', 'Library', 'Application Support', 'Kernel'), telemetry: f.telemetry?.canSend ?? false }),
    'app.openTerminal': async () => ok,
    // A fixed list with no icons, so a screenshot is the same on every Mac. Opening does nothing, but still refuses a path outside the fixture's rooms (KERNEL-427).
    'app.openApps': async () => ({ apps: OPEN_APPS.filter((a) => ['finder', 'vscode', 'cursor', 'terminal'].includes(a.id)).map(({ id, name, kind }) => ({ id, name, kind })), defaultId: 'vscode' }),
    'app.openIn': async ({ path }) => { mustBeInside(path, [...f.rooms, ...f.workspaces].map((x) => x.path)); return ok },
    'app.checkOnline': async () => ({ online: !f.push.some((e) => e.type === 'online' && !e.online) }),
    'telemetry.recent': async () => f.telemetry?.recent ?? [],
    'telemetry.track': async () => ok
  }
  for (const channel of f.hold ?? []) (handlers as Record<string, unknown>)[channel] = () => new Promise<never>(() => undefined)
  // A fixture can make a call fail or answer late, to draw a failed load or catch a call in flight (KERNEL-869).
  for (const channel of Object.keys(handlers) as (keyof Handlers)[]) {
    const fails = f.fails?.[channel]
    const lag = f.lag?.[channel]
    if (fails === undefined && lag === undefined) continue
    const inner = handlers[channel] as (req: unknown) => Promise<unknown>
    ;(handlers as Record<string, unknown>)[channel] = async (req: unknown) => {
      if (lag) await new Promise((r) => setTimeout(r, lag))
      if (fails !== undefined) throw new Error(fails)
      return inner(req)
    }
  }
  return handlers
}

/**
 * The events a fixture replays, with the `script.url` events the engine would push among them: a run script's first local
 * URL right after the line that prints it, and null when it exits (KERNEL-246). A fixture that pushes its own keeps it.
 */
export function fixturePush(f: Fixture): PushEvent[] {
  const out: PushEvent[] = []
  const found = new Set<string>()
  for (const e of f.push) {
    if (e.type === 'script.exit' && e.kind === 'run' && found.delete(JSON.stringify([e.workspaceId, e.name ?? 'run']))) {
      out.push({ type: 'script.url', workspaceId: e.workspaceId, name: e.name ?? 'run', url: null })
    }
    out.push(e)
    if (e.type === 'script.url' && e.url) found.add(JSON.stringify([e.workspaceId, e.name]))
    if (e.type !== 'script.output' || e.kind !== 'run') continue
    const name = e.name ?? 'run'
    const k = JSON.stringify([e.workspaceId, name])
    const url = found.has(k) ? null : e.lines.map((l) => localUrlIn(l.line)).find(Boolean)
    if (url) { found.add(k); out.push({ type: 'script.url', workspaceId: e.workspaceId, name, url }) }
  }
  return out
}
