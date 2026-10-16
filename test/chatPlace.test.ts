import { describe, expect, it } from 'vitest'

type Place = { pinned: boolean; anchors: { id: string; offset: number }[]; scrollTop: number; lastUserId?: string; heights?: Record<string, number> }
type Mod = {
  readPlace: (rows: { id: string; top: number; height: number }[], scrollTop: number, pinned: boolean, lastUserId?: string) => Place
  placeTop: (place: Place, rowTop: (id: string) => number | undefined, range: number) => number
  opensAtEnd: (place: Place | undefined, lastSentId: string | undefined) => boolean
  savePlace: (chatId: string, place: Place) => void
  takePlace: (chatId: string) => Place | undefined
  dropPlace: (chatId: string) => void
  leftAtEnd: (distFromEnd: number) => boolean
  restoreState: () => { see: (at: number) => boolean; settled: boolean; stop: () => void; correcting: boolean }
  holdView: (o: { put: () => number; ends: boolean; over: () => boolean; following: () => boolean; now: () => number; raf: (step: () => void) => number; caf: (id: number) => void; capMs: number; frames: (running: boolean) => void }) => { state: { correcting: boolean; settled: boolean; live: boolean }; resume: () => void; stop: () => void }
  countNew: <T extends { id: string }>(items: T[], before: ReadonlySet<string> | null, isMessage: (i: T) => boolean) => number
  dropArchived: (workspaces: { id: string; status: string }[], chats: Record<string, { id: string }[] | undefined>) => void
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

// A thread as the browser lays it out (KERNEL-918): rows far from the view are skipped and take the height they were given, the saved one or a 60px placeholder,
// rows near the view are drawn at their real size, and some of those grow a few frames after they are first drawn (code highlighting, images).
const GAP = 12
const VIEW = 700
const MARGIN = 600
const PLACEHOLDER = 60

function model() {
  const real = Array.from({ length: 120 }, (_, i) => 90 + ((i * 53) % 260))
  const grows = (i: number) => i % 3 === 0
  const growth = (i: number) => 40 + ((i * 17) % 120)
  return {
    real,
    mount(place?: Place) {
      const drawnAt = new Map<number, number>()
      const intrinsic = real.map((_, i) => place?.heights?.[`r${i}`] ?? PLACEHOLDER)
      let scrollTop = 0
      let frame = 0
      const heights = () => real.map((r, i) => {
        const at = drawnAt.get(i)
        if (at === undefined) return intrinsic[i]
        return r + (grows(i) && frame - at >= 3 ? growth(i) : 0)
      })
      const layout = () => {
        const h = heights()
        let top = 0
        return h.map((height, i) => { const box = { id: `r${i}`, top, height }; top += height + GAP; return box })
      }
      const range = () => { const l = layout(); const last = l[l.length - 1]; return Math.max(0, last.top + last.height - VIEW) }
      // Drawing a row changes the layout, which can change what is near the view, so it settles within the frame like the browser's does.
      const settle = () => {
        for (let n = 0; n < 8; n++) {
          scrollTop = Math.min(scrollTop, range())
          let changed = false
          for (const b of layout()) {
            const near = b.top + b.height > scrollTop - MARGIN && b.top < scrollTop + VIEW + MARGIN
            if (near && !drawnAt.has(Number(b.id.slice(1)))) { drawnAt.set(Number(b.id.slice(1)), frame); changed = true }
          }
          if (!changed) return
        }
      }
      return {
        boxes: layout,
        range,
        get scrollTop() { return scrollTop },
        set scrollTop(v: number) { scrollTop = Math.max(0, Math.min(v, range())); settle() },
        tick() { frame++; settle() }
      }
    }
  }
}

describe('leaving and coming back (KERNEL-918)', () => {
  const grow = async (chat: string, cycles: number, opts: { leaveAfter?: number } = {}) => {
    const { readPlace, placeTop, opensAtEnd, savePlace, takePlace, leftAtEnd, restoreState } = await load()
    const m = model()
    const first = m.mount()
    first.scrollTop = 4000
    for (let i = 0; i < 30; i++) first.tick()
    const dist = (t: { scrollTop: number; range: () => number }) => t.range() - t.scrollTop
    savePlace(chat, readPlace(first.boxes(), first.scrollTop, leftAtEnd(dist(first))))
    const anchor = takePlace(chat)!.anchors[0]
    const seen: number[] = []
    for (let n = 0; n < cycles; n++) {
      const place = takePlace(chat)
      expect(opensAtEnd(place, undefined)).toBe(false)
      const t = m.mount(place)
      const st = restoreState()
      let frames = 0
      const put = () => {
        const tops = new Map(t.boxes().map((r) => [r.id, r.top]))
        t.scrollTop = placeTop(place!, (id) => tops.get(id), t.range())
        return t.scrollTop
      }
      st.see(put())
      while (!st.settled && frames < 200) { frames++; t.tick(); st.see(put()); if (opts.leaveAfter !== undefined && frames >= opts.leaveAfter) break }
      // Late layout after the restore settled is still corrected, as the thread's size observer does.
      if (opts.leaveAfter === undefined) for (let i = 0; i < 10; i++) { t.tick(); st.see(put()) }
      // Late growth lands after the last frame put the view back, and the reader leaves in that same moment.
      if (opts.leaveAfter !== undefined) { t.tick(); t.tick() }
      if (!st.correcting) savePlace(chat, readPlace(t.boxes(), t.scrollTop, leftAtEnd(dist(t))))
      const row = t.boxes().find((r) => r.id === anchor.id)!
      seen.push(row.top + anchor.offset - t.scrollTop)
    }
    return seen
  }

  it('puts the view on the same pixel after 50 round trips, with placeholder rows and late growth', async () => {
    const seen = await grow('chat-50', 50)
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]).toBe(0)
  })

  it('keeps the view on the same pixel when the reader leaves mid-restore, with late growth landing as they go', async () => {
    expect(new Set(await grow('chat-mid', 20, { leaveAfter: 2 }))).toEqual(new Set([0]))
  })

  it('does the same for the Lead chat', async () => {
    const seen = await grow('lead-1', 50)
    expect(new Set(seen)).toEqual(new Set([0]))
  })

  it('keeps the spot from before when the reader leaves while the restore is still correcting', async () => {
    const { savePlace, takePlace, readPlace, restoreState } = await load()
    const before = readPlace(rows, 500, false)
    savePlace('mid', before)
    const st = restoreState()
    st.see(100)
    st.see(240)
    expect(st.correcting).toBe(true)
    if (!st.correcting) savePlace('mid', readPlace(rows, 240, false))
    expect(takePlace('mid')).toEqual(before)
  })

  it('settles after 4 frames at the same spot, unsettles when late layout moves it, and is the reader\'s once they take over', async () => {
    const { restoreState } = await load()
    const st = restoreState()
    expect([st.see(300), st.see(300), st.see(300), st.see(300)]).toEqual([true, false, false, false])
    expect(st.settled).toBe(false)
    expect(st.see(300)).toBe(false)
    expect(st.settled).toBe(true)
    expect(st.see(342)).toBe(true)
    expect(st.settled).toBe(false)
    st.stop()
    expect(st.correcting).toBe(false)
  })

  it('counts a chat as at the end only within 2px of it', async () => {
    const { leftAtEnd, readPlace, opensAtEnd } = await load()
    expect(leftAtEnd(0)).toBe(true)
    expect(leftAtEnd(2)).toBe(true)
    expect(leftAtEnd(3)).toBe(false)
    expect(opensAtEnd(readPlace(rows, 1000, leftAtEnd(40)), undefined)).toBe(false)
    expect(opensAtEnd(readPlace(rows, 1040, leftAtEnd(0)), undefined)).toBe(true)
  })

  it('reopens a chat left 40px above its end at that spot', async () => {
    const { readPlace, placeTop, opensAtEnd, leftAtEnd } = await load()
    const list = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, top: i * 212, height: 200 }))
    const range = 10 * 212 - 12 - 700
    const place = readPlace(list, range - 40, leftAtEnd(40))
    expect(opensAtEnd(place, undefined)).toBe(false)
    expect(placeTop(place, tops(list), range)).toBe(range - 40)
  })

  it('drops the spots of every chat in an archived workspace, and only those', async () => {
    const { savePlace, takePlace, dropArchived } = await load()
    for (const id of ['a1', 'a2', 'k1']) savePlace(id, { pinned: false, anchors: [], scrollTop: 1 })
    dropArchived([{ id: 'wa', status: 'archived' }, { id: 'wk', status: 'ready' }], { wa: [{ id: 'a1' }, { id: 'a2' }], wk: [{ id: 'k1' }] })
    expect([takePlace('a1'), takePlace('a2')]).toEqual([undefined, undefined])
    expect(takePlace('k1')).toBeDefined()
  })

  describe('a chat opening at its end', () => {
    // A frame clock the test advances by hand.
    const clock = () => {
      let queued: (() => void) | undefined
      let t = 0
      return { now: () => t, raf: (f: () => void) => { queued = f; return 1 }, caf: () => { queued = undefined }, frame(ms = 16) { t += ms; const f = queued; queued = undefined; f?.() } }
    }
    const open = async (c: ReturnType<typeof clock>, flags: { byHand: boolean; pinned: boolean; at: () => number }) => {
      const { holdView } = await load()
      return holdView({ put: () => flags.at(), ends: true, over: () => flags.byHand, following: () => flags.pinned, now: c.now, raf: c.raf, caf: c.caf, capMs: 600, frames: () => undefined })
    }

    it('is no longer correcting once a streaming thread keeps the hold going past its time', async () => {
      const c = clock()
      let end = 100
      const hold = await open(c, { byHand: false, pinned: true, at: () => (end += 40) })
      for (let i = 0; i < 40; i++) c.frame()
      expect(hold.state.correcting).toBe(false)
    })

    it('is no longer correcting when the reader scrolls in the first frames', async () => {
      const c = clock()
      const flags = { byHand: false, pinned: true, at: () => 500 }
      const hold = await open(c, flags)
      c.frame()
      flags.byHand = true
      flags.pinned = false
      c.frame()
      expect(hold.state.correcting).toBe(false)
    })

    it('saves the spot the reader scrolled to and left, instead of keeping the old one', async () => {
      const { savePlace, takePlace, readPlace, leftAtEnd } = await load()
      const c = clock()
      const flags = { byHand: false, pinned: true, at: () => 500 }
      const hold = await open(c, flags)
      c.frame()
      flags.byHand = true
      flags.pinned = false
      c.frame()
      const old = readPlace(rows, 0, false)
      savePlace('end-open', old)
      if (!hold.state.correcting) savePlace('end-open', readPlace(rows, 424, leftAtEnd(900)))
      expect(takePlace('end-open')).not.toBe(old)
      expect(takePlace('end-open')?.scrollTop).toBe(424)
    })
  })
})

describe('a chat spot survives a restart (KERNEL-922)', () => {
  it('is stored under chat:<id>, with the last send, and heights stay in memory', async () => {
    const { readPlace, savePlace, takePlace, dropPlace } = await load()
    const { getSpot, resetSpots } = (await import(/* @vite-ignore */ '../src/renderer/src/ui/keptScroll' as string)) as { getSpot: (k: string) => { end: boolean; pos: number; data?: unknown } | undefined; resetSpots: () => void }
    savePlace('chat-r', readPlace(rows, 500, false, 'u9'))
    const spot = getSpot('chat:chat-r')
    expect(spot).toMatchObject({ end: false, pos: 500, data: { lastUserId: 'u9' } })
    expect(JSON.stringify(spot)).not.toContain('heights')
    expect(takePlace('chat-r')?.lastUserId).toBe('u9')
    dropPlace('chat-r')
    expect(getSpot('chat:chat-r')).toBeUndefined()
    resetSpots()
  })
})

describe('counting new messages (KERNEL-922)', () => {
  const kind = (i: { id: string; kind: string }) => i.kind === 'text'
  const items = [{ id: 'a', kind: 'text' }, { id: 'b', kind: 'tool' }, { id: 'c', kind: 'text' }, { id: 'd', kind: 'thinking' }, { id: 'e', kind: 'text' }]
  it('counts only messages that were not there when the reader left the end', async () => {
    const { countNew } = await load()
    expect(countNew(items, new Set(['a', 'b']), kind)).toBe(2)
    expect(countNew(items, new Set(items.map((i) => i.id)), kind)).toBe(0)
  })
  it('is zero at the end, and a streamed reply counts once', async () => {
    const { countNew } = await load()
    expect(countNew(items, null, kind)).toBe(0)
    expect(countNew([...items.slice(0, 2), { id: 'c', kind: 'text' }], new Set(['a', 'b']), kind)).toBe(1)
  })
})
