import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ActivityEvent, Chat, PrCheck, PrInfo, ReviewKind, TeamUpdate, Workspace } from '@shared/types'
import { ALWAYS_REVIEW, autoMergeBlock, autoMergeRetry, autoMergeWhy, type AutoMergeFacts } from '@shared/merge'
import { Kernel } from '../src/main/kernel'
import { Prs } from '../src/main/features/prs'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { exec, git } from '../src/main/services/exec'
import { BranchConflict, HEAD_MOVED } from '../src/main/services/github'
import { applySettingsPatch, autoMergeInProject, DEFAULT_SETTINGS, loadAppSettings, sharedMergeOf } from '../src/main/services/settings'
import { decide, LeadUpdates, type TeamEvent } from '../src/main/services/leadUpdates'
import { tempRepo, freePort } from './helpers'

// KERNEL-556: Kernel merges a PR every review approved by itself, once the user turns auto-merge on for themselves.

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

const AGENTS = {
  'README.md': '# shop\n',
  '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.'
}
const ON = { pr: { autoMerge: { on: true } } }
const GREEN: PrCheck[] = [{ name: 'Test', state: 'pass' }]
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n'

/**
 * A project on a fake GitHub whose `main` holds `main` besides the agents, with the app's settings `app`. `pr` opens Christian's work on
 * a PR that passed `checks`, with the code review's approval of its head and the blockers of the kinds `blockers` names.
 */
async function setup(o: { app?: object; main?: Record<string, string>; local?: boolean } = {}) {
  const repo = await tempRepo({ ...AGENTS, ...o.main })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...(o.app ?? ON) }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  k.sessions.send = async () => ({ queued: false })
  const gh = { pr: null as PrInfo | null, merged: [] as string[], reads: 0, head: undefined as string | undefined }
  k.github = {
    info: async (_cwd, _ref, workspaceId) => { gh.reads++; return gh.pr ? { ...gh.pr, workspaceId, ...(gh.head ? { head: gh.head } : {}) } : null },
    merge: async (_cwd, _ref, method) => { gh.merged.push(method); if (gh.pr) gh.pr = { ...gh.pr, state: 'merged' } },
    ready: async () => undefined,
    reopen: async () => undefined
  }
  let project = await k.addProject(repo)
  if (o.local) project = k.store.saveProject({ ...project, host: 'local' })
  const buildChat = async () => {
    const c = await k.lead.newLeadChat(project.id, { prompt: '' })
    await vi.waitFor(() => expect(k.store.workspace(k.store.chat(c.id)!.workspaceId)?.status).toBe('ready'), { timeout: 10_000, interval: 10 })
    return k.lead.setMode(k.store.chat(c.id)!.workspaceId, 'build')
  }
  const activity: ActivityEvent[] = []
  const onActivity = (e: ActivityEvent) => { activity.push(e) }
  bus.on('activity', onActivity)
  onTestFinished(() => { bus.off('activity', onActivity) })
  /** `build`: the work is a chat with Kernel's own, in Build here (KERNEL-778). */
  const pr = async (files: Record<string, string>, r: { checks?: PrCheck[]; blockers?: ReviewKind[]; approved?: ReviewKind[]; build?: boolean } = {}) => {
    const ws = r.build ? await buildChat() : await k.createWorkspace(project.id, { prompt: 'Build it', agentId: 'christian', title: 'Task' })
    for (const [f, c] of Object.entries(files)) { await mkdir(dirname(join(ws.path, f)), { recursive: true }); await writeFile(join(ws.path, f), c) }
    await git(ws.path, 'add', '-A')
    await git(ws.path, 'commit', '-qm', 'work')
    const head = (await git(ws.path, 'rev-parse', 'HEAD')).trim()
    gh.pr = { workspaceId: ws.id, number: 101, url: 'https://github.com/o/shop/pull/101', title: 'feat: task', state: 'ready', baseRef: 'main', checks: r.checks ?? GREEN, comments: [], conflicts: [], head }
    const verdict = (lens: ReviewKind, verdict: 'approved' | 'blockers', ts: number) => ({ workspaceId: 'rev', agentId: 'kernel-reviewer', verdict, summary: '', sha: head, prNumber: 101, lens, ts })
    const reviews = [...(r.approved ?? ['code']).map((k, i) => verdict(k, 'approved', i + 1)), ...(r.blockers ?? []).map((k, i) => verdict(k, 'blockers', 10 + i))]
    return k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prNumber: 101, prUrl: gh.pr.url, prTitle: 'feat: task', prState: 'ready', prHead: head, reviews })
  }
  return { k, repo, project, gh, pr, activity }
}

type Row = [label: string, o: { app?: object; main?: Record<string, string>; local?: boolean; files?: Record<string, string>; checks?: PrCheck[]; blockers?: ReviewKind[] }, refused: string]

describe('which PRs merge by themselves', () => {
  const OFF = {}
  const rows: Row[] = [
    ['a PR with no checks', { checks: [] }, 'It has no required checks, and auto-merge needs at least one to pass.'],
    ['a failing check', { checks: [{ name: 'Test', state: 'fail' }] }, 'Not every required check has passed.'],
    ['a PR over the line limit', { files: { 'big.txt': lines(401) } }, 'It changes 401 lines, more than the 400 auto-merge allows.'],
    ["a PR that touches the project's settings file", { files: { '.kernel/settings.toml': '[merge]\nauto = true\n' } }, "It changes .kernel/settings.toml, which always needs a person's review."],
    ['a PR that touches it in another case, as the Mac reads it', { files: { '.KERNEL/settings.toml': '[merge]\nauto = true\n' } }, "It changes .KERNEL/settings.toml, which always needs a person's review."],
    // KERNEL-632: the agents' files and instructions count at the root and in any folder below it.
    ...['CLAUDE.md', 'AGENTS.md', '.claude/agents/x.md', 'src/CLAUDE.md', 'packages/x/AGENTS.md', 'apps/web/.claude/agents/x.md'].map((f): Row =>
      [`a PR that touches ${f}`, { files: { [f]: 'You are Christian.\n' } }, `It changes ${f}, which always needs a person's review.`]),
    ["a path the base branch's [merge] always_review adds", { main: { '.kernel/settings.toml': '[merge]\nalways_review = ["migrations/**"]\n' }, files: { 'migrations/001.sql': 'select 1;\n' } }, "It changes migrations/001.sql, which always needs a person's review."],
    ['a shared settings file that turns it on', { app: OFF, main: { '.kernel/settings.toml': '[merge]\nauto = true\nmax_lines = 5000\n' } }, 'Auto-merge is off.'],
    ['a personal settings file the repo committed', { app: OFF, main: { '.kernel/settings.local.toml': '[merge]\nauto = true\n' } }, 'Auto-merge is off.'],
    ['a local merge', { local: true }, 'This project merges on this Mac, and auto-merge only merges pull requests on GitHub.'],
    ['a blocker on the head commit', { blockers: ['security'] }, 'The security review found blockers on the latest commit.']
  ]

  it.each(rows)('refuses %s', async (_label, o, refused) => {
    const { k, gh, pr } = await setup(o)
    const ws = await pr(o.files ?? { 'src/a.ts': 'export const a = 1\n' }, o)
    expect(await k.prs.autoMerge(ws.id)).toEqual({ refused })
    expect(gh.merged).toEqual([])
    expect(k.store.workspace(ws.id)?.prState).toBe('ready')
  })

  it('merges the clean case through the usual merge', async () => {
    const { k, gh, pr, activity } = await setup()
    const ws = await pr({ 'src/a.ts': lines(400) })
    expect(await k.prs.autoMerge(ws.id)).toEqual({ merged: expect.objectContaining({ prState: 'merged' }) })
    expect(gh.merged).toEqual(['squash'])
    expect(activity.find((a) => a.text === 'merged automatically')).toMatchObject({ actor: 'kernel', object: 'PR #101' })
  })

  it("merges a Build here chat's own PR by the same rule, and refuses it on a blocker (KERNEL-778)", async () => {
    const { k, gh, pr } = await setup({ main: { '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.' } })
    const blocked = await pr({ 'src/a.ts': 'export const a = 1\n' }, { build: true, blockers: ['code'] })
    expect(await k.prs.autoMerge(blocked.id)).toEqual({ refused: 'The code review found blockers on the latest commit.' })
    const ws = await pr({ 'src/b.ts': 'export const b = 1\n' }, { build: true })
    expect(await k.prs.autoMerge(ws.id)).toEqual({ merged: expect.objectContaining({ prState: 'merged' }) })
    expect(gh.merged).toEqual(['squash'])
    expect(k.store.workspace(ws.id)?.status).toBe('ready')
  })

  it("merges with the user's own personal settings file turning it on, the app's setting off", async () => {
    const { k, repo, gh, pr } = await setup({ app: {} })
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[merge]\nauto = true\n')
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' })
    expect(await k.prs.autoMerge(ws.id)).toEqual({ merged: expect.objectContaining({ prState: 'merged' }) })
    expect(gh.merged).toEqual(['squash'])
  })

  it('refuses a PR that got new commits between the check and the merge', async () => {
    const { k, gh, pr } = await setup()
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' })
    const read = k.github.info
    let n = 0
    k.github = { ...k.github, info: async (...a) => { const got = await read(...a); return ++n > 1 && got ? { ...got, head: 'f'.repeat(40) } : got } }
    expect(await k.prs.autoMerge(ws.id)).toEqual({ refused: 'The pull request has new commits since Kernel checked it.' })
    expect(gh.merged).toEqual([])
  })

  // KERNEL-829: GitHub merges only the head Kernel weighed, so a push after the fresh read lands nothing.
  it('holds GitHub to the head it weighed, and lands nothing when a push came after the check', async () => {
    const { k, gh, pr } = await setup()
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' })
    const weighedHead = gh.pr!.head
    const heads: (string | undefined)[] = []
    k.github = { ...k.github, merge: async (_cwd, _ref, _method, o) => {
      heads.push(o?.head)
      // A push lands on GitHub between Kernel's read and the merge, and GitHub turns down the old head.
      throw new Error(HEAD_MOVED)
    } }
    expect(await k.prs.autoMerge(ws.id)).toEqual({ refused: HEAD_MOVED })
    expect(heads).toEqual([weighedHead])
    expect(gh.merged).toEqual([])
    expect(k.store.workspace(ws.id)?.prState).toBe('ready')
  })

  it('reports a merge as merged when gh timed out after GitHub merged it (KERNEL-829)', async () => {
    const { k, gh, pr, activity } = await setup()
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' })
    const merge = k.github.merge
    k.github = { ...k.github, merge: async (...a) => { await merge(...a); throw new Error("gh pr merge --squash didn't finish in 60 seconds") } }
    expect(await k.prs.autoMerge(ws.id)).toEqual({ merged: expect.objectContaining({ prState: 'merged', mergedWith: 'squash' }) })
    expect(gh.merged).toEqual(['squash'])
    expect(activity.find((a) => a.text === 'merged automatically')).toMatchObject({ actor: 'kernel', object: 'PR #101' })
  })

  it('warns once in the project that the shared settings file sets auto-merge, and ignores it', async () => {
    const { k, gh, pr, activity } = await setup({ app: {}, main: { '.kernel/settings.toml': '[merge]\nauto = true\n' } })
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' })
    k.prs.considerAutoMerge(ws)
    // Weighed again, as when GitHub's block changed, and not warned again.
    k.prs.considerAutoMerge({ ...ws, prBlocked: 'behind' })
    const warned = activity.filter((a) => a.warn && a.text.startsWith('ignores'))
    expect(warned).toEqual([expect.objectContaining({ actor: 'kernel', text: 'ignores [merge] auto in .kernel/settings.toml:', object: 'auto-merge is a personal setting, set in .kernel/settings.local.toml' })])
    expect(gh.reads).toBe(0)
  })
})

describe('the trigger', () => {
  // KERNEL-1017: a PR no review approved is weighed when merging without a review is on or reviews are off.
  describe('with no review approving the PR', () => {
    const files = { 'src/a.ts': 'export const a = 1\n' }
    const apply = (autoReview: boolean, withoutReview: boolean) => ({ pr: { autoReview, autoMerge: { on: true, withoutReview } } })

    it('merges on green checks when the setting is on, and the Lead hears no review', async () => {
      const { k, gh, pr } = await setup({ app: apply(false, true) })
      const ws = await pr(files, { approved: [] })
      const told = vi.spyOn(k.leadUpdates, 'autoMerging')
      bus.push({ type: 'workspace', workspace: ws })
      await vi.waitFor(() => expect(k.store.workspace(ws.id)?.prState).toBe('merged'))
      expect(gh.merged).toEqual(['squash'])
      expect(told).toHaveBeenCalledWith(ws.id, expect.objectContaining({ card: 'Checks passed, 1 line, no review' }))
    })

    it('tells the Lead why it did not merge, naming the setting, when it is off and reviews are off', async () => {
      const { k, gh, pr } = await setup({ app: apply(false, false) })
      const ws = await pr(files, { approved: [] })
      const told = vi.spyOn(k.leadUpdates, 'autoMergeRefused')
      bus.push({ type: 'workspace', workspace: ws })
      await vi.waitFor(() => expect(told).toHaveBeenCalledWith(ws.id, 'No review approved it. Turn on Merge without a review in Settings, Pull requests to merge on green checks.'))
      expect(gh.merged).toEqual([])
    })

    it('says nothing while reviews are on and the setting is off, so a review can still approve', async () => {
      const { k, gh, pr } = await setup({ app: apply(true, false) })
      k.settings.pr.autoReview = true
      const ws = await pr(files, { approved: [] })
      const weighed = vi.spyOn(k.prs, 'autoMerge')
      bus.push({ type: 'workspace', workspace: ws })
      await new Promise((r) => setTimeout(r, 100))
      expect(weighed).not.toHaveBeenCalled()
      expect(gh.reads).toBe(0)
      const approved = k.store.saveWorkspace({ ...ws, reviews: [{ workspaceId: 'rev', agentId: 'kernel-reviewer', verdict: 'approved', summary: '', sha: ws.prHead, prNumber: 101, lens: 'code', ts: 1 }] })
      bus.push({ type: 'workspace', workspace: approved })
      await vi.waitFor(() => expect(k.store.workspace(ws.id)?.prState).toBe('merged'))
    })

    it('still returns early on a blocker with the setting on', async () => {
      const { k, gh, pr } = await setup({ app: apply(false, true) })
      const ws = await pr(files, { approved: [], blockers: ['code'] })
      const weighed = vi.spyOn(k.prs, 'autoMerge')
      bus.push({ type: 'workspace', workspace: ws })
      await new Promise((r) => setTimeout(r, 100))
      expect(weighed).not.toHaveBeenCalled()
      expect(gh.merged).toEqual([])
    })
  })

  it('is off by default: a PR every review approved reads nothing and stays open', async () => {
    const { k, gh, pr } = await setup({ app: {} })
    expect(DEFAULT_SETTINGS('/h').pr.autoMerge).toEqual({ on: false, maxLines: 400, alwaysReview: [], withoutReview: false })
    expect(k.settings.pr.autoMerge.on).toBe(false)
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' })
    bus.push({ type: 'workspace', workspace: ws })
    await new Promise((r) => setTimeout(r, 100))
    expect(gh.reads).toBe(0)
    expect(gh.merged).toEqual([])
  })

  it('merges once the approval of the head is saved, from the workspace push alone, and weighs each head once', async () => {
    const { k, gh, pr } = await setup()
    k.settings.pr.autoReview = true
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' }, { approved: [] })
    const weighed = vi.spyOn(k.prs, 'autoMerge')
    // No approval of the head yet: nothing to weigh.
    bus.push({ type: 'workspace', workspace: ws })
    expect(weighed).not.toHaveBeenCalled()
    const approved = k.store.saveWorkspace({ ...ws, reviews: [{ workspaceId: 'rev', agentId: 'kernel-reviewer', verdict: 'approved', summary: '', sha: ws.prHead, prNumber: 101, lens: 'code', ts: 1 }] })
    bus.push({ type: 'workspace', workspace: approved })
    bus.push({ type: 'workspace', workspace: approved })
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.prState).toBe('merged'))
    expect(gh.merged).toEqual(['squash'])
    expect(weighed).toHaveBeenCalledTimes(1)
  })

  // KERNEL-703: a check the repo doesn't require, still running, holds the merge, and its run finishing weighs the PR again.
  it('refuses while a check the repo does not require runs, and weighs again once it finishes', async () => {
    const { k, gh, pr } = await setup()
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' })
    const weighed = vi.spyOn(k.prs, 'autoMerge')
    const lint = (state: PrCheck['state']): PrCheck[] => [...GREEN, { name: 'Lint', state, optional: true }]
    // The poll read it ready before Lint started; the weigh's own read sees Lint running.
    gh.pr = { ...gh.pr!, checks: lint('running') }
    k.prs.considerAutoMerge(ws)
    await vi.waitFor(() => expect(weighed).toHaveBeenCalledTimes(1))
    expect(await weighed.mock.results[0].value).toEqual({ refused: 'Lint is still running.' })
    gh.pr = { ...gh.pr!, state: 'checks' }
    expect((await k.prs.refreshPr(ws.id)).prState).toBe('checks')
    expect(gh.merged).toEqual([])
    gh.pr = { ...gh.pr!, state: 'ready', checks: lint('pass') }
    expect((await k.prs.refreshPr(ws.id)).prState).toBe('ready')
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.prState).toBe('merged'))
    expect(weighed).toHaveBeenCalledTimes(2)
    expect(gh.merged).toEqual(['squash'])
  })

  it('weighs again when checks ran between two reads that both read ready', async () => {
    const { k, gh, pr } = await setup()
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' })
    const weighed = vi.spyOn(k.prs, 'autoMerge')
    gh.pr = { ...gh.pr!, checks: [...GREEN, { name: 'Lint', state: 'running', optional: true }] }
    k.prs.considerAutoMerge(ws)
    await vi.waitFor(() => expect(weighed).toHaveBeenCalledTimes(1))
    gh.pr = { ...gh.pr!, checks: [...GREEN, { name: 'Lint', state: 'pass', optional: true }] }
    await k.prs.refreshPr(ws.id)
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.prState).toBe('merged'))
    expect(weighed).toHaveBeenCalledTimes(2)
  })
})

// KERNEL-768: a refusal GitHub hadn't settled is weighed again after the quick re-read, a few times at most.
describe('weighing again', () => {
  const conflictWait = Prs.conflictWait
  afterEach(() => { Prs.conflictWait = conflictWait })

  /** A PR ready to auto-merge whose GitHub reads `read` shapes, with the quick re-read every 20 ms and the weighs counted. */
  async function weighing(files: Record<string, string>, read: (pr: PrInfo, n: number) => PrInfo) {
    const s = await setup()
    const ws = await s.pr(files)
    s.k.prs.recheckMs = 20
    const info = s.k.github.info
    let n = 0
    s.k.github = { ...s.k.github, info: async (...a) => { const got = await info(...a); return got && read(got, ++n) } }
    const weighed = vi.spyOn(s.k.prs, 'autoMerge')
    const told = vi.spyOn(s.k.leadUpdates, 'autoMergeRefused')
    return { ...s, ws, weighed, told }
  }
  const unknown = (pr: PrInfo): PrInfo => ({ ...pr, conflictsUnknown: true })
  const quiet = () => new Promise((r) => setTimeout(r, 150))

  it('merges a PR GitHub read as unknown, once GitHub settles', async () => {
    let settled = false
    const { k, ws, gh, weighed, told } = await weighing({ 'src/a.ts': 'export const a = 1\n' }, (pr) => (settled ? pr : unknown(pr)))
    k.prs.considerAutoMerge(ws)
    await vi.waitFor(() => expect(weighed).toHaveBeenCalledTimes(1))
    expect(await weighed.mock.results[0].value).toEqual({ refused: "GitHub doesn't read it as ready to merge." })
    settled = true
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.prState).toBe('merged'))
    expect(gh.merged).toEqual(['squash'])
    expect(weighed).toHaveBeenCalledTimes(2)
    expect(told).not.toHaveBeenCalled()
  })

  it('merges a PR whose read failed once', async () => {
    const { k, ws, gh, weighed, told } = await weighing({ 'src/a.ts': 'export const a = 1\n' }, (pr, n) => { if (n === 1) throw new Error('network'); return pr })
    k.prs.considerAutoMerge(ws)
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.prState).toBe('merged'))
    expect(await weighed.mock.results[0].value).toEqual({ refused: "Kernel couldn't read the pull request from GitHub." })
    expect(gh.merged).toEqual(['squash'])
    expect(told).not.toHaveBeenCalled()
  })

  it('merges once GitHub settles a PR its merge found still checking for conflicts', async () => {
    Prs.conflictWait = { every: 5, cap: 10 }
    let settled = false
    // The weigh reads it ready; the merge's own reads find GitHub checking it again.
    const { k, ws, gh, weighed, told } = await weighing({ 'src/a.ts': 'export const a = 1\n' }, (pr, n) => (n === 1 || settled ? pr : unknown(pr)))
    k.prs.considerAutoMerge(ws)
    await vi.waitFor(() => expect(weighed).toHaveBeenCalledTimes(1))
    expect(await weighed.mock.results[0].value).toEqual({ refused: 'GitHub is still checking #101 for conflicts. Try again in a moment.' })
    settled = true
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.prState).toBe('merged'))
    expect(gh.merged).toEqual(['squash'])
    expect(told).not.toHaveBeenCalled()
  })

  it('merges a PR whose merge GitHub turned down because the base branch moved meanwhile (KERNEL-829)', async () => {
    const { k, ws, gh, weighed, told } = await weighing({ 'src/a.ts': 'export const a = 1\n' }, (pr) => pr)
    const merge = k.github.merge
    let tries = 0
    k.github = { ...k.github, merge: async (...a) => {
      if (++tries === 1) throw new Error('gh pr merge 101 --squash failed (1): GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)')
      return merge(...a)
    } }
    // The poll's read weighs it, so the read after the failed merge finds the same key.
    await k.prs.refreshPr(ws.id)
    await vi.waitFor(() => expect(weighed).toHaveBeenCalledTimes(1))
    expect(await weighed.mock.results[0].value).toEqual({ refused: expect.stringContaining('Base branch was modified') })
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.prState).toBe('merged'))
    expect(gh.merged).toEqual(['squash'])
    expect(weighed).toHaveBeenCalledTimes(2)
    expect(told).not.toHaveBeenCalled()
  })

  it.each([
    ['over the line limit', { 'big.txt': lines(401) }, 'It changes 401 lines, more than the 400 auto-merge allows.'],
    ['touching an always-review path', { 'CLAUDE.md': 'You are Christian.\n' }, "It changes CLAUDE.md, which always needs a person's review."]
  ])('weighs a PR %s once, and the Lead hears why', async (_label, files, refused) => {
    const { k, ws, gh, weighed, told } = await weighing(files, (pr) => pr)
    k.prs.considerAutoMerge(ws)
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith(ws.id, refused))
    const reads = gh.reads
    await quiet()
    expect(weighed).toHaveBeenCalledTimes(1)
    expect(gh.reads).toBe(reads)
  })

  it('stops weighing a PR GitHub keeps reading as unknown, and the Lead then hears why', async () => {
    const { k, ws, gh, weighed, told } = await weighing({ 'src/a.ts': 'export const a = 1\n' }, unknown)
    // The poll's read weighs it, so every weigh after has the same key.
    await k.prs.refreshPr(ws.id)
    // Nine weighs, each reading the PR's diff with git: about 2 seconds here, near 3 on a CI runner.
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith(ws.id, "GitHub doesn't read it as ready to merge."), { timeout: 15_000 })
    expect(weighed).toHaveBeenCalledTimes(Prs.autoMergeRetries + 1)
    expect(told).toHaveBeenCalledTimes(1)
    await quiet()
    expect(weighed).toHaveBeenCalledTimes(Prs.autoMergeRetries + 1)
    expect(gh.merged).toEqual([])
  })

  it.each([
    ['the PR is forgotten', (k: Kernel, id: string) => k.prs.forgetPr(id)],
    ['the poll stops', (k: Kernel) => k.prs.stop()]
  ])('weighs nothing again once %s', async (_label, end) => {
    const { k, ws, gh, weighed } = await weighing({ 'src/a.ts': 'export const a = 1\n' }, unknown)
    k.prs.considerAutoMerge(ws)
    await vi.waitFor(() => expect(weighed).toHaveBeenCalledTimes(1))
    await weighed.mock.results[0].value
    end(k, ws.id)
    const reads = gh.reads
    await quiet()
    expect(weighed).toHaveBeenCalledTimes(1)
    expect(gh.reads).toBe(reads)
  })
})

// KERNEL-835: auto-merge never merges a PR whose checks ran against an older main. It brings the branch up to date first.
describe('a PR behind its base', () => {
  type Setup = Awaited<ReturnType<typeof setup>>

  /**
   * Christian's PRs from `files`, numbered from 101, on a fake GitHub that merges into the project's main and updates a branch the way
   * GitHub does: a merge of the base into it, whose checks then run, or a BranchConflict. `pass` lets a PR's checks pass.
   */
  async function hub(s: Setup, ...files: Record<string, string>[]) {
    const tip = async () => (await git(s.repo, 'rev-parse', 'main')).trim()
    const prs = new Map<string, PrInfo>()
    const wss: Workspace[] = []
    for (const [i, f] of files.entries()) {
      const made = await s.pr(f)
      const ws = s.k.store.saveWorkspace({ ...made, prNumber: 101 + i, prUrl: `https://github.com/o/shop/pull/${101 + i}`, reviews: made.reviews?.map((v) => ({ ...v, prNumber: 101 + i })) })
      wss.push(ws)
      prs.set(ws.id, { ...s.gh.pr!, workspaceId: ws.id, number: ws.prNumber!, url: ws.prUrl!, head: ws.prHead, baseOid: await tip() })
    }
    const of = (n: number) => [...prs.values()].find((p) => p.number === n)!
    const merged: number[] = []
    const updates: number[] = []
    s.k.github = {
      info: async (_cwd, _ref, id) => { const p = prs.get(id); return p ? { ...p } : null },
      merge: async (_cwd, ref) => {
        const p = [...prs.values()].find((x) => s.k.store.workspace(x.workspaceId)?.branch === ref)!
        await git(s.repo, 'merge', '-q', '--no-ff', '-m', `Merge #${p.number}`, ref)
        merged.push(p.number)
        prs.set(p.workspaceId, { ...p, state: 'merged' })
      },
      ready: async () => undefined,
      reopen: async () => undefined,
      updateBranch: async (_cwd, ref) => {
        const p = of(Number(ref))
        const base = await tip()
        const tree = await exec('git', ['-C', s.repo, 'merge-tree', '--write-tree', p.head!, base])
        if (tree.code !== 0) throw new BranchConflict('gh pr update-branch failed (1): GraphQL: merge conflict between base and head (updatePullRequestBranch)')
        const to = (await git(s.repo, 'commit-tree', tree.stdout.trim().split('\n')[0], '-p', p.head!, '-p', base, '-m', 'Merge main')).trim()
        updates.push(p.number)
        prs.set(p.workspaceId, { ...p, head: to, baseOid: base, blocked: undefined, state: 'checks', checks: [{ name: 'Test', state: 'running' }] })
      }
    }
    const pass = (id: string) => prs.set(id, { ...prs.get(id)!, state: 'ready', checks: GREEN })
    const moveMain = async (file: string) => {
      await writeFile(join(s.repo, file), `${file}\n`)
      await git(s.repo, 'add', file)
      await git(s.repo, 'commit', '-qm', `main gets ${file}`)
    }
    return { wss, prs, merged, updates, pass, moveMain, branchUpdated: vi.spyOn(s.k.leadUpdates, 'branchUpdated') }
  }

  it('merges the first PR of a wave, brings the second up to date, and merges it once its checks pass again, with no new review', async () => {
    const s = await setup({ app: { pr: { autoMerge: { on: true }, autoReview: true } } })
    const h = await hub(s, { 'src/a.ts': 'export const a = 1\n' }, { 'src/b.ts': 'export const b = 1\n' })
    const [a] = h.wss
    // The code review approved Christian's second PR in its first round.
    const b = s.k.store.saveWorkspace({ ...h.wss[1], reviewRound: { n: 1, rounds: 3, head: h.wss[1].prHead!, prNumber: 102, kinds: ['code'] } })
    const started = vi.spyOn(s.k.reviews as unknown as { startReview: () => Promise<unknown> }, 'startReview').mockResolvedValue(b)
    const again = vi.spyOn(s.k.reviews as unknown as { reviewAgain: () => Promise<unknown> }, 'reviewAgain').mockResolvedValue(undefined)
    // The new head's checks pass before Kernel has recorded the update, and a read of the PR comes in meanwhile. Its ready
    // waits for the record, or `onReady` would start a round on the new head.
    const record = s.k.reviews.recordBaseUpdate.bind(s.k.reviews)
    vi.spyOn(s.k.reviews, 'recordBaseUpdate').mockImplementation(async (id, from, to) => {
      h.pass(id)
      await s.k.prs.refreshPr(id)
      expect(s.k.store.workspace(id)?.prHead).toBe(from)
      return record(id, from, to)
    })
    expect(await s.k.prs.autoMerge(a.id)).toEqual({ merged: expect.objectContaining({ prState: 'merged' }) })
    const r = await s.k.prs.autoMerge(b.id)
    expect(r).toEqual({ updated: expect.stringMatching(/^[0-9a-f]{40}$/) })
    const to = (r as { updated: string }).updated
    expect(h.updates).toEqual([102])
    expect(s.k.store.workspace(b.id)?.baseUpdates).toEqual([{ from: b.prHead, to }])
    // Christian's worktree was clean and idle, so it moved to the merge.
    expect((await git(b.path, 'rev-parse', 'HEAD')).trim()).toBe(to)
    expect(h.branchUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: b.id }), 'main')
    // The Lead update and the activity entry carry the update. Christian's chat gets no note about it (KERNEL-970).
    const chat = s.k.store.chats(b.id)[0]
    expect(chat).toBeDefined()
    expect(s.k.store.items(chat.id).filter((i) => i.kind === 'note' && i.text.includes('up to date'))).toEqual([])
    await vi.waitFor(() => expect(s.k.store.workspace(b.id)?.prState).toBe('merged'))
    expect(h.merged).toEqual([101, 102])
    expect(h.updates).toEqual([102])
    expect(started).not.toHaveBeenCalled()
    expect(again).not.toHaveBeenCalled()
    expect(s.k.store.workspace(b.id)?.reviewRound).toMatchObject({ n: 1, head: b.prHead })
  })

  it('moves a PR whose update conflicts to conflict, which reaches the Lead', async () => {
    const s = await setup()
    const h = await hub(s, { 'src/a.ts': 'export const a = 1\n' }, { 'src/a.ts': 'export const a = 2\n' })
    const [a, b] = h.wss
    await s.k.prs.autoMerge(a.id)
    const pushes: unknown[] = []
    const onPush = (e: unknown) => { pushes.push(e) }
    bus.on('push', onPush)
    onTestFinished(() => { bus.off('push', onPush) })
    expect(await s.k.prs.autoMerge(b.id)).toEqual({ refused: 'It conflicts with main.' })
    expect(s.k.store.workspace(b.id)?.prState).toBe('conflict')
    expect(pushes).toContainEqual({ type: 'pr', workspaceId: b.id, state: 'conflict' })
    expect(h.merged).toEqual([101])
    expect(h.branchUpdated).not.toHaveBeenCalled()
  })

  it('stops after three updates, and the Lead tells the user once', async () => {
    const s = await setup()
    const h = await hub(s, { 'src/a.ts': 'export const a = 1\n' })
    const [w] = h.wss
    // Main moves each time the new head's checks are running, and the read after they pass weighs it.
    for (const n of [1, 2, 3]) {
      await h.moveMain(`moved-${n}.txt`)
      if (n > 1) h.pass(w.id)
      await s.k.prs.refreshPr(w.id)
      await vi.waitFor(() => expect(h.updates).toHaveLength(n))
      await vi.waitFor(() => expect(s.k.store.workspace(w.id)).toMatchObject({ prState: 'checks', prHead: h.prs.get(w.id)!.head }))
    }
    await h.moveMain('moved-4.txt')
    h.pass(w.id)
    await s.k.prs.refreshPr(w.id)
    await vi.waitFor(() => expect(s.k.store.workspace(w.id)?.prState).toBe('ready'))
    const said = 'main moved past it again after Kernel brought it up to date 3 times, so Kernel stopped updating it.'
    expect(await s.k.prs.autoMerge(w.id)).toEqual({ refused: said })
    expect(await s.k.prs.autoMerge(w.id)).toEqual({ refused: said })
    expect(h.updates).toEqual([101, 101, 101])
    expect(h.merged).toEqual([])
    expect(h.branchUpdated.mock.calls.filter((c) => c[2]?.capped)).toEqual([[expect.objectContaining({ id: w.id }), 'main', { capped: 3 }]])
  })

  it('updates a PR GitHub reads as behind under the "up to date" rule and merges it, telling a busy teammate to pull', async () => {
    const s = await setup()
    const h = await hub(s, { 'src/a.ts': 'export const a = 1\n' })
    const [w] = h.wss
    await h.moveMain('moved.txt')
    // GitHub says behind, and gives no base commit to compare.
    h.prs.set(w.id, { ...h.prs.get(w.id)!, blocked: 'behind', baseOid: undefined })
    // Christian has changes it hasn't committed, so its worktree stays where it is.
    await writeFile(join(w.path, 'src/a.ts'), 'export const a = 3\n')
    const sent = vi.spyOn(s.k.sessions, 'send')
    expect(await s.k.prs.autoMerge(w.id)).toEqual({ updated: expect.any(String) })
    expect((await git(w.path, 'rev-parse', 'HEAD')).trim()).toBe(w.prHead)
    expect(sent).toHaveBeenCalledWith(expect.any(String), [{ type: 'text', text: expect.stringContaining('Run git pull --no-rebase before you push again.') }], { from: 'kernel' })
    h.pass(w.id)
    await s.k.prs.refreshPr(w.id)
    await vi.waitFor(() => expect(s.k.store.workspace(w.id)?.prState).toBe('merged'))
    expect(h.merged).toEqual([101])
  })

  it('updates the PR once when two weighs of the same head find it behind together', async () => {
    const s = await setup()
    const h = await hub(s, { 'src/a.ts': 'export const a = 1\n' })
    await h.moveMain('moved.txt')
    const both = await Promise.all([s.k.prs.autoMerge(h.wss[0].id), s.k.prs.autoMerge(h.wss[0].id)])
    expect(both).toContainEqual({ updated: expect.any(String) })
    expect(both).toContainEqual({ refused: 'Kernel is already bringing it up to date.' })
    expect(h.updates).toEqual([101])
  })

  it('merges a PR its base has not moved past, without updating it', async () => {
    const s = await setup()
    const h = await hub(s, { 'src/a.ts': 'export const a = 1\n' })
    expect(await s.k.prs.autoMerge(h.wss[0].id)).toEqual({ merged: expect.objectContaining({ prState: 'merged' }) })
    expect(h.updates).toEqual([])
  })
})

describe('Merge PR while a check the repo does not require runs (KERNEL-703)', () => {
  it('refuses, naming the check, and merges on Merge anyway', async () => {
    const { k, gh, pr } = await setup({ app: {} })
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' })
    gh.pr = { ...gh.pr!, checks: [...GREEN, { name: 'Test e2e', state: 'running', optional: true }] }
    await expect(k.prs.mergePr(ws.id)).rejects.toThrow('Test e2e is still running.')
    expect(gh.merged).toEqual([])
    expect((await k.prs.mergePr(ws.id, { override: true })).prState).toBe('merged')
    expect(gh.merged).toEqual(['squash'])
  })

  it('merges past a check the repo does not require that failed', async () => {
    const { k, gh, pr } = await setup({ app: {} })
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' })
    gh.pr = { ...gh.pr!, checks: [...GREEN, { name: 'Test e2e', state: 'fail', optional: true }] }
    expect((await k.prs.mergePr(ws.id)).prState).toBe('merged')
  })
})

describe('the rule', () => {
  const pr: PrInfo = { workspaceId: 'w', number: 7, url: '', title: '', state: 'ready', baseRef: 'main', checks: GREEN, comments: [], conflicts: [], head: 'a'.repeat(40) }
  const clean: AutoMergeFacts = {
    rules: { on: true, maxLines: 400, alwaysReview: [], withoutReview: false }, local: false, requireGreen: true, pr,
    reviews: { required: ['code'], approved: ['code', 'ux'], blocking: [], running: false }, diff: { lines: 120, touched: [] }
  }

  it('lets the clean case through and says why', () => {
    expect(autoMergeBlock(clean)).toBeUndefined()
    expect(autoMergeWhy(clean)).toEqual({
      why: "the code and UX reviews approved its latest commit, its check passed, it changes 120 lines, within the user's limit of 400, and it changes no path that always needs a person's review",
      card: 'Code and UX approved, checks passed, 120 lines'
    })
  })

  it('refuses whatever Kernel could not read, and every other condition that fails', () => {
    const r = clean.reviews!
    expect(autoMergeBlock({ ...clean, requireGreen: false })).toBe('Require green checks to merge is off in Settings, Pull requests, and auto-merge needs it on.')
    expect(autoMergeBlock({ ...clean, pr: null })).toBe("Kernel couldn't read the pull request from GitHub.")
    expect(autoMergeBlock({ ...clean, pr: { ...pr, checks: [{ name: 'Vercel', state: 'pass', optional: true }] } })).toBe('It has no required checks, and auto-merge needs at least one to pass.')
    expect(autoMergeBlock({ ...clean, pr: { ...pr, checks: [...GREEN, { name: 'e2e', state: 'running' }] } })).toBe('Not every required check has passed.')
    // KERNEL-703: an optional check holds it while it runs, and doesn't once it failed (KERNEL-388).
    expect(autoMergeBlock({ ...clean, pr: { ...pr, checks: [...GREEN, { name: 'e2e', state: 'queued', optional: true }] } })).toBe('e2e is still running.')
    expect(autoMergeBlock({ ...clean, pr: { ...pr, checks: [...GREEN, { name: 'e2e', state: 'fail', optional: true }] } })).toBeUndefined()
    expect(autoMergeBlock({ ...clean, pr: { ...pr, blocked: 'review' } })).toBe('GitHub needs an approving review before this pull request can merge.')
    expect(autoMergeBlock({ ...clean, pr: { ...pr, conflictsUnknown: true } })).toBe("GitHub doesn't read it as ready to merge.")
    expect(autoMergeBlock({ ...clean, reviews: undefined })).toBe("Kernel couldn't tell which reviews it needs.")
    expect(autoMergeBlock({ ...clean, reviews: { ...r, required: [] } })).toBe('None of its reviews is required, and auto-merge needs a required review to approve it.')
    expect(autoMergeBlock({ ...clean, reviews: { ...r, required: ['code', 'security'] } })).toBe("The security review hasn't approved the latest commit.")
    expect(autoMergeBlock({ ...clean, reviews: { ...r, running: true } })).toBe('A review of it is still running.')
    expect(autoMergeBlock({ ...clean, diff: undefined })).toBe("Kernel couldn't read what it changes.")
    expect(autoMergeBlock({ ...clean, diff: { lines: 400, touched: [] } })).toBeUndefined()
    expect(autoMergeBlock({ ...clean, diff: { lines: 3, touched: ['CLAUDE.md', 'AGENTS.md'] } })).toBe("It changes CLAUDE.md and 1 other file that always need a person's review.")
    expect(autoMergeWhy({ ...clean, diff: undefined })).toBeUndefined()
  })

  // KERNEL-1017: merging without a review skips the approval rules and nothing else.
  describe('without a review', () => {
    const r = clean.reviews!
    const none: NonNullable<AutoMergeFacts['reviews']> = { ...r, required: [], approved: [] }
    const free = { ...clean, rules: { ...clean.rules, withoutReview: true }, reviews: none }

    it('names the setting when nothing approved and no review is required', () => {
      const off = { ...clean, reviews: none }
      expect(autoMergeBlock(off)).toBe('No review approved it. Turn on Merge without a review in Settings, Pull requests to merge on green checks.')
      expect(autoMergeBlock({ ...off, reviews: { ...none, required: ['code'] } })).toBe(autoMergeBlock(off))
    })

    it('merges on green checks alone, and says no review ran', () => {
      expect(autoMergeBlock(free)).toBeUndefined()
      expect(autoMergeBlock({ ...free, reviews: { ...none, required: ['code', 'security'] } })).toBeUndefined()
      expect(autoMergeWhy(free)).toEqual({
        why: "its check passed, it changes 120 lines, within the user's limit of 400, and it changes no path that always needs a person's review, and no review ran",
        card: 'Checks passed, 120 lines, no review'
      })
      expect(autoMergeWhy({ ...free, reviews: { ...none, approved: ['code'] } })?.card).toBe('Code approved, checks passed, 120 lines')
    })

    it('still holds for blockers, an overrule, a running review and every other rule', () => {
      expect(autoMergeBlock({ ...free, reviews: { ...none, blocking: ['code'] } })).toBe('The code review found blockers on the latest commit.')
      expect(autoMergeBlock({ ...free, reviews: { ...none, overruled: ['code'] } })).toBe("The code review found blockers on the latest commit, and auto-merge doesn't merge past an overrule.")
      expect(autoMergeBlock({ ...free, reviews: { ...none, running: true } })).toBe('A review of it is still running.')
      expect(autoMergeBlock({ ...free, diff: { lines: 401, touched: [] } })).toBe('It changes 401 lines, more than the 400 auto-merge allows.')
      expect(autoMergeBlock({ ...free, pr: { ...pr, checks: [] } })).toBe('It has no required checks, and auto-merge needs at least one to pass.')
    })

    it('weighs again only what had not settled', () => {
      expect(autoMergeRetry(free)).toBe(false)
      expect(autoMergeRetry({ ...free, reviews: { ...none, running: true } })).toBe(true)
      expect(autoMergeRetry({ ...free, reviews: { ...none, blocking: ['code'] } })).toBe(false)
      expect(autoMergeRetry({ ...free, diff: undefined })).toBe(true)
      expect(autoMergeRetry({ ...clean, reviews: none })).toBe(false)
    })
  })

  // KERNEL-768: what GitHub or Kernel hadn't settled is weighed again; the user's own rules are final.
  it('weighs again only what had not settled', () => {
    const r = clean.reviews!
    const temporary: AutoMergeFacts[] = [
      { ...clean, pr: null },
      { ...clean, pr: undefined },
      { ...clean, pr: { ...pr, head: undefined } },
      { ...clean, pr: { ...pr, conflictsUnknown: true } },
      { ...clean, pr: { ...pr, state: 'checks' } },
      { ...clean, pr: { ...pr, checks: [...GREEN, { name: 'e2e', state: 'running' }] } },
      { ...clean, pr: { ...pr, checks: [...GREEN, { name: 'e2e', state: 'queued', optional: true }] } },
      { ...clean, reviews: undefined },
      { ...clean, reviews: { ...r, running: true } },
      { ...clean, diff: undefined }
    ]
    for (const f of temporary) expect([autoMergeBlock(f) ?? 'merges', autoMergeRetry(f)]).toEqual([expect.any(String), true])
    const final: AutoMergeFacts[] = [
      { ...clean, rules: { ...clean.rules, on: false }, pr: null },
      { ...clean, local: true, pr: null },
      { ...clean, requireGreen: false },
      { ...clean, pr: { ...pr, checks: [] } },
      { ...clean, pr: { ...pr, checks: [{ name: 'Test', state: 'fail' }, { name: 'e2e', state: 'running' }] } },
      { ...clean, pr: { ...pr, blocked: 'review' } },
      { ...clean, pr: { ...pr, blocked: 'review', conflictsUnknown: true } },
      { ...clean, reviews: { ...r, blocking: ['security'], running: true } },
      { ...clean, reviews: { ...r, overruled: ['security'] } },
      { ...clean, reviews: { ...r, required: [] } },
      { ...clean, reviews: { ...r, required: ['code', 'security'], running: true } },
      { ...clean, diff: { lines: 401, touched: [] } },
      { ...clean, diff: { lines: 3, touched: ['CLAUDE.md'] } }
    ]
    for (const f of final) expect([autoMergeBlock(f) ?? 'merges', autoMergeRetry(f)]).toEqual([expect.any(String), false])
    expect(autoMergeRetry(clean)).toBe(false)
  })

  it("keeps Kernel's own always-review paths", () => {
    expect(ALWAYS_REVIEW).toEqual(['.kernel/**', '**/.claude/agents/**', '**/CLAUDE.md', '**/AGENTS.md', '.github/workflows/**'])
  })
})

describe('the settings', () => {
  it("reads only always_review from the shared file's [merge], and names the personal keys it ignores", () => {
    expect(sharedMergeOf('[merge]\nauto = true\nmax_lines = 9000\nalways_review = ["db/**", " ", 3]\n')).toEqual({ alwaysReview: ['db/**'], ignored: ['auto', 'max_lines'] })
    expect(sharedMergeOf('not toml [')).toEqual({ alwaysReview: [], ignored: [] })
    expect(sharedMergeOf(undefined)).toEqual({ alwaysReview: [], ignored: [] })
  })

  it("lets the personal file override the app's setting for its project, its paths adding to the app's", async () => {
    const repo = await tempRepo()
    const app = { on: false, maxLines: 400, alwaysReview: ['infra/**'], withoutReview: false }
    expect(autoMergeInProject(repo, app)).toEqual({ rules: app, personal: false, ignored: [] })
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[merge]\nauto = true\nmax_lines = 150\nalways_review = ["db/**"]\n')
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[merge]\nauto = false\n')
    expect(autoMergeInProject(repo, app)).toEqual({ rules: { on: true, maxLines: 150, alwaysReview: ['infra/**', 'db/**'], withoutReview: false }, personal: true, ignored: ['auto'] })
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[merge]\nwithout_review = true\n')
    expect(autoMergeInProject(repo, app).rules.withoutReview).toBe(true)
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[merge]\nwithout_review = "yes"\n')
    expect(autoMergeInProject(repo, { ...app, withoutReview: true }).rules.withoutReview).toBe(true)
  })

  it('ignores without_review in the shared file', async () => {
    const repo = await tempRepo()
    const app = { on: true, maxLines: 400, alwaysReview: [], withoutReview: false }
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[merge]\nwithout_review = true\n')
    expect(sharedMergeOf('[merge]\nwithout_review = true\n')).toEqual({ alwaysReview: [], ignored: ['without_review'] })
    expect(autoMergeInProject(repo, app)).toEqual({ rules: app, personal: false, ignored: ['without_review'] })
  })

  it("keeps a hand-edited settings.json's auto-merge off unless it says true", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-set-'))
    const file = join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ version: 2, pr: { autoMerge: { on: 'yes', maxLines: -3, alwaysReview: 'all', withoutReview: 'yes' } } }))
    expect((await loadAppSettings(file, dir)).resolved.pr.autoMerge).toEqual({ on: false, maxLines: 400, alwaysReview: [], withoutReview: false })
    const next = applySettingsPatch((await loadAppSettings(file, dir)).resolved, { pr: { autoMerge: { on: true, maxLines: 250.5 } } })
    expect(next.pr.autoMerge).toEqual({ on: true, maxLines: 400, alwaysReview: [], withoutReview: false })
    expect(applySettingsPatch(next, { pr: { autoMerge: { withoutReview: true } } }).pr.autoMerge.withoutReview).toBe(true)
  })
})

describe('what Kernel hears', () => {
  const open: LeadUpdates[] = []
  afterEach(() => { open.forEach((u) => u.detach()); open.length = 0 })
  const ws = (prState: Workspace['prState']) => ({ id: 'w1', projectId: 'r', name: 'w1', agentId: 'christian', prState, prNumber: 54, prUrl: 'https://github.com/o/shop/pull/54', status: 'ready' }) as Workspace
  const ev = (kind: TeamEvent['kind'], o: Partial<TeamEvent> = {}): TeamEvent => ({ n: 1, workspaceId: 'w1', kind, pr: 54, ...o })
  const auto = { why: "the code review approved its latest commit, its check passed, it changes 12 lines, within the user's limit of 400, and it changes no path that always needs a person's review", card: 'Code approved, checks passed, 12 lines' }

  it('asks for a short merge summary on the ready to merge line, and says why auto-merge left the PR when it is on', () => {
    const review = { approved: ['code' as const], blocking: [], blockers: false, reviewing: [], inProgress: false, waiting: [] }
    const c = { allMerged: () => false, review }
    expect(decide({ ws: ws('ready'), name: 'Christian', events: [ev('pr.ready')] }, c).todo).toEqual([
      'PR #54 passed checks, has no conflicts and the code review approved it. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran, and anything they should know.'
    ])
    expect(decide({ ws: ws('ready'), name: 'Christian', events: [ev('pr.ready')] }, { ...c, refused: () => 'It changes 612 lines, more than the 400 auto-merge allows.' }).todo).toEqual([
      "PR #54 passed checks, has no conflicts and the code review approved it. Auto-merge is on, and Kernel didn't merge it. It changes 612 lines, more than the 400 auto-merge allows. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran, why Kernel didn't merge it, and anything they should know."
    ])
  })

  it('tells Kernel to pass on a merge Kernel made by itself, with the link, even once the work is archived', () => {
    const out = decide({ ws: { ...ws('merged'), status: 'archived' }, name: 'Christian', events: [ev('pr.merged', { auto })] }, { allMerged: () => false })
    expect(out.todo).toEqual(['Tell the user Kernel merged PR #54 automatically and why, in a line or two, with its link https://github.com/o/shop/pull/54.'])
  })

  it("carries Kernel's update of a PR without waking the Lead, and wakes it to tell the user once Kernel stops (KERNEL-835)", () => {
    const c = { allMerged: () => false }
    expect(decide({ ws: ws('checks'), name: 'Christian', events: [ev('pr.updated', { updated: { base: 'main' } })] }, c).todo).toEqual([])
    expect(decide({ ws: ws('ready'), name: 'Christian', events: [ev('pr.updated', { updated: { base: 'main', capped: 3 } })] }, c).todo).toEqual([
      "Tell the user main keeps moving past PR #54, so Kernel stopped bringing it up to date after 3 tries and won't merge it by itself. They can update and merge it by hand."
    ])
  })

  /** Christian's ready PR #54 in w1, and Artkin's review workspace of it, handed off in the Lead chat lc. */
  async function lead() {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-am-')), 'k.db'))
    store.saveProject({ id: 'r', name: 'Shop', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
    const base = { projectId: 'r', baseRef: 'main', mode: 'worktree', port: 1, status: 'ready', leadChatId: 'lc', createdAt: 1 }
    store.saveWorkspace({ ...base, id: 'w1', name: 'w1', branch: 'w1', path: '/x/w1', agentId: 'christian', prState: 'ready', prNumber: 54, prUrl: 'https://github.com/o/shop/pull/54', title: 'Task' } as Workspace)
    store.saveWorkspace({ ...base, id: 'rv', name: 'rv', branch: 'rv', path: '/x/rv', agentId: 'artkin', prState: 'none', reviewOf: 'w1', title: 'Review PR #54' } as Workspace)
    store.saveChat({ id: 'lc', workspaceId: 'lead', title: 'lc', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 } as Chat)
    const posts: { text: string; update: TeamUpdate }[] = []
    const u = new LeadUpdates({
      store, enabled: () => true, target: () => ({ chat: store.chat('lc')! }), isLead: () => false, agentName: (_r, id) => (id === 'christian' ? 'Christian' : 'Artkin'),
      post: (_chatId, text, update) => { posts.push({ text, update }); return true }, delayMs: 10
    })
    u.attach()
    open.push(u)
    return { store, u, posts }
  }

  it('holds a verdict about a PR Kernel is weighing for auto-merge until it knows the outcome', async () => {
    const { store, u, posts } = await lead()
    u.readingPr('w1')
    u.reviewed(store.workspace('rv')!, store.workspace('w1')!, { workspaceId: 'rv', agentId: 'artkin', verdict: 'approved', summary: 'Good.', lens: 'code', ts: 1 })
    await new Promise((r) => setTimeout(r, 60))
    expect(posts).toEqual([])
    u.readPr('w1')
    await vi.waitFor(() => expect(posts).toHaveLength(1))
  })

  it("says Kernel brought the PR up to date in the text Kernel reads and on the card (KERNEL-835)", async () => {
    const { store, u, posts } = await lead()
    u.branchUpdated(store.workspace('w1')!, 'main')
    u.autoMerging('w1', auto)
    store.saveWorkspace({ ...store.workspace('w1')!, prState: 'merged' })
    bus.push({ type: 'pr', workspaceId: 'w1', state: 'merged' })
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].text).toContain('- Kernel brought PR #54 up to date with main, waiting for checks.')
    expect(posts[0].update.rows[0].events[0]).toEqual({ kind: 'pr.updated', text: 'Brought #54 up to date with main, waiting for checks', actionable: false })
  })

  it('says "Merged automatically" and why on the card, and in the text Kernel reads', async () => {
    const { store, u, posts } = await lead()
    u.autoMerging('w1', auto)
    store.saveWorkspace({ ...store.workspace('w1')!, prState: 'merged' })
    bus.push({ type: 'pr', workspaceId: 'w1', state: 'merged' })
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].text).toContain(`- Kernel merged PR #54 automatically, since ${auto.why}.`)
    expect(posts[0].text).toContain('- Tell the user Kernel merged PR #54 automatically and why, in a line or two, with its link https://github.com/o/shop/pull/54.')
    expect(posts[0].update.rows[0].events).toEqual([
      { kind: 'pr.merged', text: 'Merged automatically', actionable: true },
      { kind: 'pr.review', text: 'Code approved, checks passed, 12 lines', actionable: false }
    ])
  })
})
