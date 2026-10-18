import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PrInfo, RateLimit, ReviewKind, Workspace } from '@shared/types'
import { mergeBlock } from '@shared/merge'
import { Kernel } from '../src/main/kernel'
import { git } from '../src/main/services/exec'
import { decide, type TeamEvent } from '../src/main/services/leadUpdates'
import { tempRepo, freePort } from './helpers'

// KERNEL-552: review rounds re-run only what blocked, stop after `[review] rounds`, and skip optional reviews near the usage limit.

// No Claude Code process ever starts: a review chat's first brief goes to a session that never answers.
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

const AGENTS = {
  'README.md': '# shop\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\ntools: Read, Edit, Write, Bash\n---\nYou are Christian.'
}
const UX_ON = '[review.ux]\npaths = ["src/renderer/**"]\n'

/** A project with no reviewer agent, its `[review]` committed on main, and Christian's PR on one commit that passed checks. */
async function setup(o: { settings?: string; files?: Record<string, string> } = {}) {
  const repo = await tempRepo({ ...AGENTS, ...(o.settings ? { '.kernel/settings.toml': o.settings } : {}) })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ version: 2, hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { autoReview: true } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  const project = await k.addProject(repo)
  const ws = await k.createWorkspace(project.id, { prompt: 'Build it', agentId: 'christian', title: 'Task 1' })
  /** Christian commits `files` and the PR passes checks on that commit. */
  const push = async (files: Record<string, string>) => {
    for (const [f, c] of Object.entries(files)) { await mkdir(dirname(join(ws.path, f)), { recursive: true }); await writeFile(join(ws.path, f), c) }
    await git(ws.path, 'add', '-A')
    await git(ws.path, 'commit', '-qm', 'work')
    const head = (await git(ws.path, 'rev-parse', 'HEAD')).trim()
    k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prNumber: 101, prTitle: 'Task 1', prState: 'ready', prHead: head })
    return head
  }
  await push(o.files ?? { 'src/main/a.ts': 'a\n', 'src/renderer/App.tsx': 'export {}\n' })
  const of = () => k.store.workspace(ws.id)!
  const rws = () => k.store.workspaces(project.id).filter((w) => w.reviewOf === ws.id)
  const chatOf = (kind: ReviewKind) => k.store.chats(rws()[0].id).find((c) => c.lens?.kind === kind)!
  /** The kind's review chat sends its verdict on the PR's head, as a reviewer that reset to it would. */
  const verdict = async (kind: ReviewKind, v: 'approved' | 'blockers') => {
    const [r] = rws()
    await git(r.path, 'reset', '-q', '--hard', of().prHead!)
    await k.reviews.submitReview(r.id, v === 'approved' ? { verdict: v, summary: 'Fine.' } : { verdict: v, summary: 'No.', blockers: [{ text: `A ${kind} problem.` }] }, chatOf(kind).id)
  }
  /** What Kernel sends review chats from here on, by kind. */
  const sent: ReviewKind[] = []
  const record = () => { k.sessions.send = async (chatId) => { sent.push(k.store.chat(chatId)!.lens!.kind); return { queued: false } } }
  return { k, repo, project, ws, push, of, rws, chatOf, verdict, sent, record }
}

const info = (ws: Workspace): PrInfo => ({ workspaceId: ws.id, number: ws.prNumber!, url: '', title: '', state: 'ready', baseRef: 'main', checks: [], comments: [], conflicts: [], head: ws.prHead! })
const ready = (ws: Workspace): TeamEvent => ({ n: 1, workspaceId: ws.id, kind: 'pr.ready', pr: ws.prNumber })

describe('review rounds', () => {
  it('starts only the kinds that blocked in round 1, and the others keep their approval on the new head', async () => {
    const { k, push, of, rws, verdict, sent, record } = await setup({ settings: UX_ON })
    await k.reviews.onReady(of().id)
    expect(of().reviewRound).toEqual({ n: 1, rounds: 2, head: of().prHead, prNumber: 101, kinds: ['code', 'ux'] })
    await verdict('code', 'blockers')
    await verdict('ux', 'approved')
    const first = of().prHead!
    record()
    // The fix touches nothing under the UX review's paths.
    const second = await push({ 'src/main/a.ts': 'fixed\n' })
    await k.reviews.onReady(of().id)
    expect(sent).toEqual(['code'])
    expect(rws()).toHaveLength(1)
    expect(of().reviewRound).toEqual({ n: 2, rounds: 2, head: second, prNumber: 101, kinds: ['code', 'ux'], kept: ['ux'] })
    // The UX approval counts for the new head, and says which commit it was given on.
    expect(of().reviews?.find((v) => v.lens === 'ux')).toMatchObject({ verdict: 'approved', sha: second, keptFrom: first })
    expect(k.reviews.reviewState(of())).toMatchObject({ approved: ['ux'], blocking: [], waiting: ['code'] })
    const rules = { requireGreen: false, requireReviewer: true }
    expect(mergeBlock(of(), info(of()), rules)).toBe("The code review hasn't approved the latest commit. Merging waits for every required review (Settings, Pull requests).")
    await verdict('code', 'approved')
    expect(mergeBlock(of(), info(of()), rules)).toBeUndefined()
    // A ready on the same head, as when the base moved, starts nothing.
    await k.reviews.onReady(of().id)
    expect(sent).toEqual(['code'])
  })

  it('runs an approving kind again when the fix touches its paths, the code review\'s being every file', async () => {
    const { k, push, of, verdict, sent, record } = await setup({ settings: UX_ON })
    await k.reviews.onReady(of().id)
    await verdict('code', 'approved')
    await verdict('ux', 'blockers')
    record()
    await push({ 'src/renderer/App.tsx': 'export const fixed = 1\n' })
    await k.reviews.onReady(of().id)
    expect(sent).toEqual(['code', 'ux'])
    expect(of().reviewRound).toMatchObject({ n: 2, kinds: ['code', 'ux'] })
    expect(of().reviewRound?.kept).toBeUndefined()
  })

  it('starts no review after [review] rounds with blockers left, and the To do line asks the user', async () => {
    const { k, push, of, chatOf, verdict, sent, record } = await setup({ settings: UX_ON, files: { 'src/main/a.ts': 'a\n' } })
    await k.reviews.onReady(of().id)
    await verdict('code', 'blockers')
    record()
    await push({ 'src/main/a.ts': 'try 1\n' })
    await k.reviews.onReady(of().id)
    expect(sent).toEqual(['code'])
    await verdict('code', 'blockers')
    expect(k.reviews.reviewState(of())).toMatchObject({ blocking: ['code'], stillBlocked: { rounds: 2, kinds: ['code'] } })
    // The verdict of the last round Kernel runs goes to the user, not back to Christian.
    const [r] = k.store.workspaces(of().projectId).filter((w) => w.reviewOf === of().id)
    const review: TeamEvent = { n: 1, workspaceId: r.id, kind: 'review', pr: 101, review: { verdict: 'blockers', lens: 'code', summary: 'No.', blockers: [{ text: 'x' }], of: of().id, ofName: 'Christian', ofPr: 101, current: true } }
    const ctx = { allMerged: () => false, workspace: (id: string) => k.store.workspace(id), stateOf: (id: string) => k.reviews.reviewState(k.store.workspace(id)!) }
    expect(decide({ ws: r, name: 'Code review', events: [review] }, ctx).todo).toEqual([
      "PR #101 is still blocked after 2 review rounds, so Kernel won't review it again by itself. Don't send it back to Christian: tell the user what the code review found that is still open, and ask with ask_user how they want to go on."
    ])
    // Christian pushes anyway, once the review chat's turn is over. Nothing starts, and the update on the new commits asks the user too.
    k.sessions.stop(chatOf('code').id)
    const round = of().reviewRound
    await push({ 'src/main/a.ts': 'try 2\n' })
    await k.reviews.onReady(of().id)
    expect(sent).toEqual(['code'])
    expect(of().reviewRound).toEqual(round)
    const state = k.reviews.reviewState(of())
    expect(state).toMatchObject({ blockers: false, inProgress: false, stillBlocked: { rounds: 2, kinds: ['code'] } })
    expect(decide({ ws: of(), name: 'Christian', events: [ready(of())] }, { ...ctx, review: state }).todo).toEqual([
      "PR #101 has new commits, but it was still blocked after 2 review rounds, so Kernel didn't review them. Don't send it back to Christian: tell the user what the code review found that is still open, and ask with ask_user how they want to go on."
    ])
  })

  it('keeps a running round as it started when [review] changes, and applies the change from the next round', async () => {
    const { k, repo, push, of, rws, verdict, sent, record } = await setup()
    await k.reviews.onReady(of().id)
    expect(of().reviewRound?.kinds).toEqual(['code'])
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[review]\nrounds = 3\n\n[review.ux]\nrequired = false\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-qm', 'Turn on the UX review')
    record()
    // Ready again on the same commit: the round stays the one that started.
    await k.reviews.onReady(of().id)
    expect(sent).toEqual([])
    expect(k.store.chats(rws()[0].id).map((c) => c.lens?.kind)).toEqual(['code'])
    expect(of().reviewRound).toMatchObject({ n: 1, rounds: 2, kinds: ['code'] })
    await verdict('code', 'blockers')
    await push({ 'src/main/a.ts': 'fixed\n' })
    await k.reviews.onReady(of().id)
    expect(sent).toEqual(['code', 'ux'])
    expect(of().reviewRound).toMatchObject({ n: 2, rounds: 3, kinds: ['code', 'ux'] })
  })

  it('saves the [review] rounds that stopped a round, so the update agrees, and a raised value starts the next push\'s round (KERNEL-633)', async () => {
    const { k, repo, push, of, chatOf, verdict, sent, record } = await setup({ files: { 'src/main/a.ts': 'a\n' } })
    const policy = async (toml: string) => {
      await mkdir(join(repo, '.kernel'), { recursive: true })
      await writeFile(join(repo, '.kernel', 'settings.toml'), toml)
      await git(repo, 'add', '-A')
      await git(repo, 'commit', '-qm', 'Review policy')
    }
    await k.reviews.onReady(of().id)
    await verdict('code', 'blockers')
    // Round 1 of 2 left blockers, so they go back to Christian. Then the base branch lowers `rounds` to 1.
    expect(k.reviews.reviewState(of()).stillBlocked).toBeUndefined()
    await policy('[review]\nrounds = 1\n')
    k.sessions.stop(chatOf('code').id)
    record()
    await push({ 'src/main/a.ts': 'try 1\n' })
    await k.reviews.onReady(of().id)
    expect(sent).toEqual([])
    expect(of().reviewRound).toMatchObject({ n: 1, rounds: 1 })
    const state = k.reviews.reviewState(of())
    expect(state.stillBlocked).toEqual({ rounds: 1, kinds: ['code'] })
    expect(decide({ ws: of(), name: 'Christian', events: [ready(of())] }, { allMerged: () => false, review: state }).todo).toEqual([
      "PR #101 has new commits, but it was still blocked after 1 review round, so Kernel didn't review them. Don't send it back to Christian: tell the user what the code review found that is still open, and ask with ask_user how they want to go on."
    ])
    // Raising it again lets the next push start round 2.
    await policy('[review]\nrounds = 3\n')
    const head = await push({ 'src/main/a.ts': 'try 2\n' })
    await k.reviews.onReady(of().id)
    expect(sent).toEqual(['code'])
    expect(of().reviewRound).toMatchObject({ n: 2, rounds: 3, head })
  })

  it('runs the kinds with no verdict again on the same head after the review workspace was archived, in the same round (KERNEL-633)', async () => {
    const { k, of, rws, verdict } = await setup({ settings: UX_ON })
    await k.reviews.onReady(of().id)
    await verdict('ux', 'approved')
    const round = of().reviewRound
    const [first] = rws()
    await k.archive.archiveWorkspace(first.id)
    // CI runs again on the same commit.
    await k.reviews.onReady(of().id)
    const open = rws().filter((w) => w.status !== 'archived')
    expect(open).toHaveLength(1)
    expect(open[0].id).not.toBe(first.id)
    expect(k.store.chats(open[0].id).map((c) => c.lens?.kind)).toEqual(['code'])
    expect(of().reviewRound).toEqual(round)
    // With that review workspace open, another ready on the head starts nothing more.
    await k.reviews.onReady(of().id)
    expect(rws().filter((w) => w.status !== 'archived')).toHaveLength(1)
  })

  it('starts nothing on the same head after archiving once every kind reported', async () => {
    const { k, of, rws, verdict } = await setup({ settings: UX_ON })
    await k.reviews.onReady(of().id)
    await verdict('code', 'blockers')
    await verdict('ux', 'approved')
    await k.archive.archiveWorkspace(rws()[0].id)
    await k.reviews.onReady(of().id)
    expect(rws().filter((w) => w.status !== 'archived')).toHaveLength(0)
  })
})

describe("Kernel's own update of a PR from its base (KERNEL-832)", () => {
  /** Main moves on, and Christian's branch merges it, the way `gh pr update-branch` would. `extra` adds a change of its own to the merge. */
  async function update(t: Awaited<ReturnType<typeof setup>>, extra?: Record<string, string>) {
    await writeFile(join(t.repo, 'README.md'), '# shop, moved on\n')
    await git(t.repo, 'commit', '-qam', 'main moves on')
    const ws = t.of()
    await git(ws.path, 'merge', '-q', '--no-ff', '--no-commit', 'main')
    for (const [f, c] of Object.entries(extra ?? {})) { await writeFile(join(ws.path, f), c); await git(ws.path, 'add', f) }
    await git(ws.path, 'commit', '-qm', 'Merge main')
    const to = (await git(ws.path, 'rev-parse', 'HEAD')).trim()
    t.k.store.saveWorkspace({ ...ws, prHead: to })
    return { from: ws.prHead!, to }
  }

  it('keeps the approval on the updated head and starts no review', async () => {
    const t = await setup()
    await t.k.reviews.onReady(t.of().id)
    await t.verdict('code', 'approved')
    t.record()
    const { from, to } = await update(t)
    expect(await t.k.reviews.recordBaseUpdate(t.of().id, from, to)).toBe(true)
    expect(t.of().baseUpdates).toEqual([{ from, to }])
    await t.k.reviews.onReady(t.of().id)
    expect(t.sent).toEqual([])
    expect(t.of().reviewRound).toMatchObject({ n: 1, head: from })
    expect(t.k.reviews.reviewState(t.of())).toMatchObject({ approved: ['code'], blocking: [], waiting: [] })
    expect(mergeBlock(t.of(), info(t.of()), { requireGreen: false, requireReviewer: true })).toBeUndefined()
  })

  it('keeps blockers on the updated head, so it stays blocked', async () => {
    const t = await setup()
    await t.k.reviews.onReady(t.of().id)
    await t.verdict('code', 'blockers')
    t.record()
    const { from, to } = await update(t)
    expect(await t.k.reviews.recordBaseUpdate(t.of().id, from, to)).toBe(true)
    await t.k.reviews.onReady(t.of().id)
    expect(t.sent).toEqual([])
    expect(t.k.reviews.reviewState(t.of())).toMatchObject({ blocking: ['code'] })
    expect(mergeBlock(t.of(), info(t.of()), { requireGreen: false, requireReviewer: false })).toContain('The code review found 1 blocker')
  })

  it('reviews the same head again when Kernel never recorded it, as after a teammate pushed it', async () => {
    const t = await setup()
    await t.k.reviews.onReady(t.of().id)
    await t.verdict('code', 'approved')
    t.record()
    await update(t)
    await t.k.reviews.onReady(t.of().id)
    expect(t.sent).toEqual(['code'])
    expect(t.k.reviews.reviewState(t.of())).toMatchObject({ approved: [], waiting: ['code'] })
  })

  it("doesn't record an update that brings in a change of its own, nor a commit that isn't a merge with the base", async () => {
    const t = await setup()
    await t.k.reviews.onReady(t.of().id)
    await t.verdict('code', 'approved')
    t.record()
    const { from, to } = await update(t, { 'src/main/a.ts': 'slipped in\n' })
    expect(await t.k.reviews.recordBaseUpdate(t.of().id, from, to)).toBe(false)
    const pushed = await t.push({ 'src/main/b.ts': 'b\n' })
    expect(await t.k.reviews.recordBaseUpdate(t.of().id, to, pushed)).toBe(false)
    expect(t.of().baseUpdates).toBeUndefined()
    await t.k.reviews.onReady(t.of().id)
    expect(t.sent).toEqual(['code'])
  })
})

describe('a PR waiting for its reviews to approve (KERNEL-717)', () => {
  const rules = { requireGreen: false, requireReviewer: true }

  it('holds the merge from the ready event until every kind approves the head, and again on the next commit', async () => {
    const { k, push, of, verdict } = await setup({ settings: UX_ON })
    const started = k.reviews.onReady(of().id)
    // Marked before Kernel reads `[review]` with git, so nothing merges in between.
    expect(of().reviewPending).toBe(of().prHead)
    expect(mergeBlock(of(), info(of()), rules)).toContain('The review of the latest commit is starting.')
    await started
    expect(of().reviewPending).toBeUndefined()
    expect(mergeBlock(of(), info(of()), rules)).toContain("The code and UX reviews haven't approved the latest commit.")
    await verdict('code', 'approved')
    expect(mergeBlock(of(), info(of()), rules)).toContain("The UX review hasn't approved the latest commit.")
    await verdict('ux', 'approved')
    expect(mergeBlock(of(), info(of()), rules)).toBeUndefined()
    // A new commit outside the UX review's paths: only the code review runs again, and the merge waits for it alone.
    await push({ 'src/main/a.ts': 'more\n' })
    await k.reviews.onReady(of().id)
    expect(mergeBlock(of(), info(of()), rules)).toContain("The code review hasn't approved the latest commit.")
    await verdict('code', 'approved')
    expect(mergeBlock(of(), info(of()), rules)).toBeUndefined()
  })

  it('holds nothing when no review is planned, with automatic review off, or with the approval switch off', async () => {
    const none = await setup({ settings: '[team]\nreviewer = "none"\n' })
    await none.k.reviews.onReady(none.of().id)
    expect(none.of().reviewPending).toBeUndefined()
    expect(none.of().reviewRound).toBeUndefined()
    expect(mergeBlock(none.of(), info(none.of()), rules)).toBeUndefined()

    const off = await setup()
    off.k.settings.pr.autoReview = false
    // A marker a quit left behind goes once automatic review is off.
    off.k.store.saveWorkspace({ ...off.of(), reviewPending: off.of().prHead })
    await off.k.reviews.onReady(off.of().id)
    expect(off.of().reviewPending).toBeUndefined()
    expect(mergeBlock(off.of(), info(off.of()), rules)).toBeUndefined()

    const on = await setup()
    await on.k.reviews.onReady(on.of().id)
    expect(mergeBlock(on.of(), info(on.of()), { requireGreen: false, requireReviewer: false })).toBeUndefined()
  })

  it("never waits for an optional kind skipped near the usage limit", async () => {
    const { k, of, verdict } = await setup({ settings: '[review.ux]\nrequired = false\n' })
    const near: RateLimit = { type: 'five_hour', status: 'allowed', utilization: 0.95, resetsAt: Math.round(Date.now() / 1000) + 3600 }
    ;(k.sessions as unknown as { mergeLimits: (l: RateLimit[]) => void }).mergeLimits([near])
    await k.reviews.onReady(of().id)
    // The code review is held for usage and still counts as waiting.
    expect(mergeBlock(of(), info(of()), rules)).toContain("The code review hasn't approved the latest commit.")
    await verdict('code', 'approved')
    expect(mergeBlock(of(), info(of()), rules)).toBeUndefined()
  })

  it('takes up a review a quit left pending at the next start', async () => {
    const { k, of, rws } = await setup()
    k.store.saveWorkspace({ ...of(), reviewPending: of().prHead })
    expect(mergeBlock(of(), info(of()), rules)).toContain('is starting')
    k.reviews.start()
    await vi.waitFor(() => expect(of().reviewRound?.head).toBe(of().prHead), { timeout: 10_000, interval: 20 })
    expect(of().reviewPending).toBeUndefined()
    expect(rws()).toHaveLength(1)
    expect(mergeBlock(of(), info(of()), rules)).toContain("The code review hasn't approved the latest commit.")
  })
})

describe('review rounds near the usage limit', () => {
  it('skips an optional kind and names it, and a required kind waits for usage to drop', async () => {
    const { k, of, rws, chatOf } = await setup({ settings: '[review.ux]\nrequired = false\n' })
    const near: RateLimit = { type: 'five_hour', status: 'allowed', utilization: 0.95, resetsAt: Math.round(Date.now() / 1000) + 3600 }
    ;(k.sessions as unknown as { mergeLimits: (l: RateLimit[]) => void }).mergeLimits([near])
    await k.reviews.onReady(of().id)
    expect(of().reviewRound).toEqual({ n: 1, rounds: 2, head: of().prHead, prNumber: 101, kinds: ['code', 'ux'], skipped: ['ux'], optional: ['ux'] })
    expect(k.store.chats(rws()[0].id).map((c) => c.lens?.kind)).toEqual(['code'])
    // Setup passed, and the code review's brief waits for usage instead of starting.
    await vi.waitFor(() => expect(k.sessions.queueReason(chatOf('code').id)).toBe('limit'), { timeout: 10_000, interval: 20 })
    const state = k.reviews.reviewState(of())
    expect(state).toMatchObject({ inProgress: true, reviewing: [], held: ['code'], skipped: ['ux'] })
    expect(decide({ ws: of(), name: 'Christian', events: [ready(of())] }, { allMerged: () => false, review: state }).todo).toEqual([])
  })

  it('runs every kind with "Pause new work when close to the limit" off', async () => {
    const { k, of } = await setup({ settings: '[review.ux]\nrequired = false\n' })
    k.settings.usage = { ...k.settings.usage, pauseNearLimit: false }
    ;(k.sessions as unknown as { mergeLimits: (l: RateLimit[]) => void }).mergeLimits([{ type: 'five_hour', status: 'allowed', utilization: 0.95, resetsAt: Math.round(Date.now() / 1000) + 3600 }])
    await k.reviews.onReady(of().id)
    expect(of().reviewRound).toMatchObject({ kinds: ['code', 'ux'] })
    expect(of().reviewRound?.skipped).toBeUndefined()
  })
  it("passes on one kind's blockers while another waits for usage, and names the one that waits (KERNEL-633)", async () => {
    const { k, of, rws, chatOf, verdict } = await setup({ settings: UX_ON })
    ;(k.sessions as unknown as { mergeLimits: (l: RateLimit[]) => void }).mergeLimits([{ type: 'five_hour', status: 'allowed', utilization: 0.95, resetsAt: Math.round(Date.now() / 1000) + 3600 }])
    await k.reviews.onReady(of().id)
    await vi.waitFor(() => expect(k.sessions.queueReason(chatOf('ux').id)).toBe('limit'), { timeout: 10_000, interval: 20 })
    await verdict('code', 'blockers')
    const state = k.reviews.reviewState(of())
    // Still in progress, so auto-merge counts the UX review as not done.
    expect(state).toMatchObject({ inProgress: true, reviewing: [], held: ['ux'], blocking: ['code'] })
    const [r] = rws()
    const review: TeamEvent = { n: 1, workspaceId: r.id, kind: 'review', pr: 101, review: { verdict: 'blockers', lens: 'code', summary: 'No.', blockers: [{ text: 'x' }], of: of().id, ofName: 'Christian', ofPr: 101, current: true } }
    const ctx = { allMerged: () => false, workspace: (id: string) => k.store.workspace(id), stateOf: (id: string) => k.reviews.reviewState(k.store.workspace(id)!) }
    expect(decide({ ws: r, name: 'Code review', events: [review] }, ctx).todo).toEqual([
      `Send the code review's blockers to Christian with message_agent (workspace ${of().id}). The UX review waits for usage to drop below the limit, and its findings come in a later update.`
    ])
  })
})

describe('KERNEL-1072: reviews on request', () => {
  it('turning automatic review on reviews ready, unreviewed PRs', async () => {
    const t = await setup()
    await t.k.config.setSettings({ pr: { autoReview: false } })
    expect(t.rws()).toHaveLength(0)
    await t.k.config.setSettings({ pr: { autoReview: true } })
    await vi.waitFor(() => expect(t.rws()).toHaveLength(1))
  })

  it('a review request starts the review with automatic review off', async () => {
    const t = await setup()
    await t.k.config.setSettings({ pr: { autoReview: false } })
    const started = await t.k.reviews.requestReview(t.ws.id)
    expect(started?.reviewOf).toBe(t.ws.id)
    expect(t.rws()).toHaveLength(1)
  })
})
