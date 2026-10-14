import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatItem, TeamUpdateEvent, TeamUpdateRow } from '../src/shared/types'
import { atEnd, entryInView, markFit, railEntries, railKey, RAIL_MIN, sameEntries, updateLabel, type RailEntry } from '../src/renderer/src/screens/workspace/railEntries'
import { ChatRail, RailView } from '../src/renderer/src/screens/workspace/ChatRail'

// KERNEL-599: the chat rail lists the user's messages, and in Kernel's chat the Team updates, and marks the one in view.

Object.assign(globalThis, { React })

type UserItem = Extract<ChatItem, { kind: 'user' }>
const user = (id: string, text: string, over: Partial<UserItem> = {}): UserItem => ({ kind: 'user', id, ts: 0, parts: [{ type: 'text', text }], ...over })
const ev = (kind: TeamUpdateEvent['kind'], text: string): TeamUpdateEvent => ({ kind, text, actionable: false })
const row = (name: string, events: TeamUpdateEvent[], over: Partial<TeamUpdateRow> = {}): TeamUpdateRow => ({ workspaceId: `ws-${name}`, agentId: name.toLowerCase(), name, task: 'A task', events, ...over })
const update = (id: string, rows: TeamUpdateRow[]): UserItem => user(id, 'Team update from Kernel, not from the user.', { from: 'kernel', update: { rows } })
const reply = (id: string): ChatItem => ({ kind: 'text', id, ts: 0, text: 'A reply' })

describe('what the rail lists', () => {
  const items: ChatItem[] = [
    user('u1', 'Plan the week\nand tell me what is blocked'),
    reply('x1'),
    { kind: 'tool', id: 't1', ts: 0, toolUseId: 'tu', name: 'Bash', label: 'Run', detail: 'ls', status: 'done' },
    user('n1', 'Kernel restarted this chat.', { from: 'kernel' }),
    update('tu1', [row('Kai', [ev('pr.ready', 'Ready to merge')])]),
    user('u2', 'Ask Kai to fix it', { from: 'lead' }),
    { kind: 'user', id: 'i1', ts: 0, parts: [{ type: 'file', name: 'create-pr.md', text: 'Open the PR' }] },
    { kind: 'note', id: 'note1', ts: 0, text: 'PR #7 passed checks.' },
    user('u3', 'What can I merge?')
  ]

  it('lists only the messages the thread draws as the user\'s bubble, oldest first, in a teammate\'s chat', () => {
    const list = railEntries(items, false)
    expect(list.map((e) => e.id)).toEqual(['u1', 'u2', 'u3'])
    expect(list.every((e) => !e.update)).toBe(true)
  })

  it('adds the Team updates in Kernel\'s chat, in place', () => {
    const list = railEntries(items, true)
    expect(list.map((e) => e.id)).toEqual(['u1', 'tu1', 'u2', 'u3'])
    expect(list.find((e) => e.id === 'tu1')).toMatchObject({ update: true, label: 'Kai, PR ready', more: 0 })
  })

  it('reads the first line of a message, and a chip\'s name when it has no text', () => {
    expect(railEntries([user('a', 'Plan the week\nand tell me what is blocked')], false)[0].label).toBe('Plan the week')
    expect(railEntries([user('a', '\n\n  Second line first  \nthird')], false)[0].label).toBe('Second line first')
    const image: UserItem = { kind: 'user', id: 'b', ts: 0, parts: [{ type: 'image', name: 'image.png' }] }
    expect(railEntries([image], false)[0].label).toBe('image.png')
    expect(railEntries([user('c', 'x'.repeat(500))], false)[0].label).toHaveLength(160)
  })

  it('skips a Team update with no rows, which the thread draws as Kernel\'s note', () => {
    expect(railEntries([update('tu0', [])], true)).toEqual([])
  })

  it('keeps one list while an unrelated reply streams in', () => {
    const a = railEntries(items, true)
    const b = railEntries([...items, reply('x2')], true)
    expect(sameEntries(a, b)).toBe(true)
    expect(sameEntries(a, railEntries([...items, user('u4', 'One more')], true))).toBe(false)
  })
})

describe('a Team update\'s row', () => {
  const label = (rows: TeamUpdateRow[]) => updateLabel(update('u', rows))

  it('reads the teammate and the newest event in a few words', () => {
    expect(label([row('Kai', [ev('turn', 'Finished a turn'), ev('pr.opened', 'Pushed a fix'), ev('pr.ready', 'Ready to merge')])])?.label).toBe('Kai, PR ready')
    expect(label([row('Kai', [ev('turn', 'Finished a turn'), ev('pr.opened', 'Opened PR #162'), ev('pr.cifail', 'Checks failed')])])?.label).toBe('Kai, checks failed')
    expect(label([row('Noor', [ev('pr.opened', 'Opened PR #161')])])?.label).toBe('Noor, opened PR #161')
    expect(label([row('Noor', [ev('pr.merged', 'Merged PR #150')])])?.label).toBe('Noor, merged PR #150')
    expect(label([row('Theo', [ev('review', 'Approved PR #161')])])?.label).toBe('Theo, approved')
    expect(label([row('Theo', [ev('review', 'Code review approved PR #161')])])?.label).toBe('Theo, approved')
    expect(label([row('Theo', [ev('review', 'Found 2 blockers in PR #161')])])?.label).toBe('Theo, found 2 blockers')
    expect(label([row('Ivy', [ev('turn', 'Finished a turn')])])?.label).toBe('Ivy, finished a turn')
    expect(label([row('Ivy', [ev('setup.failed', 'Setup failed')])])?.label).toBe('Ivy, setup failed')
  })

  it('skips the grey review segment that follows Ready to merge, and never says "Team update from Kernel"', () => {
    const l = label([row('Kai', [ev('pr.opened', 'Opened PR #162'), ev('pr.ready', 'Ready to merge'), ev('pr.review', 'Theo approved')])])
    expect(l?.label).toBe('Kai, PR ready')
    expect(l?.label).not.toMatch(/team update|from kernel/i)
  })

  it('counts the rows after the first, and reads the first row\'s own newest event', () => {
    const l = label([row('Kai', [ev('pr.ready', 'Ready to merge')]), row('Noor', [ev('pr.opened', 'Opened PR #161')]), row('Theo', [ev('review', 'Approved PR #161')])])
    expect(l).toEqual({ label: 'Kai, PR ready', more: 2 })
  })

  it('gives the name alone for a row with nothing to say, and says a shared file', () => {
    expect(label([row('Kai', [])])?.label).toBe('Kai')
    expect(label([row('Kai', [], { shared: [{ sharedId: 's', version: 1, title: 'Notes', kind: 'markdown' }] })])?.label).toBe('Kai, shared a file')
  })

  it('reads an update from before the card data was saved from its lines', () => {
    const text = ['Update from Kernel (not the user):', '- Kai · Remove the Try section (workspace w1): PR #108 is ready to merge', '- Theo · Review PR 108 (workspace w2): opened PR #109'].join('\n')
    const old: UserItem = { kind: 'user', id: 'old', ts: 0, from: 'kernel', parts: [{ type: 'text', text }] }
    expect(updateLabel(old)).toEqual({ label: 'Kai, PR ready', more: 1 })
    expect(railEntries([old], true)[0]).toMatchObject({ id: 'old', update: true, label: 'Kai, PR ready' })
  })
})

describe('the item in view', () => {
  it('is the newest entry whose top has passed the top of the view', () => {
    expect(entryInView([-900, -420, -40, 260, 610], false)).toBe(2)
    expect(entryInView([-900, -420, -40, 260, 610], true)).toBe(4)
  })

  it('counts a message that a jump landed 16px under the top, and not one further down', () => {
    expect(entryInView([-300, 16, 400], false)).toBe(1)
    expect(entryInView([-300, 17, 400], false)).toBe(1)
    expect(entryInView([-300, 18, 400], false)).toBe(0)
  })

  it('is the first entry before any top has passed, and nothing without entries', () => {
    expect(entryInView([120, 480], false)).toBe(0)
    expect(entryInView([], false)).toBe(-1)
  })

  it('skips an entry that is not on the page', () => {
    expect(entryInView([-500, NaN, -10, NaN], false)).toBe(2)
  })

  it('counts a chat resting on its end as at the bottom, with its 8px of padding', () => {
    expect(atEnd({ scrollHeight: 4222, scrollTop: 3566, clientHeight: 656 })).toBe(true)
    expect(atEnd({ scrollHeight: 4222, scrollTop: 3559, clientHeight: 656 })).toBe(true)
    expect(atEnd({ scrollHeight: 4222, scrollTop: 3400, clientHeight: 656 })).toBe(false)
  })
})

describe('the rail\'s keys', () => {
  const s = { open: true, active: 3, count: 6 }

  it('moves the active row with Up and Down and stops at the ends', () => {
    expect(railKey('ArrowDown', s)).toEqual({ open: true, active: 4 })
    expect(railKey('ArrowUp', s)).toEqual({ open: true, active: 2 })
    expect(railKey('ArrowDown', { ...s, active: 5 })).toEqual({ open: true, active: 5 })
    expect(railKey('ArrowUp', { ...s, active: 0 })).toEqual({ open: true, active: 0 })
  })

  it('goes to the ends with Home and End', () => {
    expect(railKey('Home', s)).toEqual({ open: true, active: 0 })
    expect(railKey('End', s)).toEqual({ open: true, active: 5 })
  })

  it('jumps to the active row and closes with Enter', () => {
    expect(railKey('Enter', s)).toEqual({ open: false, active: 3, jump: true })
  })

  it('closes with Escape', () => {
    expect(railKey('Escape', s)).toEqual({ open: false, active: 3 })
  })

  it('opens a closed list on an arrow, with the row it had, and leaves Enter and Escape alone', () => {
    const closed = { ...s, open: false }
    expect(railKey('ArrowDown', closed)).toEqual({ open: true, active: 3 })
    expect(railKey('ArrowUp', closed)).toEqual({ open: true, active: 3 })
    expect(railKey('Enter', closed)).toBeUndefined()
    expect(railKey('Escape', closed)).toBeUndefined()
  })

  it('leaves every other key alone, so Tab moves on', () => {
    expect(railKey('Tab', s)).toBeUndefined()
    expect(railKey('a', s)).toBeUndefined()
  })
})

describe('the marks\' gap', () => {
  it('keeps the 2px marks 6px apart while they fit', () => {
    expect(markFit(18, 656)).toEqual({ mark: 2, gap: 6 })
  })

  it('tightens the gap when the stack would be taller than the column, and the marks only when they touch', () => {
    const tight = markFit(100, 656)
    expect(tight.mark).toBe(2)
    expect(tight.gap).toBeGreaterThan(0)
    expect(tight.gap).toBeLessThan(6)
    // 100 marks of 2px and 99 gaps, plus the rail's padding and the 12px clear above and below, fill the column exactly.
    expect(100 * tight.mark + 99 * tight.gap + 36).toBeCloseTo(656)
    const packed = markFit(500, 656)
    expect(packed.gap).toBe(0)
    expect(packed.mark).toBeLessThan(2)
  })
})

const list = (n: number, update = new Set<number>()): RailEntry[] => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, label: update.has(i) ? `Kai, PR ready ${i}` : `Message ${i}`, more: update.has(i) ? 1 : 0, update: update.has(i) }))

describe('the rail', () => {
  const html = (entries: RailEntry[]) => renderToStaticMarkup(React.createElement(ChatRail, { entries, scroller: { current: null } }))

  it('is hidden until the chat has 2 entries to list', () => {
    expect(RAIL_MIN).toBe(2)
    expect(html([])).toBe('')
    expect(html(list(1))).toBe('')
    const two = html(list(2))
    expect(two).toContain('aria-label="Jump to message"')
    expect(two.match(/class="rail-m"/g)).toHaveLength(2)
  })

  it('is a button with a popup list that is closed at rest', () => {
    const two = html(list(2))
    expect(two).toContain('<button type="button" class="rail-btn"')
    expect(two).toContain('aria-haspopup="listbox"')
    expect(two).toContain('aria-expanded="false"')
    expect(two).not.toContain('role="listbox"')
  })

  it('draws a short mark for a Team update and marks the entry in view', () => {
    const view = renderToStaticMarkup(React.createElement(RailView, { entries: list(4, new Set([1])), current: 2, at: 2, open: false, id: 'r' }))
    const marks = view.match(/<span class="rail-m"[^>]*>/g)!
    expect(marks).toHaveLength(4)
    expect(marks[1]).toContain('data-update')
    expect(marks[2]).toContain('data-now')
    expect(marks.filter((m) => m.includes('data-now'))).toHaveLength(1)
  })

  it('draws the open list as options, with the item in view selected and the active row named by the button', () => {
    const view = renderToStaticMarkup(React.createElement(RailView, { entries: list(5, new Set([1])), current: 3, at: 2, open: true, id: 'r' }))
    expect(view).toContain('aria-expanded="true"')
    expect(view).toContain('aria-controls="r-list"')
    expect(view).toContain('aria-activedescendant="r-2"')
    expect(view).toContain('role="listbox"')
    const options = view.match(/<div id="r-\d" class="rail-opt" role="option"[^>]*>/g)!
    expect(options).toHaveLength(5)
    expect(options[3]).toContain('aria-selected="true"')
    expect(options[3]).toContain('data-now')
    expect(options[2]).toContain('aria-selected="false"')
    expect(options[2]).toContain('data-active')
    expect(options[1]).toContain('data-update')
  })

  it('ends a Team update row with its count of more rows, faint and not read twice', () => {
    const view = renderToStaticMarkup(React.createElement(RailView, { entries: list(3, new Set([1])), current: 0, at: 0, open: true, id: 'r' }))
    expect(view).toContain('<span class="rail-opt-tx">Kai, PR ready 1</span><span class="rail-opt-nx" aria-hidden="true">+1</span>')
    expect(view).toContain('aria-label="Kai, PR ready 1, and 1 more"')
    expect(view.match(/rail-opt-nx/g)).toHaveLength(1)
  })
})
