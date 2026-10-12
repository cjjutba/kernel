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
