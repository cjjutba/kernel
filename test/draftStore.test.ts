import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatPart } from '../src/shared/types'

const words = (t: string): ChatPart[] => [{ type: 'text', text: t }]
const image: ChatPart = { type: 'image', name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' }
const file: ChatPart = { type: 'file', name: 'a.ts', path: 'src/a.ts' }

let disk: Map<string, string>
/** A fresh copy of the module each time, as a new launch: it loads from `disk` on first use. */
async function launch() {
  vi.resetModules()
  return import('../src/renderer/src/screens/workspace/composer/draftStore')
}
const onDisk = () => JSON.parse(disk.get('kernel.drafts') ?? 'null')

beforeEach(() => {
  vi.useFakeTimers()
  disk = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v), removeItem: (k: string) => void disk.delete(k) })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('composer draft store', () => {
  it('keeps a draft per chat and forgets one saved empty', async () => {
    const { loadDraft, saveDraft } = await launch()
    saveDraft('a', words('hello'), 'w1')
    saveDraft('b', words('other'), 'w1')
    expect(loadDraft('a')).toEqual(words('hello'))
    expect(loadDraft('b')).toEqual(words('other'))
    saveDraft('a', [], 'w1')
    expect(loadDraft('a')).toBeUndefined()
    expect(loadDraft('b')).toEqual(words('other'))
  })

  it('drops the drafts of closed chats, and their saved copy', async () => {
    const { dropDrafts, loadDraft, saveDraft } = await launch()
    saveDraft('a', words('1'), 'w1')
    saveDraft('b', words('2'), 'w1')
    saveDraft('c', words('3'), 'w1')
    vi.advanceTimersByTime(500)
    dropDrafts(['a', 'c', 'never-had-one'])
    expect([loadDraft('a'), loadDraft('b'), loadDraft('c')]).toEqual([undefined, words('2'), undefined])
    vi.advanceTimersByTime(500)
    expect(Object.keys(onDisk().drafts)).toEqual(['b'])
  })
})

describe('drafts on disk', () => {
  it('writes 500 ms after the last change, as one write', async () => {
    const { saveDraft } = await launch()
    const set = vi.spyOn(localStorage, 'setItem')
    saveDraft('a', words('h'), 'w1')
    vi.advanceTimersByTime(400)
    saveDraft('a', words('he'), 'w1')
    vi.advanceTimersByTime(400)
    expect(set).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(set).toHaveBeenCalledTimes(1)
    expect(onDisk()).toEqual({ v: 1, drafts: { a: { workspaceId: 'w1', parts: words('he') } } })
  })

  it('writes when the page is hidden or about to unload, without waiting', async () => {
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', { addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn) })
    const { saveDraft } = await launch()
    saveDraft('a', words('hi'), 'w1')
    expect([...listeners.keys()].sort()).toEqual(['beforeunload', 'pagehide'])
    expect(disk.size).toBe(0)
    listeners.get('pagehide')!()
    expect(onDisk().drafts.a.parts).toEqual(words('hi'))
    saveDraft('a', words('hi there'), 'w1')
    listeners.get('beforeunload')!()
    expect(onDisk().drafts.a.parts).toEqual(words('hi there'))
  })

  it('comes back after a relaunch, text and chips in order, loaded once on first use', async () => {
    const first = await launch()
    first.saveDraft('a', [...words('see '), file, ...words(' please')], 'w1')
    vi.advanceTimersByTime(500)
    const get = vi.spyOn(localStorage, 'getItem')
    const second = await launch()
    expect(get).not.toHaveBeenCalled()
    expect(second.loadDraft('a')).toEqual([...words('see '), file, ...words(' please')])
    second.loadDraft('b')
    second.saveDraft('c', words('x'), 'w1')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('never writes an image chip, and writes nothing for a draft of only an image', async () => {
    const { saveDraft, loadDraft } = await launch()
    saveDraft('a', [...words('look '), image, ...words(' here')], 'w1')
    saveDraft('b', [image], 'w1')
    vi.advanceTimersByTime(500)
    expect(onDisk().drafts).toEqual({ a: { workspaceId: 'w1', parts: [...words('look '), ...words(' here')] } })
    expect(disk.get('kernel.drafts')).not.toContain('dataUrl')
    // In memory the image is still there until the app quits.
    expect(loadDraft('b')).toEqual([image])
    const again = await launch()
    expect(again.loadDraft('b')).toBeUndefined()
  })

  it('keeps a draft over 100 KB in memory only', async () => {
    const { saveDraft, loadDraft } = await launch()
    const big = words('x'.repeat(101 * 1024))
    saveDraft('big', big, 'w1')
    saveDraft('small', words('ok'), 'w1')
    vi.advanceTimersByTime(500)
    expect(Object.keys(onDisk().drafts)).toEqual(['small'])
    expect(loadDraft('big')).toEqual(big)
  })

  it('keeps drafts in memory, and clears the older copy, when the write hits the quota', async () => {
    const { saveDraft, loadDraft } = await launch()
    saveDraft('a', words('1'), 'w1')
    vi.advanceTimersByTime(500)
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') }, removeItem: (k: string) => void disk.delete(k) })
    saveDraft('a', words('12'), 'w1')
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    expect(loadDraft('a')).toEqual(words('12'))
    // The old copy goes, or "1" would come back after a restart.
    expect(disk.has('kernel.drafts')).toBe(false)
  })

  it('does not write a sent message back: saving empty removes it from disk', async () => {
    const first = await launch()
    first.saveDraft('a', words('hello'), 'w1')
    vi.advanceTimersByTime(500)
    first.saveDraft('a', [], 'w1')
    vi.advanceTimersByTime(500)
    expect(disk.has('kernel.drafts')).toBe(false)
    expect((await launch()).loadDraft('a')).toBeUndefined()
  })

  it('works when localStorage is missing, blocked or holds something else', async () => {
    vi.stubGlobal('localStorage', undefined)
    const a = await launch()
    a.saveDraft('a', words('x'), 'w1')
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    expect(a.loadDraft('a')).toEqual(words('x'))
    for (const junk of ['{nope', 'null', '[]', '{"v":2,"drafts":{}}', '{"v":1,"drafts":{"a":{"workspaceId":"","parts":[{"type":"text","text":"x"}]},"b":{"workspaceId":"w","parts":"no"},"c":null}}']) {
      vi.stubGlobal('localStorage', { getItem: () => junk, setItem: () => undefined, removeItem: () => undefined })
      const m = await launch()
      expect([m.loadDraft('a'), m.loadDraft('b'), m.loadDraft('c')]).toEqual([undefined, undefined, undefined])
    }
  })
})

describe('pruning drafts', () => {
  const s = {
    workspaces: [{ id: 'w1', status: 'ready' }, { id: 'w2', status: 'archived' }, { id: 'w3', status: 'ready' }],
    chats: { w1: [{ id: 'open' }], w2: [{ id: 'archived-chat' }] } as Record<string, { id: string }[]>
  }
  const seed = async () => {
    const m = await launch()
    m.saveDraft('open', words('1'), 'w1')
    m.saveDraft('closed', words('2'), 'w1')
    m.saveDraft('archived-chat', words('3'), 'w2')
    m.saveDraft('unloaded', words('4'), 'w3')
    m.saveDraft('removed-room', words('5'), 'w9')
    return m
  }
  const left = (m: Awaited<ReturnType<typeof launch>>) => ['open', 'closed', 'archived-chat', 'unloaded', 'removed-room'].filter((id) => m.loadDraft(id))

  it('drops a draft of an archived or removed workspace, or of a chat missing from a workspace whose chats have loaded', async () => {
    const m = await seed()
    m.pruneDrafts(s, (id) => id === 'w1')
    expect(left(m)).toEqual(['open', 'unloaded'])
  })
  it('keeps the drafts of a workspace whose chats have not loaded, even when a pushed chat made a partial list', async () => {
    const m = await seed()
    m.pruneDrafts({ ...s, chats: { ...s.chats, w3: [{ id: 'pushed' }] } }, () => false)
    expect(left(m)).toEqual(['open', 'closed', 'unloaded'])
  })
  it('removes the saved copy of what it drops', async () => {
    const m = await seed()
    vi.advanceTimersByTime(500)
    m.pruneDrafts(s, (id) => id === 'w1')
    vi.advanceTimersByTime(500)
    expect(Object.keys(onDisk().drafts).sort()).toEqual(['open', 'unloaded'])
  })
  it('keeps a restored draft through a prune at launch, when no chat has loaded', async () => {
    const first = await launch()
    first.saveDraft('c3', words('half a thought'), 'w1')
    vi.advanceTimersByTime(500)
    const m = await launch()
    m.pruneDrafts({ workspaces: [{ id: 'w1', status: 'ready' }], chats: {} }, () => false)
    expect(m.loadDraft('c3')).toEqual(words('half a thought'))
  })
})
