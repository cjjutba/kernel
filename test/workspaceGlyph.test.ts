import { describe, expect, it } from 'vitest'
import { chatGlyph, leadGlyph, workspaceGlyph } from '../src/renderer/src/components/sidebar/workspaceGlyph'
import { leadWaiting } from '../src/renderer/src/lead'
import type { Approval, ReviewRound, ReviewVerdict, Workspace } from '../src/shared/types'

const approval = (kind: Approval['kind'], extra: Partial<Approval> = {}): Approval =>
  ({ id: `a-${kind}`, kind, source: 'sdk', title: kind, status: 'pending', createdAt: 0, ...extra })
const plan = approval('plan')
const hookPlan = approval('tool', { id: 'a-hook-plan', toolName: 'ExitPlanMode' })
const bash = approval('tool', { id: 'a-bash', toolName: 'Bash' })
const question = approval('question')

describe('glyphs for pending approvals', () => {
  it('shows the clipboard when only plans wait, whether they arrive as a plan or as ExitPlanMode', () => {
    expect(chatGlyph({ waiting: [plan], running: false })).toEqual({ icon: 'plan', tone: 'needs', label: 'Plan to review' })
    expect(chatGlyph({ waiting: [plan, hookPlan], running: true })).toMatchObject({ icon: 'plan', label: 'Plan to review' })
  })

  it('shows the question mark when a tool or question waits, even next to a plan', () => {
    expect(chatGlyph({ waiting: [plan, bash], running: false })).toEqual({ icon: 'question', tone: 'needs', label: 'Needs you' })
    expect(chatGlyph({ waiting: [question, plan], running: false })).toMatchObject({ icon: 'question', label: 'Needs you' })
  })

  it('shows the clipboard on the Lead row while its status is working, since a team plan never sets needs', () => {
    expect(leadGlyph('working', [plan])).toMatchObject({ icon: 'plan', label: 'Plan to review' })
    expect(leadGlyph('idle', [plan])).toMatchObject({ icon: 'plan' })
    expect(leadGlyph('working', [])).toMatchObject({ icon: 'spin' })
    expect(leadGlyph('needs', [])).toMatchObject({ icon: 'question' })
  })

  it('finds the Lead\'s pending approvals on its workspace, and none without one', () => {
    const other = approval('question', { id: 'a-other', workspaceId: 'ws-other' })
    const mine = approval('plan', { id: 'a-mine', workspaceId: 'ws-lead' })
    const done = approval('plan', { id: 'a-done', workspaceId: 'ws-lead', status: 'allowed' })
    const loose = approval('question', { id: 'a-loose' })
    expect(leadWaiting([other, mine, done, loose], 'ws-lead')).toEqual([mine])
    expect(leadWaiting([other, mine, done, loose], undefined)).toEqual([])
  })
})

describe('a ready PR GitHub blocks (KERNEL-401)', () => {
  it('reads open, as the header does, not ready to merge', () => {
    const ws = (o: Partial<Workspace>) => ({ id: 'w', status: 'ready', prState: 'ready', ...o }) as Workspace
    const idle = { waiting: [], running: false }
    expect(workspaceGlyph(ws({}), idle)).toEqual({ icon: 'prReady', tone: 'add', label: 'Ready to merge' })
    expect(workspaceGlyph(ws({ prBlocked: 'behind' }), idle)).toEqual({ icon: 'pr', tone: 'add', label: 'PR open' })
  })
})

describe('a ready PR its review holds back (KERNEL-608)', () => {
  const ws = (o: Partial<Workspace>) => ({ id: 'w', status: 'ready', prState: 'ready', prNumber: 7, prHead: 'b', ...o }) as Workspace
  const idle = { waiting: [], running: false }
  const verdict = (o: Partial<ReviewVerdict>): ReviewVerdict => ({ workspaceId: 'rv', agentId: 'kernel-reviewer', verdict: 'blockers', summary: '', blockers: [{ text: 'No label.' }], sha: 'b', prNumber: 7, lens: 'ux', ts: 1, ...o })
  const round = (o: Partial<ReviewRound> = {}): ReviewRound => ({ n: 3, rounds: 3, head: 'a', prNumber: 7, kinds: ['code', 'ux'], ...o })

  it('reads blockers found while any kind of review found them on the head commit, as the header and the PRs tab do', () => {
    const blocked = ws({ reviews: [verdict({ lens: 'code', verdict: 'approved', blockers: undefined }), verdict({})] })
    expect(workspaceGlyph(blocked, idle)).toEqual({ icon: 'prChanges', tone: 'del', label: 'Blockers found' })
    expect(workspaceGlyph({ ...blocked, prState: 'open' }, idle)).toEqual({ icon: 'prChanges', tone: 'del', label: 'Blockers found' })
    // GitHub's own block still reads open first, as the header has it.
    expect(workspaceGlyph({ ...blocked, prBlocked: 'review' }, idle)).toEqual({ icon: 'pr', tone: 'add', label: 'PR open' })
  })

  it('reads ready to merge once the blockers are on an earlier commit, or on another PR', () => {
    expect(workspaceGlyph(ws({ reviews: [verdict({ sha: 'a' })] }), idle)).toEqual({ icon: 'prReady', tone: 'add', label: 'Ready to merge' })
    expect(workspaceGlyph(ws({ reviews: [verdict({ prNumber: 6 })] }), idle)).toEqual({ icon: 'prReady', tone: 'add', label: 'Ready to merge' })
  })

  it('reads open, not ready to merge, while the review rounds ran out with blockers left on the last round', () => {
    // A commit after the last round nobody reviewed, as in KERNEL-558.
    const capped = ws({ reviews: [verdict({ sha: 'a' })], reviewRound: round() })
    expect(workspaceGlyph(capped, idle)).toEqual({ icon: 'pr', tone: 'add', label: 'PR open' })
    // Rounds left, a last round that left no blockers, or a round of another PR, read ready again.
    expect(workspaceGlyph({ ...capped, reviewRound: round({ n: 2 }) }, idle)).toMatchObject({ label: 'Ready to merge' })
    expect(workspaceGlyph({ ...capped, reviews: [verdict({ sha: 'a', verdict: 'approved', blockers: undefined })] }, idle)).toMatchObject({ label: 'Ready to merge' })
    expect(workspaceGlyph({ ...capped, reviewRound: round({ prNumber: 6 }) }, idle)).toMatchObject({ label: 'Ready to merge' })
  })
})

describe('a PR action pending (KERNEL-520)', () => {
  const ws = (o: Partial<Workspace>) => ({ id: 'w', status: 'ready', prState: 'ready', ...o }) as Workspace
  const idle = { waiting: [], running: false }

  it("spins in the action's word from the press, before the PR state moves, and reads the PR again when it ends", () => {
    expect(workspaceGlyph(ws({}), { ...idle, pending: 'merge' })).toEqual({ icon: 'spin', tone: 'muted', label: 'Merging' })
    expect(workspaceGlyph(ws({ prState: 'draft' }), { ...idle, pending: 'ready' })).toEqual({ icon: 'spin', tone: 'muted', label: 'Marking ready' })
    expect(workspaceGlyph(ws({}), idle)).toEqual({ icon: 'prReady', tone: 'add', label: 'Ready to merge' })
  })

  it('waits behind what needs you and what is working, and never covers a merged PR', () => {
    expect(workspaceGlyph(ws({}), { waiting: [plan], running: false, pending: 'merge' })).toMatchObject({ icon: 'plan' })
    expect(workspaceGlyph(ws({ status: 'setup' }), { ...idle, pending: 'merge' })).toMatchObject({ label: 'Setting up' })
    // A chat already working while setup runs reads as working (KERNEL-1012).
    expect(workspaceGlyph(ws({ status: 'setup' }), { waiting: [], running: true })).toMatchObject({ label: 'Working' })
    expect(workspaceGlyph(ws({}), { waiting: [], running: true, pending: 'merge' })).toMatchObject({ label: 'Working' })
    expect(workspaceGlyph(ws({ prState: 'merged' }), { ...idle, pending: 'merge' })).toEqual({ icon: 'merged', tone: 'merged', label: 'Merged' })
  })
})
