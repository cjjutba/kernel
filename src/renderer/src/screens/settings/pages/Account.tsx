import { useMemo } from 'react'
import { MODELS, type AccountProfile, type RateLimit } from '@shared/types'
import { limitProvider } from '@shared/providers'
import { call, cleanError } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, Meter, Toggle, useBusy } from '../../../ui'
import { resetPhrase } from '../../workspace/banners/model'
import { Page, Row, Section } from '../kit'
import { patchSettings, useSettings } from '../useSettings'

const modelLabel = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id
const WINDOW_MODEL: Partial<Record<RateLimit['type'], string>> = { seven_day_opus: 'Opus 5.5', seven_day_sonnet: 'Sonnet 5.5' }

/** The three windows the page shows, from rate_limit_event data: the session, the week, and one per model that has its own weekly limit. */
export function usageRows(usage: RateLimit[]): { id: string; title: string; limit?: RateLimit }[] {
  const perModel = usage.filter((l) => l.type === 'seven_day_opus' || l.type === 'seven_day_sonnet' || (l.type !== 'five_hour' && l.type !== 'seven_day' && l.model))
  return [
    { id: 'session', title: 'Current session', limit: usage.find((l) => l.type === 'five_hour') },
    { id: 'week', title: 'This week, all models', limit: usage.find((l) => l.type === 'seven_day') },
    ...(perModel.length
      ? perModel.map((l) => ({ id: l.type, title: `This week, ${l.model ? modelLabel(l.model) : WINDOW_MODEL[l.type] ?? 'one model'}`, limit: l }))
      : [{ id: 'model', title: 'This week, per model' }])
  ]
}

/**
 * The Claude account whose meters the page shows: the one in use, or with a key in use, the subscription agents were last on.
 * A key has no windows, and nothing reads the subscription's while it is idle, so its numbers stand as they were last read (KERNEL-524).
 */
export function meterAccount(accounts: AccountProfile[], usage: RateLimit[]): AccountProfile | undefined {
  const claude = accounts.filter((a) => a.provider === 'claude')
  const active = claude.find((a) => a.active)
  if (active?.auth !== 'apiKey') return active
  const read = (a: AccountProfile) => Math.max(0, ...usage.filter((l) => limitProvider(l) === 'claude' && (l.accountId ?? 'cli') === a.id).map((l) => l.readAt ?? 0))
  return claude.filter((a) => a.auth !== 'apiKey').sort((a, b) => read(b) - read(a))[0]
}

/** "62% used · resets at 3:40 PM". */
export function usageNote(l: RateLimit | undefined, now: number): string {
  if (l?.utilization === undefined) return 'No usage reported yet'
  const used = `${Math.round(l.utilization * 100)}% used`
  return l.resetsAt ? `${used} · resets ${resetPhrase(l.resetsAt, now)}` : used
}

/** Settings > Account and usage (SettingsAccount.png). The meters are white from 85%. */
export function Account() {
  // Claude's windows on the account Claude runs on now, or the subscription behind a key in use. Codex's have their own line on Settings, Providers (KERNEL-406).
  const accounts = useStore((s) => s.accounts)
  const all = useStore((s) => s.usage)
  const account = useStore((s) => s.account)
  const keyInUse = accounts.find((a) => a.provider === 'claude' && a.active && a.auth === 'apiKey')
  const shown = useMemo(() => meterAccount(accounts, all), [accounts, all])
  const usage = useMemo(() => all.filter((l) => limitProvider(l) === 'claude' && (l.accountId ?? 'cli') === (shown?.id ?? 'cli')), [all, shown])
  const plan = keyInUse ? shown?.plan : account?.plan ?? (account?.signedIn ? 'Claude account' : 'Signed out')
  const s = useSettings()
  const [busy, run] = useBusy<'signOut' | 'usage'>()
  const now = Date.now()
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
      <Section title="Usage">
        {keyInUse && <Row label={`Agents are on ${keyInUse.label}, billed per token.`} />}
        {(!keyInUse || usage.length > 0) && usageRows(usage).map((r) => (
          <Row key={r.id} label={r.title} full={
            <div className="set-meter">
              <Meter label={r.title} value={r.limit?.utilization ?? 0} />
              <span className="set-meter-note">{usageNote(r.limit, now)}</span>
            </div>
          } />
        ))}
      </Section>
      <Section title="Claude">
        {plan && <Row label="Plan"><span className="set-value">{plan}</span></Row>}
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
