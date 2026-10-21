import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTogether, getState, setState } from '../src/renderer/src/store'
import type { AgentDef, Chat, ChatItem, Project, Workspace } from '../src/shared/types'

vi.mock('../src/renderer/src/api', () => ({
  cleanError: (e: unknown) => String(e),
  onPush: () => () => undefined,
  call: async () => []
}))

const project = { id: 'r1', name: 'r1', path: '/r/r1', defaultBranch: 'main', paused: false, createdAt: 1 } as Project
const ivy = { id: 'ivy', name: 'Ivy' } as AgentDef
const ws = { id: 'w1', projectId: 'r1', name: 'w1', branch: 'b', baseRef: 'main', path: '/w/w1', mode: 'worktree', agentId: 'ivy', port: 0, status: 'ready', prState: 'none', createdAt: 1 } as Workspace
const chat = { id: 'c1', workspaceId: 'w1', title: 'Clean-account journey', kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: 1 } as Chat
const user: ChatItem = { kind: 'user', id: 'u1', ts: 1, parts: [{ type: 'text', text: 'Run step 6' }] }

beforeEach(() => {
  setState({ projects: [project], agents: { r1: [ivy] }, workspaces: [ws], chats: { w1: [chat] }, items: { c1: [user] } })
  setState((s) => ({ ui: { ...s.ui, toasts: [] } }))
})

const toasts = () => getState().ui.toasts
const arrive = (item: ChatItem) => applyTogether({ type: 'chat.item', chatId: 'c1', item })

describe('a turn that ended on an error (KERNEL-1094)', () => {
  it('raises one toast with the error, the chat and Retry', () => {
    arrive({ kind: 'result', id: 'r1', ts: 2, durationMs: 48_000, ok: false, error: "Anthropic's API is overloaded (529)." })
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]).toMatchObject({ title: "Ivy's turn failed", sub: "Anthropic's API is overloaded (529).", detail: 'Clean-account journey', glyph: 'error', action: { label: 'Retry', retryNow: 'c1', primary: true } })
  })

  it('says nothing for a turn that went well, one you stopped, or one that hit a usage limit', () => {
    arrive({ kind: 'result', id: 'r1', ts: 2, durationMs: 1000, ok: true })
    arrive({ kind: 'interrupted', id: 'i1', ts: 3 })
    arrive({ kind: 'result', id: 'r2', ts: 4, durationMs: 1000, ok: false })
    expect(toasts()).toHaveLength(0)
    setState({ items: { c1: [user] } })
    arrive({ kind: 'result', id: 'r3', ts: 5, durationMs: 1000, ok: false, limit: true })
    expect(toasts()).toHaveLength(0)
  })
})
