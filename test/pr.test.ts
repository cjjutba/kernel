import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatItem, ChatPart, PrInfo, PrState, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { tempRepo } from './helpers'
import { git } from '../src/main/services/exec'
import { checkOf, infoOf, parseReviews, prNote, prStateOf, resolveFile, type PrView } from '../src/main/services/github'
import { afterArchive, headerView, instructionOf, prToast, reviewLines } from '../src/renderer/src/screens/workspace/pr/model'
import { Kernel } from '../src/main/kernel'
import { DEFAULT_SETTINGS, prInstructions } from '../src/main/services/settings'
import { LEAD_REVIEW_RULE, LEAD_RULE } from '../src/main/services/handoff'
import { mergeBlock, mergeableState } from '@shared/merge'

describe('checks from statusCheckRollup', () => {
  it('maps check runs and status contexts, with durations', () => {
    expect(checkOf({ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-07T10:00:00Z', completedAt: '2026-10-07T10:00:12Z', detailsUrl: 'u' })).toEqual({ name: 'lint', state: 'pass', meta: '12s', url: 'u' })
    expect(checkOf({ name: 'e2e', status: 'COMPLETED', conclusion: 'TIMED_OUT' }).state).toBe('fail')
    expect(checkOf({ name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' }).state).toBe('skipped')
    expect(checkOf({ name: 'build', status: 'QUEUED', conclusion: null }).state).toBe('queued')
    expect(checkOf({ name: 'build', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-10-07T10:00:00Z', completedAt: '0001-01-01T00:00:00Z' })).toEqual({ name: 'build', state: 'running' })
    expect(checkOf({ context: 'Vercel', state: 'PENDING', targetUrl: 'v' })).toEqual({ name: 'Vercel', state: 'running', url: 'v' })
    expect(checkOf({ context: 'Vercel', state: 'SUCCESS' }).state).toBe('pass')
  })

  it('reads a skipped check as green and a queued one as running', () => {
    const pr: PrView = { number: 1, url: 'u', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'SKIPPED' }] }
    expect(prStateOf(pr)).toBe('ready')
    expect(prStateOf({ ...pr, statusCheckRollup: [{ name: 'a', status: 'QUEUED' }] })).toBe('checks')
  })
})

describe('review comments', () => {
  it('keeps one comment per thread and the text of each changes-requested review', () => {
    const json = JSON.stringify({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [
        { isResolved: false, path: 'src/app/invoices/table.tsx', line: 42, originalLine: 40, comments: { nodes: [{ id: 'c1', body: ' Use the shared EmptyState. ', author: { login: 'theo' } }] } },
        { isResolved: true, path: 'src/page.tsx', line: null, originalLine: 18, comments: { nodes: [{ id: 'c2', body: 'Done', author: null }] } },
        { isResolved: false, path: 'x.ts', line: 1, comments: { nodes: [] } }
      ] },
      latestReviews: { nodes: [
        { id: 'r1', state: 'CHANGES_REQUESTED', body: 'Two things before this lands.', author: { login: 'theo' } },
        { id: 'r2', state: 'APPROVED', body: 'Looks good', author: { login: 'ivy' } },
        { id: 'r3', state: 'CHANGES_REQUESTED', body: '', author: { login: 'noor' } }
      ] }
    } } } })
    expect(parseReviews(json)).toEqual([
      { id: 'r1', author: 'theo', body: 'Two things before this lands.', resolved: false },
      { id: 'c1', author: 'theo', path: 'src/app/invoices/table.tsx', line: 42, body: 'Use the shared EmptyState.', resolved: false },
      { id: 'c2', author: '', path: 'src/page.tsx', line: 18, body: 'Done', resolved: true }
    ])
    expect(parseReviews('nope')).toEqual([])
  })

  it('lines up the review card rows', () => {
    expect(reviewLines([
      { id: '1', author: 'Theo', path: 'src/app/invoices/table.tsx', line: 42, body: 'Use the shared EmptyState from components/ui.', resolved: false },
      { id: '2', author: 'Theo', path: 'src/app/invoices/page.tsx', line: 18, body: 'Keep the skeleton up.', resolved: false }
    ])).toEqual(['table.tsx:42   Use the shared EmptyState from components/ui.', 'page.tsx:18    Keep the skeleton up.'])
  })
})

const TEXTS = { resolveInstructions: '# Resolve conflicts', fixChecksInstructions: '# Fix checks', addressReviewInstructions: '# Address review' }
const info = (o: Partial<PrInfo> = {}): PrInfo => ({ workspaceId: 'w', number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state: 'ready', baseRef: 'main', checks: [], comments: [], conflicts: [], ...o })

describe('what Kernel tells the agent and the chat', () => {
  it('sends the review comments, failing checks or conflicting files with the instructions', () => {
    const [name, text] = resolveFile('changes', TEXTS, info({ comments: [
      { id: '1', author: 'theo', path: 'src/table.tsx', line: 42, body: 'Use EmptyState.', resolved: false },
      { id: '2', author: 'theo', path: 'src/page.tsx', line: 1, body: 'Fixed already', resolved: true }
    ] }))
    expect(name).toBe('address-review.md')
    expect(text).toContain('- src/table.tsx:42 (theo): Use EmptyState.')
    expect(text).not.toContain('Fixed already')
    expect(resolveFile('cifail', TEXTS, info({ checks: [{ name: 'playwright', state: 'fail', url: 'https://ci/1' }, { name: 'lint', state: 'pass' }] }))[1]).toContain('- playwright https://ci/1')
    expect(resolveFile('conflict', TEXTS, info({ conflicts: ['src/a.ts'] }))).toEqual(['resolve-conflicts.md', '# Resolve conflicts\n\nConflicting files:\n- src/a.ts'])
    expect(resolveFile('cifail', TEXTS, info())[1]).toBe('# Fix checks')
    expect(resolveFile('changes', TEXTS, info())[1]).toBe('# Address review')
  })

  it('notes merges, closes and failed checks', () => {
    const ws = { prNumber: 42, baseRef: 'origin/main' } as Workspace
    expect(prNote({ ...ws, prState: 'merged' }, info(), 'squash')).toBe('PR #42 was squashed into main.')
    expect(prNote({ ...ws, prState: 'merged' }, info())).toBe('PR #42 was merged on GitHub.')
    expect(prNote({ ...ws, prState: 'closed' }, info())).toBe('PR #42 was closed without merging on GitHub.')
    expect(prNote({ ...ws, prState: 'cifail' }, info({ checks: [{ name: 'lint', state: 'fail' }, { name: 'playwright', state: 'fail' }] }))).toBe('lint and playwright failed on the PR.')
    expect(prNote({ ...ws, prState: 'ready' }, info())).toBeUndefined()
    // The base names the room's remote (KERNEL-190).
    expect(prNote({ ...ws, baseRef: 'upstream/main', prState: 'merged' }, { ...info(), baseRef: '' }, 'merge', 'upstream')).toBe('PR #42 was merged into main.')
  })

  it("picks each PR instruction from the room, then the app, then the default (KERNEL-190)", () => {
    const defaults = DEFAULT_SETTINGS('').pr
    const app = { ...defaults, createInstructions: '# App create', fixChecksInstructions: '' }
    expect(prInstructions(app, { createInstructions: '# Room create', addressReviewInstructions: '  ' })).toEqual({
      createInstructions: '# Room create', resolveInstructions: defaults.resolveInstructions,
      fixChecksInstructions: defaults.fixChecksInstructions, addressReviewInstructions: defaults.addressReviewInstructions
    })
    expect(prInstructions(app).createInstructions).toBe('# App create')
    expect(defaults.fixChecksInstructions).toMatch(/^# Fix failing checks/)
    expect(defaults.addressReviewInstructions).toMatch(/^# Address review/)
  })
})

describe('PR header and toasts', () => {
  it('has a layout for every state', () => {
    expect(headerView('none')).toMatchObject({ link: false, caret: true, button: { label: 'Create PR', action: 'create' } })
    expect(headerView('none', false).button).toBeUndefined()
    expect(headerView('none', false)).toMatchObject({ link: false, caret: false })
    expect(headerView('checks').button).toMatchObject({ label: 'Checks running', kind: 'busy' })
    expect(headerView('conflict').button).toMatchObject({ label: 'Resolve conflicts', action: 'resolve' })
    expect(headerView('ready').button).toMatchObject({ label: 'Merge PR', action: 'merge' })
    expect(headerView('merged')).toMatchObject({ merged: true, link: true })
    expect(headerView('merged').button).toBeUndefined()
    expect(headerView('draft')).toMatchObject({ state: { label: 'Draft', tone: 'idle' }, button: { label: 'Ready for review', action: 'ready' } })
    expect(headerView('cifail')).toMatchObject({ state: { label: 'Checks failed', tone: 'fail' }, button: { label: 'Fix checks' } })
    expect(headerView('changes')).toMatchObject({ state: { label: 'Changes requested', tone: 'fail' }, button: { label: 'Address review' } })
    expect(headerView('closed')).toMatchObject({ state: { label: 'Closed', tone: 'idle', glyph: 'prClosed' }, button: { label: 'Reopen' }, archive: true })
  })

  it('offers Merge PR in exactly the states the merge rule lets through (KERNEL-349)', () => {
    const states = Object.keys({ none: 1, creating: 1, draft: 1, open: 1, checks: 1, cifail: 1, changes: 1, conflict: 1, resolving: 1, ready: 1, merging: 1, merged: 1, closed: 1 } satisfies Record<PrState, 1>) as PrState[]
    for (const s of states) {
      const ws = { id: 'w', prState: s, prNumber: 42 } as Workspace
      expect(headerView(s).button?.action === 'merge', s).toBe(!mergeBlock(ws, undefined, { requireGreen: false, requireReviewer: false }))
      expect(mergeableState(s), s).toBe(s === 'ready' || s === 'open')
    }
  })

  it('names every state and gives its band a tone, without a spinner in the label (KERNEL-274)', () => {
    const label = (s: Parameters<typeof headerView>[0], changed?: boolean) => { const { state } = headerView(s, changed); return `${state.label}/${state.tone}/${state.glyph}` }
    expect(label('none', false)).toBe('No changes yet/idle/branch')
    expect(label('none')).toBe('No PR yet/idle/branch')
    expect(label('creating')).toBe('No PR yet/idle/branch')
    expect(label('open')).toBe('Open/ready/pr')
    expect(label('checks')).toBe('Open/idle/pr')
    expect(label('conflict')).toBe('Merge conflicts/fail/pr')
    expect(label('resolving')).toBe('Merge conflicts/fail/pr')
    expect(label('ready')).toBe('Ready to merge/ready/pr')
    expect(label('merging')).toBe('Ready to merge/ready/pr')
    expect(label('merged')).toBe('Merged/merged/merged')
    expect(label('draft')).toBe('Draft/idle/prDraft')
  })

  it('toasts a created PR, a merge, and a create that ended without a PR', () => {
    const ws = { prNumber: 42, prUrl: 'u', prTitle: 'feat: table', baseRef: 'origin/main' } as Workspace
    expect(prToast(undefined, { ...ws, prState: 'merged' })).toBeUndefined()
    expect(prToast('creating', { ...ws, prState: 'checks' })).toEqual({ title: 'PR #42 created', sub: 'feat: table', action: { label: 'View', href: 'u' } })
    expect(prToast('creating', { ...ws, prState: 'draft' })?.sub).toBe('Opened as a draft')
    expect(prToast('merging', { ...ws, prState: 'merged' }, { method: 'squash' })).toEqual({ title: 'PR #42 merged', sub: 'Squashed into main', action: { label: 'View', href: 'u' } })
    expect(prToast('ready', { ...ws, prState: 'merged' })?.sub).toBe('Merged on GitHub')
    expect(prToast('creating', { ...ws, prNumber: undefined, prState: 'none' }, { agent: 'Kai' })).toEqual({ title: 'Could not create the PR', sub: 'Kai finished without opening one.' })
    expect(prToast('checks', { ...ws, prState: 'ready' })).toBeUndefined()
  })

  it('draws only PR instruction files as a sent card', () => {
    const user = (parts: ChatPart[]): ChatItem => ({ kind: 'user', id: 'u', ts: 0, parts })
    expect(instructionOf(user([{ type: 'file', name: 'create-pr.md', text: '# Create' }]))?.name).toBe('create-pr.md')
    expect(instructionOf(user([{ type: 'file', name: 'pasted_text_1.txt', text: 'log' }]))).toBeUndefined()
    expect(instructionOf(user([{ type: 'text', text: 'hi' }, { type: 'file', name: 'create-pr.md', text: 'x' }]))).toBeUndefined()
  })
})

describe('PR flow in the kernel (gh and the session stubbed)', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  async function setup(settings: object = {}) {
    const repo = await tempRepo({
      'README.md': '# client\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
      '.claude/agents/theo.md': '---\nname: theo\ndescription: Reviewer.\nrole: Reviewer\n---\nYou are Theo.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...settings }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const sent: ChatPart[][] = []
    let running = false
    k.sessions.send = async (_chatId, parts) => { sent.push(parts); return { queued: false } }
    k.sessions.isRunning = () => running
    const gh = { pr: null as PrInfo | null, merged: [] as string[] }
    k.github = {
      info: async (_cwd, _ref, workspaceId) => (gh.pr ? { ...gh.pr, workspaceId } : null),
      merge: async (_cwd, _ref, method) => { gh.merged.push(method); if (gh.pr) gh.pr = { ...gh.pr, state: 'merged' } },
      ready: async () => undefined,
      reopen: async () => undefined
    }
    const room = await k.addRoom(repo)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    sent.length = 0
    const notes = () => k.store.items(k.store.chats(ws.id)[0].id).flatMap((i) => (i.kind === 'note' ? [i.text] : []))
    return { k, ws, sent, gh, notes, busy: (b: boolean) => { running = b } }
  }

  it('creates through the agent, holds Creating during the turn, then follows GitHub', async () => {
    const { k, ws, sent, gh, busy } = await setup({ pr: { draft: false } })
    busy(true)
    expect((await k.createPr(ws.id, true)).prState).toBe('creating')
    const file = sent[0][0]
    expect(file.type === 'file' && file.name === 'create-pr.md' && file.text?.endsWith('\nOpen as draft')).toBe(true)
    expect((await k.refreshPr(ws.id)).prState).toBe('creating')
    busy(false)
    gh.pr = info({ state: 'draft' })
    expect(await k.refreshPr(ws.id)).toMatchObject({ prState: 'draft', prNumber: 42, prTitle: 'feat: table' })
    await expect(k.createPr(ws.id)).rejects.toThrow('already has a pull request')
    await k.stop()
  })

  it("saves the PR's head commit as GitHub reports it, so a review of another commit reads as stale (KERNEL-130)", async () => {
    const { k, ws, gh } = await setup()
    const view = { number: 42, url: 'u', state: 'OPEN' as const, isDraft: false, mergeable: 'MERGEABLE' as const, reviewDecision: null, statusCheckRollup: [] }
    expect(infoOf('w', { ...view, headRefOid: 'abc' }, [], []).head).toBe('abc')
    expect(infoOf('w', view, [], [])).not.toHaveProperty('head')
    gh.pr = { ...info({ state: 'ready' }), head: 'abc' }
    expect((await k.refreshPr(ws.id)).prHead).toBe('abc')
    gh.pr = { ...info({ state: 'checks' }), head: 'def' }
    expect((await k.refreshPr(ws.id)).prHead).toBe('def')
    await k.stop()
  })

  it('never reads a PR GitHub is still checking for conflicts as ready (KERNEL-283)', () => {
    const view: PrView = { number: 42, url: 'u', state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN', reviewDecision: null, statusCheckRollup: [{ name: 'e2e', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
    expect(prStateOf(view)).toBe('checks')
    expect(infoOf('w', view, [], [])).toMatchObject({ state: 'checks', conflictsUnknown: true })
    // The rest of the read is real.
    expect(prStateOf({ ...view, statusCheckRollup: [{ name: 'e2e', status: 'COMPLETED', conclusion: 'FAILURE' }] })).toBe('cifail')
    expect(prStateOf({ ...view, reviewDecision: 'CHANGES_REQUESTED' })).toBe('changes')
    // Settled, draft or closed PRs aren't waiting on GitHub.
    for (const v of [{ ...view, mergeable: 'MERGEABLE' as const }, { ...view, isDraft: true }, { ...view, state: 'MERGED' as const }]) expect(infoOf('w', v, [], [])).not.toHaveProperty('conflictsUnknown')
  })

  it('holds a conflict and leaves ready while GitHub checks for conflicts, then follows it after one quick read (KERNEL-283)', async () => {
    const { k, ws, gh } = await setup()
    const states: string[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'pr' && e.workspaceId === ws.id) states.push(e.state) }
    bus.on('push', onPush)
    let reads = 0
    const read = k.github.info
    k.github = { ...k.github, info: async (...a) => { reads++; return read(...a) } }
    k.prs.recheckMs = 30
    const unknown = (o: Partial<PrInfo> = {}) => info({ state: 'checks', conflictsUnknown: true, ...o })

    // Ready, then main moves: checks until GitHub settles, and one quick read follows it back to ready.
    gh.pr = info({ state: 'ready' })
    await k.prs.refreshPr(ws.id)
    gh.pr = unknown()
    expect((await k.prs.refreshPr(ws.id)).prState).toBe('checks')
    // A second unknown read before the quick one doesn't queue another.
    await k.prs.refreshPr(ws.id)
    gh.pr = info({ state: 'ready' })
    reads = 0
    // The quick read runs real git before it reaches the stub, so wait for it, then check no second one follows.
    await vi.waitFor(() => expect(reads).toBe(1))
    await wait(100)
    expect(reads).toBe(1)
    expect(k.store.workspace(ws.id)?.prState).toBe('ready')

    // A conflict stays a conflict, even with checks failing meanwhile, until GitHub says it is gone.
    gh.pr = info({ state: 'conflict' })
    await k.prs.refreshPr(ws.id)
    gh.pr = unknown({ state: 'cifail', checks: [{ name: 'e2e', state: 'fail' }] })
    expect((await k.prs.refreshPr(ws.id)).prState).toBe('conflict')
    gh.pr = unknown()
    reads = 0
    await vi.waitFor(() => expect(reads).toBe(1))
    await wait(100)
    // Still unknown after the quick read: the poll takes it from there.
    expect(reads).toBe(1)
    expect(k.store.workspace(ws.id)?.prState).toBe('conflict')
    gh.pr = info({ state: 'ready' })
    expect((await k.prs.refreshPr(ws.id)).prState).toBe('ready')
    expect(states).toEqual(['ready', 'checks', 'ready', 'conflict', 'ready'])

    // Archiving drops a pending quick read.
    // A quick read that started while the archive was still running lands on its own time, so wait it out before counting.
    let inflight = 0
    const refresh = k.refreshPr.bind(k)
    k.refreshPr = async (...a) => { inflight++; try { return await refresh(...a) } finally { inflight-- } }
    gh.pr = unknown()
    await k.prs.refreshPr(ws.id)
    await k.archive.archiveWorkspace(ws.id)
    await vi.waitFor(() => expect(inflight).toBe(0))
    reads = 0
    await wait(100)
    // A read that starts after the archive must still show up, even when it lands late.
    await vi.waitFor(() => expect(inflight).toBe(0))
    expect(reads).toBe(0)
    bus.off('push', onPush)
    await k.stop()
  })

  it('reads every PR GitHub is still checking on one shared timer (KERNEL-283)', async () => {
    const { k, ws, gh } = await setup()
    const other = await k.workspaces.createWorkspace(ws.roomId, { prompt: 'Build the inbox', agentId: 'kai', title: 'Inbox' })
    const read: string[] = []
    k.github = { ...k.github, info: async (_cwd, _ref, workspaceId) => { read.push(workspaceId); return gh.pr ? { ...gh.pr, workspaceId } : null } }
    k.prs.recheckMs = 37
    const timers = vi.spyOn(globalThis, 'setTimeout')
    // Right after a merge, GitHub checks every other PR for conflicts again.
    gh.pr = info({ state: 'conflict' })
    await k.prs.refreshPr(ws.id)
    await k.prs.refreshPr(other.id)
    gh.pr = info({ state: 'checks', conflictsUnknown: true })
    await k.prs.refreshPr(ws.id)
    await k.prs.refreshPr(other.id)
    expect(timers.mock.calls.filter(([, ms]) => ms === 37)).toHaveLength(1)
    timers.mockRestore()
    // No pr.ready while unknown: both stay in conflict until GitHub says MERGEABLE.
    expect([k.store.workspace(ws.id)?.prState, k.store.workspace(other.id)?.prState]).toEqual(['conflict', 'conflict'])
    gh.pr = info({ state: 'ready' })
    read.length = 0
    await wait(120)
    expect(read.sort()).toEqual([ws.id, other.id].sort())
    expect([k.store.workspace(ws.id)?.prState, k.store.workspace(other.id)?.prState]).toEqual(['ready', 'ready'])
    await k.stop()
  })

  it("refuses to merge a PR GitHub is still checking for conflicts, as not ready (KERNEL-283)", async () => {
    const { k, ws, gh } = await setup()
    gh.pr = info({ state: 'ready' })
    await k.prs.refreshPr(ws.id)
    gh.pr = info({ state: 'checks', conflictsUnknown: true })
    expect((await k.prs.refreshPr(ws.id)).prState).toBe('checks')
    await expect(k.prs.mergePr(ws.id)).rejects.toThrow('This pull request is not ready to merge.')
    expect(gh.merged).toEqual([])
    await k.stop()
  })

  it('reads GitHub before every merge, and refuses a PR that last read ready while GitHub checks it for conflicts (KERNEL-376)', async () => {
    const { k, ws, gh } = await setup()
    gh.pr = info({ state: 'ready' })
    await k.prs.refreshPr(ws.id)
    // Another PR merged since the last poll, so GitHub is working out again whether this one conflicts.
    gh.pr = info({ state: 'checks', conflictsUnknown: true })
    await expect(k.prs.mergePr(ws.id)).rejects.toThrow('This pull request is not ready to merge.')
    expect(gh.merged).toEqual([])
    expect(k.store.workspace(ws.id)?.prState).toBe('ready')
    // Once GitHub settles on mergeable, the merge goes ahead.
    gh.pr = info({ state: 'ready' })
    expect(await k.prs.mergePr(ws.id)).toMatchObject({ prState: 'merged' })
    expect(gh.merged).toEqual(['squash'])
    await k.stop()
  })

  it('reads GitHub before a merge that neither green checks nor a review needs it for (KERNEL-376)', async () => {
    const { k, ws, gh } = await setup({ pr: { requireGreen: false, requireReviewer: false } })
    gh.pr = info({ state: 'ready' })
    await k.prs.refreshPr(ws.id)
    gh.pr = info({ state: 'checks', conflictsUnknown: true })
    await expect(k.prs.mergePr(ws.id)).rejects.toThrow('This pull request is not ready to merge.')
    expect(gh.merged).toEqual([])
    await k.stop()
  })

  it('drops the quick read on stop (KERNEL-283)', async () => {
    const { k, ws, gh } = await setup()
    let reads = 0
    const read = k.github.info
    k.github = { ...k.github, info: async (...a) => { reads++; return read(...a) } }
    k.prs.recheckMs = 30
    gh.pr = info({ state: 'checks', conflictsUnknown: true })
    await k.prs.refreshPr(ws.id)
    await k.stop()
    reads = 0
    await wait(100)
    expect(reads).toBe(0)
  })

  it('goes back to Create PR when the turn ends without a PR', async () => {
    const { k, ws } = await setup()
    await k.createPr(ws.id)
    expect((await k.refreshPr(ws.id)).prState).toBe('none')
    await k.stop()
  })

  it('does not adopt an old merged PR on the same branch', async () => {
    const { k, ws, gh } = await setup()
    gh.pr = info({ state: 'merged' })
    expect((await k.refreshPr(ws.id)).prState).toBe('none')
    await k.stop()
  })

  it('sends review comments, notes failures, and merges only on green checks', async () => {
    const { k, ws, sent, gh, notes } = await setup()
    gh.pr = info({ state: 'cifail', checks: [{ name: 'playwright', state: 'fail' }] })
    expect((await k.refreshPr(ws.id)).prState).toBe('cifail')
    expect(notes()).toEqual(['playwright failed on the PR.'])

    gh.pr = info({ state: 'changes', comments: [{ id: 'c', author: 'theo', path: 'table.tsx', line: 42, body: 'Use EmptyState.', resolved: false }] })
    await k.refreshPr(ws.id)
    await k.resolvePr(ws.id)
    const file = sent[0][0]
    expect(file.type === 'file' && file.name === 'address-review.md' && file.text?.includes('table.tsx:42 (theo): Use EmptyState.')).toBe(true)
    expect(k.store.workspace(ws.id)?.prState).toBe('resolving')

    gh.pr = info({ state: 'ready', checks: [{ name: 'e2e', state: 'running' }] })
    await k.refreshPr(ws.id)
    await expect(k.mergePr(ws.id)).rejects.toThrow('Checks have not passed yet')
    expect(gh.merged).toEqual([])

    gh.pr = info({ state: 'ready', checks: [{ name: 'e2e', state: 'pass' }] })
    const merged = await k.mergePr(ws.id)
    expect(gh.merged).toEqual(['squash'])
    expect(merged).toMatchObject({ prState: 'merged' })
    expect(merged.mergedAt).toBeTypeOf('number')
    expect(notes().at(-1)).toBe('PR #42 was squashed into main.')
    await k.stop()
  })

  it('with Reviewer approval required, merges a reviewed PR only on an approval of its latest commit (KERNEL-115)', async () => {
    const { k, ws, gh } = await setup()
    const verdict = (v: 'approved' | 'blockers', sha: string, ts: number): NonNullable<Workspace['reviews']>[number] => ({ workspaceId: 'rev', agentId: 'theo', verdict: v, summary: '', sha, prNumber: 42, ts })
    const review = (...reviews: NonNullable<Workspace['reviews']>) => k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, reviews })
    const refusal = "Theo hasn't approved the latest commit. Merging waits for the reviewer's approval (Settings, Pull requests)."
    gh.pr = { ...info({ state: 'ready', checks: [{ name: 'e2e', state: 'pass' }] }), head: 'b'.repeat(40) }
    await k.prs.refreshPr(ws.id)

    review(verdict('blockers', 'b'.repeat(40), 1))
    await expect(k.prs.mergePr(ws.id)).rejects.toThrow(refusal)
    // An approval of the commit before the latest push doesn't count.
    review(verdict('approved', 'a'.repeat(40), 2))
    await expect(k.prs.mergePr(ws.id)).rejects.toThrow(refusal)
    // The poll last saw the approved commit, and a push since moved the head: the merge reads GitHub's head itself.
    review(verdict('approved', 'a'.repeat(40), 2))
    k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prHead: 'a'.repeat(40) })
    await expect(k.prs.mergePr(ws.id)).rejects.toThrow(refusal)
    expect(gh.merged).toEqual([])

    review(verdict('blockers', 'a'.repeat(40), 1), { ...verdict('approved', 'b'.repeat(40), 2), workspaceId: 'rev2' })
    expect(await k.prs.mergePr(ws.id)).toMatchObject({ prState: 'merged' })
    expect(gh.merged).toEqual(['squash'])
    await k.stop()
  })

  it('merges a PR nobody reviewed, and a reviewed one with the setting off (KERNEL-115)', async () => {
    const { k, ws, gh } = await setup()
    gh.pr = { ...info({ state: 'ready' }), head: 'b'.repeat(40) }
    await k.prs.refreshPr(ws.id)
    expect(await k.prs.mergePr(ws.id)).toMatchObject({ prState: 'merged' })

    const off = await setup({ pr: { requireReviewer: false } })
    off.gh.pr = { ...info({ state: 'ready' }), head: 'b'.repeat(40) }
    await off.k.prs.refreshPr(off.ws.id)
    off.k.store.saveWorkspace({ ...off.k.store.workspace(off.ws.id)!, reviews: [{ workspaceId: 'rev', agentId: 'theo', verdict: 'blockers', summary: '', sha: 'b'.repeat(40), prNumber: 42, ts: 1 }] })
    expect(await off.k.prs.mergePr(off.ws.id)).toMatchObject({ prState: 'merged' })
    await k.stop()
    await off.k.stop()
  })

  it("describes the automatic review in the Lead's prompt only while auto review is on (KERNEL-115)", async () => {
    const lead = { id: 'rowan', name: 'Rowan', role: 'Lead', description: '', lead: true, prompt: '', file: '' }
    const on = await setup()
    expect(on.k.tools.rulesFor(on.ws, lead)).toContain(LEAD_REVIEW_RULE)
    const off = await setup({ pr: { autoReview: false } })
    expect(off.k.tools.rulesFor(off.ws, lead) ?? '').not.toContain(LEAD_REVIEW_RULE)
    // Asked for, a review still goes to the reviewer.
    expect(LEAD_RULE).toContain('When the user asks for a review, hand the PR to the team\'s reviewer')
    await on.k.stop()
    await off.k.stop()
  })

  it('continues on a fresh branch from the base, in the same worktree', async () => {
    const { k, ws, gh, notes } = await setup()
    gh.pr = info({ state: 'ready' })
    await k.refreshPr(ws.id)
    gh.pr = info({ state: 'merged' })
    await k.refreshPr(ws.id)
    gh.pr = null
    const next = await k.continuePr(ws.id)
    expect(next).toMatchObject({ branch: 'feat/invoice-table-2', prState: 'none', prNumber: undefined, path: ws.path })
    expect((await git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('feat/invoice-table-2')
    expect(k.store.chats(ws.id)).toHaveLength(1)
    expect(notes().at(-1)).toBe('Continuing on feat/invoice-table-2 from main. The chat stays.')
    await k.stop()
  })
})

describe('PR instructions per room (KERNEL-190)', () => {
  const app = { createInstructions: '# App create', resolveInstructions: '# App resolve', fixChecksInstructions: '# App fix', addressReviewInstructions: '# App review' }
  const room = { createInstructions: '# Room create', resolveInstructions: '# Room resolve', fixChecksInstructions: '# Room fix', addressReviewInstructions: '# Room review' }

  it.each(['room', 'app', 'default'] as const)('Create PR, Resolve conflicts, Fix checks and Address review send the %s instruction', async (from) => {
    const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...(from === 'default' ? {} : { pr: app }) }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const sent: ChatPart[] = []
    k.sessions.send = async (_chatId, parts) => { sent.push(...parts); return { queued: false } }
    k.sessions.isRunning = () => false
    let pr: PrInfo | null = null
    k.github = { info: async (_cwd, _ref, workspaceId) => (pr ? { ...pr, workspaceId } : null), merge: async () => undefined, ready: async () => undefined, reopen: async () => undefined }
    const r = await k.addRoom(repo)
    if (from === 'room') await k.handlers()['settings.setRoom']({ roomId: r.id, patch: { pr: room } })
    const want = from === 'room' ? room : from === 'app' ? app : DEFAULT_SETTINGS('').pr
    const ws = await k.createWorkspace(r.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    const last = () => { const p = sent.at(-1)!; return p.type === 'file' ? [p.name, p.text] : [] }

    await k.createPr(ws.id)
    expect(last()).toEqual(['create-pr.md', want.createInstructions])
    for (const [state, name, text, extra] of [
      ['conflict', 'resolve-conflicts.md', want.resolveInstructions, { conflicts: ['src/a.ts'] }],
      ['cifail', 'fix-checks.md', want.fixChecksInstructions, { checks: [{ name: 'lint', state: 'fail' }] }],
      ['changes', 'address-review.md', want.addressReviewInstructions, { comments: [{ id: 'c', author: 'theo', body: 'Rename it.', resolved: false }] }]
    ] as [PrInfo['state'], string, string, Partial<PrInfo>][]) {
      pr = info({ state, ...extra })
      await k.refreshPr(ws.id, { settle: true })
      await k.resolvePr(ws.id)
      const [n, t] = last()
      expect(n).toBe(name)
      expect(t?.startsWith(`${text}\n\n`)).toBe(true)
    }
    expect(last()[1]).toContain('- Review (theo): Rename it.')
    await k.stop()
  })
})

describe('after the open workspace is archived (KERNEL-132)', () => {
  const ws = (extra: Partial<Workspace>) => ({ id: 'w', roomId: 'r', name: 'w', branch: 'b', baseRef: 'main', path: '/x', mode: 'worktree', agentId: 'theo', port: 1, status: 'archived', prState: 'none', createdAt: 1, ...extra }) as Workspace
  const kernel = { seen: true, byHand: false }

  it("opens the Lead's chat with a toast for a review Kernel archived on screen after its work merged or closed", () => {
    expect(afterArchive(ws({ reviewOf: 'k' }), ws({ id: 'k', prState: 'merged', prNumber: 108 }), 'Theo', kernel)).toEqual({ to: 'room', toast: { title: "Archived Theo's review after PR #108 merged", sub: 'Restore it from History.' } })
    expect(afterArchive(ws({ reviewOf: 'k' }), ws({ id: 'k', prState: 'closed', prNumber: 108 }), 'Theo', kernel)).toMatchObject({ toast: { title: "Archived Theo's review after PR #108 was closed" } })
  })

  it('names what it can: no PR number, or a reviewer no longer on the team', () => {
    expect(afterArchive(ws({ reviewOf: 'k' }), ws({ id: 'k', prState: 'merged' }), 'Theo', kernel)).toMatchObject({ toast: { title: "Archived Theo's review" } })
    expect(afterArchive(ws({ reviewOf: 'k' }), ws({ id: 'k', prState: 'merged', prNumber: 108 }), undefined, kernel)).toMatchObject({ toast: { title: 'Archived the review after PR #108 merged' } })
  })

  it('goes to History for any other archive: not a review, work still open, archived by hand, or already archived when opened', () => {
    expect(afterArchive(ws({}), undefined, 'Kai', kernel)).toEqual({ to: 'history' })
    expect(afterArchive(ws({ reviewOf: 'k' }), ws({ id: 'k', prState: 'ready', prNumber: 108 }), 'Theo', kernel)).toEqual({ to: 'history' })
    expect(afterArchive(ws({ reviewOf: 'k' }), undefined, 'Theo', kernel)).toEqual({ to: 'history' })
    const merged = ws({ id: 'k', prState: 'merged', prNumber: 108 })
    expect(afterArchive(ws({ reviewOf: 'k' }), merged, 'Theo', { seen: true, byHand: true })).toEqual({ to: 'history' })
    expect(afterArchive(ws({ reviewOf: 'k' }), merged, 'Theo', { seen: false, byHand: false })).toEqual({ to: 'history' })
  })
})
