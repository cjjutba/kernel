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

describe('the padding under a sent message (KERNEL-803)', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ anchorPad: (clientHeight: number, anchorTop: number, endBottom: number) => number; ANCHOR_GAP: number }>

  it('fills the view under the message, so a short chat anchors too', async () => {
    const { anchorPad, ANCHOR_GAP } = await load()
    // A 100px message on its own in a 700px view: the rest of the view, less the gap above the message.
    expect(anchorPad(700, 300, 400)).toBe(700 - ANCHOR_GAP - 100)
  })

  it('shrinks by exactly what the reply grows', async () => {
    const { anchorPad } = await load()
    const empty = anchorPad(700, 300, 400)
    expect(anchorPad(700, 300, 460)).toBe(empty - 60)
  })

  it('is gone once the message and its reply fill the view, and never negative', async () => {
    const { anchorPad, ANCHOR_GAP } = await load()
    expect(anchorPad(700, 300, 300 + 700 - ANCHOR_GAP)).toBe(0)
    expect(anchorPad(700, 300, 2000)).toBe(0)
  })
})

describe('a message that travels more than a screen lands at its gap (KERNEL-825)', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ anchorGoal: (scrollTop: number, markTop: number, viewTop: number) => number; anchorPad: (clientHeight: number, anchorTop: number, endBottom: number) => number; ANCHOR_GAP: number }>

  it('aims at a position more than a view away, and the padding keeps that position inside the range', async () => {
    const { anchorGoal, anchorPad } = await load()
    const view = 700
    // The reader is 1500px above the end of 2000px of rows when the 90px message is added at the bottom of them.
    const scrollTop = 400
    const markTop = 2000 - 90 - scrollTop
    const goal = anchorGoal(scrollTop, markTop, 0)
    expect(goal - scrollTop).toBeGreaterThan(view)
    const pad = anchorPad(view, markTop, 2000 - scrollTop)
    expect(2000 + pad - view).toBeGreaterThanOrEqual(goal)
  })

  it('moves the aim by what the rows above the message shift mid-glide', async () => {
    const { anchorGoal, ANCHOR_GAP } = await load()
    const before = anchorGoal(800, 900, 0)
    // Rows measured a frame after the glide passed them grew by 12px, so the message sits 12px lower at the same scroll position.
    expect(anchorGoal(800, 912, 0)).toBe(before + 12)
    // Once there, the message sits exactly at the gap.
    expect(anchorGoal(before + 12, ANCHOR_GAP, 0)).toBe(before + 12)
  })
})

describe('what a send anchors (KERNEL-803)', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ followsSend: (item: ChatItem | undefined) => boolean }>

  it('anchors the reader\'s own message only, never a team update, a hand-off or a note', async () => {
    const { followsSend } = await load()
    expect(followsSend(user())).toBe(true)
    expect(followsSend(user({ from: 'lead' }))).toBe(false)
    expect(followsSend(user({ from: 'kernel' }))).toBe(false)
    expect(followsSend({ kind: 'note', id: 'n1', ts: 1, text: 'PR #12 merged' } as ChatItem)).toBe(false)
  })
})

describe('a send anchors once and the padding outlives its turn (KERNEL-837)', () => {
  type View = { scrollTop: number; scrollHeight: number; clientHeight: number }
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ sendAnchor: (last: ChatItem | undefined, anchoredId: string | null, open?: boolean, readerAway?: boolean) => 'anchor' | 'keep'; postedFromQueue: (queuedAt: number, now: number) => boolean; QUEUE_POST_MS: number }>

  it('anchors a new message, then leaves the reader alone while the turn runs, ends or an approval arrives', async () => {
    const { sendAnchor } = await load()
    expect(sendAnchor(user(), null)).toBe('anchor')
    expect(sendAnchor(user(), 'u1')).toBe('keep')
    expect(sendAnchor({ kind: 'text', id: 't1', ts: 2, text: 'Done.' }, 'u1')).toBe('keep')
  })

  it('anchors the next message after the first', async () => {
    const { sendAnchor } = await load()
    expect(sendAnchor(user({ id: 'u2' }), 'u1')).toBe('anchor')
  })

  it('never anchors what is not the reader\'s own message', async () => {
    const { sendAnchor } = await load()
    expect(sendAnchor(user({ from: 'lead' }), null)).toBe('keep')
    expect(sendAnchor(undefined, null)).toBe('keep')
  })

  it('anchors a queued message when it posts, unless the reader scrolled by hand since the last anchor', async () => {
    const { sendAnchor } = await load()
    expect(sendAnchor(user({ id: 'u2' }), 'u1', true, false)).toBe('anchor')
    expect(sendAnchor(user({ id: 'u2' }), 'u1', true, true)).toBe('keep')
  })

  it('counts a message as posted from the queue for a moment after the queue held one', async () => {
    const { postedFromQueue, QUEUE_POST_MS } = await load()
    expect(postedFromQueue(10_000, 10_000 + QUEUE_POST_MS - 1)).toBe(true)
    expect(postedFromQueue(10_000, 10_000 + QUEUE_POST_MS)).toBe(false)
    expect(postedFromQueue(0, 60_000)).toBe(false)
  })
})

describe('a tall message and the padding (KERNEL-837)', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ anchorGoal: (scrollTop: number, markTop: number, viewTop: number) => number; anchorPad: (clientHeight: number, anchorTop: number, endBottom: number) => number; ANCHOR_GAP: number }>

  it('anchors the top of a message taller than the view, with no padding to scroll into', async () => {
    const { anchorGoal, anchorPad, ANCHOR_GAP } = await load()
    const view = 700
    const tall = 1500
    expect(anchorPad(view, 300, 300 + tall)).toBe(0)
    const goal = anchorGoal(0, 300, 0)
    expect(goal).toBe(300 - ANCHOR_GAP)
    expect(300 + tall - view).toBeGreaterThanOrEqual(goal)
  })
})

describe('the first message of a new chat anchors, a reopened chat does not (KERNEL-825, KERNEL-837)', () => {
  const load = async () => {
    const t = await import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as { sendAnchor: (last: ChatItem | undefined, anchoredId: string | null, open?: boolean, readerAway?: boolean) => 'anchor' | 'keep' }
    const p = await import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/chatPlace' as string) as { markJustSent: (id: string, now?: number) => void; peekJustSent: (id: string, now?: number) => boolean; takeJustSent: (id: string) => boolean; JUST_SENT_MS: number }
    return { ...t, ...p }
  }
  const mine = { kind: 'user', id: 'u1', ts: 1, parts: [{ type: 'text', text: 'Build it' }] } as ChatItem

  it('anchors the message a chat was created with, through the same step a later send takes', async () => {
    const { sendAnchor, markJustSent, peekJustSent } = await load()
    markJustSent('new-chat')
    expect(peekJustSent('new-chat')).toBe(true)
    expect(sendAnchor(mine, null, true)).toBe('anchor')
  })

  it('survives every mount until the anchor has settled, so a second mount anchors too', async () => {
    const { markJustSent, peekJustSent, takeJustSent } = await load()
    markJustSent('c1')
    expect(peekJustSent('c1')).toBe(true)
    expect(peekJustSent('c1')).toBe(true)
    expect(takeJustSent('c1')).toBe(true)
    expect(peekJustSent('c1')).toBe(false)
    expect(takeJustSent('never-sent')).toBe(false)
  })

  it('keeps the mark through a place being saved and taken, so a chat that mounts twice places its message both times', async () => {
    const { markJustSent, peekJustSent, takeJustSent, savePlace, takePlace } = await import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/chatPlace' as string) as { markJustSent: (id: string) => void; peekJustSent: (id: string) => boolean; takeJustSent: (id: string) => boolean; savePlace: (id: string, p: unknown) => void; takePlace: (id: string) => unknown }
    markJustSent('twice')
    expect(peekJustSent('twice')).toBe(true)
    savePlace('twice', { pinned: false, anchors: [], scrollTop: 0, anchoredId: 'u1', anchoredTop: 24 })
    expect(takePlace('twice')).toBeDefined()
    expect(peekJustSent('twice')).toBe(true)
    takeJustSent('twice')
  })

  it('is dropped when nothing used it, so a chat opened much later is just a chat', async () => {
    const { markJustSent, peekJustSent, JUST_SENT_MS } = await load()
    markJustSent('old', 1000)
    expect(peekJustSent('old', 1000 + JUST_SENT_MS)).toBe(true)
    markJustSent('older', 1000)
    expect(peekJustSent('older', 1000 + JUST_SENT_MS + 1)).toBe(false)
    expect(peekJustSent('older', 1000)).toBe(false)
  })

  it('leaves a reopened chat whose last item is the reader\'s message alone', async () => {
    const { sendAnchor } = await load()
    expect(sendAnchor(mine, null, false)).toBe('keep')
  })
})

describe('a jump ends the send aim (KERNEL-825)', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ aimOver: (anchoredId: string | null, id: string, byHand: boolean, pinned: boolean) => boolean }>

  it('keeps aiming while the message is anchored and nobody has taken the view', async () => {
    const { aimOver } = await load()
    expect(aimOver('u1', 'u1', false, false)).toBe(false)
  })

  it('stops when Scroll to bottom pins the view, when the reader or the chat rail takes it, and when another message is anchored', async () => {
    const { aimOver } = await load()
    expect(aimOver('u1', 'u1', false, true)).toBe(true)
    expect(aimOver('u1', 'u1', true, false)).toBe(true)
    expect(aimOver('u2', 'u1', false, false)).toBe(true)
    expect(aimOver(null, 'u1', false, false)).toBe(true)
  })
})

describe('a place keeps the anchored message, running or not (KERNEL-837)', () => {
  type P = { anchoredId?: string; anchoredTop?: number; pinned: boolean }
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/chatPlace' as string) as Promise<{ readPlace: (rows: { id: string; top: number; height: number }[], scrollTop: number, pinned: boolean, lastUserId?: string, anchoredId?: string) => P; keptAnchor: (place: P | undefined, lastSentId: string | undefined) => string | undefined; placeTop: (place: P & { anchors: { id: string; offset: number }[]; scrollTop: number }, rowTop: (id: string) => number | undefined, range: number) => number; opensAtEnd: (place: P & { lastUserId?: string } | undefined, lastSentId: string | undefined) => boolean }>
  const rows = [{ id: 'a1', top: 0, height: 200 }, { id: 'u1', top: 212, height: 80 }]

  it('keeps it after the turn ends and for a reader at the end of the rows, where the padding still stands', async () => {
    const { readPlace } = await load()
    expect(readPlace(rows, 188, false, 'u1', 'u1').anchoredId).toBe('u1')
    expect(readPlace(rows, 188, true, 'u1', 'u1').anchoredId).toBe('u1')
    expect(readPlace(rows, 0, false, 'u1').anchoredId).toBeUndefined()
  })

  it('brings the message back only while it is still the last one the reader sent', async () => {
    const { readPlace, keptAnchor } = await load()
    const place = readPlace(rows, 188, false, 'u1', 'u1')
    expect(keptAnchor(place, 'u1')).toBe('u1')
    expect(keptAnchor(place, 'u2')).toBeUndefined()
    expect(keptAnchor(undefined, 'u1')).toBeUndefined()
  })

  it('opens where it was left, not at the end, when the anchor is kept, even for a pinned reader', async () => {
    const { readPlace, opensAtEnd } = await load()
    expect(opensAtEnd(readPlace(rows, 188, true, 'u1', 'u1'), 'u1')).toBe(false)
    expect(opensAtEnd(readPlace(rows, 188, true, 'u1'), 'u1')).toBe(true)
  })

  it('puts the view back by the message itself, 24px down or wherever the reader had moved it', async () => {
    const { readPlace, placeTop } = await load()
    expect(placeTop({ ...readPlace(rows, 188, false, 'u1', 'u1'), anchors: [], scrollTop: 0 }, (id) => (id === 'u1' ? 212 : undefined), 900)).toBe(188)
    // Scrolled up 300px and left: the message was 300px lower in the view.
    expect(placeTop({ ...readPlace(rows, 0, false, 'u1', 'u1'), anchors: [], scrollTop: 0 }, (id) => (id === 'u1' ? 212 : undefined), 900)).toBe(0)
  })
})

describe('scrolling into the padding under a sent message (KERNEL-837)', () => {
  type View = { scrollTop: number; scrollHeight: number; clientHeight: number }
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ followsAfterScroll: (pinned: boolean, view: View, before: View, byHand: boolean) => boolean; anchorPad: (clientHeight: number, anchorTop: number, endBottom: number) => number }>
  // The rows end 700px down in an 800px view. The measured height is the rows', as the thread's flat view reads it.
  const flat = (scrollTop: number): View => ({ scrollTop, scrollHeight: 1500, clientHeight: 800 })

  it('keeps following when the reader scrolls down past the end of the rows, and never pulls the view back up', async () => {
    const { followsAfterScroll } = await load()
    expect(followsAfterScroll(true, flat(760), flat(700), true)).toBe(true)
    expect(followsAfterScroll(true, flat(900), flat(760), true)).toBe(true)
  })

  it('pins at the end of the rows on the way down, and not before', async () => {
    const { followsAfterScroll } = await load()
    expect(followsAfterScroll(false, flat(300), flat(200), true)).toBe(false)
    expect(followsAfterScroll(false, flat(680), flat(600), true)).toBe(true)
  })

  it('makes the padding from the layout alone, so no scroll position can change it', async () => {
    const { anchorPad } = await load()
    expect(anchorPad(800, 24, 24 + 300)).toBe(800 - 24 - 300)
    expect(anchorPad(800, 24, 24 + 300)).toBe(anchorPad(800, 24, 24 + 300))
    expect(anchorPad(800, 24, 24 + 2000)).toBe(0)
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
