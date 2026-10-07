import type { Approval, Chat, Workspace } from '@shared/types'
import type { Fixture } from '../../fixtures'
import type { Handlers } from './kernel'

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
  const decided = (a: Approval, d: Parameters<Handlers['approvals.decide']>[0]['decision']): Approval =>
    d.behavior === 'answer' ? { ...a, status: 'answered', answer: d.text } : { ...a, status: d.behavior === 'allow' ? 'allowed' : 'denied' }

  return {
    'preflight.run': async () => f.preflight,
    'hooks.install': async () => ({ path: '(fixture)', events: [] }),
    'rooms.list': async () => f.rooms,
    'rooms.add': async ({ path, name }) => f.rooms.find((r) => r.path === path) ?? { id: 'fixture-room', name: name ?? path.split('/').pop() ?? path, path, defaultBranch: 'main', paused: false, createdAt: Date.now() },
    'rooms.setPaused': async ({ roomId, paused }) => ({ ...room(roomId), paused }),
    'rooms.brief': async ({ roomId, agentId }) => {
      const lead = f.agents[roomId]?.find((a) => a.lead)
      const ws = f.workspaces.find((w) => w.roomId === roomId && w.agentId === (agentId ?? lead?.id) && w.status !== 'archived')
      const c = ws && f.chats.find((x) => x.workspaceId === ws.id)
      if (!ws || !c) throw new Error('This fixture has no chat for that agent.')
      return { chatId: c.id, workspaceId: ws.id }
    },
    'agents.list': async ({ roomId }) => f.agents[roomId] ?? [],
    'agents.status': async ({ roomId }) => f.status[roomId] ?? {},
    'workspaces.list': async ({ roomId }) => f.workspaces.filter((w) => !roomId || w.roomId === roomId),
    'workspaces.create': async () => { throw new Error('Fixture mode does not create workspaces.') },
    'workspaces.archive': async () => ({ ok: true }),
    'workspaces.changes': async ({ workspaceId }) => f.changes[workspaceId] ?? [],
    'workspaces.diff': async ({ workspaceId }) => f.diffs[workspaceId] ?? '',
    'chats.list': async ({ workspaceId }) => f.chats.filter((c) => c.workspaceId === workspaceId),
    'chats.create': async ({ workspaceId, kind }) => {
      const first = f.chats.find((c) => c.workspaceId === workspaceId)
      if (!first) throw new Error(`Unknown workspace ${workspaceId}`)
      return { ...first, id: `fixture-chat-${Date.now()}`, kind: kind ?? 'chat', title: kind === 'terminal' ? 'Terminal (claude)' : 'New chat', sessionId: undefined, plan: false }
    },
    'chats.items': async ({ chatId }) => f.items[chatId] ?? [],
    'chats.send': async () => ({ queued: false }),
    'chats.interrupt': async () => ({ ok: true }),
    'chats.configure': async ({ chatId, ...patch }) => ({ ...chat(chatId), ...patch }),
    'approvals.list': async ({ roomId }) => f.approvals.filter((a) => !roomId || a.roomId === roomId).sort((a, b) => b.createdAt - a.createdAt),
    'approvals.decide': async ({ id, decision }) => {
      const a = f.approvals.find((x) => x.id === id)
      if (!a) throw new Error('This request already timed out or was answered.')
      return decided(a, decision)
    },
    'pr.create': async ({ workspaceId }) => workspace(workspaceId),
    'pr.refresh': async ({ workspaceId }) => workspace(workspaceId),
    'pr.merge': async ({ workspaceId }) => workspace(workspaceId),
    'pr.resolve': async () => ({ ok: true }),
    'pr.ready': async ({ workspaceId }) => workspace(workspaceId),
    'pr.reopen': async ({ workspaceId }) => workspace(workspaceId),
    'scripts.run': async () => ({ ok: true }),
    'scripts.stop': async () => ({ ok: true }),
    'activity.recent': async ({ roomId, limit = 50 }) => f.activity.filter((e) => !roomId || e.roomId === roomId).sort((a, b) => b.ts - a.ts).slice(0, limit),
    'usage.get': async () => f.usage
  }
}
