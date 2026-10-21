import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatPart, Thread, Workspace } from '../src/shared/types'
import { checkoutHolder, reusableWorktrees } from '../src/shared/leadWorkspace'
import { ageOf, branchLine, branchRows } from '../src/renderer/src/screens/workspace/composer/branchRows'

// KERNEL-786: New chat's where row. Moving the typed draft between projects, and the branch menu's tags.

const words = (t: string): ChatPart[] => [{ type: 'text', text: t }]

describe('picking another project under the box', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('moves the typed draft to the picked project and leaves the first project empty', async () => {
    vi.resetModules()
    const { loadDraft, moveDraft, newChatDraftOf, saveDraft } = await import('../src/renderer/src/screens/workspace/composer/draftStore')
    saveDraft(newChatDraftOf('a'), words('add a retry'), '')
    moveDraft(newChatDraftOf('a'), newChatDraftOf('b'))
    expect(loadDraft(newChatDraftOf('b'))).toEqual(words('add a retry'))
    expect(loadDraft(newChatDraftOf('a'))).toBeUndefined()
  })

  it('keeps each project\'s model picks where they were made, and replaces the other project\'s text', async () => {
    vi.resetModules()
    const { loadDraft, loadPicks, moveDraft, newChatDraftOf, savePicks, saveDraft } = await import('../src/renderer/src/screens/workspace/composer/draftStore')
    saveDraft(newChatDraftOf('a'), words('from a'), '')
    savePicks(newChatDraftOf('a'), { model: 'opus-a' })
    saveDraft(newChatDraftOf('b'), words('old b'), '')
    savePicks(newChatDraftOf('b'), { model: 'sonnet-b' })
    moveDraft(newChatDraftOf('a'), newChatDraftOf('b'))
    expect(loadDraft(newChatDraftOf('b'))).toEqual(words('from a'))
    expect(loadPicks(newChatDraftOf('b'))).toEqual({ model: 'sonnet-b' })
    expect(loadPicks(newChatDraftOf('a'))).toEqual({ model: 'opus-a' })
  })

  it('moves nothing from an empty box, or to the same project', async () => {
    vi.resetModules()
    const { loadDraft, moveDraft, newChatDraftOf, saveDraft } = await import('../src/renderer/src/screens/workspace/composer/draftStore')
    saveDraft(newChatDraftOf('b'), words('keep me'), '')
    moveDraft(newChatDraftOf('a'), newChatDraftOf('b'))
    expect(loadDraft(newChatDraftOf('b'))).toEqual(words('keep me'))
    moveDraft(newChatDraftOf('b'), newChatDraftOf('b'))
    expect(loadDraft(newChatDraftOf('b'))).toEqual(words('keep me'))
  })
})

describe('the branch menu', () => {
  const now = 1_000_000_000_000
  const minutes = (n: number) => now - n * 60_000
  const list = [
    { name: 'origin/main', committedAt: minutes(60 * 24 * 8) },
    { name: 'origin/feat/kernel-713', committedAt: minutes(40) },
    { name: 'origin/fix/kernel-717', committedAt: minutes(60 * 24) },
    { name: 'spike/local-only', committedAt: minutes(60 * 3) },
    { name: 'feat/kernel-713', committedAt: minutes(30) },
    { name: 'origin/HEAD', committedAt: minutes(1) }
  ]
  const workspaces = [
    { id: 'w1', projectId: 'r', branch: 'feat/kernel-713', status: 'ready' as const },
    { id: 'w2', projectId: 'other', branch: 'fix/kernel-717', status: 'ready' as const },
    { id: 'w3', projectId: 'r', branch: 'spike/local-only', status: 'archived' as const }
  ]
  const rows = branchRows({ list, fallback: 'origin/main', remote: 'origin', workspaces, projectId: 'r', now })

  it('lists the default first, then the repo\'s branches once each, without the remote HEAD', () => {
    expect(rows.map((r) => r.name)).toEqual(['main', 'feat/kernel-713', 'fix/kernel-717', 'spike/local-only'])
  })

  it('tags the default, a branch with an open workspace in this project, a remote branch, and nothing for a local one', () => {
    expect(rows.map((r) => r.tag)).toEqual(['default', 'has a workspace', 'remote', ''])
    expect(rows[1].workspaceId).toBe('w1')
    expect(rows[2].workspaceId).toBeUndefined()
  })

  it('writes the age and tag line, and sets the remote ref as the base', () => {
    expect(branchLine(rows[0])).toBe('8d · default')
    expect(branchLine(rows[1])).toBe('40m · has a workspace')
    expect(rows[1].ref).toBe('origin/feat/kernel-713')
  })

  it('gives the default the tag even when a workspace is on it', () => {
    const r = branchRows({ list, fallback: 'origin/main', remote: 'origin', workspaces: [{ id: 'w', projectId: 'r', branch: 'main', status: 'ready' }], projectId: 'r', now })
    expect(r[0]).toMatchObject({ tag: 'default', workspaceId: 'w' })
  })

  it('writes ages tight', () => {
    expect(ageOf(minutes(0), now)).toBe('1m')
    expect(ageOf(minutes(59), now)).toBe('59m')
    expect(ageOf(minutes(60 * 5), now)).toBe('5h')
    expect(ageOf(minutes(60 * 24 * 3), now)).toBe('3d')
    expect(ageOf(minutes(60 * 24 * 15), now)).toBe('15d')
    expect(ageOf(minutes(60 * 24 * 45), now)).toBe('6w')
  })
})

describe('the Workspace menu offers', () => {
  const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, projectId: 'p', name: id, branch: `kernel/${id}`, baseRef: 'origin/main', path: `/wt/${id}`, mode: 'worktree', agentId: 'lead', lead: true, threadId: `t-${id}`, port: 4000, status: 'ready', prState: 'none', createdAt: 1, ...over })
  const thread = (id: string, over: Partial<Thread> = {}): Thread => ({ id: `t-${id}`, projectId: 'p', title: id, createdAt: 1, ...over })

  it('the worktrees of open chats, the chat touched last first and five at most, and none that cannot take a tab', () => {
    const open = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ws(id, { createdAt: i }))
    const threads = Object.fromEntries([...open.map((w, i) => thread(w.id, { createdAt: i })), thread('x'), thread('y'), thread('z'), thread('w')].map((t) => [t.id, t]))
    threads['t-a'] = thread('a', { createdAt: 0, lastSentAt: 100 })
    const others = [ws('x', { status: 'archived' }), ws('y', { folderGone: true }), ws('z', { worktreePending: {} }), ws('w', { mode: 'current' }), ws('v', { projectId: 'q' }), ws('u', { shared: true })]
    expect(reusableWorktrees([...others, ...open], threads, 'p').map((w) => w.id)).toEqual(['a', 'f', 'e', 'd', 'c'])
    expect(reusableWorktrees(open, { ...threads, 't-f': thread('f', { closedAt: 5 }) }, 'p').map((w) => w.id)).toEqual(['a', 'e', 'd', 'c', 'b'])
  })

  it('the checkout as taken by another open chat on it, never by the asking chat or an archived one', () => {
    const held = ws('h', { mode: 'current', path: '/repo' })
    expect(checkoutHolder([ws('a'), held], 'p', { agentId: 'lead', lead: true })?.id).toBe('h')
    expect(checkoutHolder([held], 'p', { id: 'h', agentId: 'lead', lead: true })).toBeUndefined()
    expect(checkoutHolder([{ ...held, status: 'archived' }], 'p', { agentId: 'lead', lead: true })).toBeUndefined()
    expect(checkoutHolder([held], 'q', { agentId: 'lead', lead: true })).toBeUndefined()
  })
})
