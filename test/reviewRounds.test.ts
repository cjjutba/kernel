import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PrInfo, RateLimit, ReviewKind, Workspace } from '@shared/types'
import { mergeBlock } from '@shared/merge'
import { Kernel } from '../src/main/kernel'
import { git } from '../src/main/services/exec'
import { decide, type TeamEvent } from '../src/main/services/leadUpdates'
import { tempRepo } from './helpers'

// KERNEL-552: review rounds re-run only what blocked, stop after `[review] rounds`, and skip optional reviews near the usage limit.

// No Claude Code process ever starts: a review chat's first brief goes to a session that never answers.
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

const AGENTS = {
  'README.md': '# shop\n',
  '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\ntools: Read, Edit, Write, Bash\n---\nYou are Kai.'
}
const UX_ON = '[review.ux]\npaths = ["src/renderer/**"]\n'

/** A room with no reviewer agent, its `[review]` committed on main, and Kai's PR on one commit that passed checks. */
async function setup(o: { settings?: string; files?: Record<string, string> } = {}) {
  const repo = await tempRepo({ ...AGENTS, ...(o.settings ? { '.kernel/settings.toml': o.settings } : {}) })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  const room = await k.addRoom(repo)
  const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Task 1' })
  /** Kai commits `files` and the PR passes checks on that commit. */
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
  const rws = () => k.store.workspaces(room.id).filter((w) => w.reviewOf === ws.id)
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
  return { k, repo, room, ws, push, of, rws, chatOf, verdict, sent, record }
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
    // The verdict of the last round Kernel runs goes to the user, not back to Kai.
    const [r] = k.store.workspaces(of().roomId).filter((w) => w.reviewOf === of().id)
    const review: TeamEvent = { n: 1, workspaceId: r.id, kind: 'review', pr: 101, review: { verdict: 'blockers', lens: 'code', summary: 'No.', blockers: [{ text: 'x' }], of: of().id, ofName: 'Kai', ofPr: 101, current: true } }
    const ctx = { allMerged: () => false, workspace: (id: string) => k.store.workspace(id), stateOf: (id: string) => k.reviews.reviewState(k.store.workspace(id)!) }
    expect(decide({ ws: r, name: 'Code review', events: [review] }, ctx).todo).toEqual([
      "PR #101 is still blocked after 2 review rounds, so Kernel won't review it again by itself. Don't send it back to Kai: tell the user what the code review found that is still open, and ask with ask_user how they want to go on."
    ])
    // Kai pushes anyway, once the review chat's turn is over. Nothing starts, and the update on the new commits asks the user too.
    k.sessions.stop(chatOf('code').id)
    const round = of().reviewRound
    await push({ 'src/main/a.ts': 'try 2\n' })
    await k.reviews.onReady(of().id)
    expect(sent).toEqual(['code'])
    expect(of().reviewRound).toEqual(round)
    const state = k.reviews.reviewState(of())
    expect(state).toMatchObject({ blockers: false, inProgress: false, stillBlocked: { rounds: 2, kinds: ['code'] } })
    expect(decide({ ws: of(), name: 'Kai', events: [ready(of())] }, { ...ctx, review: state }).todo).toEqual([
      "PR #101 has new commits, but it was still blocked after 2 review rounds, so Kernel didn't review them. Don't send it back to Kai: tell the user what the code review found that is still open, and ask with ask_user how they want to go on."
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
    // Round 1 of 2 left blockers, so they go back to Kai. Then the base branch lowers `rounds` to 1.
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
    expect(decide({ ws: of(), name: 'Kai', events: [ready(of())] }, { allMerged: () => false, review: state }).todo).toEqual([
      "PR #101 has new commits, but it was still blocked after 1 review round, so Kernel didn't review them. Don't send it back to Kai: tell the user what the code review found that is still open, and ask with ask_user how they want to go on."
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

describe('review rounds near the usage limit', () => {
  it('skips an optional kind and names it, and a required kind waits for usage to drop', async () => {
    const { k, of, rws, chatOf } = await setup({ settings: '[review.ux]\nrequired = false\n' })
    const near: RateLimit = { type: 'five_hour', status: 'allowed', utilization: 0.95, resetsAt: Math.round(Date.now() / 1000) + 3600 }
    ;(k.sessions as unknown as { mergeLimits: (l: RateLimit[]) => void }).mergeLimits([near])
    await k.reviews.onReady(of().id)
    expect(of().reviewRound).toEqual({ n: 1, rounds: 2, head: of().prHead, prNumber: 101, kinds: ['code', 'ux'], skipped: ['ux'] })
    expect(k.store.chats(rws()[0].id).map((c) => c.lens?.kind)).toEqual(['code'])
    // Setup passed, and the code review's brief waits for usage instead of starting.
    await vi.waitFor(() => expect(k.sessions.queueReason(chatOf('code').id)).toBe('limit'), { timeout: 10_000, interval: 20 })
    const state = k.reviews.reviewState(of())
    expect(state).toMatchObject({ inProgress: true, reviewing: [], held: ['code'], skipped: ['ux'] })
    expect(decide({ ws: of(), name: 'Kai', events: [ready(of())] }, { allMerged: () => false, review: state }).todo).toEqual([])
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
    const review: TeamEvent = { n: 1, workspaceId: r.id, kind: 'review', pr: 101, review: { verdict: 'blockers', lens: 'code', summary: 'No.', blockers: [{ text: 'x' }], of: of().id, ofName: 'Kai', ofPr: 101, current: true } }
    const ctx = { allMerged: () => false, workspace: (id: string) => k.store.workspace(id), stateOf: (id: string) => k.reviews.reviewState(k.store.workspace(id)!) }
    expect(decide({ ws: r, name: 'Code review', events: [review] }, ctx).todo).toEqual([
      `Send the code review's blockers to Kai with message_agent (workspace ${of().id}). The UX review waits for usage to drop below the limit, and its findings come in a later update.`
    ])
  })
})
