/**
 * Block structure of the markdown assistant replies and plans use: headings, paragraphs, nested lists with task boxes,
 * quotes, rules, tables and fenced code. Not full CommonMark; enough that a plan reads as a document.
 */
export type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'ul'; items: ListItem[] }
  | { type: 'ol'; start: number; items: ListItem[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'hr' }
  | { type: 'table'; align: Align[]; head: string[]; rows: string[][] }

/** `checked` is set on task items (`- [ ]` and `- [x]`) only. */
export interface ListItem { text: string; checked?: boolean; children: Block[] }
export type Align = 'left' | 'center' | 'right' | undefined

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const TASK = /^\[([ xX])\]\s+(.*)$/

const indent = (line: string) => line.length - line.trimStart().length
const dedent = (line: string, n: number) => line.slice(Math.min(n, indent(line)))
const isTable = (lines: string[], i: number) => i + 1 < lines.length && lines[i].includes('|') && lines[i + 1].includes('|') && TABLE_SEP.test(lines[i + 1])

/** A line that ends a paragraph because a block of its own starts there. */
function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i]
  return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l) || isTable(lines, i)
}

function cells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function alignOf(cell: string): Align {
  const c = cell.trim()
  if (c.startsWith(':') && c.endsWith(':')) return 'center'
  if (c.endsWith(':')) return 'right'
  if (c.startsWith(':')) return 'left'
  return undefined
}

/**
 * One list from `start`. A line indented two or more spaces past the list's own items belongs to the open item and is
 * parsed as its own blocks, which is how lists nest (models indent by two, three or four, so this is looser than
 * CommonMark). A list of the other kind at the same depth ends this one; `start` keeps the numbers right after it.
 */
function parseList(lines: string[], start: number): [Block, number] {
  const first = ITEM.exec(lines[start])!
  const ordered = /\d/.test(first[2])
  const child = indent(lines[start]) + 2
  const items: { head: string; body: string[]; pad: number }[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    const open = items[items.length - 1]
    if (!line.trim()) {
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      const next = j < lines.length ? ITEM.exec(lines[j]) : null
      const sibling = next && indent(lines[j]) < child && /\d/.test(next[2]) === ordered && !RULE.test(lines[j])
      if (!open || j >= lines.length || (!sibling && indent(lines[j]) < child)) break
      for (let k = i; k < j; k++) open.body.push('')
      i = j
      continue
    }
    const m = ITEM.exec(line)
    if (m && !RULE.test(line) && indent(line) < child) {
      if (/\d/.test(m[2]) !== ordered) break
      items.push({ head: m[3], body: [], pad: indent(line) + m[2].length + 1 })
      i++
      continue
    }
    if (open && indent(line) >= child) {
      open.body.push(dedent(line, open.pad))
      i++
      continue
    }
    // Lazy continuation: wrapped text straight after the item's first line.
    if (open && !open.body.length && lines[i - 1]?.trim() && !startsBlock(lines, i)) {
      open.head += '\n' + line.trim()
      i++
      continue
    }
    break
  }
  const list = items.map(({ head, body }): ListItem => {
    const task = TASK.exec(head)
    const children = parseBlocks(body.join('\n'))
    return task ? { text: task[2], checked: task[1] !== ' ', children } : { text: head, children }
  })
  return [ordered ? { type: 'ol', start: parseInt(first[2], 10), items: list } : { type: 'ul', items: list }, i]
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length)))
  const out: Block[] = []
  let para: string[] = []
  const flush = () => { if (para.length) out.push({ type: 'p', text: para.join('\n') }); para = [] }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const close = new RegExp(`^\\s{0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`)
      const body: string[] = []
      const pad = indent(line)
      i++
      while (i < lines.length && !close.test(lines[i])) body.push(dedent(lines[i++], pad))
      out.push({ type: 'code', lang: fence[2], text: body.join('\n') })
      i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) { flush(); out.push({ type: 'h', level: heading[1].length, text: heading[2] }); i++; continue }
    if (RULE.test(line)) { flush(); out.push({ type: 'hr' }); i++; continue }
    if (QUOTE.test(line)) {
      flush()
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1])
      out.push({ type: 'quote', blocks: parseBlocks(body.join('\n')) })
      continue
    }
    if (isTable(lines, i)) {
      flush()
      const head = cells(line)
      const align = cells(lines[i + 1]).map(alignOf)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = cells(lines[i++])
        rows.push(head.map((_, c) => row[c] ?? ''))
      }
      out.push({ type: 'table', align: head.map((_, c) => align[c]), head, rows })
      continue
    }
    if (ITEM.test(line)) {
      flush()
      const [list, next] = parseList(lines, i)
      out.push(list)
      i = next
      continue
    }
    if (!line.trim()) { flush(); i++; continue }
    para.push(line.replace(/^\s{0,3}/, ''))
    i++
  }
  flush()
  return out
}

/** The text of the first block when it is a heading, which a plan card shows as its title. */
export function leadingTitle(blocks: Block[]): string | undefined {
  const b = blocks[0]
  return b?.type === 'h' && b.level <= 2 ? b.text : undefined
}
