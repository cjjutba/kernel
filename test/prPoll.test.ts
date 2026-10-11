import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrInfo, PrState, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { NetworkMonitor } from '../src/main/services/health'

// KERNEL-216: the PR poll runs one at a time, reads nothing offline, backs off a PR whose reads fail, and reads a PR
// that has only waited on someone for a day every 5 minutes.

const info = (workspaceId: string, state: PrState, o: Partial<PrInfo> = {}): PrInfo =>
  ({ workspaceId, number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state, baseRef: 'main', checks: [], comments: [], conflicts: [], ...o })

const kernels: Kernel[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const k of kernels.splice(0)) await k.stop()
})

/**
 * A Kernel whose GitHub answers with `prs[workspaceId]`, or null when it has none, and counts each read. `n` workspaces
 * share one worktree, which is all a read needs, so ten open PRs don't cost ten checkouts.
 */
async function setup(n = 1) {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  kernels.push(k)
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  const room = await k.addRoom(repo)
  const first = await k.workspaces.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
  const ws: Workspace[] = [first]
  for (let i = 1; i < n; i++) {
    const copy: Workspace = { ...first, id: `${first.id}-${i}`, name: `${first.name}-${i}` }
    k.store.saveWorkspace(copy)
    ws.push(copy)
  }
  const prs: Record<string, PrInfo | null> = {}
  const reads: string[] = []
  k.github = {
    info: async (_cwd, _ref, workspaceId) => { reads.push(workspaceId); return prs[workspaceId] ?? null },
    merge: async () => undefined, ready: async () => undefined, reopen: async () => undefined
  }
  return { k, ws, prs, reads }
}

/** Fake time for Date only, so git and gh stubs still run. `tick` moves on one poll and runs it. */
function clock(k: Kernel) {
  vi.useFakeTimers({ toFake: ['Date'] })
  let now = Date.parse('2026-10-11T09:00:00Z')
  vi.setSystemTime(now)
  return {
    at: () => now,
    tick: async (ms = k.prs.pollMs) => { now += ms; vi.setSystemTime(now); await k.prs.pollPrs() },
    jump: (ms: number) => { now += ms; vi.setSystemTime(now) }
  }
}

describe('the PR poll (KERNEL-216)', () => {
  it('runs one poll at a time when gh hangs', async () => {
    const { k, ws, prs, reads } = await setup(2)
    for (const w of ws) { prs[w.id] = info(w.id, 'ready'); await k.prs.refreshPr(w.id) }
    reads.length = 0
    let release!: () => void
    const hung = new Promise<void>((r) => { release = r })
    const answer = k.github.info
    let waiting = 0
    k.github = { ...k.github, info: async (...a) => { waiting++; await hung; return answer(...a) } }
    const first = k.prs.pollPrs()
    await vi.waitFor(() => expect(waiting).toBe(1))
    // The 45 second timer firing again, and again, while gh still hasn't answered.
    const second = k.prs.pollPrs()
    const third = k.prs.pollPrs()
    expect(second).toBe(first)
    expect(third).toBe(first)
    await new Promise((r) => setTimeout(r, 50))
    expect(waiting).toBe(1)
    release()
    await first
    // One read per PR, for the one poll.
    expect(reads).toEqual([ws[0].id, ws[1].id])
    // Once it is done, the next poll runs.
    const next = k.prs.pollPrs()
    expect(next).not.toBe(first)
    await next
  })

  it('reads nothing while the Mac is offline', async () => {
    const { k, ws, prs, reads } = await setup()
    prs[ws[0].id] = info(ws[0].id, 'ready')
    await k.prs.refreshPr(ws[0].id)
    reads.length = 0
    k.account.network = new NetworkMonitor({ probe: async () => false, onChange: () => undefined })
    k.account.network.online = false
    await k.prs.pollPrs()
    expect(reads).toEqual([])
    k.account.network.online = true
    await k.prs.pollPrs()
    expect(reads).toEqual([ws[0].id])
  })

  it('waits twice as long after each failed read, up to 10 minutes, and goes back to every poll once gh answers', async () => {
    const { k, ws, prs, reads } = await setup()
    const id = ws[0].id
    prs[id] = info(id, 'checks')
    await k.prs.refreshPr(id)
    const t = clock(k)
    // gh answers nothing for a PR the workspace has: gh failing, or GitHub out of reach.
    prs[id] = null
    reads.length = 0
    const at: number[] = []
    const start = t.at()
    for (let i = 0; i < 50; i++) { const before = reads.length; await t.tick(); if (reads.length > before) at.push((t.at() - start) / 1000) }
    const gaps = at.slice(1).map((s, i) => s - at[i])
    expect(gaps.slice(0, 5)).toEqual([90, 180, 360, 630, 630])
    // A thrown read counts the same.
    const stub = k.refreshPr
    k.refreshPr = async () => { reads.push(id); throw new Error('gh exploded') }
    t.jump(10 * 60_000)
    const before = reads.length
    for (let i = 0; i < 14; i++) await t.tick()
    expect(reads.length - before).toBe(1)
    k.refreshPr = stub
    // GitHub answers again: every poll reads it.
    prs[id] = info(id, 'checks')
    t.jump(10 * 60_000)
    await t.tick()
    reads.length = 0
    for (let i = 0; i < 4; i++) await t.tick()
    expect(reads).toHaveLength(4)
    expect(k.store.workspace(id)?.prState).toBe('checks')
  })

  it('reads a ready or draft PR that has not changed in a day every 5 minutes, and every poll again once it changes', async () => {
    const { k, ws, prs, reads } = await setup(3)
    const [ready, draft, checks] = ws.map((w) => w.id)
    prs[ready] = info(ready, 'ready')
    prs[draft] = info(draft, 'draft')
    prs[checks] = info(checks, 'checks')
    for (const w of ws) await k.prs.refreshPr(w.id)
    const t = clock(k)
    await t.tick()
    t.jump(24 * 60 * 60_000)
    await t.tick()
    reads.length = 0
    for (let i = 0; i < 20; i++) await t.tick()
    const count = (id: string) => reads.filter((r) => r === id).length
    // 20 polls of 45 seconds is 15 minutes: a read every seven polls, five and a quarter minutes, and the checks PR at each.
    expect([count(ready), count(draft), count(checks)]).toEqual([2, 2, 20])
    // A new commit on the ready PR: GitHub checks it, and the poll follows it at its full rate.
    prs[ready] = info(ready, 'checks', { head: 'b2' })
    for (let i = 0; i < 7; i++) await t.tick()
    reads.length = 0
    prs[ready] = info(ready, 'ready', { head: 'b2' })
    for (let i = 0; i < 4; i++) await t.tick()
    expect(count(ready)).toBe(4)
    expect(k.store.workspace(ready)?.prState).toBe('ready')
  })

  it('costs ten open PRs at most a third of the gh calls an hour it did', async () => {
    const { k, ws, prs, reads } = await setup(10)
    for (const w of ws) { prs[w.id] = info(w.id, 'ready'); await k.prs.refreshPr(w.id) }
    const t = clock(k)
    const hour = async (states: PrState[]) => {
      ws.forEach((w, i) => { prs[w.id] = info(w.id, states[i]) })
      await t.tick()
      t.jump(24 * 60 * 60_000)
      await t.tick()
      reads.length = 0
      // A poll every 45 seconds for an hour.
      for (let i = 0; i < 80; i++) await t.tick()
      return reads.length
    }
    // Before, every poll read every open PR: 80 polls of 10 PRs. Each read is `gh pr view` and `gh api graphql`.
    const before = 80 * 10
    // Ten PRs that have waited a day for a review or a merge.
    const quiet = await hour(Array(10).fill('ready'))
    // Two of them with checks running all the while.
    const busy = await hour([...Array(8).fill('ready'), 'checks', 'checks'])
    expect({ quiet, busy }).toEqual({ quiet: 110, busy: 248 })
    expect(busy * 3).toBeLessThanOrEqual(before)
  })

  it('saves and pushes a workspace only when a read changed it', async () => {
    const { k, ws, prs } = await setup()
    const id = ws[0].id
    const pushed: PushEvent[] = []
    const on = (e: PushEvent) => { if ((e.type === 'workspace' && e.workspace.id === id) || e.type === 'task') pushed.push(e) }
    bus.on('push', on)
    try {
      prs[id] = info(id, 'ready')
      await k.prs.refreshPr(id)
      expect(pushed.filter((e) => e.type === 'workspace')).toHaveLength(1)
      pushed.length = 0
      await k.prs.refreshPr(id)
      await k.prs.refreshPr(id)
      expect(pushed).toEqual([])
      prs[id] = info(id, 'ready', { title: 'feat: invoice table' })
      expect((await k.prs.refreshPr(id)).prTitle).toBe('feat: invoice table')
      expect(pushed.filter((e) => e.type === 'workspace')).toHaveLength(1)
    } finally { bus.off('push', on) }
  })
})
