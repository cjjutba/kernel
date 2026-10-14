import { describe, expect, it } from 'vitest'
import type { ChangedFile } from '../src/shared/types'
import { tableItems } from '../fixtures/base'
import { buildThread, groupLabel, turnFiles } from '../src/renderer/src/screens/workspace/thread'
import { parseDiff } from '../src/renderer/src/screens/workspace/diff'
import { parseBlocks } from '../src/renderer/src/screens/workspace/mdParse'
import { visibleRows } from '../src/renderer/src/screens/workspace/tree'

describe('transcript thread', () => {
  it('folds a finished turn into one group, then the reply with the changed files and the duration under it', () => {
    const blocks = buildThread(tableItems)
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'reply'])
    const group = blocks[1]
    if (group.kind !== 'group') throw new Error('expected a group')
    expect(groupLabel(group.tools.length, group.messages)).toBe('14 tool calls, 3 messages')
    const reply = blocks[2]
    if (reply.kind !== 'reply') throw new Error('expected the reply')
    expect(reply.item.id).toBe('x1')
    expect(reply.files).toHaveLength(4)
    expect(reply.meta.startsWith('4m 12s · ')).toBe(true)
  })

  it("keeps the files and the duration on their own rows when the reply isn't the turn's last row (KERNEL-346)", () => {
    const end = tableItems.length - 1
    const late = { kind: 'tool' as const, id: 't-late', ts: tableItems[end].ts, toolUseId: 'tu-late', name: 'Bash', label: 'Run the linter', detail: 'pnpm lint', status: 'done' as const }
    const blocks = buildThread([...tableItems.slice(0, end), late, tableItems[end]])
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'item', 'item', 'files', 'meta'])
    // A turn with no reply at all ends in its duration alone.
    expect(buildThread(tableItems.filter((i) => i.kind !== 'text')).map((b) => b.kind)).toEqual(['item', 'group', 'files', 'meta'])
  })

  it('puts a note written after the turn ended below its duration', () => {
    const note = { kind: 'note' as const, id: 'n1', ts: tableItems[tableItems.length - 1].ts + 1, text: 'PR #42 was squashed into main.' }
    const blocks = buildThread([...tableItems, note])
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'reply', 'item'])
    const last = blocks[3]
    expect(last.kind === 'item' && last.item.id).toBe('n1')
  })

  it('keeps a note the turn began with above its folded work (KERNEL-569)', () => {
    const note = { kind: 'note' as const, id: 'n-account', ts: tableItems[0].ts, text: 'Now on Personal' }
    const blocks = buildThread([tableItems[0], note, ...tableItems.slice(1)])
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'item', 'group', 'reply'])
    const opening = blocks[1]
    expect(opening.kind === 'item' && opening.item.id).toBe('n-account')
    // With no work to fold, the note sits where it was written, ahead of the reply.
    const reply = tableItems.filter((i) => i.id === 'x1' || i.kind === 'result')
    expect(buildThread([tableItems[0], note, ...reply]).map((b) => b.kind)).toEqual(['item', 'item', 'reply'])
  })

  it('shows every item of a turn that is still running', () => {
    const running = tableItems.filter((i) => i.kind !== 'result' && i.id !== 'x1')
    const blocks = buildThread(running)
    expect(blocks.every((b) => b.kind === 'item')).toBe(true)
    expect(blocks).toHaveLength(running.length)
  })

  it('labels singular counts', () => {
    expect(groupLabel(1, 0)).toBe('1 tool call')
    expect(groupLabel(2, 1)).toBe('2 tool calls, 1 message')
  })
})

describe('turn files card', () => {
  const file = (path: string, status: ChangedFile['status'], added: number, removed: number): ChangedFile => ({ path, status, added, removed })

  it('names a row by path, what happened and the counts, and marks new, deleted and renamed files', () => {
    const v = turnFiles([
      file('src/main/features/inbox.ts', 'M', 31, 12), file('test/inboxStale.test.ts', 'A', 68, 0), file('notes.md', '?', 3, 0),
      file('src/main/services/inboxPoll.ts', 'D', 0, 54), { ...file('src/b.ts', 'R', 0, 0), from: 'src/a.ts' }
    ])
    expect(v.shown.map((r) => r.label)).toEqual([
      'src/main/features/inbox.ts, edited, 31 added, 12 removed', 'test/inboxStale.test.ts, new, 68 added', 'notes.md, new, 3 added',
      'src/main/services/inboxPoll.ts, deleted, 54 removed', 'src/b.ts, renamed'
    ])
    expect(v.shown.map((r) => r.marker)).toEqual([undefined, 'New', 'New', 'Deleted', 'Renamed'])
    expect(v.shown.map((r) => r.deleted)).toEqual([false, false, false, true, false])
    expect(v.shown.map((r) => [r.name, r.dir])).toEqual([['inbox.ts', 'src/main/features'], ['inboxStale.test.ts', 'test'], ['notes.md', ''], ['inboxPoll.ts', 'src/main/services'], ['b.ts', 'src']])
  })

  it('titles the card with the file count and totals every file', () => {
    expect(turnFiles([file('a.ts', 'M', 1, 2)]).title).toBe('1 file changed in this reply')
    const v = turnFiles([file('a.ts', 'M', 31, 12), file('b.ts', 'D', 0, 54), file('c.ts', 'A', 68, 0)])
    expect(v.title).toBe('3 files changed in this reply')
    expect(v).toMatchObject({ added: 99, removed: 66 })
  })

  it('shows up to 6 files in full and from 7 folds all but the first 5, with the hidden files totals', () => {
    const files = Array.from({ length: 7 }, (_, i) => file(`f${i}.ts`, 'M', i + 1, 1))
    expect(turnFiles(files.slice(0, 6))).toMatchObject({ hidden: [] })
    const v = turnFiles(files)
    expect(v.shown.map((r) => r.name)).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts'])
    expect(v.hidden.map((r) => r.name)).toEqual(['f5.ts', 'f6.ts'])
    expect(v).toMatchObject({ hiddenAdded: 13, hiddenRemoved: 2, added: 28, removed: 7 })
  })
})

describe('workspace views', () => {
  it('parses a unified diff into numbered lines', () => {
    const [file] = parseDiff(['diff --git a/p.ts b/p.ts', '--- a/p.ts', '+++ b/p.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n'))
    expect(file).toMatchObject({ path: 'p.ts', added: 1, removed: 1 })
    expect(file.lines.slice(1).map((l) => [l.a, l.b, l.mark])).toEqual([['1', '1', ' '], ['2', '', '-'], ['', '2', '+']])
  })

  it('splits markdown into paragraphs, lists and code', () => {
    expect(parseBlocks('Hi **there**\n\n- a\n- b\n\n```ts\nx\n```').map((b) => b.type)).toEqual(['p', 'ul', 'code'])
  })

  it('reads a plan as a document: headings by level, rules, quotes, tables and tilde fences', () => {
    const blocks = parseBlocks('# Title\n## Context\nWhy.\n---\n> Note\n> more\n\n| A | B |\n|:--|--:|\n| 1 | 2 |\n| 3 |\n~~~\ncode\n~~~')
    expect(blocks.map((b) => b.type)).toEqual(['h', 'h', 'p', 'hr', 'quote', 'table', 'code'])
    expect(blocks.slice(0, 2)).toEqual([{ type: 'h', level: 1, text: 'Title' }, { type: 'h', level: 2, text: 'Context' }])
    expect(blocks[4]).toEqual({ type: 'quote', blocks: [{ type: 'p', text: 'Note\nmore' }] })
    expect(blocks[5]).toEqual({ type: 'table', align: ['left', 'right'], head: ['A', 'B'], rows: [['1', '2'], ['3', '']] })
  })

  it('nests indented lists under their item and keeps numbering across a break', () => {
    const blocks = parseBlocks('1. Noor\n- a\n2. Kai\n   - c\n     - d\n3. Ivy')
    expect(blocks.map((b) => b.type)).toEqual(['ol', 'ul', 'ol'])
    const kai = blocks[2]
    if (kai.type !== 'ol') throw new Error('expected a list')
    expect(kai.start).toBe(2)
    expect(kai.items.map((i) => i.text)).toEqual(['Kai', 'Ivy'])
    expect(kai.items[0].children).toEqual([{ type: 'ul', items: [{ text: 'c', children: [{ type: 'ul', items: [{ text: 'd', children: [] }] }] }] }])
  })

  it('keeps a list going over blank lines and reads task boxes', () => {
    const [list, after] = parseBlocks('- [ ] todo\n\n- [x] done\n  more about it\n\nAfter')
    expect(list).toEqual({ type: 'ul', items: [
      { text: 'todo', checked: false, children: [] },
      { text: 'done', checked: true, children: [{ type: 'p', text: 'more about it' }] }
    ] })
    expect(after).toEqual({ type: 'p', text: 'After' })
  })

  it('shows a folder\'s children only while it is open', () => {
    const tree = [{ path: 'src', dir: true }, { path: 'src/a.ts', dir: false }, { path: 'README.md', dir: false }]
    expect(visibleRows(tree, new Set()).map((r) => r.entry.path)).toEqual(['src', 'README.md'])
    expect(visibleRows(tree, new Set(['src'])).map((r) => r.entry.path)).toEqual(['src', 'src/a.ts', 'README.md'])
  })
})
