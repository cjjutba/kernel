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

describe('fixture mode', () => {
  it('neither reads nor writes what a real launch saved', async () => {
    const real = await launch()
    real.saveDraft('a', words('real draft'), 'w1')
    vi.advanceTimersByTime(500)
    const before = disk.get('kernel.drafts')
    const fixture = await launch()
    fixture.persistDrafts(false)
    expect(fixture.loadDraft('a')).toBeUndefined()
    fixture.saveDraft('b', words('typed in a fixture'), 'w1')
    vi.advanceTimersByTime(500)
    expect(disk.get('kernel.drafts')).toBe(before)
    expect(fixture.loadDraft('b')).toEqual(words('typed in a fixture'))
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
    m.saveDraft('removed-project', words('5'), 'w9')
    return m
  }
  const left = (m: Awaited<ReturnType<typeof launch>>) => ['open', 'closed', 'archived-chat', 'unloaded', 'removed-project'].filter((id) => m.loadDraft(id))

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

describe('a New chat box keeps its picks with its draft (KERNEL-544)', () => {
  const KEY = 'new-chat:project-z'
  const picks = { model: 'claude-sonnet-5-5', effort: 'low' as const, plan: true }

  it('keeps picks without any text, and a box emptied by hand keeps them', async () => {
    const { loadDraft, loadPicks, saveDraft, savePicks } = await launch()
    savePicks(KEY, picks)
    expect(loadPicks(KEY)).toEqual(picks)
    expect(loadDraft(KEY)).toBeUndefined()
    saveDraft(KEY, words('plan the week'), '')
    saveDraft(KEY, [], '')
    expect(loadDraft(KEY)).toBeUndefined()
    expect(loadPicks(KEY)).toEqual(picks)
  })

  it('keeps picks and text apart: typing never touches the picks, and a pick never touches the text', async () => {
    const { loadDraft, loadPicks, saveDraft, savePicks } = await launch()
    saveDraft(KEY, words('hello'), '')
    savePicks(KEY, { effort: 'medium' })
    expect(loadDraft(KEY)).toEqual(words('hello'))
    saveDraft(KEY, words('hello there'), '')
    expect(loadPicks(KEY)).toEqual({ effort: 'medium' })
    savePicks(KEY, { plan: false })
    expect(loadPicks(KEY)).toEqual({ effort: 'medium', plan: false })
    expect(loadDraft(KEY)).toEqual(words('hello there'))
  })

  it('writes a draft with picks and no parts, and brings both back after a relaunch', async () => {
    const first = await launch()
    first.savePicks(KEY, picks)
    first.savePicks('new-chat:project-a', { model: 'gpt-6-astra', effort: 'max' })
    vi.advanceTimersByTime(500)
    expect(onDisk().drafts).toEqual({
      [KEY]: { workspaceId: '', parts: [], picks },
      'new-chat:project-a': { workspaceId: '', parts: [], picks: { model: 'gpt-6-astra', effort: 'max' } }
    })
    const second = await launch()
    expect(second.loadPicks(KEY)).toEqual(picks)
    expect(second.loadPicks('new-chat:project-a')).toEqual({ model: 'gpt-6-astra', effort: 'max' })
    expect(second.loadDraft(KEY)).toBeUndefined()
  })

  it('writes the text and the picks of one box together', async () => {
    const first = await launch()
    first.saveDraft(KEY, words('fix the login'), '')
    first.savePicks(KEY, { plan: true })
    vi.advanceTimersByTime(500)
    expect(onDisk().drafts[KEY]).toEqual({ workspaceId: '', parts: words('fix the login'), picks: { plan: true } })
    const second = await launch()
    expect([second.loadDraft(KEY), second.loadPicks(KEY)]).toEqual([words('fix the login'), { plan: true }])
  })

  it('writes a box whose only text is an image without the image, and keeps its picks', async () => {
    const { savePicks, saveDraft } = await launch()
    saveDraft(KEY, [image], '')
    savePicks(KEY, { effort: 'high' })
    vi.advanceTimersByTime(500)
    expect(onDisk().drafts[KEY]).toEqual({ workspaceId: '', parts: [], picks: { effort: 'high' } })
  })

  it('clears the text and the picks together when a message is sent, in memory and on disk', async () => {
    const m = await launch()
    m.saveDraft(KEY, words('go'), '')
    m.savePicks(KEY, picks)
    m.saveDraft('new-chat:project-a', words('other'), '')
    m.savePicks('new-chat:project-a', { plan: true })
    vi.advanceTimersByTime(500)
    m.clearDraft(KEY)
    expect([m.loadDraft(KEY), m.loadPicks(KEY)]).toEqual([undefined, undefined])
    expect([m.loadDraft('new-chat:project-a'), m.loadPicks('new-chat:project-a')]).toEqual([words('other'), { plan: true }])
    vi.advanceTimersByTime(500)
    expect(Object.keys(onDisk().drafts)).toEqual(['new-chat:project-a'])
    m.clearDraft('new-chat:project-a')
    vi.advanceTimersByTime(500)
    expect(disk.has('kernel.drafts')).toBe(false)
  })

  it("keeps the project's Worktree or Local through a send, and drops the branch with the rest", async () => {
    const m = await launch()
    m.saveDraft(KEY, words('go'), '')
    m.savePicks(KEY, { ...picks, place: 'current', baseRef: 'origin/feat/x' })
    m.clearDraft(KEY)
    expect([m.loadDraft(KEY), m.loadPicks(KEY)]).toEqual([undefined, { place: 'current' }])
    vi.advanceTimersByTime(500)
    const relaunched = await launch()
    expect(relaunched.loadPicks(KEY)).toEqual({ place: 'current' })
  })

  it('goes back to following the default when a pick is set to undefined, and forgets a box left with nothing', async () => {
    const m = await launch()
    m.savePicks(KEY, { place: 'current', baseRef: 'origin/feat/x' })
    m.savePicks(KEY, { baseRef: undefined })
    expect(m.loadPicks(KEY)).toEqual({ place: 'current' })
    m.savePicks(KEY, { place: undefined })
    expect(m.loadPicks(KEY)).toBeUndefined()
    vi.advanceTimersByTime(500)
    expect(disk.has('kernel.drafts')).toBe(false)
  })

  it('forgets the New chat drafts of projects that are gone, and keeps the rest', async () => {
    const m = await launch()
    m.savePicks('new-chat:project-a', { place: 'current' })
    m.saveDraft('new-chat:project-b', words('b'), '')
    m.saveDraft('c1', words('in a chat'), 'w1')
    m.dropProjectDrafts(['project-b'])
    expect([m.loadPicks('new-chat:project-a'), m.loadDraft('new-chat:project-b'), m.loadDraft('c1')]).toEqual([undefined, words('b'), words('in a chat')])
  })

  it('loads a draft saved before picks existed, text only', async () => {
    disk.set('kernel.drafts', JSON.stringify({ v: 1, drafts: { [KEY]: { workspaceId: '', parts: words('old words') }, c1: { workspaceId: 'w1', parts: words('in a chat') } } }))
    const m = await launch()
    expect(m.loadDraft(KEY)).toEqual(words('old words'))
    expect(m.loadPicks(KEY)).toBeUndefined()
    expect(m.loadDraft('c1')).toEqual(words('in a chat'))
    m.savePicks(KEY, { plan: true })
    expect(m.loadDraft(KEY)).toEqual(words('old words'))
  })

  it('reads picks field by field and ignores what is not a model, an effort or a boolean', async () => {
    disk.set('kernel.drafts', JSON.stringify({ v: 1, drafts: {
      [KEY]: { workspaceId: '', parts: words('x'), picks: { model: 'gpt-6-astra', effort: 'toString', plan: 'yes' } },
      'new-chat:a': { workspaceId: '', parts: [], picks: { model: 5, effort: 'bogus', plan: 1 } },
      'new-chat:b': { workspaceId: '', parts: [], picks: 'high' },
      'new-chat:c': { workspaceId: '', parts: [], picks: { model: '  ', effort: 'ultra', plan: false } },
      'new-chat:d': { workspaceId: '', parts: [], picks: { leadMode: 'solo', place: 'cloud', baseRef: ' ' } },
      'new-chat:e': { workspaceId: '', parts: [], picks: { leadMode: 'handoff', place: 'worktree', baseRef: 'origin/feat/x' } }
    } }))
    const m = await launch()
    expect(m.loadPicks(KEY)).toEqual({ model: 'gpt-6-astra' })
    expect(m.loadDraft(KEY)).toEqual(words('x'))
    expect([m.loadPicks('new-chat:a'), m.loadPicks('new-chat:b')]).toEqual([undefined, undefined])
    expect(m.loadPicks('new-chat:c')).toEqual({ effort: 'ultra', plan: false })
    expect(m.loadPicks('new-chat:d')).toBeUndefined()
    // A leadMode an older version saved is dropped, the rest stays (one-lead-chat).
    expect(m.loadPicks('new-chat:e')).toEqual({ place: 'worktree', baseRef: 'origin/feat/x' })
  })

  it("no longer reads the retired modal's bare draft, so the next write drops it from disk (KERNEL-788)", async () => {
    disk.set('kernel.drafts', JSON.stringify({ v: 1, drafts: { 'new-chat': { workspaceId: '', parts: words('modal words'), picks }, [KEY]: { workspaceId: '', parts: words('page words') } } }))
    const m = await launch()
    expect(m.loadDraft('new-chat')).toBeUndefined()
    expect(m.loadDraft(KEY)).toEqual(words('page words'))
    m.saveDraft(KEY, words('page words again'), '')
    vi.advanceTimersByTime(500)
    expect(Object.keys(onDisk().drafts)).toEqual([KEY])
  })

  it('tells a box when its picks change, and not when only the text does', async () => {
    const m = await launch()
    const seen = vi.fn()
    const stop = m.onPicksChange(seen)
    m.saveDraft(KEY, words('typing'), '')
    expect(seen).not.toHaveBeenCalled()
    m.savePicks(KEY, { effort: 'low' })
    expect(seen).toHaveBeenCalledTimes(1)
    const before = m.loadPicks(KEY)
    m.saveDraft(KEY, words('typing more'), '')
    expect(m.loadPicks(KEY)).toBe(before)
    m.clearDraft(KEY)
    expect(seen).toHaveBeenCalledTimes(2)
    m.clearDraft(KEY)
    expect(seen).toHaveBeenCalledTimes(2)
    stop()
    m.savePicks(KEY, { plan: true })
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('keeps its picks through a prune, as it keeps its text', async () => {
    const m = await launch()
    m.savePicks(KEY, picks)
    m.savePicks('new-chat:project-a', picks)
    m.pruneDrafts({ workspaces: [], chats: {} }, () => true)
    expect([m.loadPicks(KEY), m.loadPicks('new-chat:project-a')]).toEqual([picks, picks])
  })

  it('neither reads nor writes picks in fixture mode', async () => {
    const real = await launch()
    real.savePicks(KEY, picks)
    vi.advanceTimersByTime(500)
    const before = disk.get('kernel.drafts')
    const fixture = await launch()
    fixture.persistDrafts(false)
    expect(fixture.loadPicks(KEY)).toBeUndefined()
    fixture.savePicks(KEY, { effort: 'medium' })
    vi.advanceTimersByTime(500)
    expect(disk.get('kernel.drafts')).toBe(before)
    expect(fixture.loadPicks(KEY)).toEqual({ effort: 'medium' })
  })
  describe('caret and scroll positions (KERNEL-989)', () => {
    it('keeps a position per draft, in memory only, and none for a key without a draft', async () => {
      const m = await launch()
      m.savePosition('a', { offset: 3, top: 90 })
      expect(m.loadPosition('a')).toBeUndefined()
      m.saveDraft('a', words('hello'), 'w1')
      m.saveDraft('b', words('other'), 'w1')
      m.savePosition('a', { offset: 3 })
      m.savePosition('a', { top: 90 })
      m.savePosition('b', { offset: 1, top: 4 })
      expect(m.loadPosition('a')).toEqual({ offset: 3, top: 90 })
      expect(m.loadPosition('b')).toEqual({ offset: 1, top: 4 })
      vi.advanceTimersByTime(500)
      expect(JSON.stringify(onDisk())).not.toContain('90')
      const again = await launch()
      expect(again.loadDraft('a')).toEqual(words('hello'))
      expect(again.loadPosition('a')).toBeUndefined()
    })

    it('drops a position with its draft: a send, an empty save, closed chats and a pruned workspace', async () => {
      const m = await launch()
      for (const k of ['new-chat:p', 'a', 'b', 'c']) { m.saveDraft(k, words('x'), k === 'new-chat:p' ? '' : 'w1'); m.savePosition(k, { offset: 1, top: 2 }) }
      m.clearDraft('new-chat:p')
      m.saveDraft('a', [], 'w1')
      m.dropDrafts(['b'])
      expect(['new-chat:p', 'a', 'b'].map(m.loadPosition)).toEqual([undefined, undefined, undefined])
      m.pruneDrafts({ workspaces: [], chats: {} }, () => false)
      expect(m.loadPosition('c')).toBeUndefined()
    })

    it('moves a position with the text to the other New chat box', async () => {
      const m = await launch()
      m.saveDraft('new-chat:a', words('long'), '')
      m.savePosition('new-chat:a', { offset: 2, top: 30 })
      m.moveDraft('new-chat:a', 'new-chat:b')
      expect(m.loadPosition('new-chat:a')).toBeUndefined()
      expect(m.loadPosition('new-chat:b')).toEqual({ offset: 2, top: 30 })
    })
  })
})
