import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatItem, ChatPart, PrInfo, Workspace } from '@shared/types'
import { tempRepo } from './helpers'
import { git } from '../src/main/services/exec'
import { checkOf, parseReviews, prNote, prStateOf, resolveFile, type PrView } from '../src/main/services/github'
import { headerView, instructionOf, prToast, reviewLines } from '../src/renderer/src/screens/workspace/pr/model'
import { Kernel } from '../src/main/kernel'

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

const info = (o: Partial<PrInfo> = {}): PrInfo => ({ workspaceId: 'w', number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state: 'ready', baseRef: 'main', checks: [], comments: [], conflicts: [], ...o })

describe('what Kernel tells the agent and the chat', () => {
  it('sends the review comments, failing checks or conflicting files with the instructions', () => {
    const [name, text] = resolveFile('changes', '', info({ comments: [
      { id: '1', author: 'theo', path: 'src/table.tsx', line: 42, body: 'Use EmptyState.', resolved: false },
      { id: '2', author: 'theo', path: 'src/page.tsx', line: 1, body: 'Fixed already', resolved: true }
    ] }))
    expect(name).toBe('address-review.md')
    expect(text).toContain('- src/table.tsx:42 (theo): Use EmptyState.')
    expect(text).not.toContain('Fixed already')
    expect(resolveFile('cifail', '', info({ checks: [{ name: 'playwright', state: 'fail', url: 'https://ci/1' }, { name: 'lint', state: 'pass' }] }))[1]).toContain('- playwright https://ci/1')
    expect(resolveFile('conflict', '# Resolve conflicts', info({ conflicts: ['src/a.ts'] }))).toEqual(['resolve-conflicts.md', '# Resolve conflicts\n\nConflicting files:\n- src/a.ts'])
  })

  it('notes merges, closes and failed checks', () => {
    const ws = { prNumber: 42, baseRef: 'origin/main' } as Workspace
    expect(prNote({ ...ws, prState: 'merged' }, info(), 'squash')).toBe('PR #42 was squashed into main.')
    expect(prNote({ ...ws, prState: 'merged' }, info())).toBe('PR #42 was merged on GitHub.')
    expect(prNote({ ...ws, prState: 'closed' }, info())).toBe('PR #42 was closed without merging on GitHub.')
    expect(prNote({ ...ws, prState: 'cifail' }, info({ checks: [{ name: 'lint', state: 'fail' }, { name: 'playwright', state: 'fail' }] }))).toBe('lint and playwright failed on the PR.')
    expect(prNote({ ...ws, prState: 'ready' }, info())).toBeUndefined()
  })
})

describe('PR header and toasts', () => {
  it('has a layout for every state', () => {
    expect(headerView('none')).toMatchObject({ link: false, caret: true, button: { label: 'Create PR', action: 'create' } })
    expect(headerView('none', false).button).toBeUndefined()
    expect(headerView('none', false).caret).toBe(false)
    expect(headerView('checks').button).toMatchObject({ label: 'Checks running', kind: 'busy' })
    expect(headerView('conflict').button).toMatchObject({ label: 'Resolve conflicts', action: 'resolve' })
    expect(headerView('ready').button).toMatchObject({ label: 'Merge PR', action: 'merge' })
    expect(headerView('merged')).toMatchObject({ merged: true, link: true })
    expect(headerView('merged').button).toBeUndefined()
    expect(headerView('draft')).toMatchObject({ status: { text: 'Draft' }, button: { label: 'Ready for review', action: 'ready' } })
    expect(headerView('cifail')).toMatchObject({ status: { text: 'Checks failed', tone: 'del' }, button: { label: 'Fix checks' } })
    expect(headerView('changes')).toMatchObject({ status: { text: 'Changes requested' }, button: { label: 'Address review' } })
    expect(headerView('closed')).toMatchObject({ status: { text: 'Closed' }, button: { label: 'Reopen' }, archive: true })
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
  async function setup(settings: object = {}) {
    const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
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
