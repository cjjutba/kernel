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
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ sendAnchor: (last: ChatItem | undefined, anchoredId: string | null, open?: boolean, readerAway?: boolean) => 'anchor' | 'keep'; padDroppable: (v: View, pad: number) => boolean; postedFromQueue: (queuedAt: number, now: number) => boolean; QUEUE_POST_MS: number }>

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

  it('drops the padding only once the view sits clear of it, so dropping it moves nothing', async () => {
    const { padDroppable } = await load()
    // 700px of rows and 300px of padding under a 700px view.
    expect(padDroppable({ scrollTop: 1, scrollHeight: 1000, clientHeight: 700 }, 300)).toBe(false)
    expect(padDroppable({ scrollTop: 0, scrollHeight: 1000, clientHeight: 700 }, 300)).toBe(true)
    expect(padDroppable({ scrollTop: 250, scrollHeight: 1000, clientHeight: 400 }, 300)).toBe(true)
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

describe('a place remembers the anchored message while a turn runs (KERNEL-837)', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/chatPlace' as string) as Promise<{ readPlace: (rows: { id: string; top: number; height: number }[], scrollTop: number, pinned: boolean, lastUserId?: string, anchoredId?: string) => { anchoredId?: string } }>
  const rows = [{ id: 'u1', top: 0, height: 80 }]

  it('keeps it for a reader who is not at the end, so switching tabs mid-turn and back keeps the message at the top', async () => {
    const { readPlace } = await load()
    expect(readPlace(rows, 0, false, 'u1', 'u1').anchoredId).toBe('u1')
  })

  it('leaves it out for a view at the end and when nothing was anchored', async () => {
    const { readPlace } = await load()
    expect(readPlace(rows, 0, true, 'u1', 'u1').anchoredId).toBeUndefined()
    expect(readPlace(rows, 0, false, 'u1').anchoredId).toBeUndefined()
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
