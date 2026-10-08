import { pullUrl } from '@/lib/links'
import type { ChangeItem } from '@/lib/schema'

export function ChangeList({ items }: { items: ChangeItem[] }) {
  return (
    <ul className="mt-4">
      {items.map((item) => (
        <li key={item.text} className="mt-2 text-list text-ink-3 cl-bullet">
          {item.lead ? <b className="font-medium text-ink">{item.lead}</b> : null}
          {item.lead ? ' ' : null}
          {item.text}
          {item.pr ? ' ' : null}
          {item.pr ? (
            <a
              href={pullUrl(item.pr)}
              target="_blank"
              rel="noopener"
              aria-label={`Pull request #${item.pr}`}
              className="ml-2 inline-flex h-5 items-center rounded-prchip border border-line-strong bg-surface-2 px-1.5 align-nudge font-mono text-tag leading-normal font-medium text-muted hover:border-edge-hover hover:text-ink"
            >
              #{item.pr}
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
