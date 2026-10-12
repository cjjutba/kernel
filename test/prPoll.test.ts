import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrInfo, PrState, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { NetworkMonitor } from '../src/main/services/health'
import { GhReadError, type RateLimit } from '../src/main/services/github'
import { git } from '../src/main/services/exec'

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
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { autoReview: false } }))
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

/**
 * Fake time for Date only, so git and gh stubs still run. `tick` moves on one poll and runs it. It starts at the real
 * time, since `setup` and the reads before `clock` stamp PRs with it: a fixed date would put those in the future once
 * the wall clock passed it (KERNEL-402).
 */
function clock(k: Kernel) {
  let now = Date.now()
  vi.useFakeTimers({ toFake: ['Date'] })
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

  it("leaves a PR GitHub is still checking to the quick re-check, which waits for a running poll and reads nothing offline (KERNEL-283)", async () => {
    const { k, ws, prs, reads } = await setup(2)
    const [a, b] = ws.map((w) => w.id)
    k.prs.recheckMs = 30
    prs[a] = info(a, 'ready')
    prs[b] = info(b, 'checks')
    for (const id of [a, b]) await k.prs.refreshPr(id)
    // Main moved: GitHub checks A for conflicts again, and A joins the quick re-check.
    prs[a] = info(a, 'checks', { conflictsUnknown: true })
    await k.prs.refreshPr(a)
    prs[a] = info(a, 'ready')
    let release!: () => void
    const hung = new Promise<void>((r) => { release = r })
    const answer = k.github.info
    k.github = { ...k.github, info: async (...args) => { if (args[2] === b) await hung; return answer(...args) } }
    reads.length = 0
    const poll = k.prs.pollPrs()
    // The poll skips A and hangs on B. The quick re-check's timer fires meanwhile and waits for the poll.
    await new Promise((r) => setTimeout(r, 120))
    expect(reads).toEqual([])
    release()
    await poll
    await vi.waitFor(() => expect(reads).toEqual([b, a]))
    expect(k.store.workspace(a)?.prState).toBe('ready')

    // Offline, the quick re-check reads nothing, and the first poll back online reads the PR.
    prs[a] = info(a, 'checks', { conflictsUnknown: true })
    await k.prs.refreshPr(a)
    prs[a] = info(a, 'ready')
    k.account.network = new NetworkMonitor({ probe: async () => false, onChange: () => undefined })
    k.account.network.online = false
    reads.length = 0
    await new Promise((r) => setTimeout(r, 120))
    expect(reads).toEqual([])
    k.account.network.online = true
    await k.prs.pollPrs()
    expect(reads).toContain(a)
    expect(k.store.workspace(a)?.prState).toBe('ready')
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
    const ids = new Set(ws.map((w) => w.id))
    const t = clock(k)
    const hour = async (states: PrState[]) => {
      ws.forEach((w, i) => { prs[w.id] = info(w.id, states[i]) })
      await t.tick()
      t.jump(24 * 60 * 60_000)
      await t.tick()
      reads.length = 0
      // A poll every 45 seconds for an hour.
      for (let i = 0; i < 80; i++) await t.tick()
      return reads.filter((id) => ids.has(id)).length
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

/**
 * GitHub with a batch read (KERNEL-388): `prs[workspaceId]` answers both reads, the batch by the PR's number. Each batch's
 * numbers and each full read's workspace are kept, with the options they were given.
 */
function batched(k: Kernel, prs: Record<string, PrInfo | null>) {
  const calls = { batches: [] as number[][], infos: [] as string[], options: [] as unknown[] }
  const rate: { value?: RateLimit } = {}
  k.github = {
    ...k.github,
    info: async (_cwd, _ref, id, o) => { calls.infos.push(id); calls.options.push(o); return prs[id] ?? null },
    prs: async (_cwd, numbers, o) => {
      calls.batches.push([...numbers].sort())
      calls.options.push(o)
      const byNumber = new Map(Object.values(prs).flatMap((p) => (p ? [[p.number, p] as const] : [])))
      return { infos: new Map(numbers.flatMap((n) => (byNumber.has(n) ? [[n, byNumber.get(n)!] as const] : []))), ...(rate.value ? { rate: rate.value } : {}) }
    },
    rateLimit: async () => undefined
  }
  return { calls, rate }
}

describe('the batch read (KERNEL-388)', () => {
  it("reads a room's open PRs in one batch, and in full only the PR that changed", async () => {
    const { k, ws, prs } = await setup(3)
    const [a, b, c] = ws.map((w) => w.id)
    prs[a] = info(a, 'checks', { number: 41, checks: [{ name: 'Test', state: 'running' }] })
    prs[b] = info(b, 'ready', { number: 42 })
    prs[c] = info(c, 'ready', { number: 43 })
    const { calls } = batched(k, prs)
    for (const w of ws) await k.prs.refreshPr(w.id)
    calls.infos.length = 0
    await k.prs.pollPrs()
    expect(calls.batches).toEqual([[41, 42, 43]])
    expect(calls.infos).toEqual([])
    // Test passes on A: the batch sees it, and only A gets the full read that moves its header.
    prs[a] = info(a, 'ready', { number: 41, checks: [{ name: 'Test', state: 'pass' }] })
    await k.prs.pollPrs()
    expect(calls.batches).toHaveLength(2)
    expect(calls.infos).toEqual([a])
    expect(k.store.workspace(a)?.prState).toBe('ready')
    await k.prs.pollPrs()
    expect(calls.infos).toEqual([a])
  })

  it("leaves a PR as it was when GitHub can't be read, and a finished Creating goes back after three failed reads", async () => {
    const { k, ws, prs } = await setup(2)
    const [a, b] = ws.map((w) => w.id)
    prs[a] = info(a, 'cifail', { number: 41 })
    await k.prs.refreshPr(a)
    k.store.saveWorkspace({ ...k.store.workspace(b)!, prState: 'creating', prNumber: undefined })
    k.github = { ...k.github, info: async () => { throw new GhReadError('error connecting to api.github.com') } }
    const events: PushEvent[] = []
    const on = (e: PushEvent) => { if (e.type === 'pr') events.push(e) }
    bus.on('push', on)
    try {
      expect((await k.prs.refreshPr(a)).prState).toBe('cifail')
      expect(events).toEqual([])
      expect((await k.prs.refreshPr(b, { settle: true })).prState).toBe('creating')
      expect((await k.prs.refreshPr(b, { settle: true })).prState).toBe('creating')
      expect((await k.prs.refreshPr(b, { settle: true })).prState).toBe('none')
    } finally { bus.off('push', on) }
  })

  it('stops reading near the rate limit until it resets, while opening a PR still reads it', async () => {
    const { k, ws, prs } = await setup()
    const id = ws[0].id
    prs[id] = info(id, 'checks', { number: 42 })
    const { calls, rate } = batched(k, prs)
    await k.prs.refreshPr(id)
    rate.value = { remaining: 100, limit: 5000, resetAt: Date.now() + 10 * 60_000 }
    await k.prs.pollPrs()
    await k.prs.pollPrs()
    expect(calls.batches).toHaveLength(1)
    expect(k.prs.cadence.resumesAt()).toBe(rate.value.resetAt)
    calls.infos.length = 0
    k.prs.infoMs = 0
    prs[id] = info(id, 'ready', { number: 42 })
    expect(await k.prs['getPr'](id)).toMatchObject({ state: 'ready' })
    expect(calls.infos).toEqual([id])
    expect(k.store.workspace(id)?.prState).toBe('ready')
  })

  it('pauses until the reset when GitHub refuses the batch for its rate limit', async () => {
    const { k, ws, prs } = await setup()
    const id = ws[0].id
    prs[id] = info(id, 'checks', { number: 42 })
    batched(k, prs)
    await k.prs.refreshPr(id)
    const resetAt = Date.now() + 30 * 60_000
    k.github = { ...k.github, prs: async () => { throw new GhReadError("GitHub's rate limit is used up.", true) }, rateLimit: async () => ({ remaining: 0, limit: 5000, resetAt }) }
    await k.prs.pollPrs()
    expect(k.prs.cadence.paused()).toBe(true)
    expect(k.prs.cadence.resumesAt()).toBe(resetAt)
    expect(k.store.workspace(id)?.prState).toBe('checks')
  })

  it("passes the room's optional_checks to both reads", async () => {
    const { k, ws, prs } = await setup()
    const id = ws[0].id
    const room = k.store.room(ws[0].roomId)!
    await mkdir(join(room.path, '.kernel'), { recursive: true })
    await writeFile(join(room.path, '.kernel', 'settings.toml'), '[pr]\noptional_checks = ["Vercel*"]\n')
    prs[id] = info(id, 'checks', { number: 42 })
    const { calls } = batched(k, prs)
    await k.prs.refreshPr(id)
    await k.prs.pollPrs()
    expect(calls.options).toEqual([expect.objectContaining({ optional: ['Vercel*'] }), { optional: ['Vercel*'] }])
  })

  it("keeps GitHub's merge block on a ready PR, and Merge PR says why", async () => {
    const { k, ws, prs } = await setup()
    const id = ws[0].id
    prs[id] = info(id, 'ready', { number: 42, blocked: 'review' })
    await k.prs.refreshPr(id)
    expect(k.store.workspace(id)).toMatchObject({ prState: 'ready', prBlocked: 'review' })
    await expect(k.prs.mergePr(id)).rejects.toThrow('GitHub needs an approving review before this pull request can merge.')
    prs[id] = info(id, 'ready', { number: 42 })
    await k.prs.refreshPr(id)
    expect(k.store.workspace(id)?.prBlocked).toBeUndefined()
  })

  it('moves the header with what opening the PR reads, and reuses a read from the last 10 seconds', async () => {
    const { k, ws, prs, reads } = await setup()
    const id = ws[0].id
    prs[id] = info(id, 'checks', { number: 42 })
    await k.prs.refreshPr(id)
    prs[id] = info(id, 'ready', { number: 42 })
    reads.length = 0
    expect(await k.prs['getPr'](id)).toMatchObject({ state: 'checks' })
    expect(reads).toEqual([])
    k.prs.infoMs = 0
    expect(await k.prs['getPr'](id)).toMatchObject({ state: 'ready' })
    expect(k.store.workspace(id)?.prState).toBe('ready')
    expect(reads).toEqual([id])
  })

  it('polls soon on request once started, and never before start or after stop', async () => {
    const idle = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home: await mkdtemp(join(tmpdir(), 'kernel-home-')) })
    idle.prs.pollSoon()
    expect(idle.prs['timer']).toBeUndefined()
    const { k, ws, prs } = await setup()
    const id = ws[0].id
    prs[id] = info(id, 'checks', { number: 42 })
    const { calls } = batched(k, prs)
    await k.prs.refreshPr(id)
    k.prs.cadence.c = { ...k.prs.cadence.c, soonMs: 5, minGapMs: 0, fastMs: 60_000, calmMs: 60_000 }
    k.prs.pollSoon()
    await vi.waitFor(() => expect(calls.batches).toHaveLength(1))
    k.prs.stop()
    k.prs.pollSoon()
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.batches).toHaveLength(1)
  })

  it('follows a branch switched by hand on a batch poll', async () => {
    const { k, ws, prs } = await setup()
    const id = ws[0].id
    prs[id] = info(id, 'checks', { number: 42 })
    batched(k, prs)
    await k.prs.refreshPr(id)
    await git(ws[0].path, 'checkout', '-q', '-b', 'feat/other')
    prs[id] = null
    await k.prs.pollPrs()
    expect(k.store.workspace(id)).toMatchObject({ branch: 'feat/other', prState: 'none' })
    expect(k.store.workspace(id)?.prNumber).toBeUndefined()
  })
})

describe("the GitHub pause and GitHub's merge block, as main pushes them (KERNEL-401)", () => {
  const listen = () => {
    const pushed: PushEvent[] = []
    const on = (e: PushEvent) => { if (e.type === 'github' || e.type === 'pr.blocked') pushed.push(e) }
    bus.on('push', on)
    onTestFinished(() => { bus.off('push', on) })
    return pushed
  }

  it('pushes the pause when a read starts it, when a refused read moves it, and its end from the poll after', async () => {
    const { k, ws, prs } = await setup()
    const id = ws[0].id
    prs[id] = info(id, 'checks', { number: 42 })
    const { rate } = batched(k, prs)
    await k.prs.refreshPr(id)
    const pushed = listen()
    const resetAt = Date.now() + 300
    rate.value = { remaining: 100, limit: 5000, resetAt }
    await k.prs.pollPrs()
    expect(pushed).toEqual([{ type: 'github', status: { pausedUntil: resetAt } }])
    expect(await k.handlers()['github.status']()).toEqual({ pausedUntil: resetAt })
    // GitHub's slow-down limit refuses a read past that: the pause moves, and says which limit.
    k.prs.cadence.c = { ...k.prs.cadence.c, backoffMs: 10_000 }
    k.prs['cadence'].limited({ secondary: true })
    k.prs['syncGitHub']()
    expect(pushed.at(-1)).toMatchObject({ type: 'github', status: { slowDown: true } })
    // Once it has passed, and GitHub has points to spare again, the next poll says so.
    rate.value = { remaining: 4900, limit: 5000, resetAt }
    k.prs.cadence.started()
    await k.prs.pollPrs()
    expect(pushed.at(-1)).toEqual({ type: 'github', status: {} })
    await k.prs.pollPrs()
    expect(pushed.filter((e) => e.type === 'github')).toHaveLength(3)
  })

  it('pushes pr.blocked when GitHub starts or stops blocking a PR that stays ready, and not when it becomes ready blocked', async () => {
    const { k, ws, prs } = await setup()
    const id = ws[0].id
    prs[id] = info(id, 'checks', { number: 42 })
    await k.prs.refreshPr(id)
    const pushed = listen()
    prs[id] = info(id, 'ready', { number: 42, blocked: 'behind' })
    await k.prs.refreshPr(id)
    expect(pushed).toEqual([])
    prs[id] = info(id, 'ready', { number: 42, blocked: 'review' })
    await k.prs.refreshPr(id)
    prs[id] = info(id, 'ready', { number: 42 })
    await k.prs.refreshPr(id)
    expect(pushed).toEqual([{ type: 'pr.blocked', workspaceId: id, blocked: 'review' }, { type: 'pr.blocked', workspaceId: id }])
  })

  it("keeps the loop guard while a ready PR is still behind, and starts it over once it catches up", async () => {
    const { k, ws, prs } = await setup()
    const id = ws[0].id
    const resets = vi.spyOn(k.nudges, 'reset')
    prs[id] = info(id, 'checks', { number: 42, head: 'h1', checks: [{ name: 'Test', state: 'running' }] })
    await k.prs.refreshPr(id)
    // The agent updated onto a stale base: a new head, still behind.
    prs[id] = info(id, 'ready', { number: 42, head: 'h2', blocked: 'behind', checks: [{ name: 'Test', state: 'pass' }] })
    await k.prs.refreshPr(id)
    expect(resets).not.toHaveBeenCalled()
    prs[id] = info(id, 'ready', { number: 42, head: 'h2', checks: [{ name: 'Test', state: 'pass' }] })
    await k.prs.refreshPr(id)
    expect(resets).toHaveBeenCalledTimes(1)
  })
})
