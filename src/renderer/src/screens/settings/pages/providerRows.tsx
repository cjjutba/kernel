import { useRef, type ReactNode } from 'react'
import type { AccountProfile } from '@shared/types'
import type { AccountRowView } from '../../../accountRows'
import { Button, Icon, IconButton, Menu, Meter, type MenuEntry, MENU_SEPARATOR } from '../../../ui'

// One account on Settings, Providers (feat-providers-redesign): its name and plan, one line under it, the usage meters and the notes under
// them on the left; the Active pill or its one action, then a menu with the rest, on the right.

/** The row's own action: Switch to, Sign in, Sign in again or Replace key. `busy` spins it with `busyLabel`. */
export interface RowAction { label: string; onClick: () => void; busy?: boolean; busyLabel?: string }

/** The name turned into a field. */
export interface RowRename { value: string; saving: boolean; onChange: (value: string) => void; onSave: () => void; onCancel: () => void }

export function AccountRow({ account, view, active, action, pending, locked, menu, menuHeading, menuOpen, onMenu, rename, children }: {
  account: AccountProfile
  view: AccountRowView
  /** Agents run on it: the Active pill takes the action's place. */
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
  /** Lines after the meters: the MCP sign-in line, the Keychain wait, the same organization note. */
  children?: ReactNode
}) {
  const anchor = useRef<HTMLDivElement>(null)
  // Escape, a press outside or a pick closes the menu and hands focus back to its button. Rename's field and Remove's dialog take it after.
  const close = () => { onMenu(false); anchor.current?.querySelector<HTMLButtonElement>('.prov-more')?.focus() }
  return (
    <div className="prov-row">
      <div className="prov-main">
        {rename
          ? (
            <input
              className="prov-rename" aria-label={`Name for ${account.label}`} autoComplete="off" spellCheck={false} autoFocus placeholder={account.email} disabled={rename.saving} value={rename.value}
              onFocus={(e) => e.currentTarget.select()} onChange={(e) => rename.onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') { e.preventDefault(); rename.onSave() }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); rename.onCancel() }
              }}
            />
          )
          : (
            <div className="prov-name">
              <span className="set-label">{account.label}</span>
              {account.signedIn && account.plan && <span className="prov-plan">{account.plan}</span>}
            </div>
          )}
        {view.sub && <span className="set-desc">{view.sub}</span>}
        {view.windows.length > 0 && (
          <div className="prov-meters">
            {view.windows.map((w) => (
              <div key={w.title} className="prov-win" data-tip={w.reset ? `Resets ${w.reset}` : ''}>
                <span className="prov-win-name">{w.title}</span>
                <Meter value={w.pct / 100} label={`${account.label}, ${w.title}${w.reset ? `, resets ${w.reset}` : ''}`} />
                <span className="prov-win-pct">{w.pct}%</span>
              </div>
            ))}
          </div>
        )}
        {view.resetNote && <span className="prov-note">{view.resetNote}</span>}
        {view.empty && <span className="prov-note">{view.empty}</span>}
        {view.asOf && <span className="prov-note prov-faint">{view.asOf}</span>}
        {children}
      </div>
      <div className="prov-side" ref={anchor}>
        {rename
          ? (
            <>
              <Button variant="ghost" aria-label={`Cancel renaming ${account.label}`} disabled={rename.saving} onClick={rename.onCancel}>Cancel</Button>
              <Button aria-label={`Save the name for ${account.label}`} busy={rename.saving} busyLabel="Saving" onClick={rename.onSave}>Save</Button>
            </>
          )
          : (
            <>
              {pending
                ? <Button busy busyLabel={pending}>{pending}</Button>
                : active
                  ? <span className="prov-active">Active</span>
                  : action && <Button aria-label={`${action.label} ${account.label}`} busy={action.busy} busyLabel={action.busyLabel} disabled={locked} onClick={action.onClick}>{action.label}</Button>}
              <IconButton
                icon="more" label={`More for ${account.label}`} aria-haspopup="menu" aria-expanded={menuOpen} disabled={locked || !!pending}
                className={menuOpen ? 'prov-more on' : 'prov-more'} onClick={() => onMenu(!menuOpen)}
              />
              {menuOpen && <Menu label={account.label} heading={menuHeading} anchorRef={anchor} onClose={close} style={{ right: 0, top: 34, width: 220 }} items={menu} />}
            </>
          )}
      </div>
    </div>
  )
}

/** The account in use hit a limit: what happens next, and a switch when Kernel won't make it on its own. */
export function LimitBanner({ text, action, locked }: { text: string; action?: RowAction; locked: boolean }) {
  return (
    <div className="prov-banner" role="status">
      <Icon name="warning" size={14} />
      <span className="grow">{text}</span>
      {action && <Button busy={action.busy} busyLabel={action.busyLabel} disabled={locked} onClick={action.onClick}>{action.label}</Button>}
    </div>
  )
}
