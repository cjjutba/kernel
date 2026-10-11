import { describe, expect, it } from 'vitest'
import type { PrInfo, PrState, Workspace } from '@shared/types'
import { mergeBlock, mergeNeedsPr, reviewVerdicts } from '@shared/merge'

// The one rule every Merge button and the Lead use for whether a PR can merge (KERNEL-115, KERNEL-349).

const A = 'a'.repeat(40), B = 'b'.repeat(40)
const v = (verdict: 'approved' | 'blockers', sha: string, ts: number, o: Partial<NonNullable<Workspace['reviews']>[number]> = {}) => ({ workspaceId: 'rev', agentId: 'theo', verdict, summary: '', sha, prNumber: 42, ts, ...o })
const ws = (o: Partial<Workspace> = {}) => ({ id: 'w', prState: 'ready', prNumber: 42, prHead: B, ...o }) as Workspace
const info = (o: Partial<PrInfo> = {}): PrInfo => ({ workspaceId: 'w', number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state: 'ready', baseRef: 'main', checks: [], comments: [], conflicts: [], head: B, ...o })
const both = { requireGreen: true, requireReviewer: true }
const reviewer = { requireGreen: false, requireReviewer: true }
const name = (id: string) => (id === 'theo' ? 'Theo' : id)
const held = "Theo hasn't approved the latest commit. Merging waits for the reviewer's approval (Settings, Pull requests)."
const notReady = 'This pull request is not ready to merge.'
const STATES = Object.keys({ none: 1, creating: 1, draft: 1, open: 1, checks: 1, cifail: 1, changes: 1, conflict: 1, resolving: 1, ready: 1, merging: 1, merged: 1, closed: 1 } satisfies Record<PrState, 1>) as PrState[]

describe('the PR state', () => {
  it('lets a ready PR merge', () => {
    expect(mergeBlock(ws({ prState: 'ready' }), info(), both)).toBeUndefined()
  })

  it('lets an open PR merge, one GitHub reports mergeable with no required checks', () => {
    expect(mergeBlock(ws({ prState: 'open' }), info({ state: 'open' }), both)).toBeUndefined()
  })

  it('refuses while a merge is already running', () => {
    expect(mergeBlock(ws({ prState: 'merging' }), info(), both)).toBe(notReady)
  })

  it('refuses every other state, whatever the settings', () => {
    for (const s of STATES.filter((s) => s !== 'ready' && s !== 'open')) {
      expect(mergeBlock(ws({ prState: s }), info(), both), s).toBe(notReady)
      expect(mergeBlock(ws({ prState: s }), undefined, { requireGreen: false, requireReviewer: false }), s).toBe(notReady)
    }
  })
})

describe('GitHub and the checks', () => {
  it('reads GitHub only when green checks are required or a reviewer looked at the PR', () => {
    expect(mergeNeedsPr(ws(), { requireGreen: false, requireReviewer: true })).toBe(false)
    expect(mergeNeedsPr(ws({ reviews: [v('approved', B, 1)] }), reviewer)).toBe(true)
    expect(mergeNeedsPr(ws({ reviews: [v('approved', B, 1)] }), { requireGreen: false, requireReviewer: false })).toBe(false)
    expect(mergeNeedsPr(ws(), { requireGreen: true, requireReviewer: false })).toBe(true)
  })

  it('says why a PR cannot merge, in order: its state, GitHub, checks, then the review', () => {
    expect(mergeBlock(ws({ prState: 'checks' }), null, both)).toBe(notReady)
    expect(mergeBlock(ws(), null, both)).toBe('Could not read the pull request from GitHub.')
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info({ checks: [{ name: 'e2e', state: 'running' }] }), both)).toContain('Checks have not passed yet')
    expect(mergeBlock(ws(), info({ checks: [{ name: 'e2e', state: 'skipped' }] }), both)).toBeUndefined()
  })
})

describe('the review', () => {
  it('keeps the verdicts on this PR, and marks those on its head commit current', () => {
    const out = reviewVerdicts(ws({ reviews: [v('approved', A, 1), v('approved', B, 2, { workspaceId: 'r2' }), v('approved', B, 3, { prNumber: 7 })] }))
    expect(out.verdicts.map((x) => x.ts)).toEqual([1, 2])
    expect(out.current.map((x) => x.ts)).toEqual([2])
  })

  it('merges a PR nobody reviewed', () => {
    expect(mergeBlock(ws(), undefined, reviewer)).toBeUndefined()
    expect(mergeBlock(ws({ reviews: [] }), info(), both)).toBeUndefined()
    // A review on another PR from this branch doesn't count.
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1, { prNumber: 7 })] }), info(), both)).toBeUndefined()
  })

  it('merges on an approval of the head commit', () => {
    expect(mergeBlock(ws({ reviews: [v('approved', B, 1)] }), info(), both, name)).toBeUndefined()
    // A later approval of the head commit clears earlier blockers on an older one.
    expect(mergeBlock(ws({ reviews: [v('blockers', A, 1), v('approved', B, 2, { workspaceId: 'r2' })] }), info(), both, name)).toBeUndefined()
  })

  it('holds on an approval of an earlier commit', () => {
    expect(mergeBlock(ws({ reviews: [v('approved', A, 1)] }), info(), both, name)).toBe(held)
    // GitHub's head wins over the one the last poll saw.
    expect(mergeBlock(ws({ prHead: A, reviews: [v('approved', A, 1)] }), info({ head: B }), both, name)).toBe(held)
  })

  it('holds on blockers on the head commit, naming the reviewer who found them', () => {
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info(), both, name)).toBe(held)
    expect(mergeBlock(ws({ reviews: [v('approved', B, 1, { agentId: 'ivy', workspaceId: 'r2' }), v('blockers', B, 2)] }), info(), both, name)).toBe(held)
    // Without a name lookup it falls back to the agent id.
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info(), both)).toContain("theo hasn't approved")
  })

  it('ignores the review when Reviewer approval is not required', () => {
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info(), { requireGreen: true, requireReviewer: false }, name)).toBeUndefined()
  })
})
