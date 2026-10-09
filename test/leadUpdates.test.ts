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
// KERNEL-105: each Lead chat hears about the work it handed off, and a closed chat's work goes to the first one.

const open: LeadUpdates[] = []
afterEach(() => { open.forEach((u) => u.detach()); open.length = 0 })
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const done = { ok: true, interrupted: false, lead: false, queued: false, by: 'user' as const }
const NAMES: Record<string, string> = { rowan: 'Rowan', noor: 'Noor', kai: 'Kai' }

async function setup(o: { leadChat?: boolean } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-lu-')), 'k.db'))
  store.saveRoom({ id: 'r', name: 'Kernel', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
  const ws = (id: string, agentId: string, extra: Partial<Workspace> = {}) => store.saveWorkspace({ id, roomId: 'r', name: id, branch: id, baseRef: 'main', path: `/x/${id}`, mode: 'worktree', agentId, port: 1, status: 'ready', prState: 'none', createdAt: 1, ...extra } as Workspace)
  const chat = (id: string, workspaceId: string) => store.saveChat({ id, workspaceId, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 } as Chat)
  ws('lead', 'rowan', { mode: 'current' })
  ws('w1', 'noor', { title: 'Symlink node_modules' })
  ws('w2', 'kai', { title: 'Inbox actions' })
  chat('lc', 'lead'); chat('lc2', 'lead'); chat('nc', 'w1'); chat('kc', 'w2')
  store.saveItem('nc', { kind: 'text', id: 't1', ts: 1, text: 'Linked node_modules into the worktree.\n\nTests pass.' })
  const s = { enabled: true, hasLead: o.leadChat ?? true, accept: true, busy: new Set<string>(), posts: [] as string[], to: [] as string[], delivered: 0 }
  const u = new LeadUpdates({
    store, enabled: () => s.enabled,
    // Kernel's rule in small: the owner while it's open, else the first Lead chat ("lc"), flagged as closed.
    target: (_r, owner) => {
      if (!s.hasLead) return undefined
      const was = owner ? store.chat(owner) : undefined
      return was && !was.closed ? { chat: was } : { chat: store.chat('lc')!, closed: was }
    },
    isLead: (w) => w.agentId === 'rowan',
    agentName: (_r, a) => NAMES[a],
    post: (chatId, text) => { if (!s.accept || s.busy.has(chatId)) return false; s.posts.push(text); s.to.push(chatId); return true },
    delivered: () => { s.delivered++ },
    delayMs: 20
  })
  u.attach()
  open.push(u)
  const pr = (id: string, state: PrState, number = 54) => {
    store.saveWorkspace({ ...store.workspace(id)!, prState: state, prNumber: number, prTitle: 'feat(workspace): symlink node_modules' })
    bus.push({ type: 'pr', workspaceId: id, state })
  }
  /** Who handed the workspace off. */
  const own = (id: string, leadChatId: string) => store.saveWorkspace({ ...store.workspace(id)!, leadChatId })
  return { store, u, s, pr, own, w1: store.workspace('w1')!, nc: store.chat('nc')!, kc: store.chat('kc')!, lead: store.workspace('lead')!, lc: store.chat('lc')! }
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

describe('teammate updates with several Lead chats (KERNEL-105)', () => {
  const W1 = '- Noor · Symlink node_modules (workspace w1)'
  const W2 = '- Kai · Inbox actions (workspace w2)'

  it('sends each Lead chat only the updates about the work it handed off', async () => {
    const { s, pr, own } = await setup()
    own('w1', 'lc'); own('w2', 'lc2')
    pr('w1', 'ready')
    pr('w2', 'conflict', 60)
    await wait()
    expect(s.to.sort()).toEqual(['lc', 'lc2'])
    const of = (chatId: string) => s.posts[s.to.indexOf(chatId)].split('\n')
    expect(of('lc')).toEqual([UPDATE_HEADER, `${W1}: opened PR #54 "feat(workspace): symlink node_modules"`, `${W1}: PR #54 is ready to merge`])
    expect(of('lc2')).toEqual([UPDATE_HEADER, `${W2}: opened PR #60 "feat(workspace): symlink node_modules"`, `${W2}: PR #60 has conflicts with its base`])
    expect(s.delivered).toBe(2)
  })

  it('holds a busy chat\'s updates without holding up another chat\'s', async () => {
    const { u, s, pr, own, lead, lc } = await setup()
    own('w1', 'lc'); own('w2', 'lc2')
    s.busy.add('lc')
    pr('w1', 'ready')
    pr('w2', 'ready', 60)
    await wait()
    expect(s.to).toEqual(['lc2'])
    s.busy.delete('lc')
    u.turnDone(lead, lc, { ...done, lead: true })
    expect(s.to).toEqual(['lc2', 'lc'])
    expect(s.posts[1]).toContain(`${W1}: PR #54 is ready to merge`)
    expect(s.posts[1]).not.toContain('PR #60')
  })

  it("sends a closed chat's updates to the first Lead chat in the same message, under the closed chat's name", async () => {
    const { store, s, pr, own } = await setup()
    own('w2', 'lc2')
    store.saveChat({ ...store.chat('lc2')!, title: 'Chat icons sizing', closed: true })
    pr('w1', 'ready')
    pr('w2', 'conflict', 60)
    await wait()
    expect(s.to).toEqual(['lc'])
    expect(s.posts[0].split('\n')).toEqual([
      UPDATE_HEADER,
      `${W1}: opened PR #54 "feat(workspace): symlink node_modules"`,
      `${W1}: PR #54 is ready to merge`,
      'From "Chat icons sizing", a Lead chat that is now closed:',
      `${W2}: opened PR #60 "feat(workspace): symlink node_modules"`,
      `${W2}: PR #60 has conflicts with its base`
    ])
    expect(s.delivered).toBe(1)
  })

  it('keeps the newest 20 lines across chats in one message', async () => {
    const { store, u, s, own, w1, nc, kc } = await setup()
    own('w2', 'lc2')
    store.saveChat({ ...store.chat('lc2')!, title: 'Composer unit tests', closed: true })
    const w2 = store.workspace('w2')!
    for (let i = 0; i < 15; i++) u.turnDone(w1, nc, done)
    for (let i = 0; i < 10; i++) u.turnDone(w2, kc, done)
    await wait()
    const lines = s.posts[0].split('\n')
    expect(lines[1]).toBe('- 5 earlier updates are left out.')
    expect(lines.filter((l) => l.startsWith(W1))).toHaveLength(10)
    expect(lines.filter((l) => l.startsWith(W2))).toHaveLength(10)
    expect(lines[12]).toBe('From "Composer unit tests", a Lead chat that is now closed:')
    expect(lines).toHaveLength(23)
  })
})
