import { pullUrl } from '@/lib/links'
import type { ChangeItem } from '@/lib/schema'
import { OutlineChip } from '@/components/ui/OutlineChip'

/** How many changes a section shows before the rest fold behind "Show N more". */
const SHOWN = 6

function Item({ item }: { item: ChangeItem }) {
  return (
    <li className="mt-2 text-list text-ink-3 cl-bullet">
      {item.lead ? <b className="font-medium text-ink">{item.lead}</b> : null}
      {item.lead ? ' ' : null}
      {item.text}
      {item.pr ? ' ' : null}
      {item.pr ? (
        <OutlineChip
          href={pullUrl(item.pr)}
          aria-label={`Pull request #${item.pr}`}
          className="ml-2 inline-flex h-5 items-center rounded-prchip bg-surface-2 px-1.5 align-nudge font-mono text-tag leading-normal font-medium text-muted hover:text-ink"
        >
          #{item.pr}
        </OutlineChip>
      ) : null}
    </li>
  )
}

/**
 * A section's changes. Past `SHOWN`, the rest wait behind a "Show N more" button, a native details element, so it
 * needs no script and the browser's find in page still reaches the folded changes. `fold={false}` lists them all.
 */
export function ChangeList({ items, fold = true }: { items: ChangeItem[]; fold?: boolean }) {
  const folds = fold && items.length > SHOWN + 2
  const shown = folds ? items.slice(0, SHOWN) : items
  const rest = folds ? items.slice(SHOWN) : []
  return (
    <>
      <ul className="mt-4">
        {shown.map((item) => (
          <Item key={item.text} item={item} />
        ))}
      </ul>
      {rest.length ? (
        <details className="group">
          <summary className="mt-4 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-line-strong px-3 text-ui font-medium text-ink-2 transition-colors group-open:hidden hover:border-edge-hover hover:text-ink">
            Show {rest.length} more
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-muted">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </summary>
          <ul>
            {rest.map((item) => (
              <Item key={item.text} item={item} />
            ))}
          </ul>
        </details>
      ) : null}
    </>
  )
}
