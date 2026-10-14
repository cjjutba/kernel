import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatPart } from '../src/shared/types'
import { ageOf, branchLine, branchRows } from '../src/renderer/src/screens/workspace/composer/branchRows'

// KERNEL-786: New chat's where row. Moving the typed draft between rooms, and the branch menu's tags.

const words = (t: string): ChatPart[] => [{ type: 'text', text: t }]

describe('picking another room under the box', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('moves the typed draft to the picked room and leaves the first room empty', async () => {
    vi.resetModules()
    const { loadDraft, moveDraft, newChatDraftOf, saveDraft } = await import('../src/renderer/src/screens/workspace/composer/draftStore')
    saveDraft(newChatDraftOf('a'), words('add a retry'), '')
    moveDraft(newChatDraftOf('a'), newChatDraftOf('b'))
    expect(loadDraft(newChatDraftOf('b'))).toEqual(words('add a retry'))
    expect(loadDraft(newChatDraftOf('a'))).toBeUndefined()
  })

  it('keeps each room\'s model picks where they were made, and replaces the other room\'s text', async () => {
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

  it('moves nothing from an empty box, or to the same room', async () => {
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
    { id: 'w1', roomId: 'r', branch: 'feat/kernel-713', status: 'ready' as const },
    { id: 'w2', roomId: 'other', branch: 'fix/kernel-717', status: 'ready' as const },
    { id: 'w3', roomId: 'r', branch: 'spike/local-only', status: 'archived' as const }
  ]
  const rows = branchRows({ list, fallback: 'origin/main', remote: 'origin', workspaces, roomId: 'r', now })

  it('lists the default first, then the repo\'s branches once each, without the remote HEAD', () => {
    expect(rows.map((r) => r.name)).toEqual(['main', 'feat/kernel-713', 'fix/kernel-717', 'spike/local-only'])
  })

  it('tags the default, a branch with an open workspace in this room, a remote branch, and nothing for a local one', () => {
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
    const r = branchRows({ list, fallback: 'origin/main', remote: 'origin', workspaces: [{ id: 'w', roomId: 'r', branch: 'main', status: 'ready' }], roomId: 'r', now })
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
