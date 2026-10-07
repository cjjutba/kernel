import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Approval, Notification, Workspace } from '../src/shared/types'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { Notifications, approvalNotificationId, inQuietHours } from '../src/main/services/notifications'

const open: Notifications[] = []
afterEach(() => { open.forEach((n) => n.detach()); open.length = 0 })

async function setup(o: { background?: boolean; sound?: 'none' | 'subtle'; quiet?: { from: string; to: string } | null; off?: 'permission' | 'merge' } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-n-')), 'k.db'))
  store.saveRoom({ id: 'r', name: 'Client A', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
  store.saveWorkspace({ id: 'w', roomId: 'r', name: 'org-invites', branch: 'b', baseRef: 'main', path: '/x', mode: 'worktree', agentId: 'kai', port: 1, status: 'ready', prState: 'open', prNumber: 41, createdAt: 1 } as Workspace)
  const settings = DEFAULT_SETTINGS('/h')
  settings.notifications = { ...settings.notifications, quietHours: o.quiet ?? null, sound: o.sound ?? 'subtle', ...(o.off ? { [o.off]: false } : {}) }
  const shown: Notification[] = []
  const silent: boolean[] = []
  const n = new Notifications({ store, settings: () => settings, agentName: (_r, a) => (a === 'noor' ? 'Noor' : undefined), show: (x, opts) => { shown.push(x); silent.push(opts.silent) }, inBackground: () => o.background ?? true })
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
    for (const o of [{ background: false }, { quiet: { from: '00:00', to: '23:59' } }, { off: 'permission' as const }]) {
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
