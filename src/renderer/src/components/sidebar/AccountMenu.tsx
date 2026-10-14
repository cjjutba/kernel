import './account.css'
import { useRef } from 'react'
import { chatsLabel, chatsPerAccount } from '../../accountChats'
import { call, cleanError } from '../../api'
import { actions, go, useStore } from '../../store'
import { Icon, Menu, MENU_SEPARATOR, Spinner, useBusy, type MenuEntry } from '../../ui'
import { PROVIDERS, type AccountProfile, type Provider } from '@shared/types'

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || 'K'

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
  const chats = useStore((s) => s.chats)
  const [busy, run] = useBusy<string>()
  const name = account?.name ?? account?.login ?? 'Kernel'
  const who = [account?.login ?? account?.email, account?.plan].filter(Boolean).join(' · ')
  const counts = Object.fromEntries(PROVIDERS.map((p) => [p.id, chatsPerAccount(chats, p.id)]))
  const multi = accounts.length > 2 || accounts.some((a) => a.provider === 'codex' && a.signedIn)
  const switchTo = (provider: Provider, accountId: string) => void run(`${provider}:${accountId}`, () => actions.accounts.requestSwitch(provider, accountId).catch((e) => actions.ui.toast({ title: 'Could not switch accounts', sub: cleanError(e) })))
  // One row per account, the whole row the switch button. Usage lives in the footer (KERNEL-674).
  const accountEntry = (a: AccountProfile): MenuEntry => {
    const provider = PROVIDERS.find((p) => p.id === a.provider)?.label
    const switching = busy === `${a.provider}:${a.id}`
    const note = !a.signedIn ? 'Signed out' : a.auth === 'apiKey' ? 'Billed per token' : undefined
    return {
      id: `acct:${a.provider}:${a.id}`,
      label: a.label,
      disabled: busy !== null,
      ariaLabel: !a.signedIn ? `${provider}, ${a.label}, signed out. Opens providers` : a.active ? `${provider}, ${a.label}, in use` : `Switch ${provider} to ${a.label}`,
      content: (
        <span className="acct-row">
          <span className="acct-name ellipsis">{a.label}</span>
          <span className="acct-plan ellipsis">{[a.auth === 'apiKey' ? undefined : a.plan, chatsLabel(counts[a.provider]?.[a.id])].filter(Boolean).join(' · ')}</span>
          {switching ? <Spinner label={null} pattern="wave-back" /> : note ? <span className="acct-state">{note}</span> : a.active ? <Icon name="check" size={14} /> : null}
        </span>
      ),
      onSelect: !a.signedIn ? () => go({ name: 'settings', page: 'accounts', tab: a.provider }) : a.active ? undefined : () => switchTo(a.provider, a.id)
    }
  }
  const groups = PROVIDERS.flatMap((p, i) => {
    const mine = accounts.filter((a) => a.provider === p.id)
    return mine.length ? [...(i ? [MENU_SEPARATOR] : []), { id: `title:${p.id}`, label: p.label, title: true }, ...mine.map(accountEntry)] : []
  })
  return (
    <div ref={anchor} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" className="acct" aria-haspopup="menu" aria-expanded={open} aria-label={`Account menu, ${name}`} onClick={() => actions.ui.toggleMenu('account')}>
        <span className="acct-av" aria-hidden="true">{initials(name)}</span>
        <span className="ellipsis">{name}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <Menu
          label="Account" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ left: 0, top: 'calc(100% + 6px)', width: multi ? 320 : 232 }}
          items={multi
            ? [
                ...groups,
                MENU_SEPARATOR,
                { id: 'settings', label: 'Settings', shortcut: '⌘,', onSelect: () => actions.ui.openSettings() },
                MENU_SEPARATOR,
                { id: 'manage', label: 'Manage accounts', onSelect: () => go({ name: 'settings', page: 'accounts' }) }
              ]
            : [
                ...(who ? [{ id: 'who', label: who, disabled: true }] : []),
                { id: 'settings', label: 'Settings', shortcut: '⌘,', onSelect: () => actions.ui.openSettings() },
                MENU_SEPARATOR,
                { id: 'switch', label: 'Switch account', onSelect: () => void leave('Could not switch account') },
                { id: 'out', label: 'Sign out', onSelect: () => void leave('Could not sign out') }
              ]}
        />
      )}
    </div>
  )
}
