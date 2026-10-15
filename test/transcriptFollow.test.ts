import { describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@shared/types'

const user = (o: Partial<Extract<ChatItem, { kind: 'user' }>> = {}): ChatItem => ({ kind: 'user', id: 'u1', ts: 1, parts: [{ type: 'text', text: 'Build it' }], ...o })

describe('what a reader scrolled up follows', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ followsSend: (item: ChatItem | undefined) => boolean }>

  it('follows the message the user just sent', async () => {
    const { followsSend } = await load()
    expect(followsSend(user())).toBe(true)
  })

  it("stays put when the Lead messages a teammate's chat, or Kernel posts into it", async () => {
    const { followsSend } = await load()
    expect(followsSend(user({ from: 'lead' }))).toBe(false)
    expect(followsSend(user({ from: 'kernel' }))).toBe(false)
  })

  it('stays put for anything the agent writes', async () => {
    const { followsSend } = await load()
    expect(followsSend({ kind: 'text', id: 't1', ts: 1, text: 'Done.' })).toBe(false)
    expect(followsSend({ kind: 'tool', id: 'tl1', ts: 1, toolUseId: 'x', name: 'Bash', label: 'Run', detail: 'ls', status: 'done' })).toBe(false)
    expect(followsSend(undefined)).toBe(false)
  })
})

describe('whether the chat keeps following its end after a scroll (KERNEL-605)', () => {
  type View = { scrollTop: number; scrollHeight: number; clientHeight: number }
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ followsAfterScroll: (pinned: boolean, view: View, before: View, byHand: boolean) => boolean }>
  // An 800px view over a 3000px thread. `up` is how far the view sits above the end.
  const view = (up: number, scrollHeight = 3000, clientHeight = 800): View => ({ scrollTop: scrollHeight - clientHeight - up, scrollHeight, clientHeight })
  // The same view as it was at the last scroll event, `by` pixels lower.
  const was = (v: View, by: number): View => ({ ...v, scrollTop: v.scrollTop + by })

  it('keeps following when the thread grows under a view at its end, since only the distance moved', async () => {
    const { followsAfterScroll } = await load()
    // The view didn't move.
    expect(followsAfterScroll(true, view(400), view(400), false)).toBe(true)
    // Our own scroll toward the end lands with more text below it than when it was aimed.
    expect(followsAfterScroll(true, view(400), { ...was(view(400), -600), scrollHeight: 2800 }, false)).toBe(true)
  })

  it('does not unpin when the browser clamps or anchors the view after rows resize', async () => {
    const { followsAfterScroll } = await load()
    // The view moved up and sits at the end, as a turn folding into its summary row leaves it.
    expect(followsAfterScroll(true, view(8), { ...was(view(8), 900), scrollHeight: 3900 }, false)).toBe(true)
    // Up by a few pixels with the end in reach, nobody's hand on it.
    expect(followsAfterScroll(true, view(30), was(view(30), 4), false)).toBe(true)
  })

  it('leaves a reader who scrolled up where they are when a running turn folds into its summary (KERNEL-784)', async () => {
    const { followsAfterScroll } = await load()
    // The turn's stretches and its live line collapse into one row, so the thread gets shorter and the browser keeps the reader's rows in place.
    const shorter = view(900, 2400)
    expect(followsAfterScroll(false, shorter, { ...was(shorter, 0), scrollHeight: 3000 }, false)).toBe(false)
    // A reader who was following, with the end in reach, keeps following through the same fold.
    expect(followsAfterScroll(true, view(8, 2400), { ...was(view(8, 2400), 600), scrollHeight: 3000 }, false)).toBe(true)
  })

  it('unpins at once when the reader moves up, even by a little', async () => {
    const { followsAfterScroll } = await load()
    expect(followsAfterScroll(true, view(10), was(view(10), 3), true)).toBe(false)
    expect(followsAfterScroll(true, view(600), was(view(600), 700), true)).toBe(false)
  })

  it('does not count input that scrolled nothing when layout then moves the view', async () => {
    const { followsAfterScroll } = await load()
    // A question answered by keyboard: the keys left `byHand` set, the card collapses, and the browser clamps the view up and shortens the thread by the card.
    const clamped = view(8, 2700)
    expect(followsAfterScroll(true, clamped, { ...view(8, 3000), scrollTop: clamped.scrollTop + 300 }, true)).toBe(true)
    // The composer shrinking makes the view taller, which clamps it up the same way.
    const taller = view(8, 3000, 900)
    expect(followsAfterScroll(true, taller, { ...was(taller, 100), clientHeight: 800 }, true)).toBe(true)
    // The reader's own scroll leaves the range as it was, so the same move with the same input does unpin.
    expect(followsAfterScroll(true, view(120), was(view(120), 40), true)).toBe(false)
  })

  it('unpins when a scroll nobody asked for lands the view past PIN_PX, as the plan card opening at its top does', async () => {
    const { followsAfterScroll } = await load()
    expect(followsAfterScroll(true, view(900), was(view(900), 900), false)).toBe(false)
    expect(followsAfterScroll(true, view(81), was(view(81), 20), false)).toBe(false)
  })

  it('follows again once the reader is back within PIN_PX, and not before', async () => {
    const { followsAfterScroll } = await load()
    expect(followsAfterScroll(false, view(80), was(view(80), -200), true)).toBe(true)
    expect(followsAfterScroll(false, view(81), was(view(81), -200), true)).toBe(false)
    expect(followsAfterScroll(false, view(900), was(view(900), -50), true)).toBe(false)
  })

  it('a view that never moved keeps what it had', async () => {
    const { followsAfterScroll } = await load()
    expect(followsAfterScroll(false, view(900), view(900), false)).toBe(false)
    expect(followsAfterScroll(true, view(900), view(900), false)).toBe(true)
  })
})

describe('whether following may move the view (KERNEL-629)', () => {
  type View = { scrollTop: number; scrollHeight: number; clientHeight: number }
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ movesToEnd: (view: View, byHand: boolean) => boolean }>
  const view = (up: number): View => ({ scrollTop: 3000 - 800 - up, scrollHeight: 3000, clientHeight: 800 })

  it('moves when the view is short of the end and nobody is scrolling', async () => {
    const { movesToEnd } = await load()
    expect(movesToEnd(view(300), false)).toBe(true)
    expect(movesToEnd(view(1), false)).toBe(true)
  })

  it('stays put at the end, so the native bounce finishes', async () => {
    const { movesToEnd } = await load()
    expect(movesToEnd(view(0), false)).toBe(false)
    expect(movesToEnd(view(0.4), false)).toBe(false)
  })

  it("stays put while the reader's gesture or its momentum is going", async () => {
    const { movesToEnd } = await load()
    expect(movesToEnd(view(300), true)).toBe(false)
    expect(movesToEnd(view(0), true)).toBe(false)
  })
})

describe('the reader\'s input letting go when no scroll follows it (KERNEL-629)', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ lapse: (ms: number, fn: () => void) => { (): void; cancel: () => void } }>

  it('fires once after the wait, so a pull past the end does not block following for good', async () => {
    vi.useFakeTimers()
    const { lapse } = await load()
    const fn = vi.fn()
    const input = lapse(200, fn)
    input()
    vi.advanceTimersByTime(199)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('waits again while scroll events keep restarting it, and not at all once cancelled', async () => {
    vi.useFakeTimers()
    const { lapse } = await load()
    const fn = vi.fn()
    const input = lapse(200, fn)
    input()
    vi.advanceTimersByTime(150)
    input()
    vi.advanceTimersByTime(150)
    expect(fn).not.toHaveBeenCalled()
    input.cancel()
    vi.advanceTimersByTime(500)
    expect(fn).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('a send takes the view to the end at once (KERNEL-891)', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ sendFollow: (last: ChatItem | undefined, seenId: string | null, open?: boolean, fromQueue?: boolean, pinned?: boolean) => 'follow' | 'keep'; postedFromQueue: (queuedAt: number, now: number) => boolean; QUEUE_POST_MS: number }>

  it('follows a new message, then leaves the view alone while the turn runs, ends or an approval arrives', async () => {
    const { sendFollow } = await load()
    expect(sendFollow(user(), null)).toBe('follow')
    expect(sendFollow(user(), 'u1')).toBe('keep')
    expect(sendFollow({ kind: 'text', id: 't1', ts: 2, text: 'Done.' }, 'u1')).toBe('keep')
  })

  it('follows the next message after the first, from wherever the reader is', async () => {
    const { sendFollow } = await load()
    expect(sendFollow(user({ id: 'u2' }), 'u1', true, false, false)).toBe('follow')
  })

  it('never follows what is not the reader\'s own message', async () => {
    const { sendFollow } = await load()
    expect(sendFollow(user({ from: 'lead' }), null)).toBe('keep')
    expect(sendFollow(undefined, null)).toBe('keep')
  })

  it('leaves a reopened chat whose last item is the reader\'s message alone', async () => {
    const { sendFollow } = await load()
    expect(sendFollow(user(), null, false)).toBe('keep')
  })

  it('follows a queued message when it posts, unless the reader has scrolled up since', async () => {
    const { sendFollow } = await load()
    expect(sendFollow(user({ id: 'u2' }), 'u1', true, true, true)).toBe('follow')
    expect(sendFollow(user({ id: 'u2' }), 'u1', true, true, false)).toBe('keep')
  })

  it('counts a message as posted from the queue for a moment after the queue held one', async () => {
    const { postedFromQueue, QUEUE_POST_MS } = await load()
    expect(postedFromQueue(10_000, 10_000 + QUEUE_POST_MS - 1)).toBe(true)
    expect(postedFromQueue(10_000, 10_000 + QUEUE_POST_MS)).toBe(false)
    expect(postedFromQueue(0, 60_000)).toBe(false)
  })
})

describe('a place keeps where a chat was left (KERNEL-765)', () => {
  type P = { pinned: boolean; anchors: { id: string; offset: number }[]; scrollTop: number; lastUserId?: string }
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/chatPlace' as string) as Promise<{ readPlace: (rows: { id: string; top: number; height: number }[], scrollTop: number, pinned: boolean, lastUserId?: string) => P; placeTop: (place: P, rowTop: (id: string) => number | undefined, range: number) => number; opensAtEnd: (place: P | undefined, lastSentId: string | undefined) => boolean }>
  const rows = [{ id: 'a1', top: 0, height: 200 }, { id: 'u1', top: 212, height: 80 }]

  it('opens at the end when it was left there, and where it was left otherwise', async () => {
    const { readPlace, opensAtEnd } = await load()
    expect(opensAtEnd(readPlace(rows, 188, true, 'u1'), 'u1')).toBe(true)
    expect(opensAtEnd(readPlace(rows, 0, false, 'u1'), 'u1')).toBe(false)
    expect(opensAtEnd(undefined, 'u1')).toBe(true)
  })

  it('opens at the end when the reader sent something since', async () => {
    const { readPlace, opensAtEnd } = await load()
    expect(opensAtEnd(readPlace(rows, 0, false, 'u1'), 'u2')).toBe(true)
  })

  it('puts the view back by the row it started in', async () => {
    const { readPlace, placeTop } = await load()
    expect(placeTop(readPlace(rows, 188, false, 'u1'), (id) => (id === 'a1' ? 0 : id === 'u1' ? 212 : undefined), 900)).toBe(188)
  })
})

describe('the answer row an approval shows at once (KERNEL-838)', () => {
  type A = Record<string, unknown>
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/cards/optimisticAnswer' as string) as Promise<{ answerRow: (a: A, d: A, ts?: number) => ChatItem | undefined }>
  const plan = { id: 'ap1', kind: 'plan', toolName: 'ExitPlanMode', status: 'pending', chatId: 'c1' }

  it('has the id and the words the engine will give it, so its row replaces this one', async () => {
    const { answerRow } = await load()
    const { answerItemId, answerParts } = await import('../src/shared/approvalAnswer')
    const row = answerRow(plan, { behavior: 'allow' }, 5)
    expect(row).toMatchObject({ kind: 'user', id: answerItemId('ap1'), approvalId: 'ap1', parts: [{ type: 'text', text: 'Approved' }] })
    expect(row && 'approvalId' in row && !('from' in row && row.from)).toBe(true)
    expect(answerParts({ ...plan, status: 'allowed' } as never)).toEqual((row as { parts: unknown }).parts)
  })

  it('words a plan change request, a question and an agent proposal as the engine does', async () => {
    const { answerRow } = await load()
    expect(answerRow(plan, { behavior: 'deny', message: ' Split step 2. ' })).toMatchObject({ parts: [{ type: 'text', text: 'Split step 2.' }] })
    expect(answerRow({ id: 'q1', kind: 'question', status: 'pending', chatId: 'c1' }, { behavior: 'answer', text: 'Yes' })).toMatchObject({ parts: [{ type: 'text', text: 'Yes' }] })
    expect(answerRow({ id: 'h1', kind: 'agent', status: 'pending', chatId: 'c1' }, { behavior: 'deny' })).toMatchObject({ parts: [{ type: 'text', text: 'Not now' }] })
  })

  it('adds nothing for a tool permission or a change request with images', async () => {
    const { answerRow } = await load()
    expect(answerRow({ id: 'p1', kind: 'tool', toolName: 'Bash', status: 'pending', chatId: 'c1' }, { behavior: 'allow' })).toBeUndefined()
    expect(answerRow(plan, { behavior: 'deny', message: 'x', images: [{ name: 'a.png', dataUrl: 'data:' }] })).toBeUndefined()
  })
})

describe('the optimistic answer row in the store (KERNEL-838)', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/store' as string) as Promise<{ actions: { chats: { upsertItem: (c: string, i: ChatItem) => void; dropItem: (c: string, i: ChatItem) => void } }; getState: () => { items: Record<string, ChatItem[]> } }>
  const row = (ts: number, text: string): ChatItem => ({ kind: 'user', id: 'answer-ap1', ts, parts: [{ type: 'text', text }], approvalId: 'ap1' })

  it("is replaced by the engine's row of the same id, in place, and never drawn twice", async () => {
    const { actions, getState } = await load()
    const mine = row(1, 'Approved')
    actions.chats.upsertItem('oc1', { kind: 'text', id: 't0', ts: 0, text: 'Plan.' })
    actions.chats.upsertItem('oc1', mine)
    actions.chats.upsertItem('oc1', row(2, 'Approved'))
    expect(getState().items['oc1'].map((i) => i.id)).toEqual(['t0', 'answer-ap1'])
    expect(getState().items['oc1'][1].ts).toBe(2)
  })

  it('is taken out when the call fails, but an engine row that replaced it stays', async () => {
    const { actions, getState } = await load()
    const mine = row(1, 'Approved')
    actions.chats.upsertItem('oc2', mine)
    actions.chats.dropItem('oc2', mine)
    expect(getState().items['oc2']).toEqual([])
    actions.chats.upsertItem('oc3', mine)
    actions.chats.upsertItem('oc3', row(2, 'Approved'))
    actions.chats.dropItem('oc3', mine)
    expect(getState().items['oc3']).toHaveLength(1)
  })
})

describe('the chat top fade', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ scrolledOff: (scrollTop: number) => boolean }>

  it('shows only once the view has left the top', async () => {
    const { scrolledOff } = await load()
    expect(scrolledOff(0)).toBe(false)
    expect(scrolledOff(1)).toBe(true)
  })
})
