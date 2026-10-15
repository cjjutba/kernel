import { describe, expect, it } from 'vitest'
import type { ChatPart, QueuedMessage } from '../src/shared/types'
import { escapeStops, queueBackInBox } from '../src/renderer/src/screens/workspace/composer/stop'
import { loadFailureLine } from '../src/renderer/src/screens/workspace/composer/useComposerLoads'

const words = (t: string): ChatPart[] => [{ type: 'text', text: t }]
const queued = (id: string, parts: ChatPart[]): QueuedMessage => ({ id, chatId: 'c', parts, ts: 0 })
const base = { running: true, stopping: false, menuOpen: false, autocompleteOpen: false }

describe('Escape in the box', () => {
  it('stops a running turn only once the menu and the pickers have had their Escape', () => {
    expect(escapeStops(base)).toBe(true)
    expect(escapeStops({ ...base, autocompleteOpen: true })).toBe(false)
    expect(escapeStops({ ...base, menuOpen: true })).toBe(false)
  })

  it('does nothing without a running turn, or while a Stop is already on its way', () => {
    expect(escapeStops({ ...base, running: false })).toBe(false)
    expect(escapeStops({ ...base, stopping: true })).toBe(false)
  })
})

describe('Stop and the queue', () => {
  it('puts the dropped messages after the draft, in order', () => {
    const box = queueBackInBox(words('draft'), [queued('1', words('first')), queued('2', words('second'))])
    expect(box.map((p) => (p.type === 'text' ? p.text : p.type))).toEqual(['draft', '\n\n', 'first', '\n\n', 'second'])
  })

  it('starts with the first message when the box is empty and keeps chips', () => {
    const file: ChatPart = { type: 'file', name: 'a.ts', path: 'src/a.ts' }
    expect(queueBackInBox([], [queued('1', [file, ...words('look')])])).toEqual([file, ...words('look')])
  })

  it('leaves the draft alone when nothing was queued', () => {
    const draft = words('draft')
    expect(queueBackInBox(draft, [])).toEqual(draft)
  })
})

describe('a failed composer load', () => {
  it('names what failed, and says nothing when nothing did', () => {
    expect(loadFailureLine({ queue: true, mode: false })).toMatch(/queued messages/)
    expect(loadFailureLine({ queue: false, mode: true })).toMatch(/mode/)
    expect(loadFailureLine({ queue: true, mode: true })).toMatch(/queue and mode/)
    expect(loadFailureLine({ queue: false, mode: false })).toBeUndefined()
  })
})
