import { useRef, type ReactNode } from 'react'
import type { AccountProfile, RateLimit } from '@shared/types'
import { resetPhrase } from '@shared/usage'
import { Button, Icon, IconButton, Menu, Meter, ProviderMark, Spinner, type IconName, type MenuEntry, MENU_SEPARATOR } from '../../../ui'
import { isFable, live, windowsOf } from '../../../components/footer/planModel'
import './accounts.css'

// One account on Settings, Accounts (Redesign 15, Pen 15.4): its mark, name with badges and a line of who it is, then its action and menu. Under
// them one line for each usage window (5-hour, Weekly and the model with its own weekly window) with a meter, the percent and when it resets, then
// what Kernel has to say about the account, one line each, and the rows of an MCP sign-in that is running or failed.

/** The row's own action: Switch, Sign in, Sign in again or Replace key. `busy` spins it with `busyLabel`. */
export interface RowAction { label: string; onClick: () => void; busy?: boolean; busyLabel?: string }

/** The name turned into a field. */
export interface RowRename { value: string; saving: boolean; onChange: (value: string) => void; onSave: () => void; onCancel: () => void }

/** One usage window under a column: how much is used (0 to 100) and when it resets, as "today at 4:10 PM". `absent` is a column the account's plan doesn't have: it says "Not in plan" and shows no meter. */
export interface Cell { pct: number; reset?: string; title: string; absent?: boolean }

/**
 * The three column windows of an account: 5-hour, Weekly and the model with its own weekly window (Fable). A window Kernel has a reading for shows it, or 0% once it has reset.
 * `group` is the group's third column: an account with 5-hour or weekly readings and no window for it says "Not in plan".
 */
export function rowCells(a: AccountProfile, usage: RateLimit[], now: number, group?: string): { cells: (Cell | undefined)[]; third?: string } {
  if (a.auth === 'apiKey' || !a.signedIn) return { cells: [undefined, undefined, undefined] }
  const mine = windowsOf(usage, a)
  const one = (l: RateLimit | undefined, title: string): Cell | undefined => {
    const w = live(l, now)
    if (w) return { title, pct: Math.round((w.utilization ?? 0) * 100), ...(w.resetsAt ? { reset: resetPhrase(w.resetsAt, now) } : {}) }
    return l?.utilization !== undefined ? { title, pct: 0 } : undefined
  }
  const fable = mine.find((l) => isFable(l))
  const third = fable ? 'Fable 5.1' : undefined
  const five = mine.find((l) => l.type === 'five_hour' && !l.model)
  const week = mine.find((l) => l.type === 'seven_day' && !l.model)
  const absent: Cell | undefined = group && !fable && (five?.utilization !== undefined || week?.utilization !== undefined) ? { title: group, pct: 0, absent: true } : undefined
  return { cells: [one(five, '5-hour'), one(week, 'Weekly'), third ? one(fable, third) : absent], ...(third ? { third } : {}) }
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

/** A pill after the name: "In use", "Terminal", "Added in Kernel", "Legacy". `limit` is the account at a limit, in the failing text color. */
export interface RowBadge { text: string; tone?: 'limit' }

/** One line under the windows: what Kernel says of the account, with the glyph that says what kind of thing it is. */
export interface RowNote { icon?: IconName; text: ReactNode }

/** One usage window under the name: how much is used (0 to 100) and "resets 8:20 PM". */
export interface RowWindow { title: string; pct: number; reset?: string }

/** The row's windows from `rowCells`: the 5-hour, weekly and model windows with a reading, in the Pen's words ("resets Thursday 3:00 AM"). A column the plan doesn't have is left out. */
export function rowWindows(cells: (Cell | undefined)[], third?: string): RowWindow[] {
  return cells.flatMap((c, i): RowWindow[] => {
    if (!c || c.absent) return []
    const title = i === 2 && third ? third.split(' ')[0] : c.title
    return [{ title, pct: c.pct, ...(c.reset ? { reset: `resets ${c.reset.replace(/^at /, '').replace(' at ', ' ')}` } : {}) }]
  })
}

export function AccountRow({ account, name, badges, sub, windows, notes, action, pending, locked, menu, menuHeading, menuOpen, onMenu, rename, children }: {
  account: AccountProfile
  /** The nickname, or the email when there is none. */
  name: string
  badges: RowBadge[]
  /** Who it is: the email, plan and chats on it, "Billed per token", "Signed out". */
  sub: string
  windows: RowWindow[]
  notes: RowNote[]
  action?: RowAction
  /** Something the menu started is running, such as "Signing out": its loader and words stand in for the action. */
  pending?: string
  /** Another action runs, or a sheet is open. */
  locked: boolean
  menu: (MenuEntry | typeof MENU_SEPARATOR)[]
  menuHeading?: string
  menuOpen: boolean
  onMenu: (open: boolean) => void
  rename?: RowRename
  /** Rows under the account: an MCP sign-in that is running or did not finish. */
  children?: ReactNode
}) {
  const anchor = useRef<HTMLDivElement>(null)
  // Escape, a press outside or a pick closes the menu and hands focus back to its button. Rename's field and Remove's dialog take it after.
  const close = () => { onMenu(false); anchor.current?.querySelector<HTMLButtonElement>('.ac-more')?.focus() }
  // Enter and Escape end the rename themselves, so the blur that follows when the field goes away saves nothing twice.
  // A blur with the name cleared keeps the old name: only Enter sends an empty name.
  const renameDone = useRef(false)
  if (!rename) renameDone.current = false
  const key = account.auth === 'apiKey'
  const title = rename
    ? (
      <span className="ac-renaming">
        <input
          className="input ac-rename" aria-label={`Name for ${account.label}`} autoComplete="off" spellCheck={false} autoFocus placeholder={account.email} disabled={rename.saving} value={rename.value}
          onFocus={(e) => e.currentTarget.select()} onChange={(e) => { renameDone.current = false; rename.onChange(e.target.value) }}
          onBlur={() => { if (renameDone.current || rename.saving) return; if (rename.value.trim()) rename.onSave(); else rename.onCancel() }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') { e.preventDefault(); renameDone.current = true; rename.onSave() }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renameDone.current = true; rename.onCancel() }
          }}
        />
        {rename.saving && <span className="set-save" data-state="saving" role="status"><Spinner label={null} pattern="ripple" />Saving</span>}
      </span>
    )
    : <span className="ac-name-line"><span className="ac-name">{name}</span>{badges.map((b) => <span key={b.text} className="ac-badge" data-tone={b.tone}>{b.text}</span>)}</span>
  return (
    <>
    <div className="ac-row" data-account={`${account.provider}:${account.id}`}>
      <div className="ac-top">
        <span className="ac-mark" aria-hidden="true">{key ? <Icon name="key" size={14} /> : <ProviderMark provider={account.provider} size={14} />}</span>
        <div className="ac-who">
          {title}
          <span className="ac-sub">{sub}</span>
        </div>
        <div className="ac-acts" ref={anchor}>
          {pending
            ? <span className="ac-pending" role="status"><Spinner label={null} pattern="ripple" />{pending}</span>
            : action && <Button aria-label={`${action.label} ${name}`} busy={action.busy} busyPattern="ripple" busyLabel={action.busyLabel} disabled={locked} onClick={action.onClick}>{action.label}</Button>}
          <IconButton
            icon="more" size={16} label={`More for ${name}`} aria-haspopup="menu" aria-expanded={menuOpen} disabled={locked || !!pending}
            className={menuOpen ? 'ac-more on' : 'ac-more'} onClick={() => onMenu(!menuOpen)}
          />
          {menuOpen && <Menu label={name} heading={menuHeading} anchorRef={anchor} onClose={close} style={{ right: 0, top: 32, width: 220 }} items={menu} />}
        </div>
      </div>
      {windows.length > 0 && (
        <div className="ac-wins">
          {windows.map((w) => (
            <div key={w.title} className="ac-win">
              <span className="ac-win-name">{w.title}</span>
              <Meter value={w.pct / 100} label={`${name}, ${w.title}${w.reset ? `, ${w.reset}` : ''}`} />
              <span className="ac-pc" data-tone={w.pct >= 90 ? 'hot' : undefined}>{w.pct}%</span>
              {w.reset && <span className="ac-reset">{w.reset}</span>}
            </div>
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <div className="ac-notes">
          {notes.map((n, i) => <p key={i} className="ac-note">{n.icon && <Icon name={n.icon} size={14} />}<span>{n.text}</span></p>)}
        </div>
      )}
    </div>
    {children}
    </>
  )
}
