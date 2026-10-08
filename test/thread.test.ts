import { describe, expect, it } from 'vitest'
import { tableItems } from '../fixtures/base'
import { buildThread, fileChips, groupLabel } from '../src/renderer/src/screens/workspace/thread'
import { parseDiff } from '../src/renderer/src/screens/workspace/diff'
import { parseBlocks } from '../src/renderer/src/screens/workspace/mdParse'
import { visibleRows } from '../src/renderer/src/screens/workspace/tree'

describe('transcript thread', () => {
  it('folds a finished turn into one group, then the reply, the changed files and the duration', () => {
    const blocks = buildThread(tableItems)
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'item', 'files', 'meta'])
    const group = blocks[1]
    if (group.kind !== 'group') throw new Error('expected a group')
    expect(groupLabel(group.tools.length, group.messages)).toBe('14 tool calls, 3 messages')
    const meta = blocks[4]
    expect(meta.kind === 'meta' && meta.text.startsWith('4m 12s · ')).toBe(true)
  })

  it('puts a note written after the turn ended below its duration', () => {
    const note = { kind: 'note' as const, id: 'n1', ts: tableItems[tableItems.length - 1].ts + 1, text: 'PR #42 was squashed into main.' }
    const blocks = buildThread([...tableItems, note])
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'item', 'files', 'meta', 'item'])
    const last = blocks[5]
    expect(last.kind === 'item' && last.item.id).toBe('n1')
  })

  it('shows every item of a turn that is still running', () => {
    const running = tableItems.filter((i) => i.kind !== 'result' && i.id !== 'x1')
    const blocks = buildThread(running)
    expect(blocks.every((b) => b.kind === 'item')).toBe(true)
    expect(blocks).toHaveLength(running.length)
  })

  it('labels singular counts and chips the files', () => {
    expect(groupLabel(1, 0)).toBe('1 tool call')
    expect(groupLabel(2, 1)).toBe('2 tool calls, 1 message')
    const chips = fileChips([
      { path: 'a/x.ts', status: 'M', added: 1, removed: 2 }, { path: 'b.ts', status: 'A', added: 3, removed: 0 },
      { path: 'c.ts', status: 'M', added: 4, removed: 1 }, { path: 'd.ts', status: 'M', added: 5, removed: 1 }
    ])
    expect(chips.map((c) => c.name)).toEqual(['x.ts', 'b.ts', '+2 more'])
    expect(chips[2]).toMatchObject({ added: 9, removed: 2 })
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
