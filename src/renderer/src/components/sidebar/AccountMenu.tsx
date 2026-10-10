import './account.css'
import { useRef } from 'react'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { Icon, Menu, MENU_SEPARATOR } from '../../ui'

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || 'K'

/** Signing out leaves Claude Code without a login, so the checks screen is where you sign back in (as the same or another account). */
async function leave(title: string) {
  try {
    actions.account.set(await call('account.signOut', undefined))
    actions.system.setPreflight(await call('preflight.run', undefined))
    go({ name: 'onboarding', step: 'checks' })
  } catch (e) { actions.ui.toast({ title, sub: (e as Error).message }) }
}

/** The avatar and name at the top of the sidebar, and its menu (AccountMenu.png). */
export function AccountButton() {
  const account = useStore((s) => s.account)
  const open = useStore((s) => s.ui.menu === 'account')
  const anchor = useRef<HTMLDivElement>(null)
  const name = account?.name ?? account?.login ?? 'Kernel'
  const who = [account?.login ?? account?.email, account?.plan].filter(Boolean).join(' · ')
  return (
    <div ref={anchor} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" className="acct" aria-haspopup="menu" aria-expanded={open} aria-label={`Account menu, ${name}`} onClick={() => actions.ui.toggleMenu('account')}>
        <span className="acct-av" aria-hidden="true">{initials(name)}</span>
        <span className="ellipsis">{name}</span>
        <Icon name="chevron" size={11} stroke={1.9} />
      </button>
      {open && (
        <Menu
          label="Account" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ left: 0, top: 'calc(100% + 6px)', width: 232 }}
          items={[
            ...(who ? [{ id: 'who', label: who, disabled: true }] : []),
            { id: 'settings', label: 'Settings', shortcut: '⌘,', onSelect: () => go({ name: 'settings', page: 'general' }) },
            { id: 'shortcuts', label: 'Keyboard shortcuts', onSelect: () => go({ name: 'settings', page: 'shortcuts' }) },
            { id: 'usage', label: 'Usage', onSelect: () => go({ name: 'settings', page: 'account' }) },
            { id: 'new', label: "What's new", onSelect: () => actions.ui.openModal({ name: 'whatsNew' }) },
            MENU_SEPARATOR,
            { id: 'switch', label: 'Switch account', onSelect: () => void leave('Could not switch account') },
            { id: 'out', label: 'Sign out', onSelect: () => void leave('Could not sign out') }
          ]}
        />
      )}
    </div>
  )
}
