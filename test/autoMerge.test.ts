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
import { git } from '../src/main/services/exec'
import { applySettingsPatch, autoMergeInRoom, DEFAULT_SETTINGS, loadAppSettings, sharedMergeOf } from '../src/main/services/settings'
import { decide, LeadUpdates, type TeamEvent } from '../src/main/services/leadUpdates'
import { tempRepo } from './helpers'

// KERNEL-556: Kernel merges a PR every review approved by itself, once the user turns auto-merge on for themselves.

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

const AGENTS = {
  'README.md': '# shop\n',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
}
const ON = { pr: { autoMerge: { on: true } } }
const GREEN: PrCheck[] = [{ name: 'Test', state: 'pass' }]
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n'

/**
 * A room on a fake GitHub whose `main` holds `main` besides the agents, with the app's settings `app`. `pr` opens Kai's work on
 * a PR that passed `checks`, with the code review's approval of its head and the blockers of the kinds `blockers` names.
 */
async function setup(o: { app?: object; main?: Record<string, string>; local?: boolean } = {}) {
  const repo = await tempRepo({ ...AGENTS, ...o.main })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...(o.app ?? ON) }))
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
  let room = await k.addRoom(repo)
  if (o.local) room = k.store.saveRoom({ ...room, host: 'local' })
  const buildChat = async () => {
    const c = await k.lead.newLeadChat(room.id, { prompt: '' })
    await vi.waitFor(() => expect(k.store.workspace(k.store.chat(c.id)!.workspaceId)?.status).toBe('ready'), { timeout: 10_000, interval: 10 })
    return k.lead.setMode(k.store.chat(c.id)!.workspaceId, 'build')
  }
  const activity: ActivityEvent[] = []
  const onActivity = (e: ActivityEvent) => { activity.push(e) }
  bus.on('activity', onActivity)
  onTestFinished(() => { bus.off('activity', onActivity) })
  /** `build`: the work is a chat with Kernel's own, in Build here (KERNEL-778). */
  const pr = async (files: Record<string, string>, r: { checks?: PrCheck[]; blockers?: ReviewKind[]; approved?: ReviewKind[]; build?: boolean } = {}) => {
    const ws = r.build ? await buildChat() : await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Task' })
    for (const [f, c] of Object.entries(files)) { await mkdir(dirname(join(ws.path, f)), { recursive: true }); await writeFile(join(ws.path, f), c) }
    await git(ws.path, 'add', '-A')
    await git(ws.path, 'commit', '-qm', 'work')
    const head = (await git(ws.path, 'rev-parse', 'HEAD')).trim()
    gh.pr = { workspaceId: ws.id, number: 101, url: 'https://github.com/o/shop/pull/101', title: 'feat: task', state: 'ready', baseRef: 'main', checks: r.checks ?? GREEN, comments: [], conflicts: [], head }
    const verdict = (lens: ReviewKind, verdict: 'approved' | 'blockers', ts: number) => ({ workspaceId: 'rev', agentId: 'kernel-reviewer', verdict, summary: '', sha: head, prNumber: 101, lens, ts })
    const reviews = [...(r.approved ?? ['code']).map((k, i) => verdict(k, 'approved', i + 1)), ...(r.blockers ?? []).map((k, i) => verdict(k, 'blockers', 10 + i))]
    return k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prNumber: 101, prUrl: gh.pr.url, prTitle: 'feat: task', prState: 'ready', prHead: head, reviews })
  }
  return { k, repo, room, gh, pr, activity }
}

type Row = [label: string, o: { app?: object; main?: Record<string, string>; local?: boolean; files?: Record<string, string>; checks?: PrCheck[]; blockers?: ReviewKind[] }, refused: string]

describe('which PRs merge by themselves', () => {
  const OFF = {}
  const rows: Row[] = [
    ['a PR with no checks', { checks: [] }, 'It has no required checks, and auto-merge needs at least one to pass.'],
    ['a failing check', { checks: [{ name: 'Test', state: 'fail' }] }, 'Not every required check has passed.'],
    ['a PR over the line limit', { files: { 'big.txt': lines(401) } }, 'It changes 401 lines, more than the 400 auto-merge allows.'],
    ["a PR that touches the room's settings file", { files: { '.kernel/settings.toml': '[merge]\nauto = true\n' } }, "It changes .kernel/settings.toml, which always needs a person's review."],
    ['a PR that touches it in another case, as the Mac reads it', { files: { '.KERNEL/settings.toml': '[merge]\nauto = true\n' } }, "It changes .KERNEL/settings.toml, which always needs a person's review."],
    // KERNEL-632: the agents' files and instructions count at the root and in any folder below it.
    ...['CLAUDE.md', 'AGENTS.md', '.claude/agents/x.md', 'src/CLAUDE.md', 'packages/x/AGENTS.md', 'apps/web/.claude/agents/x.md'].map((f): Row =>
      [`a PR that touches ${f}`, { files: { [f]: 'You are Kai.\n' } }, `It changes ${f}, which always needs a person's review.`]),
    ["a path the base branch's [merge] always_review adds", { main: { '.kernel/settings.toml': '[merge]\nalways_review = ["migrations/**"]\n' }, files: { 'migrations/001.sql': 'select 1;\n' } }, "It changes migrations/001.sql, which always needs a person's review."],
    ['a shared settings file that turns it on', { app: OFF, main: { '.kernel/settings.toml': '[merge]\nauto = true\nmax_lines = 5000\n' } }, 'Auto-merge is off.'],
    ['a personal settings file the repo committed', { app: OFF, main: { '.kernel/settings.local.toml': '[merge]\nauto = true\n' } }, 'Auto-merge is off.'],
    ['a local merge', { local: true }, 'This room merges on this Mac, and auto-merge only merges pull requests on GitHub.'],
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

  it('warns once in the room that the shared settings file sets auto-merge, and ignores it', async () => {
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
  it('is off by default: a PR every review approved reads nothing and stays open', async () => {
    const { k, gh, pr } = await setup({ app: {} })
    expect(DEFAULT_SETTINGS('/h').pr.autoMerge).toEqual({ on: false, maxLines: 400, alwaysReview: [] })
    expect(k.settings.pr.autoMerge.on).toBe(false)
    const ws = await pr({ 'src/a.ts': 'export const a = 1\n' })
    bus.push({ type: 'workspace', workspace: ws })
    await new Promise((r) => setTimeout(r, 100))
    expect(gh.reads).toBe(0)
    expect(gh.merged).toEqual([])
  })

  it('merges once the approval of the head is saved, from the workspace push alone, and weighs each head once', async () => {
    const { k, gh, pr } = await setup()
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

  it.each([
    ['over the line limit', { 'big.txt': lines(401) }, 'It changes 401 lines, more than the 400 auto-merge allows.'],
    ['touching an always-review path', { 'CLAUDE.md': 'You are Kai.\n' }, "It changes CLAUDE.md, which always needs a person's review."]
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
    rules: { on: true, maxLines: 400, alwaysReview: [] }, local: false, requireGreen: true, pr,
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

  it("lets the personal file override the app's setting for its room, its paths adding to the app's", async () => {
    const repo = await tempRepo()
    const app = { on: false, maxLines: 400, alwaysReview: ['infra/**'] }
    expect(autoMergeInRoom(repo, app)).toEqual({ rules: app, personal: false, ignored: [] })
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[merge]\nauto = true\nmax_lines = 150\nalways_review = ["db/**"]\n')
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[merge]\nauto = false\n')
    expect(autoMergeInRoom(repo, app)).toEqual({ rules: { on: true, maxLines: 150, alwaysReview: ['infra/**', 'db/**'] }, personal: true, ignored: ['auto'] })
  })

  it("keeps a hand-edited settings.json's auto-merge off unless it says true", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-set-'))
    const file = join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ version: 2, pr: { autoMerge: { on: 'yes', maxLines: -3, alwaysReview: 'all' } } }))
    expect((await loadAppSettings(file, dir)).resolved.pr.autoMerge).toEqual({ on: false, maxLines: 400, alwaysReview: [] })
    const next = applySettingsPatch((await loadAppSettings(file, dir)).resolved, { pr: { autoMerge: { on: true, maxLines: 250.5 } } })
    expect(next.pr.autoMerge).toEqual({ on: true, maxLines: 400, alwaysReview: [] })
  })
})

describe('what Kernel hears', () => {
  const open: LeadUpdates[] = []
  afterEach(() => { open.forEach((u) => u.detach()); open.length = 0 })
  const ws = (prState: Workspace['prState']) => ({ id: 'w1', roomId: 'r', name: 'w1', agentId: 'kai', prState, prNumber: 54, prUrl: 'https://github.com/o/shop/pull/54', status: 'ready' }) as Workspace
  const ev = (kind: TeamEvent['kind'], o: Partial<TeamEvent> = {}): TeamEvent => ({ n: 1, workspaceId: 'w1', kind, pr: 54, ...o })
  const auto = { why: "the code review approved its latest commit, its check passed, it changes 12 lines, within the user's limit of 400, and it changes no path that always needs a person's review", card: 'Code approved, checks passed, 12 lines' }

  it('asks for a short merge summary on the ready to merge line, and says why auto-merge left the PR when it is on', () => {
    const review = { approved: ['code' as const], blocking: [], blockers: false, reviewing: [], inProgress: false, waiting: [] }
    const c = { allMerged: () => false, review }
    expect(decide({ ws: ws('ready'), name: 'Kai', events: [ev('pr.ready')] }, c).todo).toEqual([
      'PR #54 passed checks, has no conflicts and the code review approved it. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran, and anything they should know.'
    ])
    expect(decide({ ws: ws('ready'), name: 'Kai', events: [ev('pr.ready')] }, { ...c, refused: () => 'It changes 612 lines, more than the 400 auto-merge allows.' }).todo).toEqual([
      "PR #54 passed checks, has no conflicts and the code review approved it. Auto-merge is on, and Kernel didn't merge it. It changes 612 lines, more than the 400 auto-merge allows. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran, why Kernel didn't merge it, and anything they should know."
    ])
  })

  it('tells Kernel to pass on a merge Kernel made by itself, with the link, even once the work is archived', () => {
    const out = decide({ ws: { ...ws('merged'), status: 'archived' }, name: 'Kai', events: [ev('pr.merged', { auto })] }, { allMerged: () => false })
    expect(out.todo).toEqual(['Tell the user Kernel merged PR #54 automatically and why, in a line or two, with its link https://github.com/o/shop/pull/54.'])
  })

  /** Kai's ready PR #54 in w1, and Theo's review workspace of it, handed off in the Lead chat lc. */
  async function lead() {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-am-')), 'k.db'))
    store.saveRoom({ id: 'r', name: 'Shop', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
    const base = { roomId: 'r', baseRef: 'main', mode: 'worktree', port: 1, status: 'ready', leadChatId: 'lc', createdAt: 1 }
    store.saveWorkspace({ ...base, id: 'w1', name: 'w1', branch: 'w1', path: '/x/w1', agentId: 'kai', prState: 'ready', prNumber: 54, prUrl: 'https://github.com/o/shop/pull/54', title: 'Task' } as Workspace)
    store.saveWorkspace({ ...base, id: 'rv', name: 'rv', branch: 'rv', path: '/x/rv', agentId: 'theo', prState: 'none', reviewOf: 'w1', title: 'Review PR #54' } as Workspace)
    store.saveChat({ id: 'lc', workspaceId: 'lead', title: 'lc', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 } as Chat)
    const posts: { text: string; update: TeamUpdate }[] = []
    const u = new LeadUpdates({
      store, enabled: () => true, target: () => ({ chat: store.chat('lc')! }), isLead: () => false, agentName: (_r, id) => (id === 'kai' ? 'Kai' : 'Theo'),
      post: (_chatId, text, update) => { posts.push({ text, update }); return true }, delayMs: 10
    })
    u.attach()
    open.push(u)
    return { store, u, posts }
  }

  it('holds a verdict about a PR Kernel is weighing for auto-merge until it knows the outcome', async () => {
    const { store, u, posts } = await lead()
    u.readingPr('w1')
    u.reviewed(store.workspace('rv')!, store.workspace('w1')!, { workspaceId: 'rv', agentId: 'theo', verdict: 'approved', summary: 'Good.', lens: 'code', ts: 1 })
    await new Promise((r) => setTimeout(r, 60))
    expect(posts).toEqual([])
    u.readPr('w1')
    await vi.waitFor(() => expect(posts).toHaveLength(1))
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
