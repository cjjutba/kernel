import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskEntry } from '../src/shared/types'
import { askWhen } from '../src/renderer/src/components/footer/askWhen'

// KERNEL-589: Ask Rowan keeps the questions you asked, newest first, across launches.

let disk: Map<string, string>
/** A fresh copy of the store each time, as a new launch: it reads `disk` on first use. */
async function launch() {
  vi.resetModules()
  return import('../src/renderer/src/store')
}

beforeEach(() => {
  disk = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v), removeItem: (k: string) => void disk.delete(k) })
})
afterEach(() => vi.unstubAllGlobals())

const entry = (n: number, extra: Partial<AskEntry> = {}): AskEntry => ({ roomId: 'room-a', chatId: `chat-${n}`, question: `Question ${n}`, at: 1_000 + n, ...extra })

describe("Ask Rowan's history", () => {
  it('starts empty, then keeps each question newest first across a restart', async () => {
    const first = await launch()
    expect(first.getState().askHistory).toEqual([])
    first.actions.quickAsk.remember(entry(1))
    first.actions.quickAsk.remember(entry(2))
    expect(first.getState().askHistory.map((e) => e.chatId)).toEqual(['chat-2', 'chat-1'])
    const second = await launch()
    expect(second.getState().askHistory.map((e) => e.chatId)).toEqual(['chat-2', 'chat-1'])
  })

  it('moves a repeated question to the top instead of listing it twice', async () => {
    const { withAsked } = await launch()
    const list = withAsked(withAsked([entry(1)], entry(2)), entry(1, { at: 5_000 }))
    expect(list.map((e) => [e.chatId, e.at])).toEqual([['chat-1', 5_000], ['chat-2', 1_002]])
  })

  it('keeps the newest 50', async () => {
    const { withAsked, ASK_HISTORY_MAX } = await launch()
    let list: AskEntry[] = []
    for (let n = 0; n < 60; n++) list = withAsked(list, entry(n))
    expect(list).toHaveLength(ASK_HISTORY_MAX)
    expect(list[0].chatId).toBe('chat-59')
    expect(list.at(-1)?.chatId).toBe('chat-10')
  })

  it('reads junk on disk as an empty history, and drops broken entries', async () => {
    disk.set('kernel.askHistory', 'not json')
    expect((await launch()).getState().askHistory).toEqual([])
    disk.set('kernel.askHistory', JSON.stringify([entry(1), { roomId: 'room-a' }, 'x', null]))
    expect((await launch()).getState().askHistory.map((e) => e.chatId)).toEqual(['chat-1'])
  })
})

describe('when a question was asked', () => {
  const now = new Date(2026, 9, 12, 15, 0).getTime()
  it('says the time today, Yesterday, the weekday this week, then the date', () => {
    expect(askWhen(new Date(2026, 9, 12, 9, 15).getTime(), now)).toBe('09:15')
    expect(askWhen(new Date(2026, 9, 11, 22, 0).getTime(), now)).toBe('Yesterday')
    expect(askWhen(new Date(2026, 9, 9, 10, 0).getTime(), now)).toBe('Fri')
    expect(askWhen(new Date(2026, 9, 1, 10, 0).getTime(), now)).toBe('Oct 1')
  })
})
