import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Approval, Chat, Notification, Workspace } from '../src/shared/types'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { KEEP_SETTLED_MS, Notifications, approvalNotificationId, inQuietHours, replyExcerpt } from '../src/main/services/notifications'
import { Approvals } from '../src/main/services/approvals'
import { startHookServer } from '../src/main/services/hookServer'
import type { PushEvent } from '../src/shared/ipc'
import { Kernel } from '../src/main/kernel'

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
    bus.push({ type: 'approval', approval: approval({ id: 'a2', source: 'hook', status: 'pending' }) })
    bus.push({ type: 'approval', approval: approval({ id: 'a2', source: 'hook', status: 'expired' }) })
    expect(n.list().find((x) => x.approvalId === 'a2')?.resolved).toMatch(/timed out/)
    // An agent's own request has no terminal to fall back to.
    bus.push({ type: 'approval', approval: approval({ id: 'a3', status: 'pending' }) })
    bus.push({ type: 'approval', approval: approval({ id: 'a3', status: 'expired' }) })
    expect(n.list().find((x) => x.approvalId === 'a3')?.resolved).toBe('This request ended before you answered.')
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
  const done = { ok: true, interrupted: false, lead: false, queued: false, by: 'user' as const }

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

describe('rows that are over (KERNEL-155)', () => {
  const NOW = new Date(2026, 0, 1, 12, 0).getTime()
  const DAY = 24 * 60 * 60_000
  const row = (id: string, extra: Partial<Notification> = {}): Notification => ({ id, kind: 'finished', roomId: 'r', workspaceId: 'w', title: id, sub: '', needsYou: false, read: true, createdAt: NOW, ...extra })
  const removedIds = () => {
    const ids: string[] = []
    const on = (e: PushEvent) => { if (e.type === 'notification.removed') ids.push(...e.ids) }
    bus.on('push', on)
    open.push({ detach: () => bus.off('push', on) } as unknown as Notifications)
    return ids
  }
  const restart = (store: Store) => {
    const again = new Notifications({ store, settings: () => DEFAULT_SETTINGS('/h'), agentName: () => undefined, now: () => NOW })
    open.push(again)
    return again
  }

  it('ends approvals left from an earlier run at start, and settles their rows as read', async () => {
    const { store, n } = await setup()
    for (const a of [approval({ id: 'sdk', workspaceId: 'w' }), approval({ id: 'hook', source: 'hook', workspaceId: 'w' })]) bus.push({ type: 'approval', approval: store.saveApproval(a) })
    expect(n.list().filter((x) => x.needsYou)).toHaveLength(2)
    n.detach()

    // The next run: the same database, no waiters.
    const expired = new Approvals(store).expireStale()
    expect(expired.map((a) => [a.id, a.status]).sort()).toEqual([['hook', 'expired'], ['sdk', 'expired']])
    const again = restart(store)
    again.attach()
    expect(store.approvals({ pendingOnly: true })).toEqual([])
    const rows = again.list()
    expect(rows.find((x) => x.approvalId === 'sdk')).toMatchObject({ needsYou: false, read: true, resolved: 'This request ended before you answered.' })
    expect(rows.find((x) => x.approvalId === 'hook')).toMatchObject({ needsYou: false, read: true, resolved: expect.stringMatching(/terminal/) })
  })

  it('leaves an approval that arrived in this run, with its waiter, pending at start', async () => {
    const { store } = await setup()
    const approvals = new Approvals(store)
    // A hook can land between the hook server starting and the expiry.
    const live = approvals.request({ kind: 'tool', source: 'hook', roomId: 'r', workspaceId: 'w', title: 'Run pnpm build' })
    expect(approvals.expireStale()).toEqual([])
    expect(approvals.isPending(live.approval.id)).toBe(true)
    expect(store.approvals({ pendingOnly: true }).map((a) => a.id)).toEqual([live.approval.id])
  })

  it("ends an archived workspace's approval that has a waiter, and leaves a held hook to its own session", async () => {
    const { store } = await setup()
    const approvals = new Approvals(store)
    const port = 17950 + Math.floor(Math.random() * 40)
    const server = await startHookServer({ port, approvals, approvalTimeoutMs: 60_000, isManaged: () => false, resolve: () => ({ roomId: 'r', workspaceId: 'w', agentId: 'kai' }) })
    try {
      const started = Date.now()
      const held = fetch(`http://127.0.0.1:${port}/hooks`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'outside', transcript_path: '/t', cwd: '/x', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm build' } })
      }).then((r) => r.json())
      while (!store.approvals({ pendingOnly: true }).length) await new Promise((r) => setTimeout(r, 10))
      const hookId = store.approvals({ pendingOnly: true })[0].id
      const sdk = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', workspaceId: 'w', title: 'Run pnpm test' })
      const elsewhere = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', workspaceId: 'other', title: 'Run pnpm lint' })

      expect(approvals.expireWorkspace('w').map((a) => a.status)).toEqual(['expired'])
      expect(await sdk.decision).toBeNull()
      expect(approvals.isPending(elsewhere.approval.id)).toBe(true)
      // A session Kernel didn't start asks with its room only (KERNEL-285), so archiving a workspace leaves it waiting.
      expect(approvals.isPending(hookId)).toBe(true)
      expect(store.approvals({ pendingOnly: true }).map((a) => a.id).sort()).toEqual([hookId, elsewhere.approval.id].sort())
      approvals.decide(hookId, { behavior: 'allow' })
      expect(await held).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("deletes an archived workspace's rows and tells open windows", async () => {
    const { store, n } = await setup()
    const ids = removedIds()
    bus.push({ type: 'pr', workspaceId: 'w', state: 'ready' })
    store.saveNotification(row('n-other', { workspaceId: 'w-other' }))
    const mine = n.list().filter((x) => x.workspaceId === 'w').map((x) => x.id)
    expect(mine).toHaveLength(1)
    expect(n.forgetWorkspace('w')).toEqual(mine)
    expect(ids).toEqual(mine)
    expect(n.list().map((x) => x.id)).toEqual(['n-other'])
  })

  it('adds no PR row for a workspace that is already archived', async () => {
    const { store, n } = await setup()
    store.saveWorkspace({ ...store.workspace('w')!, status: 'archived' })
    bus.push({ type: 'pr', workspaceId: 'w', state: 'ready' })
    expect(n.list()).toEqual([])
  })

  it("at start, deletes rows of archived and deleted workspaces and rows settled more than a week ago, never one that needs you", async () => {
    const { store, n } = await setup()
    n.detach()
    store.saveWorkspace({ ...store.workspace('w')!, id: 'w-archived', status: 'archived' })
    const old = NOW - KEEP_SETTLED_MS - DAY
    for (const r of [
      row('archived', { workspaceId: 'w-archived', needsYou: true, kind: 'merge' }),
      row('gone', { workspaceId: 'w-gone' }),
      row('old-settled', { createdAt: old }),
      row('old-room-only', { workspaceId: undefined, createdAt: old }),
      row('old-needs-you', { createdAt: old, needsYou: true, read: false, kind: 'check' }),
      row('recent-settled', { createdAt: NOW - DAY }),
      row('recent-room-only', { workspaceId: undefined, createdAt: NOW - 2 * DAY })
    ]) store.saveNotification(r)
    // A row the inbox already marked done whose approval is still waiting stays: the approval decides.
    store.saveApproval(approval({ id: 'still-waiting', workspaceId: 'w', createdAt: old }))
    store.saveNotification(row(approvalNotificationId('still-waiting'), { approvalId: 'still-waiting', kind: 'approval', createdAt: old }))

    const ids = removedIds()
    const again = restart(store)
    again.attach()
    expect(ids.sort()).toEqual(['archived', 'gone', 'old-room-only', 'old-settled'])
    expect(again.list().map((x) => x.id).sort()).toEqual([approvalNotificationId('still-waiting'), 'old-needs-you', 'recent-room-only', 'recent-settled'])
    // Run again a week later: only what still needs you, or waits on an approval, survives.
    const later = new Notifications({ store, settings: () => DEFAULT_SETTINGS('/h'), agentName: () => undefined, now: () => NOW + KEEP_SETTLED_MS + 3 * DAY })
    later.prune()
    expect(later.list().map((x) => x.id).sort()).toEqual([approvalNotificationId('still-waiting'), 'old-needs-you'])
  })
})

describe('Kernel start (KERNEL-155)', () => {
  it('expires an approval the last run left pending, and settles its row as read', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt') }))
    // The last run: Rowan's plan waits for an answer, with its row in Needs you. Then the app quits.
    const before = new Store(join(dataDir, 'kernel.db'))
    const plan = approval({ id: 'plan', kind: 'plan', toolName: undefined, title: 'Plan for the Ulat release' })
    before.saveApproval(plan)
    before.saveNotification({ id: approvalNotificationId('plan'), kind: 'approval', roomId: 'r', agentId: 'noor', approvalId: 'plan', title: 'Plan ready: the Ulat release', sub: 'Plan review', needsYou: true, read: false, createdAt: plan.createdAt })
    before.db.close()

    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop())
    expect(k.store.approvals().find((a) => a.id === 'plan')?.status).toBe('expired')
    expect(k.store.notification(approvalNotificationId('plan'))).toMatchObject({ needsYou: false, read: true, resolved: 'This request ended before you answered.' })
  })
})
