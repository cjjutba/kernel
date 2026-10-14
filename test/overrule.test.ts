import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityEvent, AgentDef, PrCheck, PrInfo, ReviewKind, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { git } from '../src/main/services/exec'
import { decide, type ReviewState, type TeamEvent } from '../src/main/services/leadUpdates'
import { kernelTools, NO_OVERRULE, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { tempRepo } from './helpers'

// KERNEL-732: the user, or the Lead on the user's quoted words, overrules the reviews' blockers on a PR's head commit.

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

const GREEN: PrCheck[] = [{ name: 'Test', state: 'pass' }]

/**
 * A room on a fake GitHub, with the app's settings `app`. `pr` opens Kai's work on a PR that passed its checks, with the
 * approvals and the blockers of the kinds named, all on its head commit.
 */
async function setup(app: object = {}) {
  const repo = await tempRepo({ 'README.md': '# shop\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...app }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  k.sessions.send = async () => ({ queued: false })
  const gh = { pr: null as PrInfo | null, merged: [] as string[], reads: 0 }
  k.github = {
    info: async (_cwd, _ref, workspaceId) => { gh.reads++; return gh.pr ? { ...gh.pr, workspaceId } : null },
    merge: async (_cwd, _ref, method) => { gh.merged.push(method); if (gh.pr) gh.pr = { ...gh.pr, state: 'merged' } },
    ready: async () => undefined,
    reopen: async () => undefined
  }
  const room = await k.addRoom(repo)
  const activity: ActivityEvent[] = []
  const onActivity = (e: ActivityEvent) => { activity.push(e) }
  bus.on('activity', onActivity)
  onTestFinished(() => { bus.off('activity', onActivity) })
  const pr = async (r: { approved?: ReviewKind[]; blockers?: ReviewKind[] } = {}) => {
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Task' })
    await writeFile(join(ws.path, 'a.ts'), 'export const a = 1\n')
    await git(ws.path, 'add', '-A')
    await git(ws.path, 'commit', '-qm', 'work')
    const head = (await git(ws.path, 'rev-parse', 'HEAD')).trim()
    gh.pr = { workspaceId: ws.id, number: 101, url: 'https://github.com/o/shop/pull/101', title: 'feat: task', state: 'ready', baseRef: 'main', checks: GREEN, comments: [], conflicts: [], head }
    const verdict = (lens: ReviewKind, verdict: 'approved' | 'blockers', ts: number) => ({ workspaceId: 'rev', agentId: 'kernel-reviewer', verdict, summary: '', sha: head, prNumber: 101, lens, ts, ...(verdict === 'blockers' ? { blockers: [{ text: 'one' }, { text: 'two' }] } : {}) })
    const reviews = [...(r.approved ?? []).map((k, i) => verdict(k, 'approved', i + 1)), ...(r.blockers ?? []).map((k, i) => verdict(k, 'blockers', 10 + i))]
    return k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prNumber: 101, prUrl: gh.pr.url, prTitle: 'feat: task', prState: 'ready', prHead: head, reviews })
  }
  return { k, gh, pr, activity }
}

describe('overruling the blockers on the head commit', () => {
  it('records the head and the kinds blocking it, says so in the activity, and lets Merge through without Merge anyway', async () => {
    const { k, gh, pr, activity } = await setup()
    const ws = await pr({ blockers: ['code'] })
    await expect(k.prs.mergePr(ws.id)).rejects.toThrow('The code review found 2 blockers on the latest commit.')
    const saved = await k.reviews.handlers()['reviews.overrule']({ workspaceId: ws.id, note: ' The second one is on purpose. ' })
    expect(saved.overruled).toEqual({ head: ws.prHead, kinds: ['code'], by: 'user', ts: expect.any(Number), note: 'The second one is on purpose.' })
    expect(k.store.workspace(ws.id)?.overruled).toEqual(saved.overruled)
    expect(activity.find((a) => a.text.startsWith('overruled'))).toMatchObject({ kind: 'note', actor: 'you', text: "overruled the code review's 2 blockers in", object: 'PR #101', quote: 'The second one is on purpose.' })
    expect((await k.prs.mergePr(ws.id)).prState).toBe('merged')
    expect(gh.merged).toEqual(['squash'])
  })

  it('refuses when nothing blocks the head, or Kernel does not know the head', async () => {
    const { k, pr } = await setup()
    const ws = await pr({ approved: ['code'] })
    expect(() => k.reviews.overrule(ws.id, { by: 'user' })).toThrow('No review found blockers on the latest commit of PR #101, so there is nothing to overrule.')
    const blocked = await pr({ blockers: ['code'] })
    k.store.saveWorkspace({ ...blocked, prHead: undefined })
    expect(() => k.reviews.overrule(blocked.id, { by: 'user' })).toThrow("Kernel doesn't know the latest commit of PR #101 yet")
    expect(k.store.workspace(blocked.id)?.overruled).toBeUndefined()
  })

  it('adds a kind that found blockers later on the same head to the kinds already overruled', async () => {
    const { k, pr } = await setup()
    const ws = await pr({ blockers: ['code'] })
    k.reviews.overrule(ws.id, { by: 'user' })
    const now = k.store.workspace(ws.id)!
    k.store.saveWorkspace({ ...now, reviews: [...now.reviews!, { ...now.reviews![0], lens: 'security', ts: 20 }] })
    expect(k.reviews.overrule(ws.id, { by: 'user' }).overruled?.kinds).toEqual(['code', 'security'])
  })

  it('takes the overrule back on Undo, which brings Blockers found back', async () => {
    const { k, gh, pr, activity } = await setup()
    const ws = await pr({ blockers: ['code'] })
    k.reviews.overrule(ws.id, { by: 'user' })
    const undone = await k.reviews.handlers()['reviews.overrule']({ workspaceId: ws.id, clear: true })
    expect(undone.overruled).toBeUndefined()
    expect(k.store.workspace(ws.id)?.overruled).toBeUndefined()
    expect(activity.find((a) => a.text.startsWith('took back'))).toMatchObject({ actor: 'you', object: 'PR #101' })
    await expect(k.prs.mergePr(ws.id)).rejects.toThrow('The code review found 2 blockers on the latest commit.')
    expect(gh.merged).toEqual([])
  })

  it('stops counting once a new commit comes in', async () => {
    const { k, gh, pr } = await setup()
    const ws = await pr({ blockers: ['code'] })
    k.reviews.overrule(ws.id, { by: 'user' })
    const next = 'f'.repeat(40)
    gh.pr = { ...gh.pr!, head: next }
    const now = k.store.workspace(ws.id)!
    k.store.saveWorkspace({ ...now, prHead: next, reviews: [...now.reviews!, { ...now.reviews![0], workspaceId: 'rev2', sha: next, ts: 30 }] })
    await expect(k.prs.mergePr(ws.id)).rejects.toThrow('The code review found 2 blockers on the latest commit.')
  })
})

describe('auto-merge and an overrule', () => {
  it('never merges on an overrule alone, and never weighs a PR with one', async () => {
    const { k, gh, pr } = await setup({ pr: { autoMerge: { on: true } } })
    // The security review is optional, so before KERNEL-732 only its blockers kept the code review's approval from merging it.
    const ws = await pr({ approved: ['code'], blockers: ['security'] })
    k.store.saveWorkspace({ ...ws, reviews: ws.reviews!.map((v) => (v.lens === 'security' ? { ...v, optional: true as const } : v)) })
    const over = k.reviews.overrule(ws.id, { by: 'user' })
    k.prs.considerAutoMerge(over)
    expect(gh.reads).toBe(0)
    expect(await k.prs.autoMerge(ws.id)).toEqual({ refused: "The security review found blockers on the latest commit, and auto-merge doesn't merge past an overrule." })
    expect(gh.merged).toEqual([])
    // A person's merge goes through.
    expect((await k.prs.mergePr(ws.id)).prState).toBe('merged')
  })
})

describe("the Team update's To do", () => {
  const ws = { id: 'w1', roomId: 'room', name: 'w1', agentId: 'kai', status: 'ready', prState: 'ready', prNumber: 54, baseRef: 'main' } as Workspace
  const review = (o: Partial<ReviewState> = {}): ReviewState => ({ approved: [], blocking: [], blockers: false, reviewing: [], inProgress: false, waiting: [], ...o })
  const verdict: TeamEvent = { n: 1, workspaceId: 'rv', kind: 'review', review: { verdict: 'blockers', lens: 'code', summary: '', of: 'w1', ofName: 'Noor', ofPr: 54, current: true } }
  const todo = (state: ReviewState) => decide({ ws: { ...ws, id: 'rv', reviewOf: 'w1' }, name: 'Theo', events: [verdict] }, { allMerged: () => false, workspace: () => ws, stateOf: () => state }).todo

  it("doesn't send overruled blockers to the author, and reads the PR ready to merge when nothing else holds it", () => {
    expect(todo(review({ blocking: ['code'], blockers: true }))).toEqual(["Send the code review's blockers to Noor with message_agent (workspace w1)."])
    const [line] = todo(review({ approved: ['security'], overruled: ['code'] }))
    expect(line).toMatch(/^PR #54 passed checks, has no conflicts and the security review approved it\. The user overruled the code review's blockers on its latest commit\. Tell the user it is ready to merge/)
    expect(todo(review({ overruled: ['code'] }))[0]).toMatch(/^PR #54 passed checks and has no conflicts\. The user overruled the code review's blockers/)
  })

  it("still passes on another kind's blockers", () => {
    expect(todo(review({ blocking: ['security'], blockers: true, overruled: ['code'] }))).toEqual([])
    const security: TeamEvent = { ...verdict, review: { ...verdict.review!, lens: 'security' } }
    expect(decide({ ws: { ...ws, id: 'rv', reviewOf: 'w1' }, name: 'Theo', events: [security] }, { allMerged: () => false, workspace: () => ws, stateOf: () => review({ blocking: ['security'], blockers: true, overruled: ['code'] }) }).todo)
      .toEqual(["Send the security review's blockers to Noor with message_agent (workspace w1)."])
  })
})

describe('overrule_blockers', () => {
  const list = (): Workspace[] => [
    { id: 'w1', roomId: 'room', name: 'w1', agentId: 'kai', status: 'ready', prState: 'ready', prNumber: 54 } as Workspace,
    { id: 'rv', roomId: 'room', name: 'rv', agentId: 'theo', status: 'ready', prState: 'none', reviewOf: 'w1' } as Workspace
  ]
  function lead(o: { said?: string; userTurn?: boolean; fails?: string } = {}) {
    const all = list()
    const overrule = vi.fn(async (id: string, note?: string) => {
      if (o.fails) throw new Error(o.fails)
      const w = all.find((x) => x.id === id)!
      return { ...w, overruled: { head: 'a'.repeat(40), kinds: ['code' as const], by: 'lead' as const, ts: 1, ...(note ? { note } : {}) } }
    })
    const deps: KernelToolDeps = {
      roomId: 'room', lead: { id: 'kernel', lead: true } as AgentDef, agents: async () => [], workspaces: () => all,
      createWorkspace: async () => all[0], messageWorkspace: async () => ({ ok: true, sent: true, note: 'Sent.' }), askUser: async () => null, hireAgent: async () => '',
      archiveWorkspace: async () => undefined, isRunning: () => false, unsaved: async () => false,
      overrule, userTurn: () => o.userTurn ?? true, userSaid: () => ({ text: o.said ?? 'Those blockers are fine, ignore them and merge.', at: 1 })
    }
    const tool = kernelTools(deps).find((t) => t.name === 'overrule_blockers')!
    const call = async (a: { workspace_id: string; go_ahead: string; note?: string }) => (await tool.handler(a as never, {})) as { content: { text: string }[]; isError?: boolean }
    return { call, overrule }
  }

  it("overrules on the user's quoted words, and a review's id on the PR it reviewed", async () => {
    const t = lead()
    const r = await t.call({ workspace_id: 'rv', go_ahead: 'those blockers are fine', note: 'on purpose' })
    expect(r.isError).toBeUndefined()
    expect(t.overrule).toHaveBeenCalledWith('w1', 'on purpose')
    expect(r.content[0].text).toBe("Overruled the code review's blockers on PR #54 at aaaaaaa. A merge goes ahead without Merge anyway until a new commit. Merge it with merge_workspace only if the user asked.")
  })

  it("refuses without a go_ahead from the user's latest message, or in a turn Kernel started", async () => {
    for (const [o, quote] of [[{}, 'merge it anyway'], [{}, ''], [{ userTurn: false }, 'those blockers are fine']] as const) {
      const t = lead(o)
      expect(await t.call({ workspace_id: 'w1', go_ahead: quote })).toEqual({ content: [{ type: 'text', text: NO_OVERRULE }], isError: true })
      expect(t.overrule).not.toHaveBeenCalled()
    }
  })

  it("passes on the feature's refusal", async () => {
    const t = lead({ fails: 'No review found blockers on the latest commit of PR #54, so there is nothing to overrule.' })
    expect(await t.call({ workspace_id: 'w1', go_ahead: 'ignore them' })).toMatchObject({ content: [{ text: 'Not overruled: No review found blockers on the latest commit of PR #54, so there is nothing to overrule.' }], isError: true })
  })
})
