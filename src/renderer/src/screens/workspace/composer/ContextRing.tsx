import { useEffect, useRef, type RefObject } from 'react'
import type { Chat } from '@shared/types'
import { call } from '../../../api'
import { Button, Meter, Popover, useBusy } from '../../../ui'
import { attempt } from '../MessageActions'

/** 14230 -> "14k", 1500 -> "1.5k", 1200000 -> "1.2M". Under 1,000 as is. */
export function formatTokens(n: number): string {
  const short = (v: number, unit: string) => `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}${unit}`
  if (n < 1000) return String(n)
  if (n < 1_000_000) return short(n / 1000, 'k')
  return `${Math.round(n / 100_000) / 10}M`
}

const R = 6
const C = 2 * Math.PI * R

/**
 * How full the context window is: a small ring in the composer's footer. Hover shows the token counts, click opens the breakdown
 * by category and Compact now (KERNEL-96). The breakdown is what `Sessions.refreshContext` saved on the chat after the last turn.
 */
export function ContextRing({ chat, blocked, open, onOpen }: { chat: Chat; blocked: boolean; open: boolean; onOpen: (open: boolean) => void }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const ring = useRef<HTMLButtonElement>(null)
  const foot = useRef<HTMLDivElement>(null)
  const was = useRef(open)
  const [busy, run] = useBusy()
  const pct = Math.max(0, Math.min(100, chat.context ?? 0))
  const usage = chat.contextUsage

  // Focus moves to Compact now on open, and back to the ring on close unless a press elsewhere already took it.
  useEffect(() => {
    if (open) foot.current?.querySelector('button')?.focus({ preventScroll: true })
    else if (was.current && (!document.activeElement || document.activeElement === document.body)) ring.current?.focus({ preventScroll: true })
    was.current = open
  }, [open])

  const doCompact = () => run('compact', async () => {
    await attempt('Could not compact', () => call('chats.compact', { chatId: chat.id }))
    onOpen(false)
  })

  return (
    <span ref={anchor} style={{ position: 'relative' }}>
      <button ref={ring} type="button" className="icon-btn ctx-ring" aria-label={`Context, ${pct}% used`} aria-haspopup="dialog" aria-expanded={open}
        data-tip={usage ? `${formatTokens(usage.used)} of ${formatTokens(usage.max)} tokens used` : `${pct}% of context used`}
        onClick={() => onOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={R} fill="none" stroke="var(--line-4)" strokeWidth="2" />
          <circle cx="8" cy="8" r={R} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="butt" strokeDasharray={`${(C * pct) / 100} ${C}`} transform="rotate(-90 8 8)" />
        </svg>
      </button>
      <Popover open={open} onClose={() => onOpen(false)} label="Context" side="top" align="right" className="ctx-pop" anchorRef={anchor as RefObject<HTMLElement | null>}>
        <div className="ctx-head">
          <span className="ctx-title">Context</span>
          <span className="muted">{usage ? `${formatTokens(usage.used)} of ${formatTokens(usage.max)} tokens` : `${pct}% used`}</span>
        </div>
        <Meter value={pct / 100} label={`Context, ${pct}% used`} />
        {usage ? (
          <ul className="ctx-rows">
            {usage.rows.filter((r) => r.kind === 'used').map((r) => (
              <li key={r.name} className="ctx-row">
                <span className="ellipsis">{r.name}</span>
                <span className="ctx-n">{formatTokens(r.tokens)}</span>
                <Meter value={usage.max ? r.tokens / usage.max : 0} label={r.name} />
              </li>
            ))}
            {usage.rows.filter((r) => r.kind !== 'used').map((r) => (
              <li key={r.name} className="ctx-row ctx-rest muted">
                <span className="ellipsis">{r.name}</span>
                <span className="ctx-n">{formatTokens(r.tokens)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted ctx-empty">Details show after the next reply.</p>}
        <div ref={foot} className="ctx-foot">
          <p className="muted">Compacting keeps a summary and frees space.</p>
          <Button variant="secondary" busy={busy === 'compact'} busyLabel="Compacting" disabled={blocked} onClick={() => void doCompact()}>Compact now</Button>
        </div>
      </Popover>
    </span>
  )
}
