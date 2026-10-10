import { Fragment, memo, useMemo, type ReactNode } from 'react'
import { CodeBlock, Icon } from '../../ui'
import { parseBlocks, type Block, type ListItem } from './mdParse'

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g

export function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i} className="md-code">{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part)
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>
    return <Fragment key={i}>{part}</Fragment>
  })
}

function Item({ item }: { item: ListItem }) {
  const task = item.checked !== undefined
  return (
    <li data-task={task ? (item.checked ? 'done' : 'open') : undefined}>
      {task && <span className="md-box" role="img" aria-label={item.checked ? 'Done' : 'Not done'}>{item.checked && <Icon name="check" size={10} stroke={2} />}</span>}
      <span className="md-li">{inline(item.text)}</span>
      {item.children.length > 0 && <Blocks blocks={item.children} />}
    </li>
  )
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map((b, i) => <BlockView key={i} block={b} />)}</>
}

function BlockView({ block: b }: { block: Block }) {
  switch (b.type) {
    case 'p': return <p>{inline(b.text)}</p>
    // Real heading elements would sit under the page's own outline, so these are headings to assistive tech only.
    case 'h': return <p className="md-h" data-level={Math.min(b.level, 4)} role="heading" aria-level={Math.min(b.level + 3, 6)}>{inline(b.text)}</p>
    case 'ul': return <ul data-tasks={b.items.some((t) => t.checked !== undefined) || undefined}>{b.items.map((t, j) => <Item key={j} item={t} />)}</ul>
    case 'ol': return <ol start={b.start === 1 ? undefined : b.start}>{b.items.map((t, j) => <Item key={j} item={t} />)}</ol>
    case 'code': return <CodeBlock>{b.text}</CodeBlock>
    case 'quote': return <blockquote><Blocks blocks={b.blocks} /></blockquote>
    case 'hr': return <hr />
    case 'table':
      return (
        <div className="md-table" role="region" aria-label="Table" tabIndex={0}>
          <table>
            <thead><tr>{b.head.map((c, j) => <th key={j} style={{ textAlign: b.align[j] }}>{inline(c)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} style={{ textAlign: b.align[k] }}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
  }
}

/** Renders `text`, or `blocks` already parsed from it (a plan card parses once to find its title). Parsed once per text. */
export const Markdown = memo(function Markdown({ text, blocks, className }: { text?: string; blocks?: Block[]; className?: string }) {
  const parsed = useMemo(() => blocks ?? parseBlocks(text ?? ''), [blocks, text])
  return <div className={['md', className].filter(Boolean).join(' ')}><Blocks blocks={parsed} /></div>
})
