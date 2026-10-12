import { useId, useRef } from 'react'
import type { Provider } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, Icon, Meter, Popover, useBusy } from '../../ui'
import { useFreshUsage } from '../../accountRows'
import { planSections, type PlanSection } from './planModel'

type Busy = `switch:${Provider}:${string}` | `signin:${Provider}`

/**
 * The Usage pill at the bottom of the sidebar (UsagePopover.png, KERNEL-619). It opens one popover with a section for Claude Code
 * and one for Codex. Each shows the account that provider runs on, with its windows and reset times, and Switch to the provider's
 * other signed-in accounts. A key in use says it is billed per token, and a provider that isn't signed in is one line with Sign in.
 * The numbers follow `usage` and `accounts` pushes, so they change while it is open.
 */
export function PlanButton() {
  const open = useStore((s) => s.ui.menu === 'plan')
  const accounts = useStore((s) => s.accounts)
  const usage = useStore((s) => s.usage)
  const anchor = useRef<HTMLDivElement>(null)
  const [busy, run] = useBusy<Busy>()
  // A running session answers with fresh numbers. Without one, main returns the last ones it saw.
  useFreshUsage(open)
  const sections = open ? planSections(accounts, usage, Date.now()) : []
  const fail = (title: string, e: unknown) => actions.ui.toast({ title, sub: cleanError(e) })
  const switchTo = (provider: Provider, accountId: string) => run(`switch:${provider}:${accountId}`, async () => {
    try {
      actions.accounts.set(await call('accounts.switch', { provider, accountId }))
      void call('usage.get', undefined).then(actions.usage.set).catch(() => undefined)
    } catch (e) { fail('Could not switch accounts', e) }
  })
  // The CLI's own login signs in right here. An added account asks for a code and keeps its name, which its sheet in Settings does.
  const signIn = (s: PlanSection) => {
    if (s.signedOut && !s.signedOut.cli) {
      actions.ui.closeMenu()
      return go({ name: 'settings', page: 'providers', tab: s.provider })
    }
    return run(`signin:${s.provider}`, async () => {
      try {
        await call('providers.signIn', { provider: s.provider })
        actions.accounts.set(await call('accounts.list', undefined))
        if (s.provider === 'claude') actions.account.set(await call('account.get', undefined))
      } catch (e) { fail('Could not sign in', e) }
    })
  }
  return (
    <div ref={anchor} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" className="plan-pill" aria-haspopup="dialog" aria-expanded={open} onClick={() => actions.ui.toggleMenu('plan')}>Usage</button>
      <Popover open={open} onClose={actions.ui.closeMenu} label="Usage" side="top" className="plan-pop" anchorRef={anchor}>
        {sections.map((s) => <PlanProvider key={s.provider} s={s} busy={busy} onSwitch={switchTo} onSignIn={signIn} />)}
        <div className="plan-foot">
          <button type="button" className="menu-item" onClick={() => go({ name: 'settings', page: 'account' })}>
            <span className="grow">Account and usage</span><Icon name="right" size={14} />
          </button>
        </div>
      </Popover>
    </div>
  )
}

function PlanProvider({ s, busy, onSwitch, onSignIn }: { s: PlanSection; busy: Busy | null; onSwitch: (provider: Provider, accountId: string) => void; onSignIn: (s: PlanSection) => void }) {
  const title = useId()
  const { account } = s
  return (
    <section className="plan-sec" aria-labelledby={title}>
      <h3 id={title} className="plan-prov">{s.name}</h3>
      {!account && (
        <div className="plan-out">
          <span className="grow">{s.name} isn’t signed in</span>
          <Button className="plan-signin" aria-label={`Sign in to ${s.name}`} busy={busy === `signin:${s.provider}`} busyLabel="Signing in" disabled={busy !== null} onClick={() => onSignIn(s)}>Sign in</Button>
        </div>
      )}
      {account && (
        <>
          <div className="plan-acct">
            <span className="plan-line">
              <span className="plan-name ellipsis">{account.label}</span>
              {s.plan && <span className="plan-plan ellipsis">{s.plan}</span>}
            </span>
            {s.email && <span className="plan-email ellipsis">{s.email}</span>}
          </div>
          {s.billed
            ? <span className="plan-billed">Billed per token</span>
            : (
              <div className="plan-rows">
                {s.windows.map((w) => (
                  <div key={w.id} className="plan-row">
                    <span className="plan-title">{w.title}</span>
                    <Meter label={`${s.name} ${w.title}`} value={w.value} />
                    <span className="plan-note">{w.note}</span>
                  </div>
                ))}
              </div>
            )}
          {s.others.length > 0 && (
            <div className="plan-switch" role="group" aria-label={`Switch ${s.name} account`}>
              <span className="plan-switch-title" aria-hidden="true">Switch</span>
              {s.others.map((o) => {
                const switching = busy === `switch:${s.provider}:${o.id}`
                return (
                  <button key={o.id} type="button" className="menu-item plan-other" aria-label={`Switch ${s.name} to ${o.label}`} aria-busy={switching || undefined} disabled={busy !== null} onClick={() => onSwitch(s.provider, o.id)}>
                    <span className="plan-other-name">{o.label}</span>
                    <span className="plan-other-plan ellipsis">{o.plan}</span>
                    {switching ? <span className="plan-other-use"><span className="spin" aria-hidden="true" />Switching</span> : o.use && <span className="plan-other-use">{o.use}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </section>
  )
}
