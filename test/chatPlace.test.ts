import { describe, expect, it } from 'vitest'

type Place = { pinned: boolean; anchors: { id: string; offset: number }[]; scrollTop: number; lastUserId?: string; heights?: Record<string, number> }
type Mod = {
  readPlace: (rows: { id: string; top: number; height: number }[], scrollTop: number, pinned: boolean, lastUserId?: string) => Place
  placeTop: (place: Place, rowTop: (id: string) => number | undefined, range: number) => number
  opensAtEnd: (place: Place | undefined, lastSentId: string | undefined) => boolean
  savePlace: (chatId: string, place: Place) => void
  takePlace: (chatId: string) => Place | undefined
  dropPlace: (chatId: string) => void
}
const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/chatPlace' as string) as Promise<Mod>

// Five rows of 200px, 12px apart.
const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, top: i * 212, height: 200 }))
const tops = (list: typeof rows) => (id: string) => list.find((r) => r.id === id)?.top

describe('reading a spot', () => {
  it('anchors on the first row whose bottom is below the view, with two earlier rows behind it', async () => {
    const { readPlace } = await load()
    const p = readPlace(rows, 500, false)
    expect(p.anchors).toEqual([{ id: 'r2', offset: 76 }, { id: 'r1', offset: 288 }, { id: 'r0', offset: 500 }])
    expect(readPlace(rows, 0, false).anchors).toEqual([{ id: 'r0', offset: 0 }])
  })

  it('restores the same row at the same offset', async () => {
    const { readPlace, placeTop } = await load()
    expect(placeTop(readPlace(rows, 500, false), tops(rows), 2000)).toBe(500)
  })

  it('holds the row and offset when rows are taller after a resize', async () => {
    const { readPlace, placeTop } = await load()
    const place = readPlace(rows, 500, false)
    const taller = rows.map((r, i) => ({ ...r, top: i * 312, height: 300 }))
    expect(placeTop(place, tops(taller), 3000)).toBe(624 + 76)
  })

  it('falls back to an earlier row when the anchor is gone, then to the old scrollTop', async () => {
    const { readPlace, placeTop } = await load()
    const place = readPlace(rows, 500, false)
    expect(placeTop(place, tops(rows.filter((r) => r.id !== 'r2')), 2000)).toBe(212 + 288)
    expect(placeTop(place, () => undefined, 2000)).toBe(500)
  })

  it('clamps to the scroll range', async () => {
    const { readPlace, placeTop } = await load()
    const place = readPlace(rows, 500, false)
    expect(placeTop(place, () => undefined, 300)).toBe(300)
    expect(placeTop(place, tops(rows), -5)).toBe(0)
  })
})

describe('whether a chat opens at its end', () => {
  const left = (o: Partial<Place> = {}): Place => ({ pinned: false, anchors: [], scrollTop: 100, lastUserId: 'u1', ...o })

  it('does for a chat with no spot and for one left at its end', async () => {
    const { opensAtEnd } = await load()
    expect(opensAtEnd(undefined, undefined)).toBe(true)
    expect(opensAtEnd(left({ pinned: true }), 'u1')).toBe(true)
  })

  it('does when the reader sent a message since, but not for the same send or none', async () => {
    const { opensAtEnd } = await load()
    expect(opensAtEnd(left(), 'u2')).toBe(true)
    expect(opensAtEnd(left(), 'u1')).toBe(false)
    expect(opensAtEnd(left({ lastUserId: undefined }), undefined)).toBe(false)
  })
})

describe('spots per chat', () => {
  it('keeps one per chat and drops it with the chat', async () => {
    const { savePlace, takePlace, dropPlace } = await load()
    savePlace('a', { pinned: false, anchors: [], scrollTop: 1 })
    savePlace('b', { pinned: false, anchors: [], scrollTop: 2 })
    expect(takePlace('a')?.scrollTop).toBe(1)
    expect(takePlace('b')?.scrollTop).toBe(2)
    dropPlace('a')
    expect(takePlace('a')).toBeUndefined()
    expect(takePlace('b')?.scrollTop).toBe(2)
  })
})

describe('row heights', () => {
  it('saves the height of every row with the spot and drops them with it', async () => {
    const { readPlace, savePlace, takePlace, dropPlace } = await load()
    const place = readPlace(rows, 500, true)
    expect(place.heights).toEqual({ r0: 200, r1: 200, r2: 200, r3: 200, r4: 200 })
    savePlace('chat-h', place)
    expect(takePlace('chat-h')?.heights?.r2).toBe(200)
    dropPlace('chat-h')
    expect(takePlace('chat-h')).toBeUndefined()
  })
})
