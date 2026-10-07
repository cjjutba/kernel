import { Fragment, type ReactNode } from 'react'
import { CodeBlock } from '../../ui'
import { parseBlocks } from './mdParse'

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

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseBlocks(text).map((b, i) => {
        switch (b.type) {
          case 'p': return <p key={i}>{inline(b.text)}</p>
          case 'h': return <p key={i} className="md-h">{inline(b.text)}</p>
          case 'ul': return <ul key={i}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>
          case 'ol': return <ol key={i}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>
          case 'code': return <CodeBlock key={i}>{b.text}</CodeBlock>
        }
      })}
    </div>
  )
}
