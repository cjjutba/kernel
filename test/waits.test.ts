import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Chat, PrInfo, PrState, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { exec, run } from '../src/main/services/exec'
import { listCheckpoints } from '../src/main/services/checkpoints'
import { kernelTools, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { resolveTarget, waitBroken, waitMet, waitRefusal } from '../src/main/services/waits'
import { saveLinearToken } from '../src/main/services/integrations'
import { tempRepo, trustRoom } from './helpers'

// KERNEL-259: a teammate waits for other workspaces' PRs to merge, and Kernel starts it, or tells it to rebase, when they do.

// A scripted SDK, as in health.test.ts. `tool` keeps the handler so the Lead's tools can run against a real Kernel.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  query: ({ options }: { options: unknown }) => {
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    sdk.calls.push({ options, feed: (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) } })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 10 })
    }
  }
}))

const flush = () => new Promise((r) => setTimeout(r, 30))
/** Releases fetch, fast-forward and may rerun setup, which takes a while when the whole suite runs at once. */
const SLOW = { timeout: 10_000 }
const AGENT = (id: string, extra = '') => `---\nname: ${id}\ndescription: ${id}.\n${extra}---\nYou are ${id}.`
const prInfo = (state: PrState, number: number): PrInfo => ({ workspaceId: '', number, url: `https://github.com/x/y/pull/${number}`, title: `PR ${number}`, state, baseRef: 'main', checks: [], comments: [], conflicts: [] })

/** A room on a repo with a bare origin, a fake GitHub, and Kernels that can quit and start again on the same data. */
async function setup(files: Record<string, string> = {}, o: { fetch?: typeof fetch; linearToken?: string } = {}) {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/rowan.md': AGENT('rowan', 'lead: true\n'), '.claude/agents/kai.md': AGENT('kai'), '.claude/agents/noor.md': AGENT('noor'), '.kernel/settings.toml': '[scripts]\nrun = "touch ran.txt"\n', ...files })
  const origin = join(await mkdtemp(join(tmpdir(), 'kernel-origin-')), 'o.git')
  await run('git', ['clone', '-q', '--bare', repo, origin])
  await run('git', ['-C', repo, 'remote', 'add', 'origin', origin])
  await run('git', ['-C', repo, 'fetch', '-q', 'origin'])
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  // The workspaces start from the local main, which a merge on GitHub doesn't move.
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, scripts: { runAfterSetup: true }, pr: { requireGreen: false } }))
  if (o.linearToken) await saveLinearToken(dataDir, o.linearToken)
  const gh = { prs: new Map<string, PrInfo>() }
  const fake = (k: Kernel) => {
    k.github = {
      info: async (_cwd, ref, workspaceId) => { const pr = gh.prs.get(ref); return pr ? { ...pr, workspaceId } : null },
      merge: async (_cwd, ref) => { const pr = gh.prs.get(ref); if (pr) { await land(origin, `pr-${pr.number}.txt`); gh.prs.set(ref, { ...pr, state: 'merged' }) } },
      ready: async () => {}, reopen: async () => {}
    }
    return k
  }
  const k = fake(new Kernel({ dataDir, home, fetch: o.fetch }))
  await k.start()
  const room = await k.addRoom(repo)
  await trustRoom(k, room.id)
  const lead = await k.leadChat(room.id)
  const again = async () => { const next = fake(new Kernel({ dataDir, home, fetch: o.fetch })); await next.start(); return next }
  /** A teammate's workspace with an open PR, the work others wait for. */
  const target = async (k: Kernel, number: number, title = `Work ${number}`, issue?: string) => {
    const ws = await k.createWorkspace(room.id, { prompt: title, agentId: 'noor', title, leadChatId: lead.id, ...(issue ? { source: { kind: 'issue' as const, id: issue, title } } : {}) })
    gh.prs.set(ws.branch, prInfo('open', number))
    return k.refreshPr(ws.id)
  }
  /** The PR merges on GitHub: its commit lands on origin, and Kernel reads the merge. */
  const mergeOnGitHub = async (k: Kernel, ws: Workspace) => {
    const pr = gh.prs.get(ws.branch)!
    await land(origin, `pr-${pr.number}.txt`)
    gh.prs.set(ws.branch, { ...pr, state: 'merged' })
    return k.refreshPr(ws.id)
  }
  const setPr = (ws: Workspace, state: PrState) => gh.prs.set(ws.branch, { ...gh.prs.get(ws.branch)!, state })
  return { k, room, lead, repo, origin, gh, again, target, mergeOnGitHub, setPr }
}

/** Another clone pushes a commit to origin's main, as a merged PR does. */
async function land(origin: string, file: string) {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-clone-'))
  await run('git', ['clone', '-q', origin, dir])
  await run('git', ['-C', dir, 'config', 'user.email', 't@t.dev'])
  await run('git', ['-C', dir, 'config', 'user.name', 'Test'])
  await writeFile(join(dir, file), `${file}\n`)
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-q', '-m', file])
  await run('git', ['-C', dir, 'push', '-q', 'origin', 'HEAD:main'])
}

const chatOf = (k: Kernel, ws: Workspace) => k.store.chats(ws.id).find((c) => c.kind !== 'terminal')!
const text = (parts: { type: string; text?: string }[]) => parts.find((p) => p.type === 'text')?.text ?? ''
const queue = (k: Kernel, chat: Chat) => k.sessions.queued(chat.id).map((q) => [text(q.parts), q.from])
const users = (k: Kernel, chat: Chat) => k.store.items(chat.id).flatMap((i) => (i.kind === 'user' ? [[text(i.parts), i.from]] : []))
const notes = (k: Kernel, chat: Chat) => k.store.items(chat.id).flatMap((i) => (i.kind === 'note' ? [i.text] : []))
const callsIn = (ws: Workspace) => sdk.calls.filter((c) => c.options.cwd === ws.path)
const result = (uuid: string) => ({ type: 'result', subtype: 'success', uuid, duration_ms: 1, session_id: 's' })
const head = async (path: string) => (await run('git', ['-C', path, 'rev-parse', 'HEAD'])).trim()
const pending = (k: Kernel) => (k.store.meta<{ pending: [string, { events: { kind: string; workspaceId: string; wait?: { gone?: string } }[] }][] }>('leadUpdates')?.pending ?? []).flatMap(([, p]) => p.events)
const released = (k: Kernel, ws: Workspace) => vi.waitFor(() => { expect(k.store.workspace(ws.id)?.waitsFor).toBeUndefined() }, SLOW)

describe('a hand-off that waits for a merge', () => {
  it('creates the worktree and runs setup, then holds the brief with no checkpoint, run script or turn', async () => {
    const { k, room, lead, target } = await setup({ '.kernel/settings.toml': '[scripts]\nsetup = "touch set-up.txt"\nrun = "touch ran.txt"\n' })
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    const chat = chatOf(k, w)
    expect(existsSync(join(w.path, 'set-up.txt'))).toBe(true)
    expect(w).toMatchObject({ status: 'ready', waitsFor: { on: [noor.id], held: true, base: await head(w.path) } })
    expect(queue(k, chat)).toEqual([['Build T-15', 'lead']])
    expect(users(k, chat)).toEqual([])
    expect(notes(k, chat)).toContain('Waiting for PR #164 by Noor to merge. Kernel sends this brief then. Send now starts it sooner.')
    expect(callsIn(w)).toEqual([])
    expect(existsSync(join(w.path, 'ran.txt'))).toBe(false)
    expect(await listCheckpoints(w)).toEqual([])
    // The Lead's message waits behind the brief, and the Lead hears why.
    const sent = await k['messageWorkspace'](room.id, w.id, 'Use the new rows', lead.id)
    expect(sent.note).toBe('Kai waits for PR #164 by Noor to merge, so this goes out after the brief. To start Kai now, call wait_for_merge with an empty list.')
    expect(queue(k, chat)).toEqual([['Build T-15', 'lead'], ['Use the new rows', 'lead']])
    await k.stop()
  })

  it.each(['GitHub', 'Kernel'])('fast-forwards onto origin and sends the brief, then the Lead\'s message, when the PR merges on %s', async (where) => {
    const { k, room, lead, target, mergeOnGitHub, origin } = await setup()
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    await k['messageWorkspace'](room.id, w.id, 'Use the new rows', lead.id)
    const chat = chatOf(k, w)
    if (where === 'GitHub') await mergeOnGitHub(k, noor)
    else await k.mergePr(noor.id)
    await released(k, w)
    expect(await head(w.path)).toBe((await run('git', ['-C', origin, 'rev-parse', 'main'])).trim())
    expect(existsSync(join(w.path, 'pr-164.txt'))).toBe(true)
    // The start of chat is the new HEAD, so reverting to it keeps the merged work.
    const start = (await listCheckpoints(k.store.workspace(w.id)!)).find((c) => c.start)!
    expect((await exec('git', ['-C', w.path, 'cat-file', '-e', `${start.ref}:pr-164.txt`])).code).toBe(0)
    expect(notes(k, chat)).toContain('PR #164 by Noor merged. Your branch now starts from it.')
    expect(users(k, chat)).toEqual([['Build T-15', 'lead']])
    await vi.waitFor(() => expect(existsSync(join(w.path, 'ran.txt'))).toBe(true), SLOW)
    callsIn(w)[0].feed(result('r1'))
    await flush()
    expect(users(k, chat)).toEqual([['Build T-15', 'lead'], ['Use the new rows', 'lead']])
    expect(pending(k).some((e) => e.kind === 'wait.released' && e.workspaceId === w.id)).toBe(true)
    await k.stop()
  })

  it('leaves a dirty tree where it is, and asks for a rebase after the brief', async () => {
    const { k, room, lead, target, mergeOnGitHub } = await setup()
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    const base = await head(w.path)
    await writeFile(join(w.path, 'README.md'), '# changed by hand\n')
    await mergeOnGitHub(k, noor)
    await released(k, w)
    const chat = chatOf(k, w)
    expect(await head(w.path)).toBe(base)
    expect(users(k, chat)).toEqual([['Build T-15', 'lead']])
    expect(queue(k, chat)).toEqual([['PR #164 by Noor merged after your branch started. Rebase onto origin/main before you build on it.', 'kernel']])
    await k.stop()
  })

  it('waits for every PR it is on', async () => {
    const { k, room, lead, target, mergeOnGitHub } = await setup()
    const a = await target(k, 164)
    const b = await target(k, 170)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [a.id, b.id] })
    await mergeOnGitHub(k, a)
    await flush()
    expect(k.store.workspace(w.id)?.waitsFor).toMatchObject({ on: [a.id, b.id], held: true })
    expect(users(k, chatOf(k, w))).toEqual([])
    await mergeOnGitHub(k, b)
    await released(k, w)
    expect(existsSync(join(w.path, 'pr-164.txt')) && existsSync(join(w.path, 'pr-170.txt'))).toBe(true)
    await k.stop()
  })

  it('tells the Lead once when a PR it waits for closes without merging, and keeps the brief held', async () => {
    const { k, room, lead, target, setPr } = await setup()
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    setPr(noor, 'closed')
    await k.refreshPr(noor.id)
    await flush()
    expect(pending(k).filter((e) => e.kind === 'wait.broken' && e.workspaceId === w.id)).toHaveLength(1)
    expect(k.store.workspace(w.id)?.waitsFor?.held).toBe(true)
    expect(queue(k, chatOf(k, w))).toEqual([['Build T-15', 'lead']])
    await k.stop()
  })

  it('tells the Lead when work it waits for is archived without merging', async () => {
    const { k, room, lead } = await setup()
    const noor = await k.createWorkspace(room.id, { prompt: 'Build T-14', agentId: 'noor', title: 'Tool rows', leadChatId: lead.id })
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    await k.archiveWorkspace(noor.id)
    expect(pending(k).filter((e) => e.kind === 'wait.broken' && e.workspaceId === w.id).map((e) => e.wait?.gone)).toEqual(['archived'])
    expect(k.store.workspace(w.id)?.waitsFor?.held).toBe(true)
    await k.stop()
  })

  it('starts at once on wait_for_merge with an empty list, or Send now on the held brief', async () => {
    const { k, room, lead, target } = await setup()
    const noor = await target(k, 164)
    const one = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    await k.setWait(one.id, [])
    expect(k.store.workspace(one.id)?.waitsFor).toBeUndefined()
    expect(users(k, chatOf(k, one))).toEqual([['Build T-15', 'lead']])
    expect(notes(k, chatOf(k, one))).toContain('Started without waiting for PR #164 by Noor.')
    const two = await k.createWorkspace(room.id, { prompt: 'Build T-16', agentId: 'kai', title: 'Thinking rows again', leadChatId: lead.id, waitFor: [noor.id] })
    const chat = chatOf(k, two)
    await k['sendNow'](chat.id, k.sessions.queued(chat.id)[0].id)
    expect(k.store.workspace(two.id)?.waitsFor).toBeUndefined()
    expect(users(k, chat)).toEqual([['Build T-16', 'lead']])
    await k.stop()
  })

  it('starts early from what merged already, and wait_for_merge says so', async () => {
    const { k, room, lead, target, mergeOnGitHub } = await setup()
    const a = await target(k, 164)
    const b = await target(k, 170)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [a.id, b.id] })
    await mergeOnGitHub(k, a)
    const rowan = (await k.agents(room.id)).find((x) => x.lead)!
    const tool = kernelTools(k['leadToolDeps'](room.id, rowan, lead)).find((t) => t.name === 'wait_for_merge')!
    const out = (await tool.handler({ workspace_id: w.id, on: [] } as never, {})).content[0] as { text: string }
    expect(out.text).toBe('Kai no longer waits. Kernel sent the brief, so Kai starts now.')
    expect(k.store.workspace(w.id)?.waitsFor).toBeUndefined()
    expect(existsSync(join(w.path, 'pr-164.txt'))).toBe(true)
    expect(notes(k, chatOf(k, w))).toEqual(expect.arrayContaining(['Started without waiting for PR #170 by Noor.', 'PR #164 by Noor merged. Your branch now starts from it.']))
    expect(users(k, chatOf(k, w))).toEqual([['Build T-15', 'lead']])
    await k.stop()
  })

  it("asks for a rebase when origin can't be fetched, instead of claiming the merge", async () => {
    const { k, room, lead, target, repo, gh } = await setup()
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    const base = await head(w.path)
    await run('git', ['-C', repo, 'remote', 'set-url', 'origin', join(tmpdir(), 'no-such-origin.git')])
    gh.prs.set(noor.branch, { ...gh.prs.get(noor.branch)!, state: 'merged' })
    await k.refreshPr(noor.id)
    await released(k, w)
    expect(await head(w.path)).toBe(base)
    expect(queue(k, chatOf(k, w))).toEqual([['PR #164 by Noor merged after your branch started. Rebase onto origin/main before you build on it.', 'kernel']])
    await k.stop()
  })

  it('runs setup again when the branch moved, and a failure there leaves Run again to send the brief', async () => {
    const { k, room, lead, target, mergeOnGitHub } = await setup({ '.kernel/settings.toml': '[scripts]\nsetup = "test ! -f pr-164.txt || test -f ok.txt"\n' })
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    expect(w.status).toBe('ready')
    await mergeOnGitHub(k, noor)
    await vi.waitFor(() => expect(k.store.workspace(w.id)?.status).toBe('failed'), SLOW)
    expect(k.store.workspace(w.id)?.waitsFor).toBeUndefined()
    const chat = chatOf(k, w)
    expect(queue(k, chat)).toEqual([['Build T-15', 'lead']])
    await writeFile(join(w.path, 'ok.txt'), 'ok\n')
    expect((await k.retrySetup(w.id)).status).toBe('ready')
    expect(users(k, chat)).toEqual([['Build T-15', 'lead']])
    await k.stop()
  })

  it('keeps the brief held when Run again passes while the wait still stands', async () => {
    const { k, room, lead, target } = await setup({ '.kernel/settings.toml': '[scripts]\nsetup = "test -f ok.txt"\n' })
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    expect(w).toMatchObject({ status: 'failed', waitsFor: { held: true } })
    await writeFile(join(w.path, 'ok.txt'), 'ok\n')
    expect(await k.retrySetup(w.id)).toMatchObject({ status: 'ready', waitsFor: { on: [noor.id], held: true } })
    const chat = chatOf(k, w)
    expect(queue(k, chat)).toEqual([['Build T-15', 'lead']])
    expect(users(k, chat)).toEqual([])
    expect(pending(k).some((e) => e.kind === 'setup.passed' && e.workspaceId === w.id && !!e.wait)).toBe(true)
    await k.stop()
  })

  it('archives a held waiter through archive_workspace, and ends its wait', async () => {
    const { k, room, lead, target } = await setup()
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    const rowan = (await k.agents(room.id)).find((a) => a.lead)!
    const archive = kernelTools(k['leadToolDeps'](room.id, rowan, lead)).find((t) => t.name === 'archive_workspace')!
    const out = await archive.handler({ workspace_ids: [w.id] } as never, {})
    expect((out.content[0] as { text: string }).text).toBe(`Archived ${w.name}.`)
    expect(k.store.workspace(w.id)).toMatchObject({ status: 'archived' })
    expect(k.store.workspace(w.id)?.waitsFor).toBeUndefined()
    await k.stop()
  })

  it("doesn't release on a target that merged an earlier PR and pressed Continue", async () => {
    const { k, room, lead, target, gh, mergeOnGitHub } = await setup()
    const noor = await target(k, 160)
    await mergeOnGitHub(k, noor)
    await k.continuePr(noor.id)
    expect(k.store.workspace(noor.id)).toMatchObject({ prState: 'none', mergedAt: expect.any(Number) })
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    await k['retryWaits']()
    const next = k.store.workspace(noor.id)!
    gh.prs.set(next.branch, prInfo('open', 164))
    await k.refreshPr(noor.id)
    await flush()
    expect(k.store.workspace(w.id)?.waitsFor).toMatchObject({ on: [noor.id], held: true })
    expect(users(k, chatOf(k, w))).toEqual([])
    await k.stop()
  })
})

describe('a teammate that already started', () => {
  it('gets the rebase message posted when its chat is idle', async () => {
    const { k, room, lead, target, mergeOnGitHub } = await setup()
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id })
    callsIn(w)[0].feed(result('r1'))
    await flush()
    expect((await k.setWait(w.id, [noor.id])).waitsFor).toEqual({ on: [noor.id], held: false })
    await mergeOnGitHub(k, noor)
    const chat = chatOf(k, w)
    await vi.waitFor(() => expect(users(k, chat).at(-1)).toEqual(['PR #164 by Noor merged into main. Fetch origin, rebase onto origin/main, re-run the tests, then carry on with your task.', 'kernel']), SLOW)
    expect(k.store.workspace(w.id)?.waitsFor).toMatchObject({ releasing: true })
    callsIn(w)[0].feed(result('r2'))
    await released(k, w)
    await k.stop()
  })

  it('queues it behind a busy turn, and sends it again after a restart until a turn Kernel started ends', async () => {
    const { k, room, lead, target, mergeOnGitHub, again } = await setup()
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id })
    await k.setWait(w.id, [noor.id])
    await mergeOnGitHub(k, noor)
    const chat = chatOf(k, w)
    const REBASE = 'PR #164 by Noor merged into main. Fetch origin, rebase onto origin/main, re-run the tests, then carry on with your task.'
    await vi.waitFor(() => expect(queue(k, chat)).toEqual([[REBASE, 'kernel']]), SLOW)
    // The brief's turn ends and the message goes out. Kernel quits before that turn ends.
    callsIn(w)[0].feed(result('r1'))
    await flush()
    expect(users(k, chat)).toEqual([['Build T-15', 'lead'], [REBASE, 'kernel']])
    expect(k.store.workspace(w.id)?.waitsFor).toMatchObject({ releasing: true })
    await k.stop()
    const before = callsIn(w).length
    const k2 = await again()
    await vi.waitFor(() => expect(users(k2, chat).filter(([t]) => t === REBASE)).toHaveLength(2), SLOW)
    callsIn(w)[before].feed(result('r2'))
    await released(k2, w)
    await k2.stop()
  })
})

describe('across a restart', () => {
  it('keeps the brief held, and a merge made while Kernel was closed releases it at the first poll', async () => {
    const { k, room, lead, target, again, origin, gh } = await setup()
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    const chat = chatOf(k, w)
    await k.stop()
    await land(origin, 'pr-164.txt')
    gh.prs.set(noor.branch, { ...gh.prs.get(noor.branch)!, state: 'merged' })
    const k2 = await again()
    await flush()
    expect(k2.store.workspace(w.id)).toMatchObject({ status: 'ready', waitsFor: { held: true } })
    expect(queue(k2, chat)).toEqual([['Build T-15', 'lead']])
    expect((await k2['messageWorkspace'](room.id, w.id, 'Still there?', lead.id)).sent).toBe(false)
    await k2['pollPrs']()
    await released(k2, w)
    expect(users(k2, chat)[0]).toEqual(['Build T-15', 'lead'])
    expect(existsSync(join(w.path, 'pr-164.txt'))).toBe(true)
    await k2.stop()
  })

  it('releases at start a merge saved just before the quit', async () => {
    const { k, room, lead, target, again, origin } = await setup()
    const noor = await target(k, 164)
    const w = await k.createWorkspace(room.id, { prompt: 'Build T-15', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id, waitFor: [noor.id] })
    await land(origin, 'pr-164.txt')
    // Saved, but Kernel quit before anything acted on it, so no push will say so again.
    k.store.saveWorkspace({ ...k.store.workspace(noor.id)!, prState: 'merged' })
    await k.stop()
    const k2 = await again()
    await released(k2, w)
    expect(users(k2, chatOf(k2, w))).toEqual([['Build T-15', 'lead']])
    await k2.stop()
  })
})

describe('the Lead\'s tools', () => {
  it('create_workspace waits by PR number, says which merge starts the teammate, and list_workspaces shows it', async () => {
    const { k, room, lead, target } = await setup()
    const noor = await target(k, 164)
    const rowan = (await k.agents(room.id)).find((a) => a.lead)!
    const tools = kernelTools(k['leadToolDeps'](room.id, rowan, lead))
    const create = tools.find((t) => t.name === 'create_workspace')!
    const out = (await create.handler({ agent: 'kai', title: 'Thinking rows', brief: 'Build T-15', wait_for: ['#164'] } as never, {})).content[0] as { text: string }
    const w = k.store.workspaces(room.id).find((x) => x.title === 'Thinking rows')!
    expect(out.text).toBe(`Created ${w.id} on ${w.branch} for kai. Kai waits for PR #164 by Noor to merge, and Kernel sends the brief then. Tell the user that merging it starts Kai.`)
    expect(w.waitsFor).toMatchObject({ on: [noor.id], held: true })
    const list = (await tools.find((t) => t.name === 'list_workspaces')!.handler({} as never, {})).content[0] as { text: string }
    expect(list.text).toContain(`${w.id} · kai · ${w.branch} · PR none · waits for PR #164 · yours`)
    await k.stop()
  })

  it('create_workspace starts as usual when what it waits for already merged', async () => {
    const { k, room, lead, target, mergeOnGitHub } = await setup()
    const noor = await target(k, 164)
    await mergeOnGitHub(k, noor)
    const rowan = (await k.agents(room.id)).find((a) => a.lead)!
    const create = kernelTools(k['leadToolDeps'](room.id, rowan, lead)).find((t) => t.name === 'create_workspace')!
    const out = (await create.handler({ agent: 'kai', title: 'Thinking rows', brief: 'Build T-15', wait_for: [noor.id] } as never, {})).content[0] as { text: string }
    const w = k.store.workspaces(room.id).find((x) => x.title === 'Thinking rows')!
    expect(out.text).toBe(`Created ${w.id} on ${w.branch} for kai.`)
    expect(w.waitsFor).toBeUndefined()
    expect(users(k, chatOf(k, w))).toEqual([['Build T-15', 'lead']])
    await k.stop()
  })

  it('wait_for_merge sets a wait on a teammate and refuses what it can\'t wait for', async () => {
    const team = [{ id: 'rowan', name: 'Rowan', lead: true }, { id: 'kai', name: 'Kai', lead: false }, { id: 'noor', name: 'Noor', lead: false }] as AgentDef[]
    const ws = (id: string, extra: Partial<Workspace> = {}) => ({ id, name: id, agentId: 'noor', status: 'ready', mode: 'worktree', prState: 'open', createdAt: 1, ...extra }) as Workspace
    const list = [ws('w1', { prNumber: 164 }), ws('k1', { agentId: 'kai', prState: 'none' })]
    const set: [string, string[]][] = []
    const deps: KernelToolDeps = {
      roomId: 'room', lead: team[0], agents: async () => team, workspaces: () => list,
      createWorkspace: async () => { throw new Error('not here') },
      messageWorkspace: async () => ({ ok: true, note: '' }), askUser: async () => null, hireAgent: async () => '',
      archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false,
      setWait: async (id, on) => { set.push([id, on]); return { ...list.find((w) => w.id === id)!, waitsFor: on.length ? { on, held: false } : undefined } }
    }
    const tools = kernelTools(deps)
    const call = async (name: string, input: object) => { const r = await tools.find((t) => t.name === name)!.handler(input as never, {}); return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError } }
    expect(await call('wait_for_merge', { workspace_id: 'k1', on: ['164'] })).toEqual({ isError: false, text: 'Kai waits for PR #164 by Noor to merge, and Kernel tells Kai to rebase onto it then. Tell the user that merging it moves Kai on.' })
    expect(set).toEqual([['k1', ['w1']]])
    expect(await call('wait_for_merge', { workspace_id: 'nope', on: [] })).toEqual({ isError: true, text: 'Not set: there is no open workspace nope in this room. Call list_workspaces for the ids.' })
    expect(await call('wait_for_merge', { workspace_id: 'k1', on: ['k1'] })).toEqual({ isError: true, text: "Not set: k1 can't wait for itself." })
    expect(await call('create_workspace', { agent: 'kai', title: 'x', brief: 'x', wait_for: ['w1'], review_of: 'w1' })).toEqual({ isError: true, text: 'Not created: a review starts from the work it reviews, so it never waits for another PR.' })
    expect(await call('create_workspace', { agent: 'kai', title: 'x', brief: 'x', wait_for: ['w1'], mode: 'current' })).toEqual({ isError: true, text: "Not created: a workspace on the main checkout has no branch of its own to start later, so it can't wait for a PR. Use worktree mode." })
  })
})

/**
 * A Linear whose issues are blocked by `blockedBy[key]`, as the issue detail query reads them. Moving an issue to In
 * Progress finds it started already. `fail` answers every call with a 500.
 */
function linear(blockedBy: Record<string, string[]>, o: { fail?: boolean } = {}) {
  const calls: string[] = []
  const fetch = (async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: { id: string } }
    calls.push(variables.id)
    if (o.fail) return new Response('{}', { status: 500 })
    const id = variables.id
    if (query.includes('query Started')) return new Response(JSON.stringify({ data: { issue: { id, state: { type: 'started' }, team: { states: { nodes: [] } } } } }))
    const issue = {
      id: `uuid-${id}`, identifier: id, title: `Issue ${id}`, url: `https://linear.app/cj/issue/${id}`, branchName: `cj/${id.toLowerCase()}`, priority: 0, updatedAt: '2026-10-10T00:00:00.000Z',
      state: { id: 's', name: 'Todo', type: 'unstarted', position: 1 }, assignee: null, labels: { nodes: [] }, team: { id: 't', key: 'KERNEL', name: 'Kernel' }, project: null, cycle: null,
      description: '', comments: { nodes: [] },
      inverseRelations: { nodes: (blockedBy[id] ?? []).map((b) => ({ type: 'blocks', issue: { identifier: b } })) }
    }
    return new Response(JSON.stringify({ data: { issue } }))
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

describe('a hand-off whose Linear issue is blocked (KERNEL-263)', () => {
  const handOff = async (k: Kernel, room: { id: string }, lead: Chat, input: object) => {
    const rowan = (await k.agents(room.id)).find((a) => a.lead)!
    const create = kernelTools(k['leadToolDeps'](room.id, rowan, lead)).find((t) => t.name === 'create_workspace')!
    const out = (await create.handler({ agent: 'kai', title: 'Thinking rows', brief: 'Build T-15', ...input } as never, {})).content[0] as { text: string }
    return { text: out.text, w: k.store.workspace(/^Created (\S+) on/.exec(out.text)![1])! }
  }

  it('starts the teammate, waits without holding the brief, says so, and asks for a rebase when the blocking PR merges', async () => {
    const l = linear({ 'KERNEL-198': ['KERNEL-197'] })
    const { k, room, lead, target, mergeOnGitHub } = await setup({}, { fetch: l.fetch, linearToken: 'k' })
    const noor = await target(k, 164, 'Tool rows', 'KERNEL-197')
    const { text: out, w } = await handOff(k, room, lead, { issue: 'KERNEL-198' })
    expect(out).toBe(`Created ${w.id} on ${w.branch} for kai. Linear marks KERNEL-198 as blocked by KERNEL-197, which Noor is building. Kai starts now, and Kernel messages Kai when PR #164 merges. Pass wait_for to hold the brief instead.`)
    expect(w.waitsFor).toEqual({ on: [noor.id], held: false })
    const chat = chatOf(k, w)
    expect(users(k, chat)).toEqual([['Build T-15', 'lead']])
    expect(notes(k, chat)).toContain('Waiting for PR #164 by Noor to merge. Kernel asks Kai to rebase onto it then.')
    callsIn(w)[0].feed(result('r1'))
    await flush()
    await mergeOnGitHub(k, noor)
    await vi.waitFor(() => expect(users(k, chat).at(-1)).toEqual(['PR #164 by Noor merged into main. Fetch origin, rebase onto origin/main, re-run the tests, then carry on with your task.', 'kernel']), SLOW)
    await k.stop()
  }, 20_000)

  it('names every blocker an open teammate is building, before its PR is open', async () => {
    const l = linear({ 'KERNEL-198': ['KERNEL-197', 'KERNEL-199'] })
    const { k, room, lead, target } = await setup({}, { fetch: l.fetch, linearToken: 'k' })
    const one = await target(k, 164, 'Tool rows', 'KERNEL-197')
    const two = await k.createWorkspace(room.id, { prompt: 'Rows', agentId: 'noor', title: 'Rows', leadChatId: lead.id, source: { kind: 'issue', id: 'KERNEL-199', title: 'Rows' } })
    const { text: out, w } = await handOff(k, room, lead, { issue: 'KERNEL-198' })
    expect(out).toBe(`Created ${w.id} on ${w.branch} for kai. Linear marks KERNEL-198 as blocked by KERNEL-197 and KERNEL-199, which Noor is building. Kai starts now, and Kernel messages Kai when PR #164 and Noor's PR merge. Pass wait_for to hold the brief instead.`)
    expect(w.waitsFor).toEqual({ on: [one.id, two.id], held: false })
    await k.stop()
  }, 20_000)

  it('ignores blockers with no open workspace, one that merged, one archived, or a review', async () => {
    const l = linear({ 'KERNEL-198': ['KERNEL-197', 'KERNEL-300', 'KERNEL-301', 'KERNEL-302'] })
    const { k, room, lead, target, mergeOnGitHub } = await setup({}, { fetch: l.fetch, linearToken: 'k' })
    await mergeOnGitHub(k, await target(k, 164, 'Tool rows', 'KERNEL-197'))
    const gone = await target(k, 170, 'Old rows', 'KERNEL-301')
    await k.archiveWorkspace(gone.id)
    const reviewed = await target(k, 171, 'Reviewed', 'KERNEL-303')
    const review = await k.createWorkspace(room.id, { prompt: 'Review', agentId: 'noor', title: 'Review', leadChatId: lead.id, reviewOf: reviewed.id })
    k.store.saveWorkspace({ ...k.store.workspace(review.id)!, source: { kind: 'issue', id: 'KERNEL-302', title: 'Review' } })
    const { text: out, w } = await handOff(k, room, lead, { issue: 'KERNEL-198' })
    expect(out).toBe(`Created ${w.id} on ${w.branch} for kai.`)
    expect(w.waitsFor).toBeUndefined()
    expect(users(k, chatOf(k, w))).toEqual([['Build T-15', 'lead']])
    await k.stop()
  }, 20_000)

  it('leaves the hand-off as it was when Linear fails or has no token', async () => {
    vi.stubEnv('LINEAR_API_KEY', '')
    try {
      for (const o of [{ fetch: linear({}, { fail: true }).fetch, linearToken: 'k' }, { fetch: linear({ 'KERNEL-198': ['KERNEL-197'] }).fetch }]) {
        const { k, room, lead, target } = await setup({}, o)
        await target(k, 164, 'Tool rows', 'KERNEL-197')
        const { text: out, w } = await handOff(k, room, lead, { issue: 'KERNEL-198' })
        expect(out).toBe(`Created ${w.id} on ${w.branch} for kai.`)
        expect(w).toMatchObject({ status: 'ready', source: { kind: 'issue', id: 'KERNEL-198', title: 'Thinking rows' } })
        expect(w.waitsFor).toBeUndefined()
        expect(users(k, chatOf(k, w))).toEqual([['Build T-15', 'lead']])
        await k.stop()
      }
    } finally { vi.unstubAllEnvs() }
  }, 20_000)

  it("says the teammate starts once the brief goes out when the brief waits for a free slot", async () => {
    const team = [{ id: 'rowan', name: 'Rowan', lead: true }, { id: 'kai', name: 'Kai', lead: false }, { id: 'noor', name: 'Noor', lead: false }] as AgentDef[]
    const noor = { id: 'w1', name: 'w1', agentId: 'noor', status: 'ready', mode: 'worktree', prState: 'open', prNumber: 164, createdAt: 1, source: { kind: 'issue', id: 'KERNEL-197', title: 'Tool rows' } } as Workspace
    const kai = { id: 'k1', name: 'k1', branch: 'feat/x', agentId: 'kai', status: 'ready', mode: 'worktree', prState: 'none', createdAt: 2, source: { kind: 'issue', id: 'KERNEL-198', title: 'Thinking rows' }, waitsFor: { on: ['w1'], held: false } } as Workspace
    let created = false
    const deps: KernelToolDeps = {
      // Kai's workspace exists once it is created, so KERNEL-287's check for a second hand-off doesn't see it first.
      roomId: 'room', lead: team[0], agents: async () => team, workspaces: () => (created ? [noor, kai] : [noor]),
      createWorkspace: async () => { created = true; return { ...kai, queued: 'capacity' as const } },
      messageWorkspace: async () => ({ ok: true, note: '' }), askUser: async () => null, hireAgent: async () => '',
      archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false
    }
    const out = (await kernelTools(deps).find((t) => t.name === 'create_workspace')!.handler({ agent: 'kai', title: 'Thinking rows', brief: 'Build T-15', issue: 'KERNEL-198' } as never, {})).content[0] as { text: string }
    expect(out.text).toBe("Created k1 on feat/x for kai. Every agent slot in Settings, Models is in use, so Kai hasn't started. The brief goes out when a slot frees up. Linear marks KERNEL-198 as blocked by KERNEL-197, which Noor is building. Kai starts once the brief goes out, and Kernel messages Kai when PR #164 merges. Pass wait_for to hold the brief instead.")
  })

  it("keeps Rowan's wait_for, even one that merged already, and doesn't add Linear's blockers", async () => {
    const l = linear({ 'KERNEL-198': ['KERNEL-197'] })
    const { k, room, lead, target, mergeOnGitHub } = await setup({}, { fetch: l.fetch, linearToken: 'k' })
    await target(k, 164, 'Tool rows', 'KERNEL-197')
    const other = await target(k, 170, 'Other')
    const held = await handOff(k, room, lead, { issue: 'KERNEL-198', wait_for: ['#170'] })
    expect(held.text).toBe(`Created ${held.w.id} on ${held.w.branch} for kai. Kai waits for PR #170 by Noor to merge, and Kernel sends the brief then. Tell the user that merging it starts Kai.`)
    expect(held.w.waitsFor).toMatchObject({ on: [other.id], held: true })
    await k.archiveWorkspace(held.w.id)
    await mergeOnGitHub(k, other)
    const started = await handOff(k, room, lead, { issue: 'KERNEL-198', wait_for: ['#170'] })
    expect(started.text).toBe(`Created ${started.w.id} on ${started.w.branch} for kai.`)
    expect(started.w.waitsFor).toBeUndefined()
    await k.stop()
  }, 20_000)
})

describe('waits, the rules', () => {
  const ws = (id: string, extra: Partial<Workspace> = {}): Workspace => ({ id, roomId: 'r', name: id, branch: id, baseRef: 'main', path: `/x/${id}`, mode: 'worktree', agentId: 'noor', port: 1, status: 'ready', prState: 'open', createdAt: 1, ...extra })
  const all = [
    ws('w1', { prNumber: 164, source: { kind: 'issue', id: 'KERNEL-197', title: 'Tool rows' } }),
    ws('old', { prNumber: 164, status: 'archived', prState: 'merged', createdAt: 9 }),
    ws('lead', { agentId: 'rowan', mode: 'current' }),
    ws('rv', { agentId: 'theo', reviewOf: 'w1' }),
    ws('main', { mode: 'current' }),
    ws('shut', { prState: 'closed', prNumber: 150 }),
    ws('gone', { status: 'archived', prState: 'none' }),
    ws('k1', { agentId: 'kai', prState: 'none' }),
    ws('k2', { agentId: 'kai', prState: 'none', waitsFor: { on: ['k3'], held: true } }),
    ws('k3', { agentId: 'kai', prState: 'none', waitsFor: { on: ['k1'], held: true } })
  ]
  const isLead = (w: Workspace) => w.agentId === 'rowan'
  const refuse = (refs: string[], o: Partial<Parameters<typeof waitRefusal>[0]> = {}) => waitRefusal({ workspaces: all, refs, isLead, ...o })

  it('finds a target by id, PR number or Linear key, open work first', () => {
    expect(resolveTarget(all, 'w1')?.id).toBe('w1')
    expect(resolveTarget(all, '#164')?.id).toBe('w1')
    expect(resolveTarget(all, '164')?.id).toBe('w1')
    expect(resolveTarget(all, 'kernel-197')?.id).toBe('w1')
    expect(resolveTarget(all, 'KERNEL-1')).toBeUndefined()
  })

  it('refuses each target that can never release the wait', () => {
    expect(refuse(['w1'])).toBeUndefined()
    expect(refuse(['nope'])).toBe('there is no workspace "nope" in this room to wait for. Pass a workspace id from list_workspaces, a PR number like #164, or a Linear issue key.')
    expect(refuse(['lead'])).toBe('lead is your own workspace, which never opens a pull request.')
    expect(refuse(['rv'])).toBe('rv is a review. Wait for the work it reviews instead (workspace w1).')
    expect(refuse(['main'])).toBe('main works on the main checkout and never opens a pull request of its own.')
    expect(refuse(['shut'])).toBe('PR #150 was closed without merging, so it will never merge.')
    expect(refuse(['gone'])).toBe('gone was archived without merging, so it will never merge.')
    expect(refuse(['k1'], { waiter: all.find((w) => w.id === 'k1') })).toBe("k1 can't wait for itself.")
    // k2 waits for k3, which waits for k1, so k1 waiting for k2 would close the loop.
    expect(refuse(['k2'], { waiter: all.find((w) => w.id === 'k1') })).toBe('k2 already waits for k1, so both would wait forever.')
    expect(refuse(['w1'], { reviewOf: 'w1' })).toBe('a review starts from the work it reviews, so it never waits for another PR.')
    expect(refuse(['w1'], { mode: 'current' })).toBe("a workspace on the main checkout has no branch of its own to start later, so it can't wait for a PR. Use worktree mode.")
  })

  it('counts a target as merged only by its PR state, and as broken once it can never merge', () => {
    const wait = { on: ['a', 'b'], held: true }
    expect(waitMet(wait, [ws('a', { prState: 'merged' }), ws('b', { prState: 'none', mergedAt: 5 })])).toBe(false)
    expect(waitMet(wait, [ws('a', { prState: 'merged' }), ws('b', { prState: 'merged' })])).toBe(true)
    expect(waitBroken(wait, [ws('a'), ws('b', { prState: 'closed' })])).toBe('b')
    expect(waitBroken(wait, [ws('a'), ws('b', { status: 'archived', prState: 'merged' })])).toBeUndefined()
    expect(waitBroken(wait, [ws('a')])).toBe('b')
  })
})
