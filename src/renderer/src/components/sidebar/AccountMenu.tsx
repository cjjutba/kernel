import './account.css'
import { useRef } from 'react'
import { call, cleanError } from '../../api'
import { actions, go, useStore } from '../../store'
import { Icon, Menu, MENU_SEPARATOR } from '../../ui'
import { PROVIDERS, type AccountProfile, type Provider } from '@shared/types'

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || 'K'

/** "cjjutba · Claude Max" for the CLI login, as before, or an added account's name and plan. */
const activeLine = (a: AccountProfile, cliWho: string) => (!a.signedIn ? 'Signed out' : cliWho || [a.label, a.plan].filter(Boolean).join(' · '))

/** Signing out leaves Claude Code without a login, so the checks screen is where you sign back in (as the same or another account). */
async function leave(title: string) {
  try {
    actions.account.set(await call('account.signOut', undefined))
    actions.system.setPreflight(await call('preflight.run', undefined))
    go({ name: 'onboarding', step: 'checks' })
  } catch (e) { actions.ui.toast({ title, sub: cleanError(e) }) }
}

/** The avatar and name at the top of the sidebar, and its menu (AccountMenu.png). */
export function AccountButton() {
  const account = useStore((s) => s.account)
  const open = useStore((s) => s.ui.menu === 'account')
  const anchor = useRef<HTMLDivElement>(null)
  const accounts = useStore((s) => s.accounts)
  const name = account?.name ?? account?.login ?? 'Kernel'
  const who = [account?.login ?? account?.email, account?.plan].filter(Boolean).join(' · ')
  // KERNEL-406: once there are accounts to choose from, the menu names each provider's active one and offers the others.
  const multi = accounts.length > 2 || accounts.some((a) => a.provider === 'codex' && a.signedIn)
  const others = accounts.filter((a) => !a.active && a.signedIn)
  const switchTo = (provider: Provider, accountId: string) => void call('accounts.switch', { provider, accountId }).then(actions.accounts.set, (e) => actions.ui.toast({ title: 'Could not switch accounts', sub: cleanError(e) }))
  return (
    <div ref={anchor} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" className="acct" aria-haspopup="menu" aria-expanded={open} aria-label={`Account menu, ${name}`} onClick={() => actions.ui.toggleMenu('account')}>
        <span className="acct-av" aria-hidden="true">{initials(name)}</span>
        <span className="ellipsis">{name}</span>
        <Icon name="chevron" size={11} stroke={1.9} />
      </button>
      {open && (
        <Menu
          label="Account" anchorRef={anchor}
          heading={multi ? (
            <span className="acct-who">
              {PROVIDERS.flatMap((p) => { const a = accounts.find((x) => x.provider === p.id && x.active); return a ? [<span key={p.id} className="acct-who-row"><span className="acct-who-name">{p.label}</span><span>{activeLine(a, a.cli && p.id === 'claude' ? who : '')}</span></span>] : [] })}
            </span>
          ) : undefined} onClose={actions.ui.closeMenu} style={{ left: 0, top: 'calc(100% + 6px)', width: 232 }}
          items={[
            ...(!multi && who ? [{ id: 'who', label: who, disabled: true }] : []),
            { id: 'settings', label: 'Settings', shortcut: '⌘,', onSelect: () => actions.ui.openSettings() },
            { id: 'shortcuts', label: 'Keyboard shortcuts', onSelect: () => go({ name: 'settings', page: 'shortcuts' }) },
            { id: 'usage', label: 'Usage', onSelect: () => go({ name: 'settings', page: 'account' }) },
            { id: 'new', label: "What's new", onSelect: () => actions.ui.openModal({ name: 'whatsNew' }) },
            MENU_SEPARATOR,
            ...(multi
              ? [
                  ...others.map((a) => ({ id: `use:${a.provider}:${a.id}`, label: `Switch to ${a.label}`, shortcut: PROVIDERS.find((p) => p.id === a.provider)?.label, onSelect: () => switchTo(a.provider, a.id) })),
                  { id: 'manage', label: 'Manage accounts', onSelect: () => go({ name: 'settings', page: 'providers' }) }
                ]
              : [
                  { id: 'switch', label: 'Switch account', onSelect: () => void leave('Could not switch account') },
                  { id: 'out', label: 'Sign out', onSelect: () => void leave('Could not sign out') }
                ])
          ]}
        />
      )}
    </div>
  )
}
