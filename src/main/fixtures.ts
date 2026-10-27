import { EFFORTS, isRunName, MODELS } from '@shared/types'
import type { AgentDef, Approval, Chat, ChatItem, ClaudeAccount, GithubIssue, HookStatus, LinearIssue, Provider, ProviderStatus, ReviewKind, ProjectSettings, Workspace } from '@shared/types'
import type { Fixture } from '../../fixtures'
import type { PushEvent } from '@shared/ipc'
import { localUrlIn } from '@shared/previewUrl'
import { isLeadWorkspace } from '@shared/leadWorkspace'
import { KERNEL_FILE } from '@shared/team'
import { join, matchesGlob } from 'node:path'
import QRCode from 'qrcode'
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
const fixtureAccount: ClaudeAccount = { signedIn: true, name: 'Sam Rivera', login: 'cjjutba', plan: 'Claude Max' }

/**
 * Fixture mode (KERNEL_FIXTURES): every IPC channel answered from one fixture, with no database, hook server or sessions.
 * Reads serve the fixture. Writes return a plausible value and change nothing, so a screenshot shows the same state every time.
 */
export function fixtureHandlers(f: Fixture): Handlers {
  /** The `mentionsGone` paths already answered once. */
  const asked = new Set<string>()
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
  const project = (id: string) => {
    const r = f.projects.find((x) => x.id === id)
    if (!r) throw new Error(`Unknown project ${id}`)
    return r
  }
  const agentOf = (projectId: string, id: string): AgentDef => {
    const a = f.agents[projectId]?.find((x) => x.id === id)
    if (!a) throw new Error(`Unknown agent ${id}`)
    return a
  }
  /** The fixture's personal and plugin agents, once each, as `agents.listGlobal` gives them with no project (KERNEL-640). */
  const globalAgents = (): AgentDef[] => {
    const all = Object.values(f.agents).flat().filter((a) => a.origin === 'personal' || a.origin === 'plugin')
    return [...new Map(all.map((a) => [a.id, a])).values()].sort((a, b) => Number(a.origin === 'plugin') - Number(b.origin === 'plugin'))
  }
  /** The workspace of the project's newest open Lead chat, the one `lead.open` finds (KERNEL-405). */
  const leadWs = (projectId: string) => {
    const lead = f.agents[projectId]?.find((a) => a.lead)
    return f.workspaces.filter((w) => w.projectId === projectId && isLeadWorkspace(w, lead?.id)).at(-1)
  }
  let settings = f.settings ?? DEFAULT_SETTINGS('/Users/you')
  const hooks: HookStatus = f.hooks ?? { port: settings.hookPort, listening: true, installed: true, events: [] }
  const update = f.update ?? { status: 'idle' as const, current: '0.1.0' }
  const account = f.account ?? fixtureAccount
  const projectSettings = (projectId: string): ProjectSettings => {
    const rs = f.projectSettings?.[projectId] ?? { scripts: {}, files: { copy: ['.env', '.env.local'] }, workspace: {} }
    // Like the engine, `run` comes first, from `[scripts] run`.
    const runScripts = rs.runScripts ?? (rs.scripts.run ? [{ name: 'run', command: rs.scripts.run }] : [])
    return { ...rs, runScripts, disabled: { skills: [], mcp: [], ...rs.disabled }, preview: { urls: rs.preview?.urls ?? [] }, env: { files: rs.env?.files ?? [] }, references: rs.references ?? [], review: rs.review ?? reviewOf(undefined), merge: rs.merge ?? { alwaysReview: [] }, sources: rs.sources ?? {} }
  }
  /** A provider's status table: the fixture's, else Kernel's bundled copy, signed in (KERNEL-406). */
  const status = (provider: Provider): ProviderStatus => f.providerStatus?.[provider] ?? { provider, source: 'bundled', signedIn: true, configFile: '' }
  /** Queued messages a fixture run removed, so Remove and Stop leave them out of the next read. */
  const unqueued = new Set<string>()
  const saved = new Map<string, ChatItem[]>()
  const queue = (chatId: string) => (f.queue?.[chatId] ?? []).filter((q) => !unqueued.has(q.id))
  const decided = (a: Approval, d: Parameters<Handlers['approvals.decide']>[0]['decision']): Approval =>
    d.behavior === 'answer' ? { ...a, status: 'answered', answer: d.text } : { ...a, status: d.behavior === 'allow' ? 'allowed' : 'denied' }

  const handlers: Handlers = {
    'evidence.pr': async ({ workspaceId }) => f.evidence?.[workspaceId] ?? null,
    'attention.plan': async ({ approvalId }) => f.attention?.[approvalId] ?? ({ prsMerged: 0, needed: 0, byKind: { plan: 0, tool: 0, question: 0, blocker: 0, merge: 0 }, finished: false }),
    'preflight.run': async () => f.preflight,
    'preflight.fix': async () => { if (f.preflightFixError) throw new Error(f.preflightFixError); return f.preflight },
    'hooks.install': async () => ({ path: '(fixture)', events: [] }),
    'hooks.uninstall': async () => f.hooks ?? { port: 7420, listening: true, installed: false, events: [] },
    'hooks.turnOn': async () => ({ ...hooks, problem: undefined }),
    'hooks.status': async () => hooks,
    'github.status': async () => f.github ?? {},
    'github.auth': async () => {
      const gh = f.preflight.find((c) => c.id === 'gh')
      const login = /as ([^\s,]+)/.exec(gh?.detail ?? '')?.[1]
      return gh?.ok ? { state: 'ok', ...(login ? { login } : {}) } : { state: 'signed-out' }
    },
    'hooks.test': async () => hooks,
    'hooks.restart': async () => hooks,
    'projects.list': async () => f.projects,
    'projects.add': async ({ path, name }) => f.projects.find((r) => r.path === path) ?? { id: 'fixture-project', name: name ?? path.split('/').pop() ?? path, path, defaultBranch: 'main', paused: false, createdAt: Date.now() },
    'projects.create': async ({ name, desc, source, from }) => ({ id: 'fixture-project', name, desc, kind: source, path: from, defaultBranch: 'main', paused: false, createdAt: Date.now() }),
    'projects.retrySetup': async () => {
      for (const step of f.afterRetry ?? []) setTimeout(() => step.events.forEach((e) => bus.push(e)), step.afterMs)
      return ok
    },
    'projects.setupLog': async ({ projectId }) => f.setupLogs?.[projectId] ?? '',
    'projects.update': async ({ projectId, patch }) => ({ ...project(projectId), ...patch }),
    'projects.setIcon': async ({ projectId, icon }) => {
      const { icon: _old, ...r } = project(projectId)
      return icon.kind === 'letter' ? r : { ...r, icon: { kind: icon.kind, file: `${projectId}-fixture.png`, at: Date.now() } }
    },
    'projects.icon': async ({ projectId }) => (project(projectId).icon ? f.projectIcons?.[projectId] ?? null : null),
    'projects.remove': async () => ok,
    'projects.setPaused': async ({ projectId, paused }) => ({ ...project(projectId), paused }),
    'projects.brief': async ({ projectId, agentId }) => {
      const lead = f.agents[projectId]?.find((a) => a.lead)
      const ws = f.workspaces.find((w) => w.projectId === projectId && w.agentId === (agentId ?? lead?.id) && w.status !== 'archived')
      const c = ws && f.chats.find((x) => x.workspaceId === ws.id)
      if (!ws || !c) throw new Error('This fixture has no chat for that agent.')
      return { chatId: c.id, workspaceId: ws.id }
    },
    'projects.overlaps': async ({ projectId }) => (f.overlaps ?? []).filter((o) => o.projectId === projectId),
    'projects.resolveOverlap': async () => ok,
    'projects.inspectFolder': async ({ path }) => f.folders?.find((x) => x.path === path) ?? { path, git: true, branch: 'main', dirty: 0 },
    'projects.recentFolders': async () => f.folders ?? [],
    'projects.pushCheck': async ({ projectId }) => f.pushChecks?.[projectId] ?? null,
    'github.repos': async ({ query }) => (f.repos ?? []).filter((r) => !query || r.fullName.includes(query)),
    'github.avatar': async ({ owner }) => f.avatars?.[owner] ?? null,
    'github.owners': async () => f.githubOwners ?? [{ login: 'cjjutba', org: false }],
    'github.repoAvailable': async ({ owner, name }) => (f.takenRepos ?? []).includes(`${owner}/${name}`) ? { available: false, reason: `${owner}/${name} already exists.` } : { available: true },
    'agents.list': async ({ projectId, retired }) => (f.agents[projectId] ?? []).filter((a) => !!a.retired === !!retired),
    'agents.status': async ({ projectId }) => f.status[projectId] ?? {},
    'agents.save': async ({ projectId, agentId, patch }) => ({ ...agentOf(projectId, agentId), ...patch }),
    'agents.listGlobal': async () => globalAgents(),
    'agents.saveGlobal': async ({ agentId, patch }) => {
      const a = globalAgents().find((x) => x.id === agentId)
      if (!a) throw new Error(`${agentId} is not in ~/.claude/agents.`)
      return { ...a, ...patch }
    },
    'agents.draft': async ({ description, name, model }) => draftAgent({ description, name, model }),
    'agents.create': async ({ projectId, draft, scope }) => {
      if (projectId) return { ...agentFromFile(draft.file, draft.text), joinedAt: Date.now() }
      if (scope === 'team') throw new Error("A team agent is saved in a project's repo. Open a project to add one.")
      return { ...agentFromFile(`~/.claude/agents/${draft.id}.md`, draft.text), origin: 'personal', joinedAt: Date.now() }
    },
    'agents.retire': async () => ok,
    'agents.restore': async ({ projectId, agentId }) => ({ ...agentOf(projectId, agentId), retired: false }),
    'agents.seed': async ({ projectId }) => f.agents[projectId] ?? [],
    'agents.setTeam': async ({ projectId }) => f.agents[projectId] ?? [],
    'agents.customize': async ({ projectId, agentId }) => ({ ...agentOf(projectId, agentId), file: join('.claude', 'agents', KERNEL_FILE) }),
    'agents.resetLead': async ({ projectId }) => (f.agents[projectId] ?? []).filter((a) => !a.retired),
    'agents.moveLead': async ({ projectId }) => (f.agents[projectId] ?? []).filter((a) => !a.retired),
    'agents.addStarter': async ({ id }) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), role: '', description: '', lead: false, prompt: '', file: join('.claude', 'agents', `${id}.md`), joinedAt: Date.now() }),
    'workspaces.list': async ({ projectId }) => f.workspaces.filter((w) => !projectId || w.projectId === projectId),
    'workspaces.create': async () => { throw new Error('Fixture mode does not create workspaces.') },
    'workspaces.fork': async () => { throw new Error('Fixture mode does not create workspaces.') },
    'workspaces.retryWorktree': async () => { throw new Error('Fixture mode does not make worktrees.') },
    'workspaces.archive': async () => ok,
    'workspaces.restore': async ({ workspaceId }) => ({ ...workspace(workspaceId), status: 'ready' }),
    'workspaces.deletePreview': async ({ workspaceIds }) => f.deletePreview ?? { workspaces: workspaceIds.length, skipped: [], unpushedBranches: 0, unpushed: [], transcriptBytes: 640 * 1024 * 1024 },
    'workspaces.delete': async ({ workspaceIds }) => ({ deleted: workspaceIds, skipped: [], keptBranches: 0, freedBytes: 0 }),
    'workspaces.gitStatus': async ({ workspaceId }) => {
      if (f.gitStatus?.[workspaceId]) return f.gitStatus[workspaceId]
      const files = f.changes[workspaceId] ?? []
      return { branch: workspace(workspaceId).branch, ahead: 0, behind: 0, dirty: { files: files.length, added: files.reduce((n, c) => n + c.added, 0), removed: files.reduce((n, c) => n + c.removed, 0) } }
    },
    // A compare pick reads its own files when the fixture has them (Pen 9.21), else the workspace's changes.
    'workspaces.changes': async ({ workspaceId, target }) => (target && target.kind !== 'base' ? f.changesAgainst?.[workspaceId]?.[target.kind] : undefined) ?? f.changes[workspaceId] ?? [],
    // A fixture can give a file its own diff under `<workspace id>:<path>`.
    'workspaces.diff': async ({ workspaceId, file }) => (file ? f.diffs[`${workspaceId}:${file}`] : undefined) ?? f.diffs[workspaceId] ?? '',
    'workspaces.commits': async ({ workspaceId }) => f.commits?.[workspaceId] ?? [],
    'workspaces.compareBranches': async ({ workspaceId }) => [...new Set([workspace(workspaceId).baseRef, ...(f.branches ?? [])])],
    'workspaces.tree': async ({ workspaceId }) => f.tree?.[workspaceId] ?? [],
    'workspaces.files': async ({ workspaceId, query, limit = 8 }) => (f.tree?.[workspaceId] ?? []).filter((e) => e.path.toLowerCase().includes(query.toLowerCase())).slice(0, limit),
    'workspaces.readFile': async ({ workspaceId, path }) => {
      const refused = f.fileErrors?.[workspaceId]?.[path]
      if (refused) throw new Error(refused)
      return f.fileText?.[workspaceId]?.[path] ?? ''
    },
    // A fixture's mentions resolve to the rows of its tree, by exact path.
    'workspaces.resolvePaths': async ({ workspaceId, paths }) => Object.fromEntries(paths.map((p) => {
      if (f.mentionsGone?.[workspaceId]?.includes(p)) {
        if (asked.has(`${workspaceId}:${p}`)) return [p, null]
        asked.add(`${workspaceId}:${p}`)
      }
      const m = f.mentions?.[workspaceId]?.[p]
      if (m !== undefined) return [p, m]
      const e = f.tree?.[workspaceId]?.find((t) => t.path === p)
      return [p, e ? { kind: e.dir ? 'dir' : 'file', path: e.path } : null]
    })),
    'workspaces.readImage': async ({ workspaceId, path, at }) => f.images?.[workspaceId]?.[`${at}:${path}`] ?? null,
    'workspaces.hunks': async ({ workspaceId, path }) => (f.hunks?.[workspaceId] ?? []).filter((h) => !path || h.path === path),
    'workspaces.commit': async () => ok,
    'workspaces.discard': async () => ok,
    'git.branches': async ({ projectId }) => f.branches ?? [...new Set(f.workspaces.filter((w) => w.projectId === projectId).map((w) => w.branch))],
    // Newest first, a few days apart, so the branch menu shows ages.
    'git.branchList': async ({ projectId }) => (f.branches ?? [...new Set(f.workspaces.filter((w) => w.projectId === projectId).map((w) => w.branch))]).map((name, i) => ({ name, committedAt: Date.now() - (i * 3 + 1) * 86_400_000 })),
    'github.prs': async ({ query }) => (f.openPrs ?? []).filter((p) => !query || `#${p.number} ${p.title} ${p.author ?? ''}`.toLowerCase().includes(query.toLowerCase())),
    'github.issues': async ({ query }) => (f.issues ?? []).filter((i) => i.source === 'github' && (!query || `${i.id} ${i.title}`.toLowerCase().includes(query.toLowerCase()))),
    'issues.list': async ({ projectId, query }) => (f.issues?.filter((i) => i.source !== 'github') ?? (f.tasks?.[projectId] ?? []).map((t) => ({ id: t.id, title: t.title }))).filter((i) => !query || `${i.id} ${i.title}`.toLowerCase().includes(query.toLowerCase())),
    'issues.next': async ({ projectId }) => f.issues?.filter((i) => i.source !== 'github') ?? (f.tasks?.[projectId] ?? []).map((t) => ({ id: t.id, title: t.title })),
    'issues.taken': async () => f.issueTaken ?? { findings: [], notes: [] },
    'issues.tracker': async ({ projectId }) => f.trackers?.[projectId] ?? { kind: 'linear', available: { linear: true } },
    'github.issueList': async ({ projectId, query }) => (f.githubIssues?.[projectId] ?? [])
      .filter((i) => !query || `${i.id} ${i.title} ${i.author ?? ''}`.toLowerCase().includes(query.replace(/^#/, '').toLowerCase()))
      .map(({ body: _b, comments: _c, ...issue }): GithubIssue => issue),
    'github.issue': async ({ projectId, id }) => {
      const issue = f.githubIssues?.[projectId]?.find((i) => i.id === id)
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
    'linear.plan': async ({ projectId }) => {
      const ws = leadWs(projectId)
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
    // What the engine saved: the fixture's items, then the rows its `after` events pushed, so a reload keeps them.
    'chats.items': async ({ chatId }) => [...(f.items[chatId] ?? []), ...(saved.get(chatId) ?? [])],
    'chats.send': async ({ parts, clientId }) => {
      for (const step of f.afterSend ?? []) setTimeout(() => step.events.forEach((e) => bus.push(e)), step.afterMs)
      // A message sent now comes back with its row, as the engine's does (KERNEL-894).
      return { queued: false, item: { kind: 'user', id: clientId ?? `fixture-${Date.now()}`, ts: Date.now(), parts } }
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
    'chats.queue': async ({ chatId }) => queue(chatId),
    'chats.queueReason': async () => null,
    'chats.moveNotice': async ({ chatId }) => f.moveNotices?.[chatId] ?? null,
    'chats.moveChoice': async ({ chatId, choice }) => ({ ...chat(chatId), moveChoice: { choice, at: Date.now() } }),
    // A fixture has no process and reads no policy, so every mode is available and nothing waits for a turn.
    'chats.runMode': async ({ chatId }) => {
      const c = chat(chatId)
      const ws = workspace(c.workspaceId)
      return chatMode(c, ws, project(ws.projectId), settings, { auto: true, bypass: true }, f.agents[ws.projectId]?.find((a) => a.id === ws.agentId))
    },
    // A fixture's running chats, retries, script lines and terminal output come from its push events.
    'chats.live': async () => ({ running: [], retry: {} }),
    'chats.unqueue': async ({ chatId, id }) => {
      unqueued.add(id)
      bus.push({ type: 'chat.queue', chatId, queue: queue(chatId) })
      return queue(chatId)
    },
    'chats.sendNow': async ({ chatId, id }) => queue(chatId).filter((q) => q.id !== id),
    'chats.steer': async ({ chatId, id }) => ({ steered: true, queued: false, queue: queue(chatId).filter((q) => q.id !== id) }),
    'skills.list': async () => f.skills ?? [],
    'commands.list': async () => [],
    'terminal.write': async () => ok,
    'terminal.resize': async () => ok,
    'terminal.replay': async () => ok,
    'terminal.close': async () => ok,
    'terminal.shells': async () => [],
    'checkpoints.list': async ({ workspaceId }) => f.checkpoints?.[workspaceId] ?? [],
    'checkpoints.preview': async ({ workspaceId, checkpointId }) => f.checkpointPreviews?.[workspaceId]?.[checkpointId] ?? { files: [], stat: { files: 0, added: 0, removed: 0 }, commitsAhead: 0, pushed: false, conflicts: [] },
    'checkpoints.revert': async ({ workspaceId }) => ({ backupBranch: `backup/${workspace(workspaceId).name}` }),
    'approvals.list': async ({ projectId }) => f.approvals.filter((a) => !projectId || a.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt),
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
    'tasks.list': async ({ projectId }) => f.tasks?.[projectId] ?? [],
    'notifications.list': async () => f.notifications ?? [],
    'notifications.playSound': async () => ({ ok: true }),
    'notifications.read': async ({ ids }) => (f.notifications ?? []).map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read: true } : n)),
    'lead.open': async ({ projectId }) => {
      if (!f.agents[projectId]?.some((a) => a.lead)) throw new Error('This fixture has no Kernel.')
      return leadWs(projectId) ?? null
    },
    'lead.start': async () => {
      const started = f.chats.find((c) => c.id === f.leadStart)
      if (!started) throw new Error('Fixture mode does not start chats.')
      return started
    },
    'lead.prefetch': async () => ({ ok: true }),
    'lead.retryCopy': async () => { throw new Error('Fixture mode does not make working copies.') },
    'threads.list': async ({ projectId }) => (f.threads ?? []).filter((t) => !projectId || t.projectId === projectId),
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
    'scripts.suggest': async ({ projectId }) => f.scriptSuggestions?.[projectId] ?? [],
    'scripts.askLead': async () => { throw new Error('Fixture mode does not start chats.') },
    'activity.recent': async ({ projectId, limit = 50 }) => f.activity.filter((e) => !projectId || e.projectId === projectId).sort((a, b) => b.ts - a.ts).slice(0, limit),
    'projects.lastActivity': async ({ projectId }) => {
      const last: Record<string, number> = {}
      for (const e of f.activity) if (e.projectId === projectId && e.agentId) last[e.agentId] = Math.max(last[e.agentId] ?? 0, e.ts)
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
    'accounts.signOut': async () => f.accounts ?? [],
    'accounts.remove': async () => f.accounts ?? [],
    'accounts.checkMcp': async () => f.accounts ?? [],
    'accounts.mcpSignIn': async () => f.accounts ?? [],
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
    'settings.project': async ({ projectId }) => projectSettings(projectId),
    // Auto works on Claude and not on Codex, as on an account that runs it (KERNEL-447).
    'permissions.availability': async () => ({ claude: { auto: true, bypass: true }, codex: { auto: false, bypass: true, reason: CODEX_AUTO } }),
    'settings.setProject': async ({ projectId, patch, shared }) => {
      // Keeps the change for the life of the fixture, so a toggle in a screenshot run behaves like the real thing. Any group
      // the patch names is applied the same way, and the sources follow the file it was written to. `runScripts` is a list
      // here and a table in the patch, so it is applied by name, with `run` kept as `[scripts] run`.
      const cur = projectSettings(projectId)
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
      const run = from === 'runScripts.run' ? runs.get('run') : (next.scripts as ProjectSettings['scripts']).run
      next.scripts = { ...(next.scripts as ProjectSettings['scripts']), run }
      next.runScripts = [...(run ? [{ name: 'run', command: run }] : []), ...[...runs].filter(([n]) => n !== 'run').map(([name, command]) => ({ name, command }))]
      f.projectSettings = { ...(f.projectSettings ?? {}), [projectId]: { ...next, sources } as ProjectSettings }
      return projectSettings(projectId)
    },
    // Keeps the change for the life of the fixture, as `settings.setProject` does. `null` puts the default back.
    'settings.setReview': async ({ projectId, review }) => {
      const cur = projectSettings(projectId)
      const defaults = reviewOf(undefined)
      const next = structuredClone(cur.review ?? defaults)
      if (review.rounds !== undefined) next.rounds = review.rounds ?? defaults.rounds
      for (const [kind, own] of Object.entries(review.kinds ?? {}) as [ReviewKind, Record<string, unknown>][]) {
        const k = next.kinds[kind] as unknown as Record<string, unknown>
        for (const [key, v] of Object.entries(own)) if (v !== undefined) k[key] = v ?? (defaults.kinds[kind] as unknown as Record<string, unknown>)[key]
      }
      f.projectSettings = { ...(f.projectSettings ?? {}), [projectId]: { ...cur, review: next } }
      return projectSettings(projectId)
    },
    // Keeps the list for the life of the fixture, as the engine's writer does: trimmed, without blanks or repeats.
    'settings.setAlwaysReview': async ({ projectId, paths }) => {
      f.projectSettings = { ...(f.projectSettings ?? {}), [projectId]: { ...projectSettings(projectId), merge: { alwaysReview: [...new Set(paths.map((p) => p.trim()).filter(Boolean))] } } }
      return projectSettings(projectId)
    },
    'files.preview': async ({ projectId, patterns }) => {
      const { copy, exclude = [] } = projectSettings(projectId).files
      const named = (list: string[], path: string) => list.some((e) => (isPattern(e) ? matchesGlob(path, e) : path === e))
      return (f.localFiles?.[projectId] ?? []).filter((file) => named(patterns ?? copy, file.path) && !named(exclude, file.path))
        .sort((a, b) => a.path.localeCompare(b.path))
    },
    'files.production': async ({ projectId }) => f.production?.[projectId] ?? [],
    'files.keepCopying': async ({ projectId, hints }) => ({ ...project(projectId), keepCopying: hints.map((h) => `${h.path}:${h.name}`) }),
    'shared.list': async ({ projectId, workspaceId, limit }) => (f.shared ?? [])
      .filter((x) => (!projectId || x.projectId === projectId) && (!workspaceId || x.workspaceId === workspaceId))
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
    'env.get': async ({ projectId }) => {
      const scope = projectId ? f.env?.projects?.[projectId] : { names: f.env?.app }
      return { names: [...(scope?.names ?? [])].sort(), files: projectId ? scope?.files ?? projectSettings(projectId).env.files.map((path) => ({ path, missing: false })) : [] }
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
    // A fixed list with no icons, so a screenshot is the same on every Mac. Opening does nothing, but still refuses a path outside the fixture's projects (KERNEL-427).
    'app.openApps': async () => ({ apps: OPEN_APPS.filter((a) => ['finder', 'vscode', 'cursor', 'terminal'].includes(a.id)).map(({ id, name, kind }) => ({ id, name, kind })), defaultId: 'vscode' }),
    'app.openIn': async ({ path }) => { mustBeInside(path, [...f.projects, ...f.workspaces].map((x) => x.path)); return ok },
    'app.checkOnline': async () => ({ online: !f.push.some((e) => e.type === 'online' && !e.online) }),
    'telemetry.recent': async () => f.telemetry?.recent ?? [],
    'telemetry.track': async () => ok,
    'remote.status': async () => f.remote?.status ?? { enabled: false, running: false },
    'remote.pair': async () => {
      const url = `${f.remote?.status?.url ?? 'http://127.0.0.1:47100'}/#pair=Zk3vQ9mT2xL8aRb6Yp1NcWd4HsE`
      return { url, qr: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), expiresAt: Date.now() + 5 * 60_000 }
    },
    'remote.devices': async () => f.remote?.devices ?? [],
    'remote.revoke': async () => ok
  }
  for (const channel of f.hold ?? []) (handlers as Record<string, unknown>)[channel] = () => new Promise<never>(() => undefined)
  // A fixture can make a call fail or answer late, to draw a failed load or catch a call in flight (KERNEL-869).
  for (const channel of Object.keys(handlers) as (keyof Handlers)[]) {
    const fails = f.fails?.[channel]
    const lag = f.lag?.[channel]
    const after = f.after?.[channel]
    if (fails === undefined && lag === undefined && !after) continue
    const inner = handlers[channel] as (req: unknown) => Promise<unknown>
    ;(handlers as Record<string, unknown>)[channel] = async (req: unknown) => {
      if (lag) await new Promise((r) => setTimeout(r, lag))
      if (fails !== undefined) throw new Error(fails)
      const res = await inner(req)
      for (const step of after ?? []) setTimeout(() => step.events.forEach((e) => { const x = filled(e, req as Record<string, unknown>, f); if (x.type === 'chat.item') saved.set(x.chatId, [...(saved.get(x.chatId) ?? []).filter((i) => i.id !== x.item.id), x.item]); bus.push(x) }), step.afterMs)
      return res
    }
  }
  return handlers
}

/** An event of `Fixture.after` with the call's message put in: `$id`, `$parts` and `$now`. A queued message's parts come from the fixture's queue for Send now. */
function filled(e: PushEvent, req: Record<string, unknown>, f: Fixture): PushEvent {
  // A window that sent no id gets a row under a new one, as the engine does.
  const id = ((req.clientId ?? req.id) as string | undefined) ?? `engine-${Date.now()}`
  const parts = req.parts ?? Object.values(f.queue ?? {}).flat().find((q) => q.id === req.id)?.parts ?? []
  const fill = (v: unknown): unknown => {
    if (v === '$id') return id
    if (v === '$parts') return parts
    if (v === '$now') return Date.now()
    if (Array.isArray(v)) return v.map(fill)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
    return v
  }
  return fill(e) as PushEvent
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
