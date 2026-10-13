import { PROVIDERS, type Provider } from '@shared/types'
import { call, cleanError } from '../../../api'
import { useFreshUsage } from '../../../accountRows'
import { planAccounts, type PlanAccount } from '../../../components/sidebar/planModel'
import { actions, go, useStore } from '../../../store'
import { Button, Meter, Toggle, useBusy } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings, useSettings } from '../useSettings'

/** One account's card: its name with Active when agents are on it, then its own windows. A key has none, and says it is billed per token. */
function AccountCard({ provider, a }: { provider: string; a: PlanAccount }) {
  const who = [a.billed ? 'API key' : a.email, a.billed ? 'Billed per token' : a.plan].filter(Boolean).join(' · ')
  return (
    <div className="set-card" role="group" aria-label={`${provider} ${a.account.label}`}>
      <Row label={a.account.label} desc={who}>{a.account.active && <span className="set-tag">Active</span>}</Row>
      {a.windows.map((w) => (
        <Row key={w.id} className="set-acct-win" label={w.title} full={
          <div className="set-meter">
            <Meter label={`${provider} ${a.account.label} ${w.title}`} value={w.value} />
            <span className="set-meter-note">{w.note}</span>
          </div>
        } />
      ))}
    </div>
  )
}

/**
 * Settings > Account and usage (SettingsAccount.png, KERNEL-665): one section per provider, Claude Code then Codex like the Usage popover, each with every
 * signed-in account and its own windows. The numbers come from the same model as the popover and follow `usage` and `accounts` pushes.
 */
export function Account() {
  const accounts = useStore((s) => s.accounts)
  const usage = useStore((s) => s.usage)
  const s = useSettings()
  const [busy, run] = useBusy<'signOut' | 'usage' | `signin:${Provider}`>()
  useFreshUsage(true)
  const now = Date.now()
  const sections = PROVIDERS.filter((p) => accounts.some((a) => a.provider === p.id)).map((p) => ({ id: p.id, ...planAccounts(p.id, accounts, usage, now) }))
  // The CLI's own login signs in right here. An added account asks for a code and keeps its name, which its sheet in Settings, Providers does.
  const signIn = (provider: Provider, cli: boolean) => {
    if (!cli) return go({ name: 'settings', page: 'providers', tab: provider })
    return run(`signin:${provider}`, async () => {
      try {
        await call('providers.signIn', { provider })
        actions.accounts.set(await call('accounts.list', undefined))
        if (provider === 'claude') actions.account.set(await call('account.get', undefined))
      } catch (e) { actions.ui.toast({ title: 'Could not sign in', sub: cleanError(e) }) }
    })
  }
  const signOut = () => run('signOut', async () => {
    try {
      actions.account.set(await call('account.signOut', undefined))
      actions.system.setPreflight(await call('preflight.run', undefined))
      go({ name: 'onboarding', step: 'checks' })
    } catch (e) { actions.ui.toast({ title: 'Could not sign out', sub: cleanError(e) }) }
  })
  const openUsage = () => run('usage', async () => {
    try { await call('app.openTerminal', { cwd: (await call('app.info', undefined)).dataDir, command: 'claude /usage' }) } catch (e) { actions.ui.toast({ title: 'Could not open a terminal', sub: cleanError(e) }) }
  })
  return (
    <Page title="Account and usage">
      {sections.map((p) => (
        <section key={p.id} className="set-section">
          <h2>{p.name}</h2>
          <div className="set-cards">
            {p.accounts.map((a) => <AccountCard key={a.account.id} provider={p.name} a={a} />)}
            {p.signedOut && (
              <div className="set-card">
                <Row label={`${p.name} isn’t signed in`}>
                  <Button aria-label={`Sign in to ${p.name}`} busy={busy === `signin:${p.id}`} busyLabel="Signing in" disabled={busy !== null} onClick={() => void signIn(p.id, p.signedOut!.cli)}>Sign in</Button>
                </Row>
              </div>
            )}
          </div>
        </section>
      ))}
      <Section title="Claude settings">
        <Row label="Details" desc="The same numbers Claude Code shows"><Button busy={busy === 'usage'} busyLabel="Opening" disabled={busy !== null} onClick={() => void openUsage()}>Open /usage</Button></Row>
        {s && (
          <>
            <Row label="Warn me before the weekly limit"><Toggle label="Warn me before the weekly limit" checked={s.usage.warnBeforeWeekly} onChange={(v) => void patchSettings({ usage: { warnBeforeWeekly: v } })} /></Row>
            <Row label="Pause new work when close to the limit" desc="Running agents finish their turn, new work waits"><Toggle label="Pause new work when close to the limit" checked={s.usage.pauseNearLimit} onChange={(v) => void patchSettings({ usage: { pauseNearLimit: v } })} /></Row>
          </>
        )}
      </Section>
      <Section title="Session">
        <Row label="Sign out" desc="Agents stop until you sign in again"><Button busy={busy === 'signOut'} busyLabel="Signing out" disabled={busy !== null} onClick={() => void signOut()}>Sign out</Button></Row>
      </Section>
    </Page>
  )
}
