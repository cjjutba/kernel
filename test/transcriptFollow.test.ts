import { describe, expect, it } from 'vitest'
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
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ followsAfterScroll: (pinned: boolean, view: View, before: number, byHand: boolean) => boolean }>
  // A 800px view over a 3000px thread. `up` is how far the view sits above the end.
  const view = (up: number, scrollHeight = 3000): View => ({ scrollTop: scrollHeight - 800 - up, scrollHeight, clientHeight: 800 })

  it('keeps following when the thread grows under a view at its end, since only the distance moved', async () => {
    const { followsAfterScroll } = await load()
    expect(followsAfterScroll(true, view(400), view(400).scrollTop, false)).toBe(true)
    // Our own scroll toward the end lands with more text below it than when it was aimed.
    expect(followsAfterScroll(true, view(400), view(400).scrollTop - 600, false)).toBe(true)
  })

  it('does not unpin when the browser clamps or anchors the view after rows resize', async () => {
    const { followsAfterScroll } = await load()
    // The view moved up and sits at the end, as a turn folding into its summary row leaves it.
    expect(followsAfterScroll(true, view(8), view(8).scrollTop + 900, false)).toBe(true)
    // Up by a few pixels with the end in reach, nobody's hand on it.
    expect(followsAfterScroll(true, view(30), view(30).scrollTop + 4, false)).toBe(true)
  })

  it('unpins at once when the reader moves up, even by a little', async () => {
    const { followsAfterScroll } = await load()
    expect(followsAfterScroll(true, view(10), view(10).scrollTop + 3, true)).toBe(false)
    expect(followsAfterScroll(true, view(600), view(600).scrollTop + 700, true)).toBe(false)
  })

  it('unpins when a scroll nobody asked for lands the view past PIN_PX, as the plan card opening at its top does', async () => {
    const { followsAfterScroll } = await load()
    expect(followsAfterScroll(true, view(900), view(900).scrollTop + 900, false)).toBe(false)
    expect(followsAfterScroll(true, view(81), view(81).scrollTop + 20, false)).toBe(false)
  })

  it('follows again once the reader is back within PIN_PX, and not before', async () => {
    const { followsAfterScroll } = await load()
    expect(followsAfterScroll(false, view(80), view(80).scrollTop - 200, true)).toBe(true)
    expect(followsAfterScroll(false, view(81), view(81).scrollTop - 200, true)).toBe(false)
    expect(followsAfterScroll(false, view(900), view(900).scrollTop - 50, true)).toBe(false)
  })

  it('a view that never moved keeps what it had', async () => {
    const { followsAfterScroll } = await load()
    expect(followsAfterScroll(false, view(900), view(900).scrollTop, false)).toBe(false)
    expect(followsAfterScroll(true, view(900), view(900).scrollTop, false)).toBe(true)
  })
})
