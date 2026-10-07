import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, Workspace } from '@shared/types'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { bashVerdict, pushesTo, usesNetwork, Sessions } from '../src/main/services/sessions'
import { applySettingsPatch, DEFAULT_SETTINGS } from '../src/main/services/settings'

// Each query() is a scripted session that never answers on its own. A turn ends when the test feeds a result.
const sdk = vi.hoisted(() => ({ calls: [] as { feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    sdk.calls.push({ feed: (m) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) } })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}
    }
  }
}))

const flush = () => new Promise((r) => setTimeout(r, 10))

describe('applySettingsPatch', () => {
  const base = DEFAULT_SETTINGS('/home/cj')
  it('merges nested fields and replaces lists', () => {
    const next = applySettingsPatch(base, { appearance: { theme: 'light' }, permissions: { alwaysAsk: ['rm -rf'] } })
    expect(next.appearance.theme).toBe('light')
    expect(next.appearance.density).toBe(base.appearance.density)
    expect(next.permissions.alwaysAsk).toEqual(['rm -rf'])
  })
  it('clears quiet hours with null', () => {
    const on = applySettingsPatch(base, { notifications: { quietHours: { from: '22:00', to: '07:00' } } })
    expect(on.notifications.quietHours).toEqual({ from: '22:00', to: '07:00' })
    expect(applySettingsPatch(on, { notifications: { quietHours: null } }).notifications.quietHours).toBeNull()
  })
  it('keeps the agent limit and the timeout in range', () => {
    const next = applySettingsPatch(base, { models: { maxConcurrent: 0 }, permissions: { approvalTimeoutSec: 1 } })
    expect(next.models.maxConcurrent).toBe(1)
    expect(next.permissions.approvalTimeoutSec).toBe(10)
  })
})

describe('protected branches', () => {
  it('finds pushes that name a protected branch', () => {
    expect(pushesTo('git push origin main', ['main'])).toBe(true)
    expect(pushesTo('git push origin HEAD:dev', ['main', 'dev'])).toBe(true)
    expect(pushesTo('npm test && git push origin main', ['main'])).toBe(true)
    expect(pushesTo('git push -u origin feat/x', ['main'])).toBe(false)
    expect(pushesTo('git push', ['main'])).toBe(false)
    expect(pushesTo('echo main', ['main'])).toBe(false)
  })
  it('sees git -C and full ref names', () => {
    expect(pushesTo('git -C ../app push origin main', ['main'])).toBe(true)
    expect(pushesTo('git push origin HEAD:refs/heads/main', ['main'])).toBe(true)
    expect(pushesTo('git -c user.name=x push origin refs/heads/dev', ['dev'])).toBe(true)
    expect(pushesTo('git -C ../app push origin feat/x', ['main'])).toBe(false)
  })
  it('denies them, and only them', () => {
    const p = { neverAllow: [], alwaysAsk: [], protectedBranches: ['main'] }
    expect(bashVerdict('git push origin main', p, [])).toBe('deny')
    expect(bashVerdict('git push origin feat/x', p, [])).toBeUndefined()
  })
})

describe('network access off', () => {
  const off = { neverAllow: [], alwaysAsk: [], network: false }
  it('recognises commands that reach the network', () => {
    for (const c of ['curl https://x.dev', 'FOO=1 wget x', 'npm test && npm install left-pad', 'git -C app fetch', 'git push origin feat/x', 'gh pr create', 'echo hi | ssh box']) expect(usesNetwork(c), c).toBe(true)
    for (const c of ['npm test', 'git status', 'git commit -m "curl it"', 'ls -la', 'echo curl']) expect(usesNetwork(c), c).toBe(false)
  })
  it('denies them only while the setting is off', () => {
    expect(bashVerdict('curl https://x.dev', off, [])).toBe('deny')
    expect(bashVerdict('curl https://x.dev', { ...off, network: true }, [])).toBeUndefined()
    expect(bashVerdict('npm test', off, [])).toBeUndefined()
  })
})

describe('agents working at once', () => {
  async function setup(maxConcurrent: number) {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-limit-')), 'kernel.db'))
    for (const id of ['a', 'b', 'c']) {
      const ws: Workspace = { id: `ws-${id}`, roomId: 'room', name: id, branch: `feat/${id}`, baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: id, port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
      const chat: Chat = { id, workspaceId: ws.id, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 }
      store.saveWorkspace(ws)
      store.saveChat(chat)
    }
    const settings = { ...DEFAULT_SETTINGS('/home/cj'), models: { ...DEFAULT_SETTINGS('/home/cj').models, maxConcurrent } }
    const sessions = new Sessions({ store, approvals: new Approvals(store), settings: () => settings, agentFor: () => undefined, mcpFor: () => undefined, roomAllow: () => [], allowInRoom: () => {} })
    return { sessions, settings }
  }
  const text = (t: string) => [{ type: 'text' as const, text: t }]
  const result = { type: 'result', subtype: 'success', is_error: false, uuid: 'r', duration_ms: 1, result: '', session_id: 's' }

  it('queues a send past the limit and starts it when a turn ends', async () => {
    const { sessions } = await setup(2)
    expect((await sessions.send('a', text('one'))).queued).toBe(false)
    expect((await sessions.send('b', text('two'))).queued).toBe(false)
    expect((await sessions.send('c', text('three'))).queued).toBe(true)
    expect(sessions.isRunning('c')).toBe(false)
    sdk.calls[sdk.calls.length - 2].feed(result)
    await flush()
    expect(sessions.isRunning('c')).toBe(true)
    expect(sessions.queued('c')).toEqual([])
  })

  it('starts waiting work when the limit goes up', async () => {
    const { sessions, settings } = await setup(1)
    await sessions.send('a', text('one'))
    expect((await sessions.send('b', text('two'))).queued).toBe(true)
    settings.models.maxConcurrent = 2
    sessions.applySettings()
    expect(sessions.isRunning('b')).toBe(true)
  })
})
