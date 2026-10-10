import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { reviewTools } from '../src/main/services/reviewMcp'
import { reviewRule, TEAMMATE_RULE } from '../src/main/services/handoff'
import { git } from '../src/main/services/exec'
import { tempRepo } from './helpers'

// KERNEL-130: a review is linked to the work it reviews, starts from its branch and reports a verdict Kernel can read.

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
  '.claude/agents/theo.md': '---\nname: theo\ndescription: Reviewer. Reviews PRs.\nrole: Reviewer\n---\nYou are Theo.'
}

async function setup() {
  const repo = await tempRepo(REPO)
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop())
  k.sessions.send = async () => ({ queued: false })
  const room = await k.addRoom(repo)
  const lead = await k.leadChat(room.id)
  const author = await k.createWorkspace(room.id, { prompt: 'Remove the Try section', agentId: 'kai', title: 'Remove the Try section', leadChatId: lead.id })
  await writeFile(join(author.path, 'sidebar.txt'), 'no try\n')
  await git(author.path, 'add', '.')
  await git(author.path, 'commit', '-qm', 'remove try')
  const tip = (await git(author.path, 'rev-parse', 'HEAD')).trim()
  const review = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'theo', title: 'Review PR #108', leadChatId: lead.id, reviewOf: author.id })
  const agents = await k.agents(room.id)
  const agent = (id: string) => agents.find((a) => a.id === id) as AgentDef
  const deps = (k.sessions as unknown as { d: { mcpFor: (ws: Workspace, a: AgentDef, c: unknown) => unknown; rulesFor: (ws: Workspace, a: AgentDef) => string | undefined } }).d
  return { k, room, lead, author, review, tip, agent, deps }
}

describe('the review link (KERNEL-130)', () => {
  it("starts the review worktree from the author's branch, under its own branch, and saves the link", async () => {
    const { review, author, tip } = await setup()
    expect(review).toMatchObject({ reviewOf: author.id, mode: 'worktree', baseRef: author.branch, branch: `${author.branch}-review` })
    expect((await git(review.path, 'rev-parse', 'HEAD')).trim()).toBe(tip)
  })

  it('gives submit_review and the review rule only to the review workspace', async () => {
    const { k, review, author, agent, deps } = await setup()
    const chat = k.store.chats(review.id)[0]
    expect(deps.mcpFor(review, agent('theo'), chat)).toHaveProperty('kernel')
    // The author has its own kernel server, with wait_for_merge (KERNEL-262), and the teammate rule.
    expect(deps.mcpFor(author, agent('kai'), chat)).toHaveProperty('kernel')
    const rule = deps.rulesFor(review, agent('theo'))!
    expect(rule).toContain(`You are reviewing Kai's work on "Remove the Try section" (workspace ${author.id})`)
    expect(rule).toContain(`git reset --hard ${author.branch}`)
    expect(rule).toContain('mcp__kernel__submit_review')
    expect(deps.rulesFor(author, agent('kai'))).toBe(TEAMMATE_RULE)
  })

  it("resets to the PR's commit on GitHub once the work has a PR, the commit verdicts are checked against (KERNEL-136)", async () => {
    const { k, review, author, agent, deps } = await setup()
    k.store.saveWorkspace({ ...k.store.workspace(author.id)!, prNumber: 108, prState: 'ready' })
    const rule = deps.rulesFor(k.store.workspace(review.id)!, agent('theo'))!
    expect(rule).toContain(`git fetch origin ${author.branch} && git reset --hard origin/${author.branch}`)
  })

  it('starts a review from the branch the author is on now (KERNEL-136)', async () => {
    const { k, room, lead, author } = await setup()
    await git(author.path, 'checkout', '-qb', 'kernel-99-sidebar')
    await writeFile(join(author.path, 'rows.txt'), 'rows\n')
    await git(author.path, 'add', '.')
    await git(author.path, 'commit', '-qm', 'rows')
    const tip = (await git(author.path, 'rev-parse', 'HEAD')).trim()
    const again = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'theo', title: 'Review the rows', leadChatId: lead.id, reviewOf: author.id })
    expect(again.branch).toBe('kernel-99-sidebar-review')
    expect((await git(again.path, 'rev-parse', 'HEAD')).trim()).toBe(tip)
  })

  it('starts reviews of work on a branch name over 80 characters, each in its own folder (KERNEL-267)', async () => {
    const { k, room, lead } = await setup()
    const branch = 'cjjutbaofficial/kernel-242-create-in-the-new-chat-modal-puts-the-brief-in-an-empty-lead'
    const author = await k.createWorkspace(room.id, { prompt: 'Fix the tab', agentId: 'kai', title: 'Fix the tab', branch, leadChatId: lead.id })
    const first = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'theo', title: 'Review PR #173', leadChatId: lead.id, reviewOf: author.id })
    const second = await k.createWorkspace(room.id, { prompt: 'Review it again', agentId: 'theo', title: 'Review PR #173', leadChatId: lead.id, reviewOf: author.id })
    expect([first.branch, second.branch]).toEqual([`${branch}-review`, `${branch}-review-2`])
    expect(new Set([author.path, first.path, second.path]).size).toBe(3)
    for (const ws of [first, second]) expect((await git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(ws.branch)
    expect((await git(author.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(branch)
  })

  it('saves a verdict on the reviewed work with the commit it reviewed, replaces it on a resubmit, and tells the Lead', async () => {
    const { k, review, author, tip } = await setup()
    expect(await k.submitReview(review.id, { verdict: 'approved', summary: 'Looks right.' })).toContain('you approved')
    expect(k.store.workspace(author.id)!.reviews).toEqual([expect.objectContaining({ workspaceId: review.id, agentId: 'theo', verdict: 'approved', sha: tip })])
    await k.submitReview(review.id, { verdict: 'blockers', summary: 'One thing.', blockers: [{ text: 'Missing test', file: 'a.test.ts' }] })
    expect(k.store.workspace(author.id)!.reviews).toEqual([expect.objectContaining({ verdict: 'blockers', blockers: [{ text: 'Missing test', file: 'a.test.ts' }] })])
    const waiting = [...(k.leadUpdates as unknown as { pending: Map<string, { events: { kind: string; workspaceId: string }[] }> }).pending.values()].flatMap((p) => p.events)
    expect(waiting.filter((e) => e.kind === 'review').map((e) => e.workspaceId)).toEqual([review.id])
  })

  it('reads reviews of the PR: approved on its head commit, stale after a push, running while the reviewer works', async () => {
    const { k, review, author, tip } = await setup()
    const state = () => (k as unknown as { reviewState: (ws: Workspace) => { approvedBy: string[]; blockers: boolean; inProgress: boolean; stale?: boolean; open?: { workspaceId: string } } }).reviewState(k.store.workspace(author.id)!)
    expect(state()).toMatchObject({ approvedBy: [], blockers: false, inProgress: false, open: { workspaceId: review.id } })
    await k.submitReview(review.id, { verdict: 'approved', summary: 'Looks right.' })
    k.store.saveWorkspace({ ...k.store.workspace(author.id)!, prHead: tip })
    expect(state()).toMatchObject({ approvedBy: ['Theo'], stale: false })
    k.store.saveWorkspace({ ...k.store.workspace(author.id)!, prHead: 'f'.repeat(40) })
    expect(state()).toMatchObject({ approvedBy: [], stale: true })
    const running = k.sessions.isRunning
    k.sessions.isRunning = (id) => k.store.chats(review.id).some((c) => c.id === id)
    expect(state().inProgress).toBe(true)
    // A reviewer still in the turn that sent a verdict on the head commit isn't reviewing any more.
    k.store.saveWorkspace({ ...k.store.workspace(author.id)!, prHead: tip })
    expect(state().inProgress).toBe(false)
    // A review whose setup failed isn't running either; it waits for the user.
    k.store.saveWorkspace({ ...k.store.workspace(author.id)!, prHead: 'f'.repeat(40) })
    k.store.saveWorkspace({ ...k.store.workspace(review.id)!, status: 'failed' })
    expect(state()).toMatchObject({ inProgress: false, open: { workspaceId: review.id, failed: true } })
    k.sessions.isRunning = running
  })

  it('refuses a verdict once the reviewed work is archived', async () => {
    const { k, review, author } = await setup()
    k.store.saveWorkspace({ ...k.store.workspace(author.id)!, status: 'archived' })
    await expect(k.submitReview(review.id, { verdict: 'approved', summary: 'x' })).rejects.toThrow('no longer open')
  })
})

describe('the review rule (KERNEL-130)', () => {
  it('fetches and resets to origin when the review started from origin', () => {
    const rule = reviewRule({ author: 'Kai', task: 'T', workspaceId: 'w', branch: 'feat/x', resetTo: 'origin/feat/x', base: 'origin/main' })
    expect(rule).toContain('`git fetch origin feat/x && git reset --hard origin/feat/x`')
    expect(rule).toContain('`gh pr view feat/x`')
  })

  it("fetches from the room's remote when it isn't origin (KERNEL-190)", () => {
    const rule = reviewRule({ author: 'Kai', task: 'T', workspaceId: 'w', branch: 'feat/x', resetTo: 'upstream/feat/x', base: 'upstream/main' }, 'upstream')
    expect(rule).toContain('`git fetch upstream feat/x && git reset --hard upstream/feat/x`')
  })
})

describe('submit_review (KERNEL-130)', () => {
  it('needs the blockers with a blockers verdict, and passes the review on', async () => {
    const got: unknown[] = []
    const [tool] = reviewTools({ submit: async (r) => { got.push(r); return 'Saved.' } })
    const r1 = await tool.handler({ verdict: 'blockers', summary: 'Bad.' } as never, {})
    expect(r1).toMatchObject({ isError: true })
    expect(got).toEqual([])
    const r2 = await tool.handler({ verdict: 'approved', summary: 'Good.' } as never, {})
    expect((r2.content[0] as { text: string }).text).toBe('Saved.')
    expect(got).toEqual([{ verdict: 'approved', summary: 'Good.' }])
  })
})
