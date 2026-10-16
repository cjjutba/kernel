import { Fragment, memo, useContext, useMemo, useRef, type ReactNode } from 'react'
import { CodeBlock, Icon } from '../../ui'
import { FileLink } from './FileLink'
import { blockTexts, FileLinkScope, useFileLinks, wordCore, type FileLinks } from './fileLinks'
import { parseBlocks, type Block, type ListItem } from './mdParse'

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g

/** Plain text with the words that resolved to a file or folder turned into links. */
function linkWords(text: string, links: FileLinks): ReactNode[] {
  const out: ReactNode[] = []
  let at = 0
  for (const m of text.matchAll(/\S+/g)) {
    const { start, end, raw } = wordCore(m[0])
    const hit = links.found.get(raw)
    if (!hit) continue
    const from = m.index + start
    if (from > at) out.push(text.slice(at, from))
    out.push(<FileLink key={from} workspaceId={links.workspaceId} raw={raw} hit={hit}>{raw}</FileLink>)
    at = m.index + end
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

/** `links` turns the paths in inline code and plain text that the workspace has into links (`useFileLinks`). */
export function inline(text: string, links?: FileLinks): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const raw = part.slice(1, -1)
      const hit = links?.found.get(raw.trim())
      return hit ? <FileLink key={i} workspaceId={links!.workspaceId} raw={raw.trim()} hit={hit}>{raw}</FileLink> : <code key={i} className="md-code">{raw}</code>
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part)
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>
    return <Fragment key={i}>{links?.found.size ? linkWords(part, links) : part}</Fragment>
  })
}

function Item({ item, links }: { item: ListItem; links?: FileLinks }) {
  const task = item.checked !== undefined
  return (
    <li data-task={task ? (item.checked ? 'done' : 'open') : undefined}>
      {task && <span className="md-box" role="img" aria-label={item.checked ? 'Done' : 'Not done'}>{item.checked && <Icon name="check" size={12} />}</span>}
      <span className="md-li">{inline(item.text, links)}</span>
      {item.children.length > 0 && <Blocks blocks={item.children} links={links} />}
    </li>
  )
}

function Blocks({ blocks, links }: { blocks: Block[]; links?: FileLinks }) {
  return <>{blocks.map((b, i) => <BlockView key={i} block={b} links={links} />)}</>
}

function BlockView({ block: b, links }: { block: Block; links?: FileLinks }) {
  switch (b.type) {
    case 'p': return <p>{inline(b.text, links)}</p>
    // Real heading elements would sit under the page's own outline, so these are headings to assistive tech only.
    case 'h': return <p className="md-h" data-level={Math.min(b.level, 4)} role="heading" aria-level={Math.min(b.level + 3, 6)}>{inline(b.text, links)}</p>
    case 'ul': return <ul data-tasks={b.items.some((t) => t.checked !== undefined) || undefined}>{b.items.map((t, j) => <Item key={j} item={t} links={links} />)}</ul>
    case 'ol': return <ol start={b.start === 1 ? undefined : b.start}>{b.items.map((t, j) => <Item key={j} item={t} links={links} />)}</ol>
    case 'code': return <CodeBlock>{b.text}</CodeBlock>
    case 'quote': return <blockquote><Blocks blocks={b.blocks} links={links} /></blockquote>
    case 'hr': return <hr />
    case 'table':
      return (
        <div className="md-table" role="region" aria-label="Table" tabIndex={0}>
          <table>
            <thead><tr>{b.head.map((c, j) => <th key={j} style={{ textAlign: b.align[j] }}>{inline(c, links)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} style={{ textAlign: b.align[k] }}>{inline(c, links)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
  }
}

/** Renders `text`, or `blocks` already parsed from it (a plan card parses once to find its title). Parsed once per text. */
export const Markdown = memo(function Markdown({ text, blocks, className }: { text?: string; blocks?: Block[]; className?: string }) {
  const parsed = useMemo(() => blocks ?? parseBlocks(text ?? ''), [blocks, text])
  // The paths this message mentions resolve in the workspace of the agent that wrote it, once the message is on screen.
  const ref = useRef<HTMLDivElement>(null)
  const texts = useMemo(() => blockTexts(parsed), [parsed])
  const links = useFileLinks(useContext(FileLinkScope), texts, ref)
  return <div ref={ref} className={['md', className].filter(Boolean).join(' ')}><Blocks blocks={parsed} links={links} /></div>
})
