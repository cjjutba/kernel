import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MergeMethod, PrInfo, PrState, Workspace } from '@shared/types'
import { autoMergeBlock, blockedText, gatingChecks, headBlockers, kindStates, mergeBlock, mergeNeedsPr, reviewVerdicts, verdictPhrase } from '@shared/merge'
import { Kernel } from '../src/main/kernel'
import { allowedMethod } from '../src/main/features/codeHost'
import { run } from '../src/main/services/exec'
import { HEAD_MOVED, prMerge } from '../src/main/services/github'
import { land, localMerge, LocalMergeError, localStatus, prepareMerge, type Refusal } from '../src/main/services/localMerge'
import { setUp, tempRepo, freePort } from './helpers'
import { leadPrs } from '../src/renderer/src/screens/workspace/pr/leadPrList'
import { mergeView } from '../src/renderer/src/screens/workspace/pr/MergeButton'

// The one rule every Merge button and the Lead use for whether a PR can merge (KERNEL-115, KERNEL-349).

const A = 'a'.repeat(40), B = 'b'.repeat(40)
const v = (verdict: 'approved' | 'blockers', sha: string, ts: number, o: Partial<NonNullable<Workspace['reviews']>[number]> = {}) => ({ workspaceId: 'rev', agentId: 'theo', verdict, summary: '', sha, prNumber: 42, ts, ...o })
const ws = (o: Partial<Workspace> = {}) => ({ id: 'w', prState: 'ready', prNumber: 42, prHead: B, ...o }) as Workspace
const info = (o: Partial<PrInfo> = {}): PrInfo => ({ workspaceId: 'w', number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state: 'ready', baseRef: 'main', checks: [], comments: [], conflicts: [], head: B, ...o })
const both = { requireGreen: true, requireReviewer: true }
const reviewer = { requireGreen: false, requireReviewer: true }
const name = (id: string) => (id === 'theo' ? 'Theo' : id)
// Verdicts from before review kinds count as the code review's (KERNEL-549).
const held = "The code review hasn't approved the latest commit. Merging waits for every required review (Settings, Pull requests)."
const found = 'The code review found 1 blocker on the latest commit. Merge anyway to go ahead.'
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

  it('refuses a PR that last read ready while GitHub is still checking it for conflicts (KERNEL-376)', () => {
    for (const rules of [both, { requireGreen: false, requireReviewer: false }]) {
      expect(mergeBlock(ws({ prState: 'ready' }), info({ state: 'checks', conflictsUnknown: true }), rules)).toBe(notReady)
      expect(mergeBlock(ws({ prState: 'ready' }), info({ conflictsUnknown: true }), rules)).toBe(notReady)
    }
  })

  it('refuses when GitHub now reads the PR as anything but ready or open (KERNEL-376)', () => {
    const off = { requireGreen: false, requireReviewer: false }
    for (const s of STATES.filter((s) => s !== 'ready' && s !== 'open')) expect(mergeBlock(ws({ prState: 'ready' }), info({ state: s }), off), s).toBe(notReady)
    expect(mergeBlock(ws({ prState: 'ready' }), info({ state: 'open' }), off)).toBeUndefined()
    expect(mergeBlock(ws({ prState: 'open' }), info({ state: 'ready' }), off)).toBeUndefined()
  })
})

describe('GitHub and the checks', () => {
  it('needs the GitHub read only when green checks are required or a reviewer looked at the PR', () => {
    expect(mergeNeedsPr(ws(), { requireGreen: false })).toBe(false)
    expect(mergeNeedsPr(ws({ reviews: [v('approved', B, 1)] }), reviewer)).toBe(true)
    // Blockers on the head commit hold the merge with the reviewer rule off too, so the head has to be GitHub's (KERNEL-497).
    expect(mergeNeedsPr(ws({ reviews: [v('approved', B, 1)] }), { requireGreen: false })).toBe(true)
    expect(mergeNeedsPr(ws(), { requireGreen: true })).toBe(true)
  })

  it('says why a PR cannot merge, in order: its state, GitHub, checks, then the review', () => {
    expect(mergeBlock(ws({ prState: 'checks' }), null, both)).toBe(notReady)
    expect(mergeBlock(ws(), null, both)).toBe('Could not read the pull request from GitHub.')
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info({ checks: [{ name: 'e2e', state: 'running' }] }), both)).toContain('Checks have not passed yet')
    expect(mergeBlock(ws(), info({ checks: [{ name: 'e2e', state: 'skipped' }] }), both)).toBeUndefined()
  })
})

describe("the repo's own rules (KERNEL-388)", () => {
  const green = { requireGreen: true, requireReviewer: false }

  it("counts only the checks that decide the PR, so a failing optional check doesn't hold the merge", () => {
    const checks: PrInfo['checks'] = [{ name: 'Release note', state: 'pass' }, { name: 'Test', state: 'fail', optional: true }, { name: 'Vercel', state: 'pass', optional: true }]
    expect(gatingChecks(checks)).toEqual([{ name: 'Release note', state: 'pass' }])
    expect(mergeBlock(ws(), info({ checks }), { requireGreen: false, requireReviewer: false })).toBeUndefined()
    expect(mergeBlock(ws(), info({ checks }), green)).toBeUndefined()
    expect(mergeBlock(ws(), info({ checks: [{ name: 'Release note', state: 'running' }, ...checks.slice(1)] }), green)).toContain('Checks have not passed yet')
  })

  // KERNEL-703: #656 merged while Test, which the repo didn't require, still ran.
  it('holds the merge while any check runs, required or not, and names it', () => {
    const running: PrInfo['checks'] = [{ name: 'Release note', state: 'pass' }, { name: 'Test', state: 'running', optional: true }]
    for (const rules of [green, { requireGreen: false, requireReviewer: false }]) {
      // The last poll read it ready before Test started, or already reads checks.
      expect(mergeBlock(ws(), info({ checks: running }), rules)).toBe('Test is still running.')
      expect(mergeBlock(ws({ prState: 'checks' }), info({ state: 'checks', checks: running }), rules)).toBe('Test is still running.')
    }
    const two: PrInfo['checks'] = [...running, { name: 'Lint', state: 'queued', optional: true }]
    expect(mergeBlock(ws(), info({ checks: two }), green)).toBe('Test and Lint are still running.')
    expect(mergeBlock(ws(), info({ checks: [...two, { name: 'e2e', state: 'running', optional: true }] }), green)).toBe('Test and 2 other checks are still running.')
  })

  it('lets Merge anyway past an optional check still running, and not past a required one', () => {
    const running: PrInfo['checks'] = [{ name: 'Release note', state: 'pass' }, { name: 'Test', state: 'running', optional: true }]
    expect(mergeBlock(ws(), info({ checks: running }), green, name, { override: true })).toBeUndefined()
    expect(mergeBlock(ws({ prState: 'checks' }), info({ state: 'checks', checks: running }), green, name, { override: true })).toBeUndefined()
    const required: PrInfo['checks'] = [{ name: 'Release note', state: 'running' }]
    expect(mergeBlock(ws({ prState: 'checks' }), info({ state: 'checks', checks: required }), { requireGreen: false, requireReviewer: false }, name, { override: true })).toBe('Release note is still running.')
    expect(mergeBlock(ws({ prState: 'checks' }), info({ state: 'checks', checks: required }), green, name, { override: true })).toContain('Checks have not passed yet')
    // Merge anyway doesn't skip anything else GitHub reads: a PR whose state is checks with no check running isn't ready.
    expect(mergeBlock(ws({ prState: 'checks' }), info({ state: 'checks' }), green, name, { override: true })).toBe(notReady)
  })

  it("refuses a PR GitHub won't merge yet with GitHub's reason, after the checks", () => {
    expect(mergeBlock(ws(), info({ blocked: 'review' }), green)).toBe('GitHub needs an approving review before this pull request can merge.')
    expect(mergeBlock(ws(), info({ blocked: 'behind' }), green)).toBe('This branch is behind main, and GitHub needs it up to date before it can merge.')
    expect(mergeBlock(ws(), info({ blocked: 'rules' }), green)).toBe("GitHub's branch rules block this merge.")
    expect(mergeBlock(ws(), info({ blocked: 'review', checks: [{ name: 'e2e', state: 'fail' }] }), green)).toContain('Checks have not passed yet')
  })

  it('goes by the last poll when the merge read nothing, and by the read when it did', () => {
    const off = { requireGreen: false, requireReviewer: false }
    expect(mergeBlock(ws({ prBlocked: 'behind' }), undefined, off)).toBe(blockedText('behind', ''))
    expect(blockedText('behind', '')).toContain('behind its base')
    expect(mergeBlock(ws({ prBlocked: 'behind' }), info(), off)).toBeUndefined()
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

  it('holds on blockers on the head commit, naming the review that found them and how many', () => {
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info(), both, name)).toBe(found)
    expect(mergeBlock(ws({ reviews: [v('approved', B, 1, { agentId: 'ivy', workspaceId: 'r2' }), v('blockers', B, 2)] }), info(), both, name)).toBe(found)
    const three = [{ text: 'a' }, { text: 'b' }, { text: 'c' }]
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1, { blockers: three })] }), info(), both, name)).toBe('The code review found 3 blockers on the latest commit. Merge anyway to go ahead.')
  })
})

describe('kinds of review (KERNEL-549)', () => {
  const code = (verdict: 'approved' | 'blockers', sha = B, o = {}) => v(verdict, sha, 1, { lens: 'code', ...o })
  const security = (verdict: 'approved' | 'blockers', sha = B, o = {}) => v(verdict, sha, 2, { lens: 'security', agentId: 'kernel-reviewer', ...o })

  it('counts the verdicts of two kinds on the head commit, one review workspace holding one of each', () => {
    expect(kindStates(ws({ reviews: [code('approved'), security('approved')] }))).toMatchObject({ ran: ['code', 'security'], approved: ['code', 'security'], blocking: [], waiting: [] })
    expect(mergeBlock(ws({ reviews: [code('approved'), security('approved')] }), info(), both, name)).toBeUndefined()
  })

  it('holds the merge on blockers from either kind, and names it', () => {
    const one = ws({ reviews: [code('approved'), security('blockers', B, { blockers: [{ text: 'a' }, { text: 'b' }] })] })
    expect(mergeBlock(one, info(), both, name)).toBe('The security review found 2 blockers on the latest commit. Merge anyway to go ahead.')
    // With the reviewer rule off too: blockers always hold (KERNEL-497).
    expect(mergeBlock(one, info(), { requireGreen: false, requireReviewer: false }, name)).toContain('The security review found 2 blockers')
    expect(headBlockers(one)).toEqual({ agentId: 'kernel-reviewer', count: 2, lenses: ['security'] })
    const both2 = ws({ reviews: [code('blockers'), security('blockers')] })
    expect(mergeBlock(both2, info(), both, name)).toBe('The code and security reviews found 2 blockers on the latest commit. Merge anyway to go ahead.')
    expect(mergeBlock(both2, info(), both, name, { override: true })).toBeUndefined()
  })

  it('waits for every required kind that reviewed the PR to approve its head commit', () => {
    // The security review approved an earlier commit: it has to look at this one too.
    expect(mergeBlock(ws({ reviews: [code('approved'), security('approved', A)] }), info(), both, name))
      .toBe("The security review hasn't approved the latest commit. Merging waits for every required review (Settings, Pull requests).")
    expect(mergeBlock(ws({ reviews: [code('approved', A), security('approved', A)] }), info(), both, name)).toContain("The code and security reviews haven't approved")
    // An optional kind's approval doesn't count toward the merge, but its blockers still hold it.
    expect(mergeBlock(ws({ reviews: [code('approved'), security('approved', A, { optional: true })] }), info(), both, name)).toBeUndefined()
    expect(mergeBlock(ws({ reviews: [code('approved'), security('blockers', B, { optional: true })] }), info(), both, name)).toContain('The security review found 1 blocker')
    // A kind that hasn't reported yet holds nothing, as a PR nobody reviewed merges.
    expect(mergeBlock(ws({ reviews: [code('approved')] }), info(), both, name)).toBeUndefined()
  })

  it('lets a later approval of the head commit by the same kind clear its blockers on an older one, but not blockers on the head commit', () => {
    expect(mergeBlock(ws({ reviews: [code('blockers', A), code('approved', B, { workspaceId: 'r2' })] }), info(), both, name)).toBeUndefined()
    expect(kindStates(ws({ reviews: [code('blockers'), code('approved', B, { workspaceId: 'r2' })] }))).toMatchObject({ approved: [], blocking: ['code'] })
  })
})

describe('reviews Kernel planned for the head commit (KERNEL-717)', () => {
  const round = (o: Partial<NonNullable<Workspace['reviewRound']>> = {}): Workspace['reviewRound'] => ({ n: 1, rounds: 2, head: B, prNumber: 42, kinds: ['code', 'security'], ...o })
  const code = (verdict: 'approved' | 'blockers', sha = B) => v(verdict, sha, 1, { lens: 'code' })
  const security = (verdict: 'approved' | 'blockers', sha = B) => v(verdict, sha, 2, { lens: 'security' })
  const starting = 'The review of the latest commit is starting. Merging waits for every required review (Settings, Pull requests).'

  it('holds from the ready event, before Kernel knows which reviews run', () => {
    expect(mergeBlock(ws({ reviewPending: B }), info(), both, name)).toBe(starting)
    // A marker on an older head says nothing about this one.
    expect(mergeBlock(ws({ reviewPending: A }), info(), both, name)).toBeUndefined()
  })

  it('holds until every required kind of the round approves the head, before any of them reports', () => {
    expect(mergeBlock(ws({ reviewRound: round() }), info(), both, name)).toBe("The code and security reviews haven't approved the latest commit. Merging waits for every required review (Settings, Pull requests).")
    expect(mergeBlock(ws({ reviewRound: round(), reviews: [code('approved')] }), info(), both, name)).toBe("The security review hasn't approved the latest commit. Merging waits for every required review (Settings, Pull requests).")
    expect(mergeBlock(ws({ reviewRound: round(), reviews: [code('approved'), security('approved')] }), info(), both, name)).toBeUndefined()
  })

  it('waits again on a new head once its round starts', () => {
    const approved = [code('approved', A), security('approved', A)]
    expect(mergeBlock(ws({ prHead: A, reviewRound: round({ head: A }), reviews: approved }), info({ head: A }), both, name)).toBeUndefined()
    expect(mergeBlock(ws({ reviewRound: round({ head: A }), reviews: approved, reviewPending: B }), info(), both, name)).toBe(starting)
    // The new round runs the code review again and keeps the security review's approval, which moved to the new head.
    const kept = [code('approved', A), security('approved', B)]
    expect(mergeBlock(ws({ reviewRound: round({ n: 2, kept: ['security'] }), reviews: kept }), info(), both, name)).toContain("The code review hasn't approved")
    expect(mergeBlock(ws({ reviewRound: round({ n: 2, kept: ['security'] }), reviews: [...kept, code('approved')] }), info(), both, name)).toBeUndefined()
  })

  it('never waits for a skipped or optional kind', () => {
    expect(mergeBlock(ws({ reviewRound: round({ skipped: ['security'] }), reviews: [code('approved')] }), info(), both, name)).toBeUndefined()
    expect(mergeBlock(ws({ reviewRound: round({ optional: ['security'] }), reviews: [code('approved')] }), info(), both, name)).toBeUndefined()
  })

  it('never waits for a kind whose blockers on the head were overruled (KERNEL-732)', () => {
    const overruled = { head: B, kinds: ['security' as const], by: 'user' as const, ts: 3 }
    expect(mergeBlock(ws({ reviewRound: round(), reviews: [code('approved'), security('blockers')], overruled }), info(), both, name)).toBeUndefined()
    // An overrule of an older head leaves the planned kind waiting.
    expect(mergeBlock(ws({ reviewRound: round(), reviews: [code('approved')], overruled: { ...overruled, head: A } }), info(), both, name)).toContain("The security review hasn't approved")
  })

  it('changes nothing with the approval switch off, or with a round of another PR', () => {
    expect(mergeBlock(ws({ reviewPending: B, reviewRound: round() }), info(), { requireGreen: true, requireReviewer: false }, name)).toBeUndefined()
    expect(mergeBlock(ws({ reviewRound: round({ prNumber: 7 }) }), info(), both, name)).toBeUndefined()
  })

  it('lists the PR as waiting for approval, not ready', () => {
    const w = { ...ws({ reviewRound: round(), projectId: 'project', agentId: 'kai', status: 'ready' }) } as Workspace
    const [row] = leadPrs([w], { leadId: undefined, projectId: 'project', prs: { w: info() }, rules: both, agents: [] })
    expect(row).toMatchObject({ ready: false, state: { label: 'Waiting for approval' } })
    expect(row.blockers).toBeUndefined()
    // Merge reads the same rule, so it offers no Merge, nor Merge anyway.
    expect(mergeView(w, info(), both)).toEqual({ kind: 'blocked', reason: expect.stringContaining("haven't approved the latest commit") })
  })
})

describe('a head Kernel updated from the base (KERNEL-832)', () => {
  const C = 'c'.repeat(40)
  const code = (verdict: 'approved' | 'blockers', sha = A) => v(verdict, sha, 1, { lens: 'code' })
  const updated = (o: Partial<Workspace> = {}) => ws({ baseUpdates: [{ from: A, to: B }], ...o })

  it('counts verdicts on the head it updated, blockers included, through updates one after another', () => {
    expect(reviewVerdicts(updated({ reviews: [code('approved')] })).current).toHaveLength(1)
    expect(mergeBlock(updated({ reviews: [code('approved')] }), info(), both, name)).toBeUndefined()
    expect(mergeBlock(updated({ reviews: [code('blockers')] }), info(), both, name)).toBe(found)
    const twice = updated({ prHead: C, baseUpdates: [{ from: A, to: B }, { from: B, to: C }], reviews: [code('approved')] })
    expect(mergeBlock(twice, info({ head: C }), both, name)).toBeUndefined()
  })

  it('carries the round, the pending review and the overrule of the head it updated', () => {
    const round = { n: 1, rounds: 2, head: A, prNumber: 42, kinds: ['code' as const] }
    expect(mergeBlock(updated({ reviewRound: round }), info(), both, name)).toBe(held)
    expect(mergeBlock(updated({ reviewPending: A }), info(), both, name)).toContain('is starting')
    expect(kindStates(updated({ reviews: [code('blockers')], overruled: { head: A, kinds: ['code'], by: 'user', ts: 2 } }))).toMatchObject({ blocking: [], overruled: ['code'] })
  })

  it('counts nothing for a head Kernel never recorded, nor backwards from an update', () => {
    expect(mergeBlock(ws({ reviews: [code('approved')] }), info(), both, name)).toBe(held)
    expect(mergeBlock(updated({ prHead: A, reviews: [code('approved', B)] }), info({ head: A }), both, name)).toBe(held)
  })
})

describe('blockers on the head commit (KERNEL-497)', () => {
  const off = { requireGreen: true, requireReviewer: false }
  const override = { override: true }

  it('names the reviewer who found blockers on the head commit and how many, built on reviewVerdicts', () => {
    expect(headBlockers(ws({ reviews: [v('blockers', B, 1, { blockers: [{ text: 'a' }, { text: 'b' }] })] }))).toEqual({ agentId: 'theo', count: 2, lenses: ['code'] })
    // A verdict with no list of blockers still found one.
    expect(headBlockers(ws({ reviews: [v('blockers', B, 1)] }))).toEqual({ agentId: 'theo', count: 1, lenses: ['code'] })
    // The latest review with blockers of a kind counts them.
    expect(headBlockers(ws({ reviews: [v('blockers', B, 2, { agentId: 'ivy', workspaceId: 'r2' }), v('blockers', B, 1)] }))).toEqual({ agentId: 'ivy', count: 1, lenses: ['code'] })
    // Blockers on an earlier commit, or on another PR from this branch, aren't on the head commit.
    expect(headBlockers(ws({ reviews: [v('blockers', A, 1)] }))).toBeUndefined()
    expect(headBlockers(ws({ reviews: [v('blockers', B, 1, { prNumber: 7 })] }))).toBeUndefined()
    expect(headBlockers(ws({ reviews: [v('approved', B, 1)] }))).toBeUndefined()
    expect(headBlockers(ws())).toBeUndefined()
  })

  it('hold the merge with the reviewer rule off', () => {
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info(), off, name)).toBe(found)
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info(), { requireGreen: false, requireReviewer: false }, name)).toBe(found)
    // GitHub's head wins: blockers on the commit the last poll saw don't hold a PR that moved on.
    expect(mergeBlock(ws({ prHead: A, reviews: [v('blockers', A, 1)] }), info({ head: B }), off, name)).toBeUndefined()
    // With no GitHub read there is nothing to judge the head by, so the merge waits for one.
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), undefined, { requireGreen: false, requireReviewer: false }, name)).toBe('Could not read the pull request from GitHub.')
  })

  it('leave the wait for an approval to the reviewer rule', () => {
    expect(mergeBlock(ws({ reviews: [v('approved', A, 1)] }), info(), off, name)).toBeUndefined()
    expect(mergeBlock(ws({ reviews: [v('approved', A, 1)] }), info(), both, name)).toBe(held)
  })

  it('give way to the override, which skips the review and only the review', () => {
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info(), off, name, override)).toBeUndefined()
    expect(mergeBlock(ws({ reviews: [v('blockers', B, 1)] }), info(), both, name, override)).toBeUndefined()
    expect(mergeBlock(ws({ reviews: [v('approved', A, 1)] }), info(), both, name, override)).toBeUndefined()
    const blockers = ws({ reviews: [v('blockers', B, 1)] })
    expect(mergeBlock(blockers, info({ checks: [{ name: 'e2e', state: 'fail' }] }), both, name, override)).toContain('Checks have not passed yet')
    expect(mergeBlock(blockers, info({ state: 'conflict' }), both, name, override)).toBe(notReady)
    expect(mergeBlock(blockers, info({ conflictsUnknown: true }), both, name, override)).toBe(notReady)
    expect(mergeBlock(blockers, info({ blocked: 'rules' }), both, name, override)).toBe("GitHub's branch rules block this merge.")
    expect(mergeBlock({ ...blockers, prState: 'cifail' }, info(), both, name, override)).toBe(notReady)
    expect(mergeBlock(blockers, null, both, name, override)).toBe('Could not read the pull request from GitHub.')
  })
})

describe('an overrule of the blockers on the head commit (KERNEL-732)', () => {
  const code = (verdict: 'approved' | 'blockers', sha = B, o = {}) => v(verdict, sha, 1, { lens: 'code', blockers: [{ text: 'a' }, { text: 'b' }], ...o })
  const security = (verdict: 'approved' | 'blockers', sha = B, o = {}) => v(verdict, sha, 2, { lens: 'security', agentId: 'kernel-reviewer', ...o })
  const over = (kinds: ('code' | 'security')[], head = B) => ({ head, kinds, by: 'user' as const, ts: 3 })

  it('clears the head\'s blockers in kindStates, headBlockers and mergeBlock, and lets the merge through without Merge anyway', () => {
    const w = ws({ reviews: [code('blockers')], overruled: over(['code']) })
    expect(kindStates(w)).toMatchObject({ ran: ['code'], blocking: [], count: 0, approved: [], waiting: [], overruled: ['code'] })
    expect(kindStates(w).agentId).toBeUndefined()
    expect(headBlockers(w)).toBeUndefined()
    // "Require Reviewer approval" on: an overruled kind waits for no approval either.
    expect(mergeBlock(w, info(), both, name)).toBeUndefined()
    expect(mergeBlock(w, info(), { requireGreen: false, requireReviewer: false }, name)).toBeUndefined()
    expect(verdictPhrase(w)).toEqual({ text: 'Blockers overruled', tone: 'faint' })
  })

  it("doesn't hide another kind's blockers, which still hold the merge", () => {
    const w = ws({ reviews: [code('blockers'), security('blockers')], overruled: over(['code']) })
    expect(kindStates(w)).toMatchObject({ blocking: ['security'], count: 1, overruled: ['code'], agentId: 'kernel-reviewer' })
    expect(headBlockers(w)).toEqual({ agentId: 'kernel-reviewer', count: 1, lenses: ['security'] })
    expect(mergeBlock(w, info(), both, name)).toBe('The security review found 1 blocker on the latest commit. Merge anyway to go ahead.')
    // Another kind that hasn't approved still holds a merge that waits for every required review.
    expect(mergeBlock(ws({ reviews: [code('blockers'), security('approved', A)], overruled: over(['code']) }), info(), both, name)).toContain("The security review hasn't approved")
  })

  it('stops counting once the PR has a new head commit, so its review counts again', () => {
    // The overrule was of A. The review of B found blockers again.
    const w = ws({ reviews: [code('blockers', A), code('blockers', B, { workspaceId: 'r2' })], overruled: over(['code'], A) })
    expect(kindStates(w)).toMatchObject({ blocking: ['code'], overruled: [] })
    expect(mergeBlock(w, info(), both, name)).toBe('The code review found 2 blockers on the latest commit. Merge anyway to go ahead.')
    // GitHub's head wins over the saved one, both ways.
    const old = ws({ prHead: A, reviews: [code('blockers', B)], overruled: over(['code'], A) })
    expect(mergeBlock(old, info({ head: B }), both, name)).toContain('The code review found 2 blockers')
    expect(mergeBlock({ ...old, overruled: over(['code']) }, info({ head: B }), both, name)).toBeUndefined()
    // A head Kernel doesn't know matches no overrule.
    expect(kindStates(ws({ prHead: undefined, reviews: [code('blockers')], overruled: over(['code']) }))).toMatchObject({ blocking: ['code'], overruled: [] })
  })

  it('takes the blockers back once the overrule is gone', () => {
    const w = ws({ reviews: [code('blockers')], overruled: over(['code']) })
    const { overruled: _gone, ...undone } = w
    expect(mergeBlock(undone as Workspace, info(), both, name)).toBe('The code review found 2 blockers on the latest commit. Merge anyway to go ahead.')
  })

  it('never counts as an approval for auto-merge', () => {
    const facts = { rules: { on: true, maxLines: 400, alwaysReview: [], withoutReview: false }, local: false, requireGreen: true, pr: info({ checks: [{ name: 'Test', state: 'pass' as const }] }), diff: { lines: 1, touched: [] } }
    const s = kindStates(ws({ reviews: [code('approved'), security('blockers', B, { optional: true })], overruled: over(['security']) }))
    expect(s).toMatchObject({ approved: ['code'], blocking: [], overruled: ['security'] })
    expect(autoMergeBlock({ ...facts, reviews: { required: ['code'], approved: s.approved, blocking: s.blocking, overruled: s.overruled, running: false } }))
      .toBe("The security review found blockers on the latest commit, and auto-merge doesn't merge past an overrule.")
  })
})

// KERNEL-467: a project with no GitHub merges its branches on the Mac, with git plumbing and a compare-and-swap on the base.

const git = (dir: string, ...args: string[]) => run('git', ['-C', dir, ...args])
const sha = async (dir: string, ref: string) => (await git(dir, 'rev-parse', ref)).trim()

/** Writes the files in `dir` and commits them. `author` sets who wrote the commit. */
async function commit(dir: string, files: Record<string, string>, message: string, author?: string) {
  for (const [f, c] of Object.entries(files)) await writeFile(join(dir, f), c)
  await git(dir, 'add', '-A')
  await run('git', ['-C', dir, 'commit', '-q', '-m', message], author ? { env: { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@t.dev` } } : {})
}

/**
 * A repo with `main` checked out in its folder, and `feat/x` in a worktree beside it with two commits: one changes a.txt and
 * one adds c.txt. `moved` puts one more commit on main, which changes b.txt, so the branch is one behind.
 */
async function repoWithBranch(o: { moved?: boolean } = {}) {
  const repo = await tempRepo({ 'a.txt': 'one\n', 'b.txt': 'two\n' })
  const wt = join(await mkdtemp(join(tmpdir(), 'kernel-wt-')), 'x')
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, 'main')
  await commit(wt, { 'a.txt': 'one!\n' }, 'feat: louder a', 'Kai')
  await commit(wt, { 'c.txt': 'three\n' }, 'feat: add c', 'Kai')
  if (o.moved) await commit(repo, { 'b.txt': 'two!\n' }, 'fix: b on main')
  return { repo, wt, main: await sha(repo, 'main'), head: await sha(repo, 'feat/x') }
}

/** The refusal a merge threw, so a test can check that nothing moved after it. */
async function refused(p: Promise<unknown>): Promise<LocalMergeError> {
  const e = await p.then(() => undefined, (e: unknown) => e)
  expect(e).toBeInstanceOf(LocalMergeError)
  return e as LocalMergeError
}

const reason = (e: LocalMergeError): Refusal => e.reason
const clean = async (dir: string) => (await git(dir, 'status', '--porcelain')).trim()

describe('reading a branch before a local merge', () => {
  it('counts ahead and behind, finds no conflict, and gives the diff stat and the clean checkout of the base', async () => {
    const { repo } = await repoWithBranch({ moved: true })
    const s = await localStatus(repo, 'feat/x', 'main')
    expect(s).toMatchObject({ base: 'main', ahead: 2, behind: 1, conflicts: [], stat: { files: 2, added: 2, removed: 1 } })
    expect(s.checkout).toEqual({ path: await realpath(repo), dirty: [] })
  })

  it('names the files that would conflict', async () => {
    const { repo } = await repoWithBranch()
    await commit(repo, { 'a.txt': 'uno\n' }, 'fix: a on main')
    expect((await localStatus(repo, 'feat/x', 'main')).conflicts).toEqual(['a.txt'])
  })

  it('merges into the local branch when the base is a remote ref', async () => {
    const { repo, wt } = await repoWithBranch()
    await git(repo, 'update-ref', 'refs/remotes/origin/main', 'main')
    expect((await localStatus(repo, 'feat/x', 'origin/main')).base).toBe('main')
    await expect(localStatus(wt, 'feat/x', 'origin/nope')).rejects.toThrow("Kernel merges into a branch in this repo, and origin/nope isn't one.")
  })
})

describe('the local merge, by method', () => {
  it('squashes the branch into one commit on the base, and fast-forwards the clean checkout of main', async () => {
    const { repo, main } = await repoWithBranch({ moved: true })
    const done = await localMerge({ repo, branch: 'feat/x', base: 'main', method: 'squash', title: 'Louder a, and c' })
    expect(done).toEqual({ sha: await sha(repo, 'main'), base: 'main' })
    expect((await git(repo, 'rev-list', '--parents', '-n', '1', 'main')).trim().split(' ').slice(1)).toEqual([main])
    expect(await git(repo, 'log', '-1', '--format=%B', 'main')).toBe('Louder a, and c\n\n* feat: louder a\n* feat: add c\n\n')
    // The folder with main checked out follows, with main's own change kept.
    expect(await readFile(join(repo, 'c.txt'), 'utf8')).toBe('three\n')
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one!\n')
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('two!\n')
    expect(await clean(repo)).toBe('')
  })

  it("keeps a single commit's own message when squashing it", async () => {
    const repo = await tempRepo({ 'a.txt': 'one\n' })
    await git(repo, 'branch', 'feat/y')
    const wt = join(await mkdtemp(join(tmpdir(), 'kernel-wt-')), 'y')
    await git(repo, 'worktree', 'add', '-q', wt, 'feat/y')
    await commit(wt, { 'a.txt': 'two\n' }, 'fix: two not one\n\nThe body stays.')
    await localMerge({ repo, branch: 'feat/y', base: 'main', method: 'squash', title: 'Ignored' })
    expect(await git(repo, 'log', '-1', '--format=%B', 'main')).toBe('fix: two not one\n\nThe body stays.\n\n')
  })

  it('makes a merge commit with the base and the branch as parents', async () => {
    const { repo, main, head } = await repoWithBranch({ moved: true })
    await localMerge({ repo, branch: 'feat/x', base: 'main', method: 'merge', title: 'Louder a, and c' })
    expect((await git(repo, 'rev-list', '--parents', '-n', '1', 'main')).trim().split(' ').slice(1)).toEqual([main, head])
    expect(await git(repo, 'log', '-1', '--format=%B', 'main')).toBe("Merge branch 'feat/x' into main\n\nLouder a, and c\n\n")
    expect(await readFile(join(repo, 'c.txt'), 'utf8')).toBe('three\n')
    expect(await clean(repo)).toBe('')
  })

  it('rebases each commit onto the moved base, keeping its author and message', async () => {
    const { repo, main, head } = await repoWithBranch({ moved: true })
    const done = await localMerge({ repo, branch: 'feat/x', base: 'main', method: 'rebase' })
    expect(done.sha).not.toBe(head)
    expect(await sha(repo, 'main~2')).toBe(main)
    expect((await git(repo, 'log', '--format=%an|%s', `${main}..main`)).trim().split('\n')).toEqual(['Kai|feat: add c', 'Kai|feat: louder a'])
    expect((await git(repo, 'rev-list', '--merges', `${main}..main`)).trim()).toBe('')
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('two!\n')
    expect(await clean(repo)).toBe('')
  })

  it('fast-forwards a rebase onto a base that never moved, so the commits stay the same', async () => {
    const { repo, head } = await repoWithBranch()
    expect(await localMerge({ repo, branch: 'feat/x', base: 'main', method: 'rebase' })).toEqual({ sha: head, base: 'main' })
    expect(await sha(repo, 'main')).toBe(head)
  })

  it('stops a rebase at the commit that conflicts, even when the branch as a whole merges cleanly', async () => {
    const { repo, wt } = await repoWithBranch()
    // The branch changes a.txt and changes it back, so as a whole it leaves a.txt alone. main changes the same line.
    await commit(wt, { 'a.txt': 'one\n' }, 'revert: quiet a')
    await commit(repo, { 'a.txt': 'uno\n' }, 'fix: a on main')
    const main = await sha(repo, 'main')
    expect((await localStatus(repo, 'feat/x', 'main')).conflicts).toEqual([])
    const e = await refused(localMerge({ repo, branch: 'feat/x', base: 'main', method: 'rebase' }))
    expect(reason(e)).toBe('conflict')
    expect(e.message).toMatch(/^Rebasing onto main would conflict at [0-9a-f]{7} \(feat: louder a\) in a\.txt\. Nothing was merged\.$/)
    expect(await sha(repo, 'main')).toBe(main)
  })

  it('moves only the branch when no folder has the base checked out', async () => {
    const { repo } = await repoWithBranch({ moved: true })
    await git(repo, 'checkout', '-q', '-b', 'other')
    const done = await localMerge({ repo, branch: 'feat/x', base: 'main', method: 'squash' })
    expect(await sha(repo, 'main')).toBe(done.sha)
    expect(await sha(repo, 'HEAD')).not.toBe(done.sha)
    expect(await clean(repo)).toBe('')
  })
})

describe('what stops a local merge', () => {
  it('refuses while the checkout of the base has uncommitted changes, and leaves them as they were', async () => {
    const { repo, main } = await repoWithBranch({ moved: true })
    await writeFile(join(repo, 'b.txt'), 'mine\n')
    const e = await refused(localMerge({ repo, branch: 'feat/x', base: 'main', method: 'squash' }))
    expect(reason(e)).toBe('dirty')
    expect(e.files).toEqual(['b.txt'])
    expect(e.message).toBe(`The main checkout at ${await realpath(repo)} has uncommitted changes, so nothing was merged. Commit or stash b.txt there, then try again.`)
    expect(await sha(repo, 'main')).toBe(main)
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('mine\n')
    expect((await localStatus(repo, 'feat/x', 'main')).checkout?.dirty).toEqual([{ status: 'M', path: 'b.txt' }])
  })

  it('counts an untracked file only where the merge would write', async () => {
    const { repo } = await repoWithBranch()
    await writeFile(join(repo, 'notes.md'), 'scratch\n')
    expect((await localStatus(repo, 'feat/x', 'main')).checkout?.dirty).toEqual([])
    await writeFile(join(repo, 'c.txt'), 'in the way\n')
    expect((await localStatus(repo, 'feat/x', 'main')).checkout?.dirty).toEqual([{ status: '??', path: 'c.txt' }])
    expect(reason(await refused(localMerge({ repo, branch: 'feat/x', base: 'main', method: 'squash' })))).toBe('dirty')
    expect(await readFile(join(repo, 'c.txt'), 'utf8')).toBe('in the way\n')
  })

  it('refuses a branch that conflicts with the base, naming the files', async () => {
    const { repo } = await repoWithBranch()
    await commit(repo, { 'a.txt': 'uno\n' }, 'fix: a on main')
    const main = await sha(repo, 'main')
    for (const method of ['squash', 'merge', 'rebase'] as const) {
      const e = await refused(localMerge({ repo, branch: 'feat/x', base: 'main', method }))
      expect(reason(e)).toBe('conflict')
      expect(e.files).toEqual(['a.txt'])
      expect(e.message).toBe('Merging into main would conflict in 1 file: a.txt. Nothing was merged.')
    }
    expect(await sha(repo, 'main')).toBe(main)
    expect(await clean(repo)).toBe('')
  })

  it('refuses a branch with nothing the base lacks', async () => {
    const repo = await tempRepo()
    await git(repo, 'branch', 'feat/empty')
    expect(reason(await refused(localMerge({ repo, branch: 'feat/empty', base: 'main', method: 'squash' })))).toBe('empty')
  })

  it("lands nothing when the base moved after the merge was made, and keeps the base's new commit", async () => {
    const { repo } = await repoWithBranch()
    const p = await prepareMerge({ repo, branch: 'feat/x', base: 'main', method: 'squash' })
    await commit(repo, { 'b.txt': 'two, from someone else\n' }, 'fix: b meanwhile')
    const theirs = await sha(repo, 'main')
    const e = await refused(land(p))
    expect(reason(e)).toBe('moved')
    expect(e.message).toBe('main moved while Kernel was merging, so nothing was merged. Try again.')
    expect(await sha(repo, 'main')).toBe(theirs)
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('two, from someone else\n')
    expect(await clean(repo)).toBe('')
  })
})

describe('a local merge through the PR feature', () => {
  const kernels: Kernel[] = []
  afterEach(async () => { for (const k of kernels.splice(0)) await k.stop() })

  it("reads the branch as ready, merges it with the project's method, and marks the workspace merged", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { requireGreen: false } }))
    const k = new Kernel({ dataDir, home })
    kernels.push(k)
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const repo = await tempRepo({ 'README.md': '# shop\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.', '.kernel/settings.toml': '[pr]\nmerge_method = "merge"\n' })
    const project = await k.addProject(repo)
    k.store.saveProject({ ...project, host: 'local' })
    const ws = await setUp(k, (await k.workspaces.createWorkspace(project.id, { prompt: 'Build the cart', agentId: 'kai', title: 'Cart' })).id)
    await expect(k.prs.createPr(ws.id)).rejects.toThrow('This project merges on this Mac')
    await commit(ws.path, { 'cart.ts': 'export const cart = []\n' }, 'feat: cart')

    const ready = await k.prs.refreshPr(ws.id)
    expect(ready).toMatchObject({ prState: 'ready', prHead: await sha(repo, ws.branch) })
    expect(ready.prNumber).toBeUndefined()
    const info = await k.handlers()['pr.get']({ workspaceId: ws.id })
    expect(info?.local).toMatchObject({ ahead: 1, behind: 0, stat: { files: 1, added: 1, removed: 0 }, method: 'merge' })

    const merged = await k.prs.mergePr(ws.id)
    const main = await sha(repo, 'main')
    expect(merged).toMatchObject({ prState: 'merged', mergeCommit: main })
    expect(merged.mergedAt).toBeTypeOf('number')
    expect((await git(repo, 'rev-list', '--parents', '-n', '1', 'main')).trim().split(' ')).toHaveLength(3)
    expect(await readFile(join(repo, 'cart.ts'), 'utf8')).toBe('export const cart = []\n')
    const notes = k.store.items(k.store.chats(ws.id)[0].id).flatMap((i) => (i.kind === 'note' ? [i.text] : []))
    expect(notes).toContain(`Merged into main as ${main.slice(0, 7)}.`)
    // The branch still reads as ahead of main, and the workspace stays merged.
    expect((await k.prs.refreshPr(ws.id)).prState).toBe('merged')
    // The merged push archives the workspace, as a merge on GitHub does.
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.status).toBe('archived'), { timeout: 10_000, interval: 20 })
  })

  it('asks the agent to merge the base into a branch that fell behind it, and only then (KERNEL-478, KERNEL-886)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    kernels.push(k)
    await k.start()
    const sent: unknown[] = []
    k.sessions.send = async (_chat, parts) => { sent.push(parts); return { queued: false } }
    const repo = await tempRepo({ 'README.md': '# shop\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const project = await k.addProject(repo)
    const ws = await setUp(k, (await k.workspaces.createWorkspace(project.id, { prompt: 'Build the cart', agentId: 'kai', title: 'Cart' })).id)
    await commit(ws.path, { 'cart.ts': 'export const cart = []\n' }, 'feat: cart')
    // The brief the workspace started with went through the same stand-in.
    sent.length = 0

    // A project on GitHub has its own Update branch.
    await expect(k.prs.updateBranch(ws.id)).rejects.toThrow('Only a branch that merges on this Mac')
    k.store.saveProject({ ...project, host: 'local' })
    await expect(k.prs.updateBranch(ws.id)).rejects.toThrow('This branch is up to date with main.')
    expect(sent).toEqual([])

    await commit(repo, { 'b.txt': 'two\n' }, 'fix: b')
    await commit(repo, { 'c.txt': 'three\n' }, 'fix: c')
    await k.prs.updateBranch(ws.id)
    expect(sent).toEqual([[{ type: 'text', text: "main has 2 new commits that this branch doesn't have. Commit your work, run git merge main, resolve any conflicts and re-run the tests. Then say what you changed." }]])
    // The state stays ready: the band reads Behind from the read, and nothing claims the agent is resolving.
    expect(k.store.workspace(ws.id)?.prState).not.toBe('resolving')

    // Once the branch is on the remote, a rebase would need the force push the guard denies, so the merge is pushed as usual.
    const bare = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
    await run('git', ['init', '-q', '--bare', bare])
    await run('git', ['-C', repo, 'remote', 'add', 'origin', bare])
    await run('git', ['-C', ws.path, 'push', '-q', '-u', 'origin', 'HEAD'])
    sent.length = 0
    await k.prs.updateBranch(ws.id)
    expect(sent).toEqual([[{ type: 'text', text: "main has 2 new commits that this branch doesn't have. Commit your work, run git merge main, resolve any conflicts, re-run the tests and push as usual. The branch is on origin, so merge rather than rebase. Then say what you changed." }]])
  })
})

describe("the project's merge method (KERNEL-468)", () => {
  const kernels: Kernel[] = []
  afterEach(async () => { for (const k of kernels.splice(0)) await k.stop() })

  async function kernel() {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { requireGreen: false } }))
    const k = new Kernel({ dataDir, home })
    kernels.push(k)
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    return k
  }

  /** A project whose repo has `files`, with a workspace per title, each with a PR that reads ready. */
  async function project(k: Kernel, titles: string[], files: Record<string, string> = {}) {
    const r = await k.addProject(await tempRepo({ 'README.md': '# client\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Builds.\n---\nYou are Kai.', ...files }))
    const out: Workspace[] = []
    for (const title of titles) {
      const ws = await k.workspaces.createWorkspace(r.id, { prompt: title, agentId: 'kai', title })
      out.push(k.store.saveWorkspace({ ...ws, prState: 'ready', prNumber: 42 }))
    }
    return out
  }

  /** A GitHub stub whose repo allows `allowed`, or can't say when it is an error. `fail` makes the next merge fail. */
  function stub(k: Kernel, allowed: MergeMethod[] | Error) {
    const s = { merges: [] as string[], asked: 0, fail: false }
    k.github = {
      info: async (_cwd, _ref, workspaceId): Promise<PrInfo> => ({ workspaceId, number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state: 'ready', baseRef: 'main', checks: [], comments: [], conflicts: [] }),
      merge: async (_cwd, ref, method) => {
        if (s.fail) { s.fail = false; throw new Error('GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)') }
        s.merges.push(`${ref} ${method}`)
      },
      mergeMethods: async () => { s.asked++; if (allowed instanceof Error) throw allowed; return allowed },
      ready: async () => {},
      reopen: async () => {}
    }
    return s
  }

  it("takes the app's method when the repo allows it or the host can't say, else the first one the repo allows", () => {
    expect(allowedMethod('squash', ['squash', 'merge'])).toBe('squash')
    expect(allowedMethod('rebase', ['squash', 'rebase'])).toBe('rebase')
    expect(allowedMethod('squash', ['merge', 'rebase'])).toBe('merge')
    expect(allowedMethod('squash', ['rebase'])).toBe('rebase')
    expect(allowedMethod('merge', undefined)).toBe('merge')
    expect(allowedMethod('merge', [])).toBe('merge')
  })

  it('merges with a method the repo allows, asks the host once, and keeps the method for the toast', async () => {
    const k = await kernel()
    const gh = stub(k, ['merge', 'rebase'])
    const [a, b, c] = await project(k, ['Invoice table', 'Invoice filters', 'Invoice export'])
    await k.prs.mergePr(a.id)
    await k.prs.mergePr(b.id)
    expect(gh.merges).toEqual([`${a.branch} merge`, `${b.branch} merge`])
    expect(gh.asked).toBe(1)
    expect(k.store.workspace(a.id)?.mergedWith).toBe('merge')
    // Once the answer is old, the host is asked again.
    k.codeHost.allowedMs = 0
    await k.prs.mergePr(c.id)
    expect(gh.asked).toBe(2)
  })

  it("merges with the project's [pr] merge_method over the app's, without asking the host", async () => {
    const k = await kernel()
    const gh = stub(k, ['squash', 'merge', 'rebase'])
    const [ws] = await project(k, ['Invoice table'], { '.kernel/settings.toml': '[pr]\nmerge_method = "rebase"\n' })
    await k.prs.mergePr(ws.id)
    expect(gh.merges).toEqual([`${ws.branch} rebase`])
    expect(gh.asked).toBe(0)
    expect(k.store.workspace(ws.id)?.mergedWith).toBe('rebase')
  })

  it("gives a local project its [pr] merge_method, else the app's, without asking GitHub (KERNEL-467)", async () => {
    const k = await kernel()
    const gh = stub(k, ['merge'])
    const plain = await tempRepo()
    const own = await tempRepo({ '.kernel/settings.toml': '[pr]\nmerge_method = "rebase"\n' })
    expect(await k.codeHost.methodFor({ host: 'local', path: plain })).toBe('squash')
    expect(await k.codeHost.methodFor({ host: 'local', path: own })).toBe('rebase')
    // The same repo on GitHub follows what GitHub allows.
    expect(await k.codeHost.methodFor({ path: plain })).toBe('merge')
    expect(gh.asked).toBe(1)
  })

  it("uses the app's method when the host can't say, and asks again after a merge fails", async () => {
    const k = await kernel()
    const unread = stub(k, new Error('gh: Could not resolve to a Repository'))
    const [a, b] = await project(k, ['Invoice table', 'Invoice filters'])
    await k.prs.mergePr(a.id)
    expect(unread.merges).toEqual([`${a.branch} squash`])

    const gh = stub(k, ['merge'])
    gh.fail = true
    // The failed read wasn't kept, so this asks, and the failed merge makes the next one ask again.
    await expect(k.prs.mergePr(b.id)).rejects.toThrow('Merge commits are not allowed')
    await k.prs.mergePr(b.id)
    expect(gh.asked).toBe(2)
    expect(gh.merges).toEqual([`${b.branch} merge`])
  })

  // KERNEL-829: GitHub merges only the head Kernel checked, and a merge gh lost track of counts once GitHub reads it merged.
  describe('the merge call', () => {
    /** GitHub reads the PR at `A`, and merged once `merged` is set. `merge` stands in for gh's merge. */
    function host(k: Kernel, merge: (o: { head?: string }, gh: { merged: boolean }) => Promise<void>) {
      const gh = { merged: false, heads: [] as (string | undefined)[] }
      stub(k, ['squash'])
      k.github = {
        ...k.github,
        info: async (_cwd, _ref, workspaceId) => info({ workspaceId, head: A, state: gh.merged ? 'merged' : 'ready' }),
        merge: async (_cwd, _ref, _method, o = {}) => { gh.heads.push(o.head); await merge(o, gh) }
      }
      return gh
    }

    it("holds a person's Merge to the head GitHub read just before", async () => {
      const k = await kernel()
      const gh = host(k, async (_o, gh) => { gh.merged = true })
      const [ws] = await project(k, ['Invoice table'])
      expect((await k.prs.mergePr(ws.id)).prState).toBe('merged')
      expect(gh.heads).toEqual([A])
    })

    it('shows the Merge button no error when gh timed out after GitHub merged', async () => {
      const k = await kernel()
      host(k, async (_o, gh) => { gh.merged = true; throw new Error("gh pr merge --squash didn't finish in 60 seconds") })
      const [ws] = await project(k, ['Invoice table'])
      expect(await k.prs.mergePr(ws.id)).toMatchObject({ prState: 'merged', mergedWith: 'squash' })
    })

    it('still fails a merge that failed when GitHub has not merged it', async () => {
      const k = await kernel()
      host(k, async () => { throw new Error("gh pr merge --squash didn't finish in 60 seconds") })
      const [ws] = await project(k, ['Invoice table'])
      await expect(k.prs.mergePr(ws.id)).rejects.toThrow("didn't finish")
      expect(k.store.workspace(ws.id)?.prState).toBe('ready')
    })

    it('passes the head to gh pr merge, and reads a moved head as new commits', async () => {
      const bin = await mkdtemp(join(tmpdir(), 'kernel-gh-'))
      const log = join(bin, 'calls.log')
      // GitHub's answer to a merge whose expected head isn't the PR's.
      await writeFile(join(bin, 'gh'), ['#!/bin/sh', `echo "$*" >> "${log}"`, 'echo "GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)" >&2', 'exit 1', ''].join('\n'), { mode: 0o755 })
      vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
      try {
        await expect(prMerge(bin, 'squash', { ref: 'feat/table', head: A })).rejects.toThrow(HEAD_MOVED)
        // Without a head the error stays gh's own.
        await expect(prMerge(bin, 'squash', { ref: 'feat/table' })).rejects.toThrow('Head branch was modified')
      } finally { vi.unstubAllEnvs() }
      expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([`pr merge feat/table --squash --match-head-commit ${A}`, 'pr merge feat/table --squash'])
    })
  })
})
