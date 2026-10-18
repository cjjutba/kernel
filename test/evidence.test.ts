import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Approval, PrInfo, ReviewVerdict, Workspace } from '../src/shared/types'
import { run } from '../src/main/services/exec'
import { Kernel } from '../src/main/kernel'
import { chmod } from 'node:fs/promises'
import { prComment } from '../src/main/services/github'
import { freePort, tempRepo } from './helpers'

const CRITERIA = ['The Export CSV check passes', 'invoice.ts totals include tax', 'The empty state shows a message']

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt') }))
  const k = new Kernel({ dataDir: dir, home })
  await k.start()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  const repo = await tempRepo()
  await run('git', ['-C', repo, 'checkout', '-q', '-b', 'feat/export'])
  await run('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'])
  await writeFile(join(repo, 'invoice.ts'), 'export const total = 1\n')
  await run('git', ['-C', repo, 'add', '-A'])
  await run('git', ['-C', repo, 'commit', '-q', '-m', 'invoice'])
  const head = async () => (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).trim()
  k.store.saveProject({ id: 'p', name: 'P', path: repo, defaultBranch: 'main', paused: false, createdAt: 1 })
  const ws = (extra: Partial<Workspace> = {}) => k.store.saveWorkspace({ id: 'w1', projectId: 'p', name: 'w1', branch: 'feat/export', baseRef: 'main', path: repo, mode: 'worktree', agentId: 'sean', port: 1, status: 'ready', prState: 'checks', prNumber: 7, createdAt: 1, ...extra } as Workspace)
  ws()
  const approval = (id: string, extra: Partial<Approval> = {}): Approval => ({ id, kind: 'tool', source: 'sdk', projectId: 'p', toolName: 'Bash', title: 'Run it', status: 'allowed', createdAt: 2, ...extra })
  k.store.saveApproval(approval('plan', { kind: 'plan', toolName: undefined, steps: [{ title: 'Export invoices', criteria: [{ text: CRITERIA[0], check: 'Export CSV' }, ...CRITERIA.slice(1)], workspaceId: 'w1' }] }))
  const comments = new Map<string, string>()
  const calls: { id?: string }[] = []
  k.github = {
    ...k.github,
    comment: async (_cwd, _ref, body, o) => {
      calls.push({ id: o.id })
      const id = o.id ?? (comments.size ? [...comments.keys()][0] : `c${comments.size + 1}`)
      comments.set(id, body)
      return { id, url: `https://github.test/pr/7#issuecomment-${id}` }
    }
  }
  const info = async (checks: PrInfo['checks'] = [], extra: Partial<PrInfo> = {}): Promise<PrInfo> => ({ workspaceId: 'w1', number: 7, url: 'u', title: 't', state: 'checks', baseRef: 'main', checks, comments: [], conflicts: [], head: await head(), ...extra })
  return { k, repo, ws, head, info, comments, calls, approval }
}

const status = (e: Awaited<ReturnType<Kernel['evidence']['update']>>) => e?.criteria.map((c) => c.status)
const verdict = (sha: string, criteria: ReviewVerdict['criteria']): ReviewVerdict => ({ workspaceId: 'r1', agentId: 'rev', verdict: 'approved', summary: 'ok', sha, prNumber: 7, criteria, ts: 5 })

describe('evidence against each criterion (KERNEL-1065)', () => {
  it('leaves every criterion unverified until a real event links it, and an agent saying done changes nothing', async () => {
    const t = await boot()
    const e = await t.k.evidence.update(await t.info())
    expect(status(e)).toEqual(['unverified', 'unverified', 'unverified'])
    expect(e?.criteria.every((c) => c.links.length === 0 || c.links.every((l) => l.effect === 'context'))).toBe(true)
    // The file the second criterion names is shown as context, and never decides it.
    expect(e?.criteria[1].links).toMatchObject([{ source: 'files', effect: 'context' }])
    expect(e?.run.files).toEqual(['invoice.ts'])
  })

  it('passes on a CI check the criterion names, and fails on the same check failing', async () => {
    const t = await boot()
    expect(status(await t.k.evidence.update(await t.info([{ name: 'Export CSV', state: 'pass' }])))).toEqual(['passed', 'unverified', 'unverified'])
    const failed = await t.k.evidence.update(await t.info([{ name: 'Export CSV', state: 'fail', url: 'https://ci/1' }]))
    expect(status(failed)).toEqual(['failed', 'unverified', 'unverified'])
    expect(failed?.criteria[0].links).toMatchObject([{ source: 'check', effect: 'contradicts', url: 'https://ci/1' }])
    // A running check, or one the plan did not name, decides nothing. Test names are never guessed from commands.
    expect(status(await t.k.evidence.update(await t.info([{ name: 'Export CSV', state: 'running' }, { name: 'vitest', state: 'pass' }])))).toEqual(['unverified', 'unverified', 'unverified'])
  })

  it('lets only the check the plan named decide, not a check the criterion text mentions (KERNEL-1069)', async () => {
    const t = await boot()
    t.k.store.saveApproval(t.approval('plan', { kind: 'plan', toolName: undefined, steps: [{
      title: 'Slugify',
      criteria: ['test/ has node:test cases covering mixed case and an empty input', { text: 'npm test passes and the test check is green', check: 'test' }, { text: 'Lint is clean', check: 'lint' }],
      workspaceId: 'w1'
    }] }))
    const e = await t.k.evidence.update(await t.info([{ name: 'test', state: 'pass' }]))
    // The first mentions node:test and the test check, but names none: the green check is context only.
    expect(e?.criteria[0]).toMatchObject({ status: 'unverified', links: [{ source: 'check', effect: 'context' }] })
    expect(e?.criteria[1]).toMatchObject({ status: 'passed', links: [{ source: 'check', effect: 'supports' }] })
    // A named check that has not run leaves the criterion unverified.
    expect(e?.criteria[2]).toMatchObject({ status: 'unverified', links: [] })
    const failed = await t.k.evidence.update(await t.info([{ name: 'Test', state: 'fail' }]))
    expect(status(failed)).toEqual(['unverified', 'failed', 'unverified'])
  })

  it('shows reviewer-only support as its own state, in the comment too (KERNEL-1069)', async () => {
    const t = await boot()
    t.k.settings.pr.evidenceComment = true
    t.ws({ reviews: [verdict(await t.head(), [{ index: 1, met: true }])] })
    const e = await t.k.evidence.update(await t.info())
    expect(status(e)).toEqual(['unverified', 'reviewer-met', 'unverified'])
    const body = [...t.comments.values()][0]
    expect(body).toMatch(/\*\*Reviewer says met\*\*: invoice\.ts totals include tax/)
    expect(body).not.toMatch(/\*\*Passed\*\*: invoice/)
  })

  it('loads a plan saved with plain string criteria, and numbers the reviewer\'s brief from 1 (KERNEL-1069)', async () => {
    const t = await boot()
    t.k.store.saveApproval(t.approval('plan', { kind: 'plan', toolName: undefined, steps: [{ title: 'Old plan', criteria: ['First thing', 'Second thing'], workspaceId: 'w1' }] }))
    expect(status(await t.k.evidence.update(await t.info([{ name: 'First thing', state: 'pass' }])))).toEqual(['unverified', 'unverified'])
    const brief = (t.k.reviews as unknown as { brief(ws: Workspace, kind: string): string }).brief(t.k.store.workspace('w1')!, 'code')
    expect(brief).toContain('numbered from 1')
    expect(brief).toContain('\n1. First thing\n2. Second thing')
    expect(brief).not.toContain('0. ')
  })

  it("labels the reviewer's judgment and lets it pass or fail a criterion", async () => {
    const t = await boot()
    const head = await t.head()
    t.ws({ reviews: [verdict(head, [{ index: 1, met: true, note: 'totals add tax' }, { index: 2, met: false }])] })
    const e = await t.k.evidence.update(await t.info())
    expect(status(e)).toEqual(['unverified', 'reviewer-met', 'failed'])
    expect(e?.criteria[1].links.find((l) => l.source === 'review')).toMatchObject({ judgedBy: 'reviewer', effect: 'supports' })
    expect(e?.criteria[1].links.find((l) => l.source === 'review')?.label).toMatch(/^Reviewer's judgment \(code\): met, totals add tax/)
  })

  it('lists approvals given during the run and images the agent shared, without deciding anything', async () => {
    const t = await boot()
    t.k.store.saveApproval(t.approval('a1', { workspaceId: 'w1' }))
    t.k.store.saveApproval(t.approval('a2', { workspaceId: 'w1', status: 'pending' }))
    t.k.store.saveSharedFile({ id: 's1', projectId: 'p', workspaceId: 'w1', agentId: 'sean', source: 'empty.png', title: 'Empty state', kind: 'image', createdAt: 1, updatedAt: 1,
      versions: [{ n: 1, at: 3, file: 'empty.png', mime: 'image/png', bytes: 1, sha256: 'x', note: 'criterion 3 looks right' }] })
    const e = await t.k.evidence.update(await t.info())
    expect(e?.run.approvals.map((a) => a.id)).toEqual(['a1'])
    expect(e?.run.images).toEqual([{ sharedId: 's1', version: 1, title: 'Empty state' }])
    expect(e?.criteria[2]).toMatchObject({ status: 'unverified', links: [{ source: 'image', effect: 'context' }] })
  })

  it('marks evidence from older commits stale when a new commit lands', async () => {
    const t = await boot()
    const old = await t.head()
    t.ws({ reviews: [verdict(old, [{ index: 1, met: true }])] })
    expect(status(await t.k.evidence.update(await t.info([{ name: 'Export CSV', state: 'pass' }])))).toEqual(['passed', 'reviewer-met', 'unverified'])

    await writeFile(join(t.repo, 'invoice.ts'), 'export const total = 2\n')
    await run('git', ['-C', t.repo, 'commit', '-qam', 'more'])
    const e = await t.k.evidence.update(await t.info([{ name: 'Export CSV', state: 'queued' }]))
    expect(status(e)).toEqual(['unverified', 'unverified', 'unverified'])
    expect(e?.criteria[0]).toMatchObject({ stale: true })
    expect(e?.criteria[0].links.find((l) => l.source === 'check' && l.commit === old)).toMatchObject({ stale: true, effect: 'supports' })
    expect(e?.criteria[1].links.find((l) => l.source === 'review')).toMatchObject({ stale: true })

    // The new head's own events count again, and the old ones stay stale.
    expect(status(await t.k.evidence.update(await t.info([{ name: 'Export CSV', state: 'pass' }])))).toEqual(['passed', 'unverified', 'unverified'])
  })

  it('keeps a verdict current when Kernel only brought the branch up to date with its base', async () => {
    const t = await boot()
    const from = await t.head()
    await writeFile(join(t.repo, 'merge.txt'), 'x')
    await run('git', ['-C', t.repo, 'add', '-A'])
    await run('git', ['-C', t.repo, 'commit', '-qm', 'merge base'])
    const to = await t.head()
    t.ws({ reviews: [verdict(from, [{ index: 1, met: true }])], baseUpdates: [{ from, to }] })
    expect(status(await t.k.evidence.update(await t.info()))).toEqual(['unverified', 'reviewer-met', 'unverified'])
  })

  it('posts nothing by default, and with the setting on two updates leave one comment', async () => {
    const t = await boot()
    await t.k.evidence.update(await t.info([{ name: 'Export CSV', state: 'pass' }]))
    expect(t.comments.size).toBe(0)

    t.k.settings.pr.evidenceComment = true
    await t.k.evidence.update(await t.info([{ name: 'Export CSV', state: 'fail' }]))
    await t.k.evidence.update(await t.info([{ name: 'Export CSV', state: 'pass' }]))
    expect(t.comments.size).toBe(1)
    expect(t.calls.map((c) => c.id)).toEqual([undefined, 'c1'])
    const body = [...t.comments.values()][0]
    expect(body).toContain('<!-- kernel-evidence -->')
    expect(body).toMatch(/\*\*Passed\*\*: The Export CSV check passes/)
    expect(body).not.toMatch(/[–—]/)
    // The same state again posts nothing.
    await t.k.evidence.update(await t.info([{ name: 'Export CSV', state: 'pass' }]))
    expect(t.calls).toHaveLength(2)
  })

  it('leaves one comment when two updates run at once', async () => {
    const t = await boot()
    t.k.settings.pr.evidenceComment = true
    const pass = await t.info([{ name: 'Export CSV', state: 'pass' }])
    const fail = await t.info([{ name: 'Export CSV', state: 'fail' }])
    await Promise.all([t.k.evidence.update(pass), t.k.evidence.update(fail)])
    expect(t.comments.size).toBe(1)
    expect(t.calls.filter((c) => !c.id)).toHaveLength(1)
  })

  it('keeps its links in the database and answers over IPC', async () => {
    const t = await boot()
    await t.k.evidence.update(await t.info([{ name: 'Export CSV', state: 'pass' }]))
    const saved = t.k.store.meta<{ links: unknown[] }>('evidence.w1')
    expect(saved?.links.length).toBeGreaterThan(0)
    expect(Object.keys(t.k.handlers())).toContain('evidence.pr')
  })
})

describe('the reviewer refers to criteria by number (KERNEL-1069)', () => {
  it('turns a 1-based number into the criterion index', async () => {
    const { reviewTools } = await import('../src/main/services/reviewMcp')
    const seen: unknown[] = []
    const [submit] = reviewTools({ submit: async (r) => { seen.push(r.criteria); return 'saved' } })
    await submit.handler({ verdict: 'approved', summary: 'ok', criteria: [{ number: 1, met: true }, { number: 3, met: false, note: 'n' }] } as never, {})
    expect(seen).toEqual([[{ index: 0, met: true }, { index: 2, met: false, note: 'n' }]])
  })
})

describe('the GitHub comment call (KERNEL-1065)', () => {
  it('posts when no comment carries the marker, and edits the one that does', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'kernel-gh-'))
    const log = join(bin, 'log')
    // A fake gh: the listing finds comment 41 only when FOUND is set, every call is logged.
    await writeFile(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> ${log}\ncase "$*" in\n *--paginate*) if [ -n "$FOUND" ]; then echo 41; fi;;\n *) printf '99\\thttps://github.test/c\\n';;\nesac\n`)
    await chmod(join(bin, 'gh'), 0o755)
    const old = process.env.PATH
    process.env.PATH = `${bin}:${old}`
    onTestFinished(() => { process.env.PATH = old; delete process.env.FOUND })
    const o = { marker: '<!-- kernel-evidence -->' }
    expect(await prComment(bin, '7', 'body', o)).toEqual({ id: '99', url: 'https://github.test/c' })
    process.env.FOUND = '1'
    await prComment(bin, '7', 'body', o)
    await prComment(bin, '7', 'body', { ...o, id: '55' })
    const lines = (await readFile(log, 'utf8')).trim().split('\n')
    expect(lines.filter((l) => l.includes('--method POST'))).toHaveLength(1)
    expect(lines.filter((l) => l.includes('--method PATCH')).map((l) => l.match(/comments\/(\d+)/)?.[1])).toEqual(['41', '55'])
  })
})
