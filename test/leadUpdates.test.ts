import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, PrState, TeamUpdate, Workspace } from '../src/shared/types'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { LeadUpdates } from '../src/main/services/leadUpdates'
import { UPDATE_HEADER } from '../src/main/services/handoff'
import { capText } from '../src/main/services/text'

// KERNEL-72: Kernel tells the Lead what its teammates did, batched, only when the Lead can take it.
// KERNEL-105: each Lead chat hears about the work it handed off, and a closed chat's work goes to the first one.
// KERNEL-117: one block per workspace, in plain words, with the full reply and the card's data.

const open: LeadUpdates[] = []
afterEach(() => { open.forEach((u) => u.detach()); open.length = 0 })
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const done = { ok: true, interrupted: false, lead: false, queued: false, by: 'lead' as const }
const NAMES: Record<string, string> = { rowan: 'Rowan', noor: 'Noor', kai: 'Kai' }
const REPLY = 'Linked node_modules into the worktree.\n\nTests pass.'

async function setup(o: { leadChat?: boolean; delayMs?: number } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-lu-')), 'k.db'))
  store.saveRoom({ id: 'r', name: 'Kernel', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
  const ws = (id: string, agentId: string, extra: Partial<Workspace> = {}) => store.saveWorkspace({ id, roomId: 'r', name: id, branch: id, baseRef: 'main', path: `/x/${id}`, mode: 'worktree', agentId, port: 1, status: 'ready', prState: 'none', createdAt: 1, ...extra } as Workspace)
  const chat = (id: string, workspaceId: string) => store.saveChat({ id, workspaceId, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 } as Chat)
  ws('lead', 'rowan', { mode: 'current' })
  ws('w1', 'noor', { title: 'Symlink node_modules' })
  ws('w2', 'kai', { title: 'Inbox actions' })
  chat('lc', 'lead'); chat('lc2', 'lead'); chat('nc', 'w1'); chat('kc', 'w2')
  store.saveItem('nc', { kind: 'text', id: 't1', ts: 1, text: REPLY })
  const s = { enabled: true, hasLead: o.leadChat ?? true, accept: true, busy: new Set<string>(), posts: [] as string[], updates: [] as TeamUpdate[], to: [] as string[], delivered: [] as TeamUpdate[] }
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
    post: (chatId, text, update) => { if (!s.accept || s.busy.has(chatId)) return false; s.posts.push(text); s.updates.push(update); s.to.push(chatId); return true },
    delivered: (_r, _c, update) => { s.delivered.push(update) },
    delayMs: o.delayMs ?? 20
  })
  u.attach()
  open.push(u)
  const pr = (id: string, state: PrState, number = 54) => {
    store.saveWorkspace({ ...store.workspace(id)!, prState: state, prNumber: number, prTitle: 'feat(workspace): symlink node_modules' })
    bus.push({ type: 'pr', workspaceId: id, state })
  }
  /** Who handed the workspace off. */
  const own = (id: string, leadChatId: string) => store.saveWorkspace({ ...store.workspace(id)!, leadChatId })
  return { store, u, s, pr, own, ws, chat, w1: store.workspace('w1')!, nc: store.chat('nc')!, kc: store.chat('kc')!, lead: store.workspace('lead')!, lc: store.chat('lc')! }
}

const NOOR = 'Noor (noor) · Symlink node_modules · workspace w1'
const KAI = 'Kai (kai) · Inbox actions · workspace w2'
const OPENED_54 = '- Opened PR #54 "feat(workspace): symlink node_modules".'
const OPENED_60 = '- Opened PR #60 "feat(workspace): symlink node_modules".'
const QUOTED = ["- Noor's last reply:", '  > Linked node_modules into the worktree.', '  >', '  > Tests pass.']

describe('teammate updates to the Lead', () => {
  it('sends one block per workspace for a PR opening, passing checks and a finished turn, with the reply and the card', async () => {
    const { u, s, pr, w1, nc } = await setup()
    pr('w1', 'checks')
    pr('w1', 'ready')
    u.turnDone(w1, nc, done)
    expect(s.posts).toEqual([])
    await wait()
    expect(s.posts).toHaveLength(1)
    expect(s.posts[0].split('\n')).toEqual([
      UPDATE_HEADER,
      '',
      NOOR,
      OPENED_54,
      '- PR #54 passed checks and has no conflicts.',
      // The reply says the turn ended, so there is no "Finished a turn." line above it.
      ...QUOTED
    ])
    expect(s.updates[0]).toEqual({
      rows: [{
        workspaceId: 'w1', agentId: 'noor', name: 'Noor', task: 'Symlink node_modules', prNumber: 54, reply: REPLY,
        events: [
          { kind: 'pr.opened', text: 'Opened PR #54', actionable: false },
          { kind: 'pr.ready', text: 'Passed checks, no conflicts', actionable: true },
          { kind: 'turn', text: 'Finished a turn', actionable: true }
        ]
      }]
    })
    expect(s.delivered).toEqual(s.updates)
  })

  it('says each PR state in plain words', async () => {
    const { s, pr } = await setup()
    pr('w1', 'checks')
    await wait()
    s.posts.length = 0
    const said: [PrState, string][] = [
      ['cifail', '- Checks failed on PR #54.'],
      ['changes', '- Changes were requested on PR #54.'],
      ['conflict', '- PR #54 has conflicts with its base branch.'],
      ['ready', '- PR #54 passed checks and has no conflicts.'],
      ['merged', '- PR #54 was merged.']
    ]
    for (const [state, line] of said) {
      pr('w1', state)
      await wait()
      expect(s.posts.pop()!.split('\n')).toEqual([UPDATE_HEADER, '', NOOR, line])
    }
    pr('w2', 'open', 60)
    pr('w2', 'closed', 60)
    await wait()
    expect(s.posts.pop()!.split('\n')).toEqual([UPDATE_HEADER, '', KAI, OPENED_60, '- PR #60 was closed without merging.'])
  })

  it("leaves out a PR state the PR has left by the time the update goes out, and sends nothing when that's all there was", async () => {
    const { s, pr } = await setup()
    pr('w1', 'checks')
    await wait()
    s.posts.length = 0
    // Checks failed, then a fix started them again: the failure is old news.
    pr('w1', 'cifail')
    pr('w1', 'checks')
    await wait()
    expect(s.posts).toEqual([])
    pr('w1', 'cifail')
    pr('w1', 'changes')
    pr('w1', 'merged')
    await wait()
    expect(s.posts.pop()!.split('\n')).toEqual([UPDATE_HEADER, '', NOOR, '- PR #54 was merged.'])
  })

  it('keeps only the last turn of a workspace, with its reply', async () => {
    const { store, u, s, w1, nc } = await setup()
    u.turnDone(w1, nc, done)
    store.saveItem('nc', { kind: 'text', id: 't2', ts: 2, text: 'Should the link be relative?' })
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.posts[0].split('\n')).toEqual([UPDATE_HEADER, '', NOOR, "- Noor's last reply:", '  > Should the link be relative?'])
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
    expect(s.posts[0].split('\n').slice(2)).toEqual([NOOR, OPENED_54, '- PR #54 passed checks and has no conflicts.', ...QUOTED])
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
    expect(s.posts[0].split('\n')).toEqual([UPDATE_HEADER, '', NOOR, '- Stopped with an error. Open the workspace to see it.'])
  })

  it('sends nothing with the setting off', async () => {
    const { u, s, pr, w1, nc } = await setup()
    s.enabled = false
    pr('w1', 'ready')
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.posts).toEqual([])
  })

  it('carries at most 8 workspaces, the newest, and says how many it left out', async () => {
    const { store, u, s, ws, chat } = await setup()
    for (let i = 1; i <= 10; i++) {
      const w = ws(`x${i}`, 'kai', { title: `Task ${i}` })
      chat(`xc${i}`, w.id)
      u.turnDone(w, store.chat(`xc${i}`)!, done)
    }
    await wait()
    const lines = s.posts[0].split('\n')
    expect(lines.filter((l) => l.startsWith('Kai (kai) · '))).toEqual([3, 4, 5, 6, 7, 8, 9, 10].map((i) => `Kai (kai) · Task ${i} · workspace x${i}`))
    expect(lines.at(-1)).toBe('Kernel left out older updates on 2 more workspaces. Call list_workspaces to see where they stand.')
    expect(s.updates[0].omitted).toBe(2)
    expect(s.updates[0].rows).toHaveLength(8)
  })

  it('cuts a long reply near 1,500 characters and never in the middle of a link', async () => {
    const { store, u, s, w1, nc } = await setup()
    const link = 'https://github.com/cjjutba/kernel/pull/108#issuecomment-6071731'
    store.saveItem('nc', { kind: 'text', id: 't2', ts: 2, text: `${'word '.repeat(298)}${link} and more` })
    u.turnDone(w1, nc, done)
    await wait()
    const [noor] = s.updates[0].rows
    expect(noor.reply!.endsWith('…')).toBe(true)
    expect(noor.reply).not.toContain('https://')
    expect(noor.reply!.length).toBeLessThanOrEqual(1501)
  })

  it("shares 6,000 characters between one message's replies", async () => {
    const { store, u, s, ws, chat } = await setup()
    for (let i = 1; i <= 5; i++) {
      const w = ws(`y${i}`, 'kai', { title: `Reply ${i}` })
      chat(`yc${i}`, w.id)
      store.saveItem(`yc${i}`, { kind: 'text', id: `y${i}`, ts: 2, text: 'word '.repeat(800) })
      u.turnDone(w, store.chat(`yc${i}`)!, done)
    }
    await wait()
    const lengths = s.updates[0].rows.map((r) => r.reply!.length)
    expect(lengths).toHaveLength(5)
    for (const n of lengths) { expect(n).toBeLessThanOrEqual(1201); expect(n).toBeGreaterThan(1100) }
  })

  it('waits again when the PR moves on before the update goes out', async () => {
    const { u, s, pr, w1, nc } = await setup({ delayMs: 200 })
    pr('w1', 'checks')
    await wait(260)
    s.posts.length = 0
    u.turnDone(w1, nc, done)
    await wait(120)
    // The PR moves 120ms into the 200ms wait, so the update waits another 200ms from here.
    pr('w1', 'resolving')
    await wait(140)
    expect(s.posts).toEqual([])
    await wait(160)
    expect(s.posts).toHaveLength(1)
  })
})

describe('capText', () => {
  it('leaves a short text alone, keeping its paragraphs', () => {
    expect(capText('  One.\n\n\n\nTwo.  ', 50)).toBe('One.\n\nTwo.')
  })

  it('cuts between words and marks the cut', () => {
    expect(capText('alpha beta gamma delta', 13)).toBe('alpha beta…')
    expect(capText('alpha beta gamma delta', 10)).toBe('alpha beta…')
  })

  it('backs up to before a link the cut falls in, and keeps a first link longer than the limit whole', () => {
    const link = 'https://github.com/cjjutba/kernel/pull/108#issuecomment-6071731'
    expect(capText(`Posted it: ${link} done`, 30)).toBe('Posted it:…')
    expect(capText(`${link} done`, 20)).toBe(`${link}…`)
    expect(capText(link, 20)).toBe(link)
  })

  it('cuts a first word longer than any link where it stands, and reads Windows line ends', () => {
    expect(capText('x'.repeat(5000), 100)).toBe(`${'x'.repeat(2048)}…`)
    expect(capText('One.  \r\n\r\n\r\nTwo.', 50)).toBe('One.\n\nTwo.')
  })
})

describe('teammate updates with several Lead chats (KERNEL-105)', () => {
  it('sends each Lead chat only the updates about the work it handed off', async () => {
    const { s, pr, own } = await setup()
    own('w1', 'lc'); own('w2', 'lc2')
    pr('w1', 'ready')
    pr('w2', 'conflict', 60)
    await wait()
    expect(s.to.sort()).toEqual(['lc', 'lc2'])
    const of = (chatId: string) => s.posts[s.to.indexOf(chatId)].split('\n')
    expect(of('lc')).toEqual([UPDATE_HEADER, '', NOOR, OPENED_54, '- PR #54 passed checks and has no conflicts.'])
    expect(of('lc2')).toEqual([UPDATE_HEADER, '', KAI, OPENED_60, '- PR #60 has conflicts with its base branch.'])
    expect(s.delivered).toHaveLength(2)
  })

  it("holds a busy chat's updates without holding up another chat's", async () => {
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
    expect(s.posts[1]).toContain('- PR #54 passed checks and has no conflicts.')
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
      '',
      NOOR,
      OPENED_54,
      '- PR #54 passed checks and has no conflicts.',
      '',
      'From "Chat icons sizing", a Lead chat that is now closed. This work is yours now.',
      '',
      KAI,
      OPENED_60,
      '- PR #60 has conflicts with its base branch.'
    ])
    expect(s.updates[0].rows.map((r) => r.fromChat)).toEqual([undefined, 'Chat icons sizing'])
    expect(s.delivered).toHaveLength(1)
  })

  it("keeps each closed chat's work under its own name, and the card in the same order as the text", async () => {
    const { store, u, s, own, ws, chat } = await setup()
    store.saveChat({ ...store.chat('lc2')!, title: 'Chat icons sizing', closed: true })
    chat('lc3', 'lead')
    store.saveChat({ ...store.chat('lc3')!, title: 'Composer unit tests', closed: true })
    const turn = (id: string, owner: string, title: string) => { const w = ws(id, 'kai', { title }); own(id, owner); chat(`${id}c`, id); u.turnDone(store.workspace(id)!, store.chat(`${id}c`)!, done) }
    turn('i1', 'lc2', 'Icons 1')
    turn('c1', 'lc3', 'Composer 1')
    turn('i2', 'lc2', 'Icons 2')
    await wait()
    const tasks = s.posts[0].split('\n').filter((l) => / · workspace /.test(l)).map((l) => l.split(' · ')[1])
    expect(tasks).toEqual(['Icons 1', 'Icons 2', 'Composer 1'])
    expect(s.updates[0].rows.map((r) => r.task)).toEqual(tasks)
    expect(s.updates[0].rows.map((r) => r.fromChat)).toEqual(['Chat icons sizing', 'Chat icons sizing', 'Composer unit tests'])
  })

  it('keeps the newest 8 workspaces across chats in one message', async () => {
    const { store, u, s, own, ws, chat } = await setup()
    store.saveChat({ ...store.chat('lc2')!, title: 'Composer unit tests', closed: true })
    for (let i = 1; i <= 6; i++) { const w = ws(`a${i}`, 'kai', { title: `Own ${i}` }); chat(`ac${i}`, w.id); u.turnDone(w, store.chat(`ac${i}`)!, done) }
    for (let i = 1; i <= 4; i++) { const w = ws(`b${i}`, 'noor', { title: `Closed ${i}`, leadChatId: 'lc2' }); chat(`bc${i}`, w.id); own(w.id, 'lc2'); u.turnDone(store.workspace(w.id)!, store.chat(`bc${i}`)!, done) }
    await wait()
    const lines = s.posts[0].split('\n')
    expect(lines.filter((l) => / · workspace /.test(l)).map((l) => l.split(' · ')[1])).toEqual(['Own 3', 'Own 4', 'Own 5', 'Own 6', 'Closed 1', 'Closed 2', 'Closed 3', 'Closed 4'])
    expect(lines).toContain('From "Composer unit tests", a Lead chat that is now closed. This work is yours now.')
    expect(lines.at(-1)).toBe('Kernel left out older updates on 2 more workspaces. Call list_workspaces to see where they stand.')
  })
})
