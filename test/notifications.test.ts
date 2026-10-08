import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Approval, Chat, Notification, Workspace } from '../src/shared/types'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { Notifications, approvalNotificationId, inQuietHours, replyExcerpt } from '../src/main/services/notifications'

const open: Notifications[] = []
afterEach(() => { open.forEach((n) => n.detach()); open.length = 0 })

async function setup(o: { background?: boolean; sound?: 'none' | 'subtle'; quiet?: { from: string; to: string } | null; off?: 'permission' | 'merge' | 'finished'; idle?: boolean } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-n-')), 'k.db'))
  store.saveRoom({ id: 'r', name: 'Client A', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
  store.saveWorkspace({ id: 'w', roomId: 'r', name: 'org-invites', branch: 'b', baseRef: 'main', path: '/x', mode: 'worktree', agentId: 'kai', port: 1, status: 'ready', prState: 'open', prNumber: 41, createdAt: 1 } as Workspace)
  const settings = DEFAULT_SETTINGS('/h')
  settings.notifications = { ...settings.notifications, quietHours: o.quiet ?? null, sound: o.sound ?? 'subtle', idle: o.idle ?? false, ...(o.off ? { [o.off]: false } : {}) }
  const shown: Notification[] = []
  const silent: boolean[] = []
  const n = new Notifications({ store, settings: () => settings, agentName: (_r, a) => (a === 'noor' ? 'Noor' : undefined), show: (x, opts) => { shown.push(x); silent.push(opts.silent) }, inBackground: () => o.background ?? true, now: () => new Date(2026, 0, 1, 12, 0).getTime(), idleAfterMs: 30 })
  n.attach()
  open.push(n)
  return { store, n, shown, silent }
}

const approval = (extra: Partial<Approval> = {}): Approval => ({ id: 'a1', kind: 'tool', source: 'sdk', roomId: 'r', agentId: 'noor', toolName: 'Bash', title: 'Run pnpm drizzle-kit push', status: 'pending', createdAt: Date.now(), ...extra })

describe('notifications service', () => {
  it('lands a pending approval in the inbox and shows a banner in the background', async () => {
    const { n, shown } = await setup()
    bus.push({ type: 'approval', approval: approval() })
    const [row] = n.list()
    expect(row).toMatchObject({ id: approvalNotificationId('a1'), kind: 'approval', needsYou: true, read: false, sub: 'Permission · Client A', title: 'Wants to run pnpm drizzle-kit push' })
    expect(row.heading).toBe('Noor wants to run pnpm drizzle-kit push')
    expect(shown).toHaveLength(1)
  })

  it('plays no sound when Settings > Notifications sound is none', async () => {
    for (const [sound, expected] of [['none', true], ['subtle', false]] as const) {
      const { silent } = await setup({ sound })
      bus.push({ type: 'approval', approval: approval() })
      expect(silent).toEqual([expected])
    }
  })

  it('records the outcome once the approval is decided or times out', async () => {
    const { n } = await setup()
    bus.push({ type: 'approval', approval: approval() })
    bus.push({ type: 'approval', approval: approval({ status: 'denied' }) })
    expect(n.list()[0]).toMatchObject({ needsYou: false, read: true, resolved: 'You denied this.' })
    bus.push({ type: 'approval', approval: approval({ id: 'a2', status: 'pending' }) })
    bus.push({ type: 'approval', approval: approval({ id: 'a2', status: 'expired' }) })
    expect(n.list().find((x) => x.approvalId === 'a2')?.resolved).toMatch(/timed out/)
  })

  it('does not show a banner while the app has focus, in quiet hours, or when the setting is off', async () => {
    for (const o of [{ background: false }, { quiet: { from: '11:00', to: '13:00' } }, { off: 'permission' as const }]) {
      const { n, shown } = await setup(o)
      bus.push({ type: 'approval', approval: approval() })
      expect(n.list()).toHaveLength(1)
      expect(shown).toHaveLength(0)
    }
  })

  it('turns PR states into merge and check rows, and settles them on merge', async () => {
    const { n } = await setup()
    bus.push({ type: 'pr', workspaceId: 'w', state: 'cifail' })
    expect(n.list()[0]).toMatchObject({ kind: 'check', title: 'Checks failed on PR #41', needsYou: true })
    bus.push({ type: 'pr', workspaceId: 'w', state: 'ready' })
    const rows = n.list()
    expect(rows.filter((x) => x.needsYou).map((x) => x.kind)).toEqual(['merge'])
    expect(rows.find((x) => x.kind === 'check')?.needsYou).toBe(false)
    bus.push({ type: 'pr', workspaceId: 'w', state: 'merged' })
    expect(n.list().some((x) => x.needsYou)).toBe(false)
  })

  it('marks rows read, one or all', async () => {
    const { n } = await setup()
    bus.push({ type: 'pr', workspaceId: 'w', state: 'ready' })
    bus.push({ type: 'approval', approval: approval() })
    const first = n.list()[0].id
    expect(n.read([first])).toHaveLength(1)
    expect(n.read('all')).toHaveLength(1)
    expect(n.list().every((x) => x.read)).toBe(true)
  })

  it('backfills approvals that were pending before it started', async () => {
    const { store, n } = await setup()
    store.saveApproval(approval({ id: 'old' }))
    n.detach()
    const again = new Notifications({ store, settings: () => DEFAULT_SETTINGS('/h'), agentName: () => undefined })
    again.attach(); open.push(again)
    expect(again.list().some((x) => x.approvalId === 'old')).toBe(true)
  })

  it('reads quiet hours across midnight', () => {
    const q = { from: '22:00', to: '07:00' }
    expect(inQuietHours(q, new Date(2026, 0, 1, 23, 30))).toBe(true)
    expect(inQuietHours(q, new Date(2026, 0, 1, 6, 59))).toBe(true)
    expect(inQuietHours(q, new Date(2026, 0, 1, 12, 0))).toBe(false)
    expect(inQuietHours(null, new Date())).toBe(false)
  })
})

describe('finished and idle rows (KERNEL-71)', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const done = { ok: true, interrupted: false, lead: false, queued: false }

  async function teammate(o: Parameters<typeof setup>[0] = {}) {
    const t = await setup(o)
    const ws = { id: 'w2', roomId: 'r', name: 'symlink-node-modules', title: 'Symlink node_modules', branch: 'b2', baseRef: 'main', path: '/y', mode: 'worktree', agentId: 'noor', port: 2, status: 'ready', prState: 'none', createdAt: 1 } as Workspace
    const chat = { id: 'c2', workspaceId: 'w2', title: 'Symlink node_modules', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 } as Chat
    t.store.saveWorkspace(ws)
    t.store.saveChat(chat)
    t.store.saveItem(chat.id, { kind: 'text', id: 't1', ts: 1, text: 'Linked node_modules into the worktree and added the exclude line.\n\nTests pass.' })
    return { ...t, ws, chat, finished: () => t.n.list().filter((r) => r.kind === 'finished'), idle: () => t.n.list().filter((r) => r.kind === 'idle') }
  }

  it("adds a Finished row for a teammate's turn, under Updates, with a banner", async () => {
    const { n, ws, chat, finished, shown } = await teammate()
    n.turnDone(ws, chat, done)
    expect(finished()).toEqual([expect.objectContaining({
      id: 'n-finished-w2', workspaceId: 'w2', agentId: 'noor', needsYou: false, read: false,
      title: 'Finished Symlink node_modules', sub: 'Workspace ready · Client A', heading: 'Noor finished Symlink node_modules',
      body: 'Linked node_modules into the worktree and added the exclude line.'
    })])
    expect(shown.map((x) => x.kind)).toEqual(['finished'])
  })

  it('keeps one row per workspace: the next finished turn replaces it', async () => {
    const { n, ws, chat, finished, store } = await teammate()
    n.turnDone(ws, chat, done)
    store.saveItem(chat.id, { kind: 'text', id: 't2', ts: 2, text: 'Fixed the review comments.' })
    n.turnDone(ws, chat, done)
    expect(finished()).toHaveLength(1)
    expect(finished()[0].body).toBe('Fixed the review comments.')
  })

  it("skips the Lead, interrupted and failed turns, queued follow-ups and pending approvals", async () => {
    const { n, ws, chat, finished, store } = await teammate()
    n.turnDone(ws, chat, { ...done, lead: true })
    n.turnDone(ws, chat, { ...done, interrupted: true })
    n.turnDone(ws, chat, { ...done, ok: false })
    n.turnDone(ws, chat, { ...done, queued: true })
    store.saveApproval({ ...approval({ id: 'a9', chatId: chat.id, workspaceId: 'w2' }) })
    n.turnDone(ws, chat, done)
    expect(finished()).toEqual([])
  })

  it('still adds the row with the banner turned off', async () => {
    const { n, ws, chat, finished, shown } = await teammate({ off: 'finished' })
    n.turnDone(ws, chat, done)
    expect(finished()).toHaveLength(1)
    expect(shown).toEqual([])
  })

  it('adds an idle row after the wait, only with the setting on and only if nothing happened', async () => {
    const on = await teammate({ idle: true })
    on.n.turnDone(on.ws, on.chat, done)
    await wait(80)
    expect(on.idle()).toEqual([expect.objectContaining({ id: 'n-idle-w2', title: 'Noor is idle', heading: 'Noor has been idle for 10 minutes', needsYou: false })])

    const busy = await teammate({ idle: true })
    busy.n.turnDone(busy.ws, busy.chat, done)
    bus.push({ type: 'chat.running', chatId: busy.chat.id, running: true })
    await wait(80)
    expect(busy.idle()).toEqual([])

    const off = await teammate({ idle: false })
    off.n.turnDone(off.ws, off.chat, done)
    await wait(80)
    expect(off.idle()).toEqual([])
  })

  it('cuts the reply excerpt at its first paragraph and about 300 characters', () => {
    expect(replyExcerpt('One line.\n\nSecond paragraph.')).toBe('One line.')
    expect(replyExcerpt('a '.repeat(400)).length).toBeLessThanOrEqual(300)
  })
})
