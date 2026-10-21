import { useEffect, useRef, type RefObject } from 'react'
import type { Chat } from '@shared/types'
import { call } from '../../../api'
import { Button, Meter, Popover, useBusy } from '../../../ui'
import { attempt } from '../MessageActions'
import { CONTEXT_WARN } from '../banners/model'
import { formatTokens } from './formatTokens'

const R = 6
const C = 2 * Math.PI * R
/**
 * From this much context use the ring turns amber. Claude Code auto compacts about 33k below the model's window, near 83% of
 * 200k and near 97% of 1M, so amber means a compact is coming (context-window-follows-model).
 */
const CONTEXT_NEAR = 75

/** The class that colors the ring and the popover's top meter: red from the banner's threshold, amber from `CONTEXT_NEAR`. */
const contextLevel = (pct: number) => pct >= CONTEXT_WARN ? 'ctx-full' : pct >= CONTEXT_NEAR ? 'ctx-near' : undefined

/** The rows the popover lists: the engine's tools and MCP rows are one line, so are memory files and skills, and the rest keep their order. */
export function contextRows(rows: NonNullable<Chat['contextUsage']>['rows']): typeof rows {
  const joined: Record<string, string> = { 'System tools': 'Tools and MCP', 'MCP tools': 'Tools and MCP', 'Memory files': 'Memory and skills', Skills: 'Memory and skills' }
  const out: typeof rows = []
  for (const r of rows) {
    const name = joined[r.name] ?? r.name
    const at = out.findIndex((x) => x.name === name && x.kind === r.kind)
    if (at >= 0) out[at] = { ...out[at], tokens: out[at].tokens + r.tokens }
    else out.push({ ...r, name })
  }
  return out
}

/**
 * How full the context window is: a small ring in the composer's footer. Hover shows the token counts, click opens the breakdown
 * by category and Compact now (KERNEL-96). The breakdown is what `Sessions.refreshContext` saved on the chat after the last turn.
 */
export function ContextRing({ chat, name, blocked, open, onOpen }: { chat: Chat; /** The agent in the chat, who compacts before the next turn once the window is full. */ name: string; blocked: boolean; open: boolean; onOpen: (open: boolean) => void }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const ring = useRef<HTMLButtonElement>(null)
  const foot = useRef<HTMLDivElement>(null)
  const was = useRef(open)
  const [busy, run] = useBusy()
  const pct = Math.max(0, Math.min(100, chat.context ?? 0))
  const usage = chat.contextUsage
  const level = contextLevel(pct)

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
      <button ref={ring} type="button" className={['icon-btn sm ctx-ring', level].filter(Boolean).join(' ')} aria-label={`Context, ${pct}% used`} aria-haspopup="dialog" aria-expanded={open} data-tip-side="above"
        data-tip={usage ? `${formatTokens(usage.used)} of ${formatTokens(usage.max)} tokens used` : `${pct}% of context used`}
        onClick={() => onOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={R} fill="none" stroke="var(--line-3)" strokeWidth="2" />
          <circle cx="8" cy="8" r={R} className="ctx-arc" fill="none" strokeWidth="2" strokeLinecap="butt" strokeDasharray={`${(C * pct) / 100} ${C}`} transform="rotate(-90 8 8)" />
        </svg>
      </button>
      <Popover open={open} onClose={() => onOpen(false)} label="Context" side="top" align="right" className={['ctx-pop', level].filter(Boolean).join(' ')} anchorRef={anchor as RefObject<HTMLElement | null>}>
        <div className="ctx-head">
          <span className="ctx-title">Context</span>
          <span className="muted">{usage ? `${formatTokens(usage.used)} of ${formatTokens(usage.max)} tokens` : chat.context === undefined ? 'New chat' : `${pct}% used`}</span>
        </div>
        {usage ? (
          <>
            <Meter value={pct / 100} label={`Context, ${pct}% used`} />
            <ul className="ctx-rows">
              {contextRows(usage.rows).map((r) => (
                <li key={r.name} className="ctx-row" data-rest={r.kind !== 'used' || undefined}>
                  <span className="ellipsis">{r.name}</span>
                  <span className="ctx-n">{formatTokens(r.tokens)}</span>
                </li>
              ))}
            </ul>
            <div ref={foot} className="ctx-foot">
              <p className="muted">{level === 'ctx-full' ? `${name} compacts before its next turn.` : 'Compacting summarizes the chat so far and keeps going.'}</p>
              <Button variant="secondary" busy={busy === 'compact'} busyLabel="Compacting" disabled={blocked} onClick={() => void doCompact()}>Compact now</Button>
            </div>
          </>
        ) : <p className="muted ctx-empty">Details show after the next reply.</p>}
      </Popover>
    </span>
  )
}
