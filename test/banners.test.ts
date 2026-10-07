import { describe, expect, it } from 'vitest'
import type { Chat, Workspace } from '@shared/types'
import { bannerFor, setupCommand, type BannerInput } from '../src/renderer/src/screens/workspace/banners/model'

const now = new Date(2026, 9, 7, 11, 0).getTime()
const S = (ms: number) => Math.round(ms / 1000)
const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-table', branch: 'feat/x', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'kai', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Table', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: 1 }
const input = (o: Partial<BannerInput> = {}): BannerInput => ({
  ws, chat, agentName: 'Kai', running: false, usage: [], account: { signedIn: true }, online: true,
  hooks: { port: 7420, listening: true, installed: true, events: [] }, now, ...o
})

describe('workspace banners', () => {
  it('shows nothing when all is well', () => {
    expect(bannerFor(input())).toBeNull()
  })

  it('words the 5-hour limit with its reset time, and keeps the composer open for queueing', () => {
    const b = bannerFor(input({ usage: [{ type: 'five_hour', status: 'rejected', resetsAt: S(new Date(2026, 9, 7, 15, 40).getTime()) }] }))
    expect(b).toMatchObject({ id: 'session', kind: 'limit', title: "You've hit your 5-hour limit", sub: 'Resets at 3:40 PM. Kai finished this turn and stopped.', blocks: false, limit: 'five_hour' })
    expect(b?.actions.map((a) => a.label)).toEqual(['Queue message', 'Notify me'])
  })

  it('blocks the composer on the weekly limit and names the reset day', () => {
    const b = bannerFor(input({ usage: [{ type: 'seven_day', status: 'rejected', resetsAt: S(new Date(2026, 9, 12, 9, 0).getTime()) }, { type: 'five_hour', status: 'rejected', resetsAt: S(now + 3600_000) }] }))
    expect(b).toMatchObject({ id: 'weekly', sub: 'Resets Monday at 9:00 AM. Every room is paused.', blocks: true })
  })

  it('ignores a rejection whose reset time has passed', () => {
    expect(bannerFor(input({ usage: [{ type: 'five_hour', status: 'rejected', resetsAt: S(now - 1000) }] }))).toBeNull()
  })

  it('offers another model in one click when the chat\'s own model is limited', () => {
    const b = bannerFor(input({ chat: { ...chat, model: 'claude-fable-5-1' }, usage: [{ type: 'seven_day_opus', status: 'rejected', model: 'claude-fable-5-1', resetsAt: S(now + 3 * 86_400_000 - 3600_000) }] }))
    expect(b).toMatchObject({ id: 'model', title: "You've reached your Fable 5.1 limit", sub: 'It resets in 3 days. Opus 5.5 can pick up where this left off.', switchTo: 'claude-opus-5-5', blocks: false })
    expect(b?.actions.map((a) => a.label)).toEqual(['Wait', 'Switch to Opus 5.5'])
    // A limit on another model is not this chat's banner.
    expect(bannerFor(input({ usage: [{ type: 'seven_day_opus', status: 'rejected', model: 'claude-opus-5-5' }] }))).toBeNull()
  })

  it('counts down an overloaded retry', () => {
    const b = bannerFor(input({ retry: { attempt: 2, of: 5, nextAt: now + 12_000 } }))
    expect(b).toMatchObject({ id: 'overloaded', kind: 'retry', sub: 'Retrying in 12s, attempt 2 of 5. Your message is safe.' })
  })

  it('offers to compact from 90% context', () => {
    expect(bannerFor(input({ chat: { ...chat, context: 89 } }))).toBeNull()
    expect(bannerFor(input({ chat: { ...chat, context: 92 } }))).toMatchObject({ id: 'context', actions: [{ id: 'newChat' }, { id: 'compact', primary: true }] })
  })

  it('puts sign-out first, then offline, then a failed setup', () => {
    const all = { account: { signedIn: false }, online: false, ws: { ...ws, status: 'failed' as const } }
    expect(bannerFor(input(all))).toMatchObject({ id: 'signedOut', blocks: true })
    expect(bannerFor(input({ ...all, account: { signedIn: true } }))).toMatchObject({ id: 'offline', blocks: false })
    expect(bannerFor(input({ ...all, account: null, online: true }))).toMatchObject({ id: 'setup', blocks: true })
  })

  it('names the setup command that failed and its exit code', () => {
    const scripts = [{ kind: 'setup' as const, line: '$ pnpm install --frozen-lockfile && cp ../.env .env', stream: 'stdout' as const }]
    expect(setupCommand(scripts)).toBe('pnpm install')
    expect(bannerFor(input({ ws: { ...ws, status: 'failed' }, scripts, setupCode: 1 }))?.sub).toBe('pnpm install exited with code 1. Kai waits until setup passes.')
  })

  it('shows the hook server going down last', () => {
    expect(bannerFor(input({ hooks: { port: 7420, listening: false, installed: true, events: [] } }))).toMatchObject({ id: 'hooks', actions: [{ id: 'checkHooks' }, { id: 'reconnect' }] })
  })
})
