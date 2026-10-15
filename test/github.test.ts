import { describe, expect, it } from 'vitest'
import type { PrInfo } from '@shared/types'
import {
  batchQuery, blockedOf, checksOf, fingerprintOf, ghCanPush, ghError, ghErrorKind, GitHubError, infoOf, matchesCheck, parseBatch, prNote, prQuery, prStateOf, readFailure, resolveFile,
  reviewsOf, type PrView, type RollupItem
} from '../src/main/services/github'
import { DEFAULT_SETTINGS, loadRepoSettings, prInstructions, saveRepoSettings } from '../src/main/services/settings'
import type { Workspace } from '@shared/types'
import type { ExecResult } from '../src/main/services/exec'
import { GITHUB_ERROR_PREFIX, githubErrorKind } from '@shared/githubError'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempRepo } from './helpers'

// KERNEL-388: PRs read in one GraphQL batch per repo, only the checks the repo requires decide a PR, GitHub's own merge
// verdict holds a ready one, and a read that fails is told apart from a PR that isn't there.

const run = (name: string, conclusion: string | null, isRequired?: boolean): RollupItem => ({ name, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion, ...(isRequired === undefined ? {} : { isRequired }) })
const view = (o: Partial<PrView> = {}): PrView => ({ number: 42, url: 'u', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, statusCheckRollup: [], ...o })

describe('the batch read', () => {
  it('asks for every PR by number in one query, each check saying whether that PR requires it, and the rate limit', () => {
    const q = batchQuery([42, 7])
    expect(q).toContain('rateLimit{cost remaining limit resetAt}')
    expect(q).toContain('p42: pullRequest(number:42)')
    expect(q).toContain('p7: pullRequest(number:7)')
    expect(q).toContain('isRequired(pullRequestNumber:42)')
    expect(q).toContain('isRequired(pullRequestNumber:7)')
    expect(q).toContain('mergeStateStatus')
    // Review comments are left to the full read of a PR that changed.
    expect(q).not.toContain('reviewThreads')
    expect(prQuery(42)).toContain('reviewThreads')
    expect(() => batchQuery([0])).toThrow()
    expect(() => batchQuery([1.5])).toThrow()
  })

  it('reads the PRs GitHub found by number, flattens their checks, and keeps the rate limit', () => {
    const node = (number: number, contexts: unknown[]) => ({ number, url: `u${number}`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', reviewDecision: null, headRefOid: 'h', updatedAt: 't', baseRefName: 'main', commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] } })
    const json = {
      data: {
        rateLimit: { cost: 1, remaining: 4100, limit: 5000, resetAt: '2026-10-11T09:00:00Z' },
        repository: { p42: node(42, [{ __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: false }]), p7: node(7, []), p999: null }
      },
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'p999'] }]
    }
    const { views, rate } = parseBatch(json)
    expect([...views.keys()]).toEqual([42, 7])
    expect(views.get(42)?.statusCheckRollup).toEqual([{ __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: false }])
    expect(views.get(42)).not.toHaveProperty('commits')
    expect(views.get(7)?.statusCheckRollup).toEqual([])
    expect(rate).toEqual({ remaining: 4100, limit: 5000, resetAt: Date.parse('2026-10-11T09:00:00Z'), cost: 1 })
    expect(parseBatch(null)).toEqual({ views: new Map() })
  })
})

describe('review threads (KERNEL-564)', () => {
  it("reads each thread's id with its comment, so the agent can reply in the thread", () => {
    expect(prQuery(42)).toContain('reviewThreads(first:100){nodes{id isResolved')
    const comment = { id: 'c1', body: 'Rename it.', authorAssociation: 'MEMBER', author: { login: 'theo' } }
    expect(reviewsOf({
      reviewThreads: { nodes: [{ id: 'PRRT_kw1', isResolved: false, path: 'src/a.ts', line: 3, comments: { nodes: [comment] } }, { isResolved: false, path: 'src/b.ts', line: 1, comments: { nodes: [{ ...comment, id: 'c2' }] } }] },
      latestReviews: { nodes: [{ id: 'r1', state: 'CHANGES_REQUESTED', body: 'Two things.', authorAssociation: 'MEMBER', author: { login: 'theo' } }] }
    })).toEqual([
      // A review's own body has no thread.
      { id: 'r1', author: 'theo', body: 'Two things.', resolved: false, association: 'trusted' },
      { id: 'c1', author: 'theo', path: 'src/a.ts', line: 3, body: 'Rename it.', resolved: false, association: 'trusted', threadId: 'PRRT_kw1' },
      { id: 'c2', author: 'theo', path: 'src/b.ts', line: 1, body: 'Rename it.', resolved: false, association: 'trusted' }
    ])
  })
})

describe('a failed read', () => {
  const r = (stderr: string, o: { code?: number; stdout?: string; timedOut?: boolean } = {}) => readFailure({ code: o.code ?? 1, stdout: o.stdout ?? '', stderr, ...(o.timedOut ? { timedOut: true } : {}) })

  it('means there is no PR when gh says so, or there is no GitHub repo or gh at all', () => {
    expect(r('no pull requests found for branch "feat/x"')).toBe('none')
    expect(r('GraphQL: Could not resolve to a PullRequest with the number of 999999.')).toBe('none')
    expect(r('failed to run git: fatal: not a git repository (or any of the parent directories): .git')).toBe('none')
    expect(r('none of the git remotes configured for this repository point to a known GitHub host')).toBe('none')
    expect(r('', { code: 127 })).toBe('none')
  })

  it("tells GitHub's rate limits apart from any other failure, which changes no PR's state", () => {
    const primary = r('GraphQL: API rate limit exceeded for user ID 1.')
    expect(primary).toMatchObject({ rateLimited: true, secondary: false })
    expect(r('', { stdout: '{"errors":[{"type":"RATE_LIMITED"}]}' })).toMatchObject({ rateLimited: true })
    expect(r('You have exceeded a secondary rate limit. Please wait a few minutes before you try again.')).toMatchObject({ rateLimited: true, secondary: true })
    expect(r('error connecting to api.github.com')).toMatchObject({ rateLimited: false, message: 'error connecting to api.github.com' })
    expect(r('To get started with GitHub CLI, please run:  gh auth login')).toMatchObject({ rateLimited: false })
    expect(r('', { timedOut: true })).toMatchObject({ message: 'gh timed out.' })
  })
})

// KERNEL-861: what gh really prints for each kind of failure, so a screen can say what to do next.
const GH_SAYS = {
  signedOut: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
  badToken: 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login\n',
  noRepo: "GraphQL: Could not resolve to a Repository with the name 'acme/gone'. (repository)\n",
  notFound: 'gh: Not Found (HTTP 404)\n',
  noAccess: 'HTTP 403: Resource not accessible by personal access token (https://api.github.com/repos/acme/app)\n',
  rateLimit: 'GraphQL: API rate limit already exceeded for user ID 1234567.\n',
  restRateLimit: 'HTTP 403: API rate limit exceeded for user ID 1234567. If you reach out to GitHub Support for help, please include the request ID 1:2:3.\n',
  secondary: 'HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.\n',
  offline: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n',
  noHost: 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host\n',
  outage: 'HTTP 502: Server Error (https://api.github.com/graphql)\n'
}

describe('the kind of a GitHub failure (KERNEL-861)', () => {
  const failed = (stderr: string, o: Partial<ExecResult> = {}): ExecResult => ({ code: 1, stdout: '', stderr, ...o })

  it("reads each kind from what gh prints", () => {
    expect(ghErrorKind(failed(GH_SAYS.signedOut, { code: 4 }))).toBe('signed-out')
    expect(ghErrorKind(failed(GH_SAYS.badToken))).toBe('signed-out')
    expect(ghErrorKind(failed(GH_SAYS.noRepo))).toBe('not-found')
    expect(ghErrorKind(failed(GH_SAYS.notFound))).toBe('not-found')
    expect(ghErrorKind(failed(GH_SAYS.noAccess))).toBe('not-found')
    expect(ghErrorKind(failed(GH_SAYS.rateLimit))).toBe('rate-limited')
    expect(ghErrorKind(failed(GH_SAYS.restRateLimit))).toBe('rate-limited')
    expect(ghErrorKind(failed(GH_SAYS.secondary))).toBe('rate-limited')
    expect(ghErrorKind(failed(GH_SAYS.offline))).toBe('offline')
    expect(ghErrorKind(failed(GH_SAYS.noHost))).toBe('offline')
    expect(ghErrorKind(failed('', { timedOut: true }))).toBe('offline')
    expect(ghErrorKind(failed(GH_SAYS.outage))).toBe('other')
    expect(ghErrorKind(failed('', { code: 127 }))).toBe('other')
  })

  it('gives a failed PR read its kind, rate limits included', () => {
    const r = (stderr: string) => readFailure(failed(stderr))
    expect(r(GH_SAYS.offline)).toMatchObject({ kind: 'offline', rateLimited: false })
    expect(r(GH_SAYS.badToken)).toMatchObject({ kind: 'signed-out', rateLimited: false })
    expect(r(GH_SAYS.rateLimit)).toMatchObject({ kind: 'rate-limited', rateLimited: true })
    expect(r(GH_SAYS.secondary)).toMatchObject({ kind: 'rate-limited', secondary: true })
    expect(r(GH_SAYS.outage)).toMatchObject({ kind: 'other' })
  })

  it('carries the kind across IPC in the error name, and the text a person reads leaves it out', () => {
    const e = ghError(failed(GH_SAYS.signedOut, { code: 4 }), 'Could not list your repositories')
    expect(e).toBeInstanceOf(GitHubError)
    expect(e.kind).toBe('signed-out')
    // Electron passes the error's string, and the window's error wraps it.
    const got = new Error(`Error invoking remote method 'github.repos': ${String(e)}`)
    expect(githubErrorKind(got)).toBe('signed-out')
    expect(got.message.replace(/^Error invoking remote method '[^']+': /, '').replace(GITHUB_ERROR_PREFIX, '')).toBe("The GitHub CLI isn't signed in. Run gh auth login in a terminal.")
    expect(githubErrorKind(new Error("Error invoking remote method 'github.repos': Error: no"))).toBeUndefined()
    expect(ghError(failed(GH_SAYS.noRepo), 'Could not list your repositories').message).toBe("Could not list your repositories: GraphQL: Could not resolve to a Repository with the name 'acme/gone'. (repository)")
    expect(ghError(failed('', { timedOut: true }), 'Could not list your repositories')).toMatchObject({ kind: 'offline', message: 'GitHub took too long to answer. Try again.' })
  })
})

describe('the checks that decide a PR', () => {
  it("marks every check the repo doesn't require as optional, once it requires some", () => {
    expect(checksOf([run('Release note', 'SUCCESS', true), run('Test', 'FAILURE', false)])).toEqual([
      { name: 'Release note', state: 'pass' },
      { name: 'Test', state: 'fail', optional: true }
    ])
  })

  it("counts every check in a repo that requires none, except those the project's optional_checks names", () => {
    expect(checksOf([run('Test', 'FAILURE', false), run('Vercel – web', null, false)]).some((c) => c.optional)).toBe(false)
    expect(checksOf([run('Test', 'FAILURE', false), run('Vercel – web', null, false)], ['vercel*'])).toEqual([
      { name: 'Test', state: 'fail' },
      { name: 'Vercel – web', state: 'running', optional: true }
    ])
    // A check the repo requires always counts.
    expect(checksOf([run('Vercel', 'FAILURE', true)], ['Vercel'])).toEqual([{ name: 'Vercel', state: 'fail' }])
  })

  it('matches project patterns whole, without case, with * for any run of characters', () => {
    expect(matchesCheck(['Vercel*'], 'vercel preview comments')).toBe(true)
    expect(matchesCheck(['Vercel'], 'Vercel preview')).toBe(false)
    expect(matchesCheck(['*coverage*'], 'codecov/coverage (patch)')).toBe(true)
    expect(matchesCheck(['a.b'], 'axb')).toBe(false)
    expect(matchesCheck(['', '  '], 'Test')).toBe(false)
  })
})

describe('the PR state', () => {
  const cases: [string, Partial<PrView>, ReturnType<typeof prStateOf>, ReturnType<typeof blockedOf>][] = [
    ['merges cleanly', {}, 'ready', undefined],
    ['conflicts, by mergeStateStatus', { mergeStateStatus: 'DIRTY', mergeable: 'MERGEABLE' }, 'conflict', undefined],
    ['fails a check the repo does not require', { mergeStateStatus: 'UNSTABLE', statusCheckRollup: [run('Release note', 'SUCCESS', true), run('Test', 'FAILURE', false)] }, 'ready', undefined],
    ['fails a required check', { mergeStateStatus: 'BLOCKED', statusCheckRollup: [run('Release note', 'FAILURE', true), run('Test', 'SUCCESS', false)] }, 'cifail', undefined],
    // KERNEL-703: a check the repo doesn't require holds ready while it runs, though its failure doesn't.
    ['still runs an optional check', { mergeStateStatus: 'UNSTABLE', statusCheckRollup: [run('Release note', 'SUCCESS', true), run('Test', null, false)] }, 'checks', undefined],
    ['still runs an optional check with changes requested', { mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [run('Release note', 'SUCCESS', true), run('Test', null, false)] }, 'changes', undefined],
    ['still runs a required check', { mergeStateStatus: 'BLOCKED', statusCheckRollup: [run('Release note', null, true)] }, 'checks', undefined],
    ['fails a check in a repo that requires none', { mergeStateStatus: 'UNSTABLE', statusCheckRollup: [run('Test', 'FAILURE', false)] }, 'cifail', undefined],
    ['waits for a required review', { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, 'ready', 'review'],
    ['is behind its base under the up to date rule', { mergeStateStatus: 'BEHIND' }, 'ready', 'behind'],
    ['is blocked by another rule', { mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' }, 'ready', 'rules'],
    ['is still being checked for conflicts', { mergeStateStatus: 'UNKNOWN' }, 'checks', undefined],
    ['comes from a GitHub that reports no verdict', { mergeStateStatus: undefined }, 'ready', undefined],
    ['has changes requested', { mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' }, 'changes', undefined]
  ]
  it.each(cases)('reads a PR that %s', (_label, o, state, blocked) => {
    const v = view(o)
    expect(prStateOf(v)).toBe(state)
    expect(blockedOf(v, prStateOf(v))).toBe(blocked)
    expect(infoOf('w', v, [], []).blocked).toBe(blocked)
  })

  it("reads a check the project's optional_checks names as not deciding the PR", () => {
    const v = view({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: [run('Vercel', 'FAILURE', false)] })
    expect(prStateOf(v)).toBe('cifail')
    expect(prStateOf(v, { optional: ['Vercel'] })).toBe('ready')
    expect(prStateOf(view({ statusCheckRollup: [run('Vercel', null, false)] }), { optional: ['Vercel'] })).toBe('checks')
    expect(infoOf('w', v, [], [], { optional: ['Vercel'] })).toMatchObject({ state: 'ready', checks: [{ name: 'Vercel', state: 'fail', optional: true }] })
  })

  it('keeps when GitHub last saw the PR change', () => {
    expect(infoOf('w', view({ updatedAt: '2026-10-11T08:00:00Z' }), [], []).updatedAt).toBe('2026-10-11T08:00:00Z')
    expect(infoOf('w', view(), [], [])).not.toHaveProperty('updatedAt')
  })
})

describe('the fingerprint a poll compares', () => {
  const base = infoOf('w', view({ headRefOid: 'a', updatedAt: 't1', statusCheckRollup: [run('Test', null)] }), [], [])

  it('is the same for the same read, whatever the comments, conflicting files or check durations', () => {
    const again: PrInfo = { ...base, comments: [{ id: 'c', author: 'theo', body: 'x', resolved: false }], conflicts: ['a.ts'], workspaceId: 'other', checks: base.checks.map((c) => ({ ...c, meta: '12s' })) }
    expect(fingerprintOf(again)).toBe(fingerprintOf(base))
  })

  it('changes with a check, a new head, a new comment or a change of state', () => {
    const fp = fingerprintOf(base)
    expect(fingerprintOf({ ...base, checks: [{ name: 'Test', state: 'pass' }] })).not.toBe(fp)
    expect(fingerprintOf({ ...base, checks: [{ name: 'Test', state: 'running', optional: true }] })).not.toBe(fp)
    expect(fingerprintOf({ ...base, head: 'b' })).not.toBe(fp)
    expect(fingerprintOf({ ...base, updatedAt: 't2' })).not.toBe(fp)
    expect(fingerprintOf({ ...base, conflictsUnknown: true })).not.toBe(fp)
    expect(fingerprintOf({ ...base, blocked: 'review' })).not.toBe(fp)
  })
})

describe('what Kernel tells the agent about failed checks', () => {
  const ws = { prNumber: 42, prState: 'cifail', baseRef: 'origin/main' } as Workspace
  const info = (checks: PrInfo['checks']): PrInfo => ({ workspaceId: 'w', number: 42, url: 'u', title: 't', state: 'cifail', baseRef: 'main', checks, comments: [], conflicts: [] })

  it('names only the failing checks that decide the PR', () => {
    const checks: PrInfo['checks'] = [{ name: 'Release note', state: 'fail', url: 'r' }, { name: 'Vercel', state: 'fail', optional: true }]
    expect(prNote(ws, info(checks))).toBe('Release note failed on the PR.')
    const [, text] = resolveFile('cifail', prInstructions(DEFAULT_SETTINGS('').pr), info(checks))
    expect(text).toContain('- Release note r')
    expect(text).not.toContain('Vercel')
  })
})

describe("the project's optional_checks", () => {
  it('reads a list of names from either settings file, the personal one winning, and keeps it when Settings saves other keys', async () => {
    const repo = await tempRepo()
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[pr]\noptional_checks = ["Vercel*", 3]\ncreate_instructions = "Open it"\n')
    expect((await loadRepoSettings(repo)).pr).toEqual({ optionalChecks: ['Vercel*'], createInstructions: 'Open it' })
    expect((await loadRepoSettings(repo)).sources['pr.optionalChecks']).toBe('shared')
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[pr]\noptional_checks = ["codecov*"]\n')
    expect((await loadRepoSettings(repo)).pr?.optionalChecks).toEqual(['codecov*'])
    expect((await loadRepoSettings(repo)).sources['pr.optionalChecks']).toBe('override')
    const after = await saveRepoSettings(repo, { pr: { resolveInstructions: 'Rebase first' } }, true)
    expect(after.pr).toMatchObject({ optionalChecks: ['codecov*'], resolveInstructions: 'Rebase first' })
    expect((await loadRepoSettings(repo)).pr?.optionalChecks).toEqual(['codecov*'])
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '')
    expect((await loadRepoSettings(repo)).pr?.optionalChecks).toEqual(['Vercel*'])
  })
})

describe("gh's push permission (KERNEL-460)", () => {
  const answer = (r: Partial<ExecResult>) => {
    const calls: string[][] = []
    const cmd = async (c: string, args: string[]): Promise<ExecResult> => { calls.push([c, ...args]); return { code: 0, stdout: '', stderr: '', ...r } }
    return { cmd, calls }
  }
  it("reads the repo's permissions.push for gh's login", async () => {
    const yes = answer({ stdout: 'true\n' })
    expect(await ghCanPush('acme/app', yes.cmd)).toBe(true)
    expect(yes.calls).toEqual([['gh', 'api', 'repos/acme/app', '--jq', '.permissions.push']])
    expect(await ghCanPush('acme/app', answer({ stdout: 'false\n' }).cmd)).toBe(false)
  })
  it("tells a repo gh can't see from a question gh couldn't answer", async () => {
    expect(await ghCanPush('acme/gone', answer({ code: 1, stderr: 'gh: Not Found (HTTP 404)\n' }).cmd)).toBeNull()
    expect(await ghCanPush('acme/app', answer({ code: 1, stderr: 'error connecting to api.github.com\n' }).cmd)).toBeUndefined()
    expect(await ghCanPush('acme/app', answer({ code: 127, stderr: 'spawn gh ENOENT' }).cmd)).toBeUndefined()
    // Signed out, GitHub sends no permissions at all.
    expect(await ghCanPush('acme/app', answer({ stdout: '\n' }).cmd)).toBeUndefined()
  })
})
