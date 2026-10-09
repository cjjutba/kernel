import type { AgentDef, Approval, Chat, ClaudeAccount, HookStatus, Workspace } from '@shared/types'
import type { Fixture } from '../../fixtures'
import { join } from 'node:path'
import type { Handlers } from './kernel'
import { applySettingsPatch, DEFAULT_SETTINGS } from './services/settings'
import { agentFromFile, draftAgent } from './services/agents'

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
  /** The Lead's own workspace on the main checkout, the one `Kernel.leadChat` finds. */
  const leadWs = (roomId: string) => {
    const lead = f.agents[roomId]?.find((a) => a.lead)
    return f.workspaces.find((w) => w.roomId === roomId && w.agentId === lead?.id && w.mode === 'current' && w.status !== 'archived')
  }
  let settings = f.settings ?? DEFAULT_SETTINGS('/Users/you')
  const hooks: HookStatus = f.hooks ?? { port: settings.hookPort, listening: true, installed: true, events: [] }
  const update = f.update ?? { status: 'idle' as const, current: '0.1.0' }
  const account = f.account ?? fixtureAccount
  const roomSettings = (roomId: string) => f.roomSettings?.[roomId] ?? { scripts: {}, files: { copy: ['.env', '.env.local'] }, workspace: {} }
  const queue = (chatId: string) => f.queue?.[chatId] ?? []
  const decided = (a: Approval, d: Parameters<Handlers['approvals.decide']>[0]['decision']): Approval =>
    d.behavior === 'answer' ? { ...a, status: 'answered', answer: d.text } : { ...a, status: d.behavior === 'allow' ? 'allowed' : 'denied' }

  return {
    'preflight.run': async () => f.preflight,
    'preflight.fix': async () => f.preflight,
    'hooks.install': async () => ({ path: '(fixture)', events: [] }),
    'hooks.uninstall': async () => f.hooks ?? { port: 7420, listening: true, installed: false, events: [] },
    'hooks.status': async () => hooks,
    'hooks.test': async () => hooks,
    'hooks.restart': async () => hooks,
    'rooms.list': async () => f.rooms,
    'rooms.add': async ({ path, name }) => f.rooms.find((r) => r.path === path) ?? { id: 'fixture-room', name: name ?? path.split('/').pop() ?? path, path, defaultBranch: 'main', paused: false, createdAt: Date.now() },
    'rooms.create': async ({ name, desc, source, from }) => ({ id: 'fixture-room', name, desc, kind: source, path: from, defaultBranch: 'main', paused: false, createdAt: Date.now() }),
    'rooms.update': async ({ roomId, patch }) => ({ ...room(roomId), ...patch }),
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
    'github.repos': async ({ query }) => (f.repos ?? []).filter((r) => !query || r.fullName.includes(query)),
    'agents.list': async ({ roomId, retired }) => (f.agents[roomId] ?? []).filter((a) => !!a.retired === !!retired),
    'agents.status': async ({ roomId }) => f.status[roomId] ?? {},
    'agents.save': async ({ roomId, agentId, patch }) => ({ ...agentOf(roomId, agentId), ...patch }),
    'agents.draft': async ({ description, name, model }) => draftAgent({ description, name, model }),
    'agents.create': async ({ draft }) => ({ ...agentFromFile(draft.file, draft.text), joinedAt: Date.now() }),
    'agents.retire': async () => ok,
    'agents.restore': async ({ roomId, agentId }) => ({ ...agentOf(roomId, agentId), retired: false }),
    'agents.seed': async ({ roomId }) => f.agents[roomId] ?? [],
    'workspaces.list': async ({ roomId }) => f.workspaces.filter((w) => !roomId || w.roomId === roomId),
    'workspaces.create': async () => { throw new Error('Fixture mode does not create workspaces.') },
    'workspaces.archive': async () => ok,
    'workspaces.restore': async ({ workspaceId }) => ({ ...workspace(workspaceId), status: 'ready' }),
    'workspaces.gitStatus': async ({ workspaceId }) => {
      if (f.gitStatus?.[workspaceId]) return f.gitStatus[workspaceId]
      const files = f.changes[workspaceId] ?? []
      return { branch: workspace(workspaceId).branch, ahead: 0, behind: 0, dirty: { files: files.length, added: files.reduce((n, c) => n + c.added, 0), removed: files.reduce((n, c) => n + c.removed, 0) } }
    },
    'workspaces.changes': async ({ workspaceId }) => f.changes[workspaceId] ?? [],
    'workspaces.diff': async ({ workspaceId }) => f.diffs[workspaceId] ?? '',
    'workspaces.tree': async ({ workspaceId }) => f.tree?.[workspaceId] ?? [],
    'workspaces.files': async ({ workspaceId, query, limit = 8 }) => (f.tree?.[workspaceId] ?? []).filter((e) => !e.dir && e.path.toLowerCase().includes(query.toLowerCase())).slice(0, limit),
    'workspaces.readFile': async ({ workspaceId, path }) => f.fileText?.[workspaceId]?.[path] ?? '',
    'workspaces.hunks': async ({ workspaceId, path }) => (f.hunks?.[workspaceId] ?? []).filter((h) => !path || h.path === path),
    'workspaces.commit': async () => ok,
    'workspaces.discard': async () => ok,
    'git.branches': async ({ roomId }) => f.branches ?? [...new Set(f.workspaces.filter((w) => w.roomId === roomId).map((w) => w.branch))],
    'github.prs': async ({ query }) => (f.openPrs ?? []).filter((p) => !query || `#${p.number} ${p.title} ${p.author ?? ''}`.toLowerCase().includes(query.toLowerCase())),
    'github.issues': async ({ query }) => (f.issues ?? []).filter((i) => i.source === 'github' && (!query || `${i.id} ${i.title}`.toLowerCase().includes(query.toLowerCase()))),
    'issues.list': async ({ roomId, query }) => (f.issues?.filter((i) => i.source !== 'github') ?? (f.tasks?.[roomId] ?? []).map((t) => ({ id: t.id, title: t.title }))).filter((i) => !query || `${i.id} ${i.title}`.toLowerCase().includes(query.toLowerCase())),
    'chats.list': async ({ workspaceId }) => f.chats.filter((c) => c.workspaceId === workspaceId),
    'chats.create': async ({ workspaceId, kind }) => {
      const first = f.chats.find((c) => c.workspaceId === workspaceId)
      if (!first) throw new Error(`Unknown workspace ${workspaceId}`)
      return { ...first, id: `fixture-chat-${Date.now()}`, kind: kind ?? 'chat', title: kind === 'terminal' ? 'Terminal (claude)' : 'New chat', sessionId: undefined, plan: false }
    },
    'chats.items': async ({ chatId }) => f.items[chatId] ?? [],
    'chats.send': async () => ({ queued: false }),
    'chats.interrupt': async () => ok,
    'chats.configure': async ({ chatId, ...patch }) => ({ ...chat(chatId), ...patch }),
    'chats.rename': async ({ chatId, title }) => ({ ...chat(chatId), title }),
    'chats.close': async () => ok,
    'chats.fork': async ({ chatId, itemId }) => {
      const c = chat(chatId)
      return { ...c, id: `fixture-fork-${Date.now()}`, title: `Fork of ${c.title}`, sessionId: undefined, forkOf: { chatId, itemId: itemId ?? (f.items[chatId]?.at(-1)?.id ?? '') } }
    },
    'chats.retry': async () => ok,
    'chats.compact': async () => ok,
    'chats.restart': async () => ok,
    'chats.queue': async ({ chatId }) => queue(chatId),
    'chats.unqueue': async ({ chatId, id }) => queue(chatId).filter((q) => q.id !== id),
    'chats.sendNow': async ({ chatId, id }) => queue(chatId).filter((q) => q.id !== id),
    'skills.list': async () => f.skills ?? [],
    'commands.list': async () => [],
    'terminal.write': async () => ok,
    'terminal.resize': async () => ok,
    'checkpoints.list': async ({ workspaceId }) => f.checkpoints?.[workspaceId] ?? [],
    'checkpoints.revert': async ({ workspaceId }) => ({ backupBranch: `backup/${workspace(workspaceId).name}` }),
    'approvals.list': async ({ roomId }) => f.approvals.filter((a) => !roomId || a.roomId === roomId).sort((a, b) => b.createdAt - a.createdAt),
    'approvals.decide': async ({ id, decision }) => {
      const a = f.approvals.find((x) => x.id === id)
      if (!a) throw new Error('This request already timed out or was answered.')
      return decided(a, decision)
    },
    'approvals.planFile': async ({ id }) => {
      const a = f.approvals.find((x) => x.id === id)
      const ws = a?.workspaceId ? workspace(a.workspaceId) : undefined
      if (!a?.planFile || !ws) throw new Error('This plan has no file.')
      return { path: join(ws.path, a.planFile), relative: a.planFile }
    },
    'tasks.list': async ({ roomId }) => f.tasks?.[roomId] ?? [],
    'notifications.list': async () => f.notifications ?? [],
    'notifications.read': async ({ ids }) => (f.notifications ?? []).map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read: true } : n)),
    'lead.ask': async ({ roomId }) => {
      const ws = leadWs(roomId)
      const c = ws && f.chats.find((x) => x.workspaceId === ws.id)
      if (!c) throw new Error('This fixture has no chat for the Lead.')
      return { chatId: c.id }
    },
    'lead.open': async ({ roomId }) => {
      const ws = leadWs(roomId)
      if (!ws) throw new Error('This fixture has no workspace for the Lead.')
      return ws
    },
    'lead.start': async () => { throw new Error('Fixture mode does not start chats.') },
    'pr.get': async ({ workspaceId }) => f.prs?.[workspaceId] ?? null,
    'pr.create': async ({ workspaceId }) => workspace(workspaceId),
    'pr.refresh': async ({ workspaceId }) => workspace(workspaceId),
    'pr.merge': async ({ workspaceId }) => workspace(workspaceId),
    'pr.resolve': async () => ({ ok: true }),
    'pr.ready': async ({ workspaceId }) => workspace(workspaceId),
    'pr.reopen': async ({ workspaceId }) => workspace(workspaceId),
    'pr.continue': async ({ workspaceId }) => ({ ...workspace(workspaceId), prState: 'none', prNumber: undefined, prUrl: undefined }),
    'scripts.run': async () => ok,
    'scripts.stop': async () => ok,
    'activity.recent': async ({ roomId, limit = 50 }) => f.activity.filter((e) => !roomId || e.roomId === roomId).sort((a, b) => b.ts - a.ts).slice(0, limit),
    'rooms.lastActivity': async ({ roomId }) => {
      const last: Record<string, number> = {}
      for (const e of f.activity) if (e.roomId === roomId && e.agentId) last[e.agentId] = Math.max(last[e.agentId] ?? 0, e.ts)
      return last
    },
    'usage.get': async () => f.usage,
    'usage.notifyOnReset': async () => ok,
    'account.get': async () => account,
    'account.signIn': async () => account,
    'account.signOut': async () => ({ signedIn: false }),
    'settings.get': async () => settings,
    'settings.set': async ({ patch }) => (settings = applySettingsPatch(settings, patch)),
    'settings.room': async ({ roomId }) => roomSettings(roomId),
    'settings.setRoom': async ({ roomId, patch }) => {
      // Keeps the change for the life of the fixture, so a toggle in a screenshot run behaves like the real thing.
      const cur = roomSettings(roomId) as unknown as Record<string, Record<string, unknown>>
      const next: Record<string, Record<string, unknown>> = { scripts: { ...cur.scripts }, files: { ...cur.files }, workspace: { ...cur.workspace }, disabled: { skills: [], mcp: [], ...cur.disabled } }
      for (const [group, values] of Object.entries(patch)) for (const [k, v] of Object.entries(values ?? {})) { if (v === null) delete next[group][k]; else next[group][k] = v }
      f.roomSettings = { ...(f.roomSettings ?? {}), [roomId]: next as never }
      return roomSettings(roomId)
    },
    'mcp.list': async () => f.mcp ?? [],
    'integrations.list': async () => f.integrations ?? [],
    'integrations.connect': async ({ id }) => ({ id, name: id, connected: true, detail: '' }),
    'update.get': async () => update,
    'update.check': async () => update,
    'update.install': async () => ok,
    'app.exportLogs': async () => ({ path: '(fixture)' }),
    'app.info': async () => ({ version: '0.1.0', dataDir: join('~', 'Library', 'Application Support', 'Kernel') }),
    'app.openTerminal': async () => ok,
    'app.checkOnline': async () => ({ online: !f.push.some((e) => e.type === 'online' && !e.online) })
  }
}
