import { useId, useRef, type ReactNode } from 'react'
import type { AccountProfile, RateLimit } from '@shared/types'
import { resetPhrase } from '@shared/usage'
import { Button, IconButton, Menu, Meter, type MenuEntry, MENU_SEPARATOR } from '../../../ui'
import { isFable, live, windowsOf } from '../../../components/footer/planModel'
import './accounts.css'

// One account on Settings, Accounts (KERNEL-680, Calm.dc.html): its name, plan and In use on the left, a meter under each column (5-hour, Weekly
// and the per-model weekly window when the data has one), then Switch and the menu, shown on hover. A click on the name opens its details.

/** The row's own action: Switch, Sign in, Sign in again or Replace key. `busy` spins it with `busyLabel`. */
export interface RowAction { label: string; onClick: () => void; busy?: boolean; busyLabel?: string }

/** The name turned into a field. */
export interface RowRename { value: string; saving: boolean; onChange: (value: string) => void; onSave: () => void; onCancel: () => void }

/** One usage window under a column: how much is used (0 to 100) and when it resets, as "today at 4:10 PM". */
export interface Cell { pct: number; reset?: string; title: string }

/** The three column windows of an account: 5-hour, Weekly and the model with its own weekly window (Fable), each only when Kernel has a live number. */
export function rowCells(a: AccountProfile, usage: RateLimit[], now: number): { cells: (Cell | undefined)[]; third?: string } {
  if (a.auth === 'apiKey' || !a.signedIn) return { cells: [undefined, undefined, undefined] }
  const mine = windowsOf(usage, a)
  const one = (l: RateLimit | undefined, title: string): Cell | undefined => {
    const w = live(l, now)
    return w ? { title, pct: Math.round((w.utilization ?? 0) * 100), ...(w.resetsAt ? { reset: resetPhrase(w.resetsAt, now) } : {}) } : undefined
  }
  const fable = mine.find((l) => isFable(l))
  const third = fable ? 'Fable 5.1' : undefined
  return { cells: [one(mine.find((l) => l.type === 'five_hour' && !l.model), '5-hour'), one(mine.find((l) => l.type === 'seven_day' && !l.model), 'Weekly'), third ? one(fable, third) : undefined], ...(third ? { third } : {}) }
}

/**
 * When the account is back, in epoch seconds: the latest reset among its 5-hour and weekly windows that are rejected and not reset yet.
 * `blocked` is true while one is, even if it has no reset time. A per-model window never blocks the account.
 */
export function blockedUntil(a: AccountProfile, usage: RateLimit[], now: number): { blocked: boolean; at?: number } {
  const hits = windowsOf(usage, a).filter((l) => (l.type === 'five_hour' || l.type === 'seven_day') && !l.model && l.status === 'rejected' && (l.resetsAt === undefined || l.resetsAt * 1000 > now))
  const times = hits.flatMap((l) => (l.resetsAt === undefined ? [] : [l.resetsAt]))
  return { blocked: hits.length > 0, ...(times.length ? { at: Math.max(...times) } : {}) }
}

export function AccountRow({ account, line2, back, note, cells, active, action, pending, locked, menu, menuHeading, menuOpen, onMenu, rename, open, onToggle, details, children }: {
  account: AccountProfile
  /** The plan, "API key" or "Signed out". */
  line2: string
  /** "Back at 4:10 PM" while the account is at a limit. */
  back?: string
  /** Said across the meter columns when there are no meters: "Billed per token", "Sign in to see usage". */
  note?: string
  cells: (Cell | undefined)[]
  /** Agents run on it: "In use" shows after the name. */
  active: boolean
  action?: RowAction
  /** Something the menu started is running, such as "Signing out": a spinning button stands in for the action. */
  pending?: string
  /** Another action runs, or a sheet is open. */
  locked: boolean
  menu: (MenuEntry | typeof MENU_SEPARATOR)[]
  menuHeading?: string
  menuOpen: boolean
  onMenu: (open: boolean) => void
  rename?: RowRename
  open: boolean
  onToggle: () => void
  /** The rows of the open details: Email, resets, MCP sign-ins and Sign-in source. */
  details: { k: string; v: ReactNode }[]
  /** Lines under the name in the open details, after the rows: the Keychain wait. */
  children?: ReactNode
}) {
  const anchor = useRef<HTMLDivElement>(null)
  const detailsId = useId()
  // Escape, a press outside or a pick closes the menu and hands focus back to its button. Rename's field and Remove's dialog take it after.
  const close = () => { onMenu(false); anchor.current?.querySelector<HTMLButtonElement>('.ac-more')?.focus() }
  if (rename) {
    return (
      <div className="ac-row" data-open="true">
        <div className="ac-renaming">
          <input
            className="ac-rename" aria-label={`Name for ${account.label}`} autoComplete="off" spellCheck={false} autoFocus placeholder={account.email} disabled={rename.saving} value={rename.value}
            onFocus={(e) => e.currentTarget.select()} onChange={(e) => rename.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') { e.preventDefault(); rename.onSave() }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); rename.onCancel() }
            }}
          />
          <Button variant="ghost" aria-label={`Cancel renaming ${account.label}`} disabled={rename.saving} onClick={rename.onCancel}>Cancel</Button>
          <Button variant="primary" aria-label={`Save the name for ${account.label}`} busy={rename.saving} busyLabel="Saving" onClick={rename.onSave}>Save</Button>
        </div>
      </div>
    )
  }
  const keep = menuOpen || !!pending || !!action?.busy || action?.label === 'Sign in'
  return (
    <div className="ac-row" data-open={open || undefined}>
      <div className="ac-grid ac-main">
        <button type="button" className="ac-disc" aria-expanded={open} aria-controls={detailsId} onClick={onToggle}>
          <svg className="ac-chev" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
          <span className="ac-who">
            <span className="ac-name-line"><span className="ac-name">{account.label}</span>{active && <span className="ac-inuse">In use</span>}</span>
            <span className="ac-line2">{line2}{back && <span className="ac-back"> · {back}</span>}</span>
          </span>
        </button>
        {note
          ? <span className="ac-note">{note}</span>
          : cells.map((c, i) => (
            <span key={i} className="ac-cell" data-tip={c?.reset ? `${c.title} resets ${c.reset}` : ''}>
              {c && <><Meter value={c.pct / 100} label={`${account.label}, ${c.title}${c.reset ? `, resets ${c.reset}` : ''}`} /><span className="ac-pc" data-hot={c.pct >= 90 || undefined}>{c.pct}%</span></>}
            </span>
          ))}
        <div className="ac-acts" ref={anchor} data-keep={keep || undefined}>
          {pending
            ? <Button busy busyLabel={pending}>{pending}</Button>
            : action && <Button aria-label={`${action.label} ${account.label}`} busy={action.busy} busyPattern="wave-back" busyLabel={action.busyLabel} disabled={locked} onClick={action.onClick}>{action.label}</Button>}
          <IconButton
            icon="more" size={16} label={`More for ${account.label}`} aria-haspopup="menu" aria-expanded={menuOpen} disabled={locked || !!pending}
            className={menuOpen ? 'ac-more on' : 'ac-more'} onClick={() => onMenu(!menuOpen)}
          />
          {menuOpen && <Menu label={account.label} heading={menuHeading} anchorRef={anchor} onClose={close} style={{ right: 0, top: 32, width: 220 }} items={menu} />}
        </div>
      </div>
      {open && (
        <div id={detailsId} role="region" aria-label={`${account.label} details`} className="ac-details">
          <dl>
            {details.map((d) => <div key={d.k} className="ac-kv"><dt>{d.k}</dt><dd>{d.v}</dd></div>)}
          </dl>
          {children}
        </div>
      )}
    </div>
  )
}
