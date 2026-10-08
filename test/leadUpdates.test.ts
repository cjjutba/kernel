import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, PrState, Workspace } from '../src/shared/types'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { LeadUpdates } from '../src/main/services/leadUpdates'
import { UPDATE_HEADER } from '../src/main/services/handoff'

// KERNEL-72: Kernel tells the Lead what its teammates did, batched, only when the Lead can take it.

const open: LeadUpdates[] = []
afterEach(() => { open.forEach((u) => u.detach()); open.length = 0 })
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const done = { ok: true, interrupted: false, lead: false, queued: false }
const NAMES: Record<string, string> = { rowan: 'Rowan', noor: 'Noor', kai: 'Kai' }

async function setup(o: { leadChat?: boolean } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-lu-')), 'k.db'))
  store.saveRoom({ id: 'r', name: 'Kernel', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
  const ws = (id: string, agentId: string, extra: Partial<Workspace> = {}) => store.saveWorkspace({ id, roomId: 'r', name: id, branch: id, baseRef: 'main', path: `/x/${id}`, mode: 'worktree', agentId, port: 1, status: 'ready', prState: 'none', createdAt: 1, ...extra } as Workspace)
  const chat = (id: string, workspaceId: string) => store.saveChat({ id, workspaceId, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 } as Chat)
  ws('lead', 'rowan', { mode: 'current' })
  ws('w1', 'noor', { title: 'Symlink node_modules' })
  ws('w2', 'kai', { title: 'Inbox actions' })
  chat('lc', 'lead'); chat('nc', 'w1'); chat('kc', 'w2')
  store.saveItem('nc', { kind: 'text', id: 't1', ts: 1, text: 'Linked node_modules into the worktree.\n\nTests pass.' })
  const s = { enabled: true, hasLead: o.leadChat ?? true, accept: true, posts: [] as string[], delivered: 0 }
  const u = new LeadUpdates({
    store, enabled: () => s.enabled,
    leadChat: () => (s.hasLead ? store.chat('lc') : undefined),
    isLead: (w) => w.agentId === 'rowan',
    agentName: (_r, a) => NAMES[a],
    post: (_chatId, text) => { if (!s.accept) return false; s.posts.push(text); return true },
    delivered: () => { s.delivered++ },
    delayMs: 20
  })
  u.attach()
  open.push(u)
  const pr = (id: string, state: PrState, number = 54) => {
    store.saveWorkspace({ ...store.workspace(id)!, prState: state, prNumber: number, prTitle: 'feat(workspace): symlink node_modules' })
    bus.push({ type: 'pr', workspaceId: id, state })
  }
  return { store, u, s, pr, w1: store.workspace('w1')!, nc: store.chat('nc')!, lead: store.workspace('lead')!, lc: store.chat('lc')! }
}

describe('teammate updates to the Lead', () => {
  it('sends one message for a PR opening, turning ready and a finished turn', async () => {
    const { u, s, pr, w1, nc } = await setup()
    pr('w1', 'checks')
    pr('w1', 'ready')
    u.turnDone(w1, nc, done)
    expect(s.posts).toEqual([])
    await wait()
    expect(s.posts).toHaveLength(1)
    expect(s.posts[0].split('\n')).toEqual([
      UPDATE_HEADER,
      '- Noor · Symlink node_modules (workspace w1): opened PR #54 "feat(workspace): symlink node_modules"',
      '- Noor · Symlink node_modules (workspace w1): PR #54 is ready to merge',
      '- Noor · Symlink node_modules (workspace w1): finished a turn: "Linked node_modules into the worktree."'
    ])
    expect(s.delivered).toBe(1)
  })

  it('reports failed checks, requested changes, conflicts, merges and closes, and stays quiet on the rest', async () => {
    const { s, pr } = await setup()
    pr('w1', 'checks')
    await wait(); s.posts.length = 0
    for (const state of ['cifail', 'checks', 'changes', 'resolving', 'conflict', 'merging', 'merged'] as PrState[]) pr('w1', state)
    pr('w2', 'open', 60); pr('w2', 'closed', 60)
    await wait()
    expect(s.posts[0].split('\n').slice(1)).toEqual([
      '- Noor · Symlink node_modules (workspace w1): checks failed on PR #54',
      '- Noor · Symlink node_modules (workspace w1): changes were requested on PR #54',
      '- Noor · Symlink node_modules (workspace w1): PR #54 has conflicts with its base',
      '- Noor · Symlink node_modules (workspace w1): PR #54 was merged',
      '- Kai · Inbox actions (workspace w2): opened PR #60 "feat(workspace): symlink node_modules"',
      '- Kai · Inbox actions (workspace w2): PR #60 was closed without merging'
    ])
  })

  it('holds updates while the Lead is busy and sends them when its turn ends, losing none', async () => {
    const { u, s, pr, w1, nc, lead, lc } = await setup()
    s.accept = false
    pr('w1', 'checks')
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.posts).toEqual([])
    pr('w1', 'ready')
    await wait()
    s.accept = true
    u.turnDone(lead, lc, { ...done, lead: true })
    expect(s.posts).toHaveLength(1)
    expect(s.posts[0].split('\n')).toHaveLength(4)
  })

  it('sends held updates on the next poll too, for a Lead that was paused', async () => {
    const { u, s, pr } = await setup()
    s.accept = false
    pr('w1', 'ready')
    await wait()
    s.accept = true
    u.flushAll()
    expect(s.posts).toHaveLength(1)
  })

  it("drops updates when the room's Lead was never briefed, and never starts a Lead chat", async () => {
    const { u, s, pr } = await setup({ leadChat: false })
    pr('w1', 'ready')
    await wait()
    s.hasLead = true
    u.flushAll()
    expect(s.posts).toEqual([])
  })

  it("never reports the Lead's own turns or PRs, and skips interrupted and queued turns", async () => {
    const { u, s, pr, w1, nc, lead, lc } = await setup()
    pr('lead', 'ready')
    u.turnDone(lead, lc, { ...done, lead: true })
    u.turnDone(w1, nc, { ...done, interrupted: true })
    u.turnDone(w1, nc, { ...done, queued: true })
    await wait()
    expect(s.posts).toEqual([])
    u.turnDone(w1, nc, { ...done, ok: false })
    await wait()
    expect(s.posts[0]).toContain('(workspace w1): stopped with an error')
  })

  it('sends nothing with the setting off', async () => {
    const { u, s, pr, w1, nc } = await setup()
    s.enabled = false
    pr('w1', 'ready')
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.posts).toEqual([])
  })

  it('caps one update at 20 lines and says how many it left out', async () => {
    const { u, s, w1, nc } = await setup()
    for (let i = 0; i < 25; i++) u.turnDone(w1, nc, done)
    await wait()
    const lines = s.posts[0].split('\n')
    expect(lines).toHaveLength(22)
    expect(lines[1]).toBe('- 5 earlier updates are left out.')
  })
})
