import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, PrInfo, PrState, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { run } from '../src/main/services/exec'
import { kernelTools, MERGE_NOT_ASKED, MERGE_OFF, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { tempRepo, freePort } from './helpers'

// KERNEL-352: Kernel merges ready PRs when the user asks, once Settings, Pull requests allows it.

// A scripted SDK, as in waits.test.ts: a turn runs until the test feeds its result.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  query: ({ options }: { options: unknown }) => {
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    const feed = (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) }
    sdk.calls.push({ options, feed })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))) }),
      interrupt: async () => { feed({ type: 'result', subtype: 'error_during_execution', uuid: `i${sdk.calls.length}`, duration_ms: 1 }) }, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 10 })
    }
  }
}))

const ws = (id: string, o: Partial<Workspace> = {}) => ({ id, projectId: 'project', name: id, agentId: 'christian', mode: 'worktree', status: 'ready', prState: 'ready', ...o }) as Workspace

/**
 * The Lead's merge_workspace over `list`, with the switch `on` and a user turn unless told otherwise. `blocked` ids'
 * merges throw that reason, as `mergePr` does when `mergeBlock` refuses, and `refreshed` ones GitHub reports a new state for.
 */
function leadTools(list: Workspace[], o: { on?: boolean; userTurn?: boolean; blocked?: Record<string, string>; refreshed?: Record<string, PrState> } = {}) {
  const mergeWorkspace = vi.fn(async (id: string) => {
    if (o.blocked?.[id]) throw new Error(o.blocked[id])
    const w = list.find((x) => x.id === id)!
    w.prState = 'merged'
    return w
  })
  const refreshPr = vi.fn(async (id: string) => {
    const w = list.find((x) => x.id === id)!
    const r = o.refreshed?.[id]
    if (r) w.prState = r
    return w
  })
  const deps: KernelToolDeps = {
    projectId: 'project', lead: { id: 'kernel', lead: true } as AgentDef, agents: async () => [{ id: 'artkin', name: 'Artkin' } as AgentDef], workspaces: () => list,
    createWorkspace: async () => list[0], messageWorkspace: async () => ({ ok: true, sent: true, note: 'Sent.' }), askUser: async () => null, hireAgent: async () => '',
    archiveWorkspace: async () => undefined, refreshPr, isRunning: () => false, unsaved: async () => false,
    mergeWorkspace, leadMerge: () => o.on ?? true, userTurn: () => o.userTurn ?? true
  }
  const tool = kernelTools(deps).find((t) => t.name === 'merge_workspace')!
  const call = (ids: string[]) => tool.handler({ workspace_ids: ids } as never, {}) as Promise<{ content: { text: string }[]; isError?: boolean }>
  const merge = async (ids: string[]) => (await call(ids)).content[0].text
  return { call, merge, mergeWorkspace, refreshPr }
}

describe('merge_workspace (KERNEL-352)', () => {
  it('refuses the whole call while the switch in Settings is off', async () => {
    const t = leadTools([ws('a', { prNumber: 265 })], { on: false })
    expect(await t.call(['a'])).toEqual({ content: [{ type: 'text', text: MERGE_OFF }], isError: true })
    expect(MERGE_OFF).toBe('Merging is off in Settings, Pull requests. Tell the user they can merge from the PRs tab.')
    expect(t.mergeWorkspace).not.toHaveBeenCalled()
    expect(t.refreshPr).not.toHaveBeenCalled()
  })

  it('refuses the whole call in a turn Kernel started, such as a Team update', async () => {
    const t = leadTools([ws('a', { prNumber: 265 })], { userTurn: false })
    expect(await t.call(['a'])).toEqual({ content: [{ type: 'text', text: MERGE_NOT_ASKED }], isError: true })
    expect(MERGE_NOT_ASKED).toBe('Only the user can ask you to merge. Tell them which PRs are ready.')
    expect(t.mergeWorkspace).not.toHaveBeenCalled()
  })

  it('counts as off when the Kernel gave it no switch or turn', async () => {
    const tool = kernelTools({ workspaces: () => [ws('a')] } as unknown as KernelToolDeps).find((x) => x.name === 'merge_workspace')!
    expect(((await tool.handler({ workspace_ids: ['a'] } as never, {})).content[0] as { text: string }).text).toBe(MERGE_OFF)
  })

  it('merges in a turn the user started, and names the PR by number and title', async () => {
    const t = leadTools([ws('changelog', { prNumber: 265, prTitle: 'Trim the 0.1.0 changelog' })])
    expect(await t.merge(['changelog'])).toBe('Merged #265 (Trim the 0.1.0 changelog).')
    expect(t.refreshPr).toHaveBeenCalledWith('changelog')
    expect(t.mergeWorkspace).toHaveBeenCalledWith('changelog')
  })

  it("merges the reviewed PR for a review's id", async () => {
    const t = leadTools([ws('author', { prNumber: 42, prTitle: 'Invoice table' }), ws('review', { agentId: 'artkin', reviewOf: 'author', prState: 'none' })])
    expect(await t.merge(['review'])).toBe('Merged #42 (Invoice table).')
    expect(t.mergeWorkspace.mock.calls).toEqual([['author']])
  })

  it('skips a PR the merge rule blocks, with its reason', async () => {
    const t = leadTools([ws('green', { prNumber: 266 }), ws('unreviewed', { prNumber: 267 })], {
      blocked: { green: 'Checks have not passed yet. Merging needs green checks (Settings, Pull requests).', unreviewed: "Artkin hasn't approved the latest commit. Merging waits for the reviewer's approval (Settings, Pull requests)." }
    })
    expect(await t.merge(['green', 'unreviewed'])).toBe([
      'Skipped #266: Checks have not passed yet. Merging needs green checks (Settings, Pull requests).',
      "Skipped #267: Artkin hasn't approved the latest commit. Merging waits for the reviewer's approval (Settings, Pull requests)."
    ].join('\n'))
  })

  it('skips a PR with blockers on its latest commit without trying to merge it, since only a person overrides them (KERNEL-497)', async () => {
    const B = 'b'.repeat(40)
    const blockers = (sha: string, n: number) => [{ workspaceId: 'rev', agentId: 'artkin', verdict: 'blockers' as const, summary: '', sha, prNumber: 42, ts: 1, blockers: Array.from({ length: n }, (_, i) => ({ text: `b${i}` })) }]
    const t = leadTools([
      ws('one', { prNumber: 42, prHead: B, reviews: blockers(B, 1) }), ws('two', { prNumber: 42, prHead: B, reviews: blockers(B, 2) }),
      ws('moved', { prNumber: 42, prHead: B, reviews: blockers('a'.repeat(40), 1) })
    ])
    expect(await t.merge(['one', 'two', 'moved'])).toBe([
      'Skipped #42: the code review found 1 blocker. Merge it from its Merge anyway button if you want it in.',
      'Skipped #42: the code review found 2 blockers. Merge it from its Merge anyway button if you want it in.',
      'Merged #42.'
    ].join('\n'))
    // Blockers on an earlier commit don't hold the PR.
    expect(t.mergeWorkspace.mock.calls).toEqual([['moved']])
  })

  it("keeps the first line of a failed merge's output", async () => {
    const t = leadTools([ws('base', { prNumber: 269 })], { blocked: { base: 'GraphQL: Base branch was modified (mergePullRequest)\nRetry the merge.' } })
    expect(await t.merge(['base'])).toBe('Skipped #269: GraphQL: Base branch was modified (mergePullRequest).')
  })

  it('skips a PR whose state is not ready, without trying to merge it', async () => {
    const t = leadTools([ws('red', { prState: 'cifail', prNumber: 266 }), ws('spike', { prState: 'none' }), ws('fighting', { prState: 'conflict', prNumber: 268 })])
    expect(await t.merge(['red', 'spike', 'fighting'])).toBe('Skipped #266: checks failing.\nSkipped spike: it has no pull request yet.\nSkipped #268: it has merge conflicts.')
    expect(t.mergeWorkspace).not.toHaveBeenCalled()
  })

  it('reads the PR from GitHub first, so a saved state from before another merge does not decide', async () => {
    const t = leadTools([ws('rechecked', { prState: 'ready', prNumber: 270 }), ws('caught-up', { prState: 'checks', prNumber: 271 })], { refreshed: { rechecked: 'checks', 'caught-up': 'ready' } })
    expect(await t.merge(['rechecked', 'caught-up'])).toBe('Skipped #270: checks are still running.\nMerged #271.')
    expect(t.mergeWorkspace.mock.calls).toEqual([['caught-up']])
  })

  it('handles a mixed batch one id at a time, one line each', async () => {
    const t = leadTools([
      ws('first', { prNumber: 1, prTitle: 'One' }), ws('lead', { agentId: 'kernel', mode: 'current', lead: true, prState: 'none' }), ws('blocked', { prNumber: 3 }),
      ws('done', { prState: 'merged', prNumber: 4 }), ws('gone', { status: 'archived', prNumber: 5 }), ws('review', { agentId: 'artkin', reviewOf: 'last', prState: 'none' }), ws('last', { prNumber: 6, prTitle: 'Six' })
    ], { blocked: { blocked: 'Could not read the pull request from GitHub.' } })
    expect(await t.merge(['first', 'lead', 'missing', 'blocked', 'done', 'gone', 'review', 'first'])).toBe([
      'Merged #1 (One).',
      'Skipped lead: it is your own workspace.',
      'Skipped missing: not an open workspace in this project.',
      'Skipped #3: Could not read the pull request from GitHub.',
      'Skipped #4: it already merged.',
      'Skipped gone: not an open workspace in this project.',
      'Merged #6 (Six).',
      'Skipped #1: it already merged.'
    ].join('\n'))
    expect(t.mergeWorkspace.mock.calls.map(([id]) => id)).toEqual(['first', 'blocked', 'last'])
  })
})

/**
 * A started Kernel on a repo with a bare origin and a fake GitHub, Kernel as Lead, Christian and Sean. A merge lands a commit on
 * origin's main and marks the PR merged, as GitHub does.
 */
async function kernelProject() {
  const agent = (id: string, extra = '') => `---\nname: ${id}\ndescription: ${id}.\n${extra}---\nYou are ${id}.`
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/kernel.md': agent('kernel', 'lead: true\n'), '.claude/agents/christian.md': agent('christian'), '.claude/agents/sean.md': agent('sean') })
  const origin = join(await mkdtemp(join(tmpdir(), 'kernel-origin-')), 'o.git')
  await run('git', ['clone', '-q', '--bare', repo, origin])
  await run('git', ['-C', repo, 'remote', 'add', 'origin', origin])
  await run('git', ['-C', repo, 'fetch', '-q', 'origin'])
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { autoReview: false } }))
  const prs = new Map<string, PrInfo>()
  const merged: string[] = []
  const k = new Kernel({ dataDir, home })
  k.github = {
    info: async (_cwd, ref, workspaceId) => { const pr = prs.get(ref); return pr ? { ...pr, workspaceId } : null },
    merge: async (_cwd, ref) => { merged.push(ref); prs.set(ref, { ...prs.get(ref)!, state: 'merged' }) },
    ready: async () => {}, reopen: async () => {}
  }
  await k.start()
  onTestFinished(() => k.stop())
  const project = await k.addProject(repo)
  const lead = await k.leadChat(project.id)
  const kernel = (await k.agents(project.id)).find((a) => a.lead)!
  const tool = kernelTools(k.lead.leadToolDeps(project.id, kernel, lead)).find((t) => t.name === 'merge_workspace')!
  const merge = async (ids: string[]) => ((await tool.handler({ workspace_ids: ids } as never, {})).content[0] as { text: string }).text
  /** Sean's workspace with PR `number` open and green. */
  const target = async (number: number, title: string) => {
    const w = await k.createWorkspace(project.id, { prompt: title, agentId: 'sean', title, leadChatId: lead.id })
    prs.set(w.branch, { workspaceId: '', number, url: `https://github.com/x/y/pull/${number}`, title, state: 'ready', baseRef: 'main', checks: [{ name: 'test', state: 'pass' }], comments: [], conflicts: [] })
    return k.refreshPr(w.id)
  }
  return { k, project, lead, merge, target, merged }
}

const result = (uuid: string) => ({ type: 'result', subtype: 'success', uuid, duration_ms: 1, session_id: 's' })

describe('merge_workspace in the Kernel (KERNEL-352)', () => {
  it('reads the switch and the turn live, merges through the Merge button path and releases a teammate waiting on it', async () => {
    const { k, project, lead, merge, target, merged } = await kernelProject()
    const sean = await target(265, 'Trim the 0.1.0 changelog')
    expect(sean.prState).toBe('ready')
    const christian = await k.createWorkspace(project.id, { prompt: 'Build on it', agentId: 'christian', title: 'Next step', leadChatId: lead.id, waitFor: [sean.id] })
    expect(christian.waitsFor).toMatchObject({ on: [sean.id], held: true })

    // Off by default, and the Lead's tools were built before the switch changed.
    expect(k.settings.pr.leadMerge).toBe(false)
    expect(await merge([sean.id])).toBe(MERGE_OFF)
    await k.handlers()['settings.set']({ patch: { pr: { leadMerge: true } } })

    // A Team update is a turn Kernel started. Answering inside it doesn't make it the user's.
    const before = sdk.calls.length
    expect(k.sessions.post(lead.id, [{ type: 'text', text: 'Team update' }])).toBe(true)
    expect(await merge([sean.id])).toBe(MERGE_NOT_ASKED)
    const leadPath = k.store.workspace(lead.workspaceId)!.path
    const update = await vi.waitFor(() => { const c = sdk.calls.slice(before).find((x) => x.options.cwd === leadPath); expect(c).toBeDefined(); return c! })
    update.feed(result('u1'))
    await vi.waitFor(() => expect(k.sessions.isRunning(lead.id)).toBe(false))
    expect(await merge([sean.id])).toBe(MERGE_NOT_ASKED)
    expect(merged).toEqual([])

    // The user's own message starts a user turn.
    await k.sessions.send(lead.id, [{ type: 'text', text: 'Merge the ready ones' }])
    expect(await merge([sean.id])).toBe('Merged #265 (Trim the 0.1.0 changelog).')
    expect(merged).toEqual([sean.branch])
    expect(k.store.workspace(sean.id)?.prState).toBe('merged')
    // The pr event releases Christian's held brief, as a merge from the PR panel does (KERNEL-259).
    await vi.waitFor(() => expect(k.store.workspace(christian.id)?.waitsFor).toBeUndefined(), { timeout: 10_000 })
  })
})
