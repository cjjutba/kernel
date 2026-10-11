import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MergeMethod, PrInfo, PrState, Workspace } from '@shared/types'
import { blockedText, gatingChecks, mergeBlock, mergeNeedsPr, reviewVerdicts } from '@shared/merge'
import { Kernel } from '../src/main/kernel'
import { allowedMethod } from '../src/main/features/codeHost'
import { tempRepo } from './helpers'

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

describe("the repo's own rules (KERNEL-388)", () => {
  const green = { requireGreen: true, requireReviewer: false }

  it("counts only the checks that decide the PR, so a failing optional check doesn't hold the merge", () => {
    const checks: PrInfo['checks'] = [{ name: 'Release note', state: 'pass' }, { name: 'Test', state: 'fail', optional: true }, { name: 'Vercel', state: 'running', optional: true }]
    expect(gatingChecks(checks)).toEqual([{ name: 'Release note', state: 'pass' }])
    expect(mergeBlock(ws(), info({ checks }), green)).toBeUndefined()
    expect(mergeBlock(ws(), info({ checks: [{ name: 'Release note', state: 'running' }, ...checks.slice(1)] }), green)).toContain('Checks have not passed yet')
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

describe("the room's merge method (KERNEL-468)", () => {
  const kernels: Kernel[] = []
  afterEach(async () => { for (const k of kernels.splice(0)) await k.stop() })

  async function kernel() {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { requireGreen: false } }))
    const k = new Kernel({ dataDir, home })
    kernels.push(k)
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    return k
  }

  /** A room whose repo has `files`, with a workspace per title, each with a PR that reads ready. */
  async function room(k: Kernel, titles: string[], files: Record<string, string> = {}) {
    const r = await k.addRoom(await tempRepo({ 'README.md': '# client\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Builds.\n---\nYou are Kai.', ...files }))
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
    const [a, b, c] = await room(k, ['Invoice table', 'Invoice filters', 'Invoice export'])
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

  it("merges with the room's [pr] merge_method over the app's, without asking the host", async () => {
    const k = await kernel()
    const gh = stub(k, ['squash', 'merge', 'rebase'])
    const [ws] = await room(k, ['Invoice table'], { '.kernel/settings.toml': '[pr]\nmerge_method = "rebase"\n' })
    await k.prs.mergePr(ws.id)
    expect(gh.merges).toEqual([`${ws.branch} rebase`])
    expect(gh.asked).toBe(0)
    expect(k.store.workspace(ws.id)?.mergedWith).toBe('rebase')
  })

  it("uses the app's method when the host can't say, and asks again after a merge fails", async () => {
    const k = await kernel()
    const unread = stub(k, new Error('gh: Could not resolve to a Repository'))
    const [a, b] = await room(k, ['Invoice table', 'Invoice filters'])
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
})
