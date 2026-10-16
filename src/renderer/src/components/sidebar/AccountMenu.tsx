import './account.css'
import { useRef } from 'react'
import { chatsLabel, chatsPerAccount } from '../../accountChats'
import { call, cleanError } from '../../api'
import { actions, getState, go, useStore } from '../../store'
import { openNewChat } from '../../lead'
import { Icon, Menu, ProviderMark, MENU_SEPARATOR, Spinner, type MenuEntry } from '../../ui'
import { PROVIDERS, type AccountProfile, type Provider } from '@shared/types'

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || 'K'

/** Signing out leaves Claude Code without a login. New chat shows the failing sign-in check with its fix (KERNEL-942). */
async function leave(title: string) {
  try {
    actions.account.set(await call('account.signOut', undefined))
    actions.system.setPreflight(await call('preflight.run', undefined))
    openNewChat(undefined)
  } catch (e) { actions.ui.toast({ title, sub: cleanError(e) }) }
}

/** The avatar and name at the top of the sidebar, and its menu (AccountMenu.png). */
export function AccountButton() {
  const account = useStore((s) => s.account)
  const open = useStore((s) => s.ui.menu === 'account')
  const anchor = useRef<HTMLDivElement>(null)
  const accounts = useStore((s) => s.accounts)
  const chats = useStore((s) => s.chats)
  const switching = useStore((s) => s.ui.switching ?? null)
  const name = account?.name ?? account?.login ?? 'Kernel'
  const who = [account?.login ?? account?.email, account?.plan].filter(Boolean).join(' · ')
  const counts = Object.fromEntries(PROVIDERS.map((p) => [p.id, chatsPerAccount(chats, p.id)]))
  const multi = accounts.length > 2 || accounts.some((a) => a.provider === 'codex' && a.signedIn)
  // The menu stays open while the switch runs, with the spinner on its row, and closes when it is done or has failed (KERNEL-986).
  const switchTo = (provider: Provider, accountId: string) => void actions.accounts.requestSwitch(provider, accountId)
    .catch((e) => actions.ui.toast({ title: 'Could not switch accounts', sub: cleanError(e) }))
    .finally(() => { if (getState().ui.menu === 'account') actions.ui.closeMenu() })
  // One row per account, the whole row the switch button. Usage lives in the footer (KERNEL-674).
  const accountEntry = (a: AccountProfile): MenuEntry => {
    const provider = PROVIDERS.find((p) => p.id === a.provider)?.label
    const here = switching?.provider === a.provider && switching.accountId === a.id
    const meta = here ? 'Switching' : !a.signedIn ? 'Signed out' : [a.auth === 'apiKey' ? 'Billed per token' : a.plan, chatsLabel(counts[a.provider]?.[a.id])].filter(Boolean).join(' · ')
    return {
      id: `acct:${a.provider}:${a.id}`,
      label: a.label,
      disabled: switching !== null,
      keepOpen: true,
      ariaLabel: here ? `Switching ${provider} to ${a.label}` : !a.signedIn ? `${provider}, ${a.label}, signed out. Opens providers` : a.active ? `${provider}, ${a.label}, in use` : `Switch ${provider} to ${a.label}`,
      content: (
        <span className="acct-row">
          <span className="acct-mark">{here ? <Spinner label={null} pattern="wave-back" /> : a.active ? <Icon name="check" size={14} /> : null}</span>
          <span className="acct-name ellipsis">{a.label}</span>
          <span className="acct-plan ellipsis">{meta}</span>
        </span>
      ),
      onSelect: !a.signedIn ? () => go({ name: 'settings', page: 'accounts', tab: a.provider }) : a.active ? undefined : () => switchTo(a.provider, a.id)
    }
  }
  const groups = PROVIDERS.flatMap((p, i) => {
    // API keys go after the subscriptions. The rest keep their order, so a switch doesn't move rows.
    const mine = accounts.filter((a) => a.provider === p.id).sort((a, b) => Number(a.auth === 'apiKey') - Number(b.auth === 'apiKey'))
    return mine.length ? [...(i ? [MENU_SEPARATOR] : []), { id: `title:${p.id}`, label: p.label, title: true, leading: <ProviderMark provider={p.id} size={14} /> }, ...mine.map(accountEntry)] : []
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
                { id: 'manage', label: 'Manage accounts', icon: 'team', onSelect: () => go({ name: 'settings', page: 'accounts' }) },
                { id: 'settings', label: 'Settings', icon: 'settings', shortcut: '⌘,', onSelect: () => actions.ui.openSettings() }
              ]
            : [
                ...(who ? [{ id: 'who', label: who, disabled: true }] : []),
                { id: 'settings', label: 'Settings', icon: 'settings', shortcut: '⌘,', onSelect: () => actions.ui.openSettings() },
                MENU_SEPARATOR,
                { id: 'switch', label: 'Switch account', onSelect: () => void leave('Could not switch account') },
                { id: 'out', label: 'Sign out', onSelect: () => void leave('Could not sign out') }
              ]}
        />
      )}
    </div>
  )
}
