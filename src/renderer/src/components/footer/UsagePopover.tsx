import { useId, type RefObject } from 'react'
import type { Provider } from '@shared/types'
import { actions, go, useStore } from '../../store'
import { Button, Icon, Meter, Popover, ProviderMark, SegmentedControl } from '../../ui'
import { pctLabel as pct } from '@shared/usage'
import { useFreshUsage } from '../../accountRows'
import { chatsLabel, chatsPerAccount } from '../../accountChats'
import { planSections, type PlanSection } from './planModel'
import { tightestWindow, tone } from './usageModel'
import type { UsageBusy } from './useUsageActions'

/** A row says "Fable 5.1" where Settings, Account and usage says "Weekly, Fable 5.1". */
const windowTitle = (title: string) => title.replace(/^Weekly, (.+)$/, '$1')
/** A key's plan is already its name, so "API Key · API key" would say it twice. */
const accountLine = (s: PlanSection, compact: boolean) => {
  const label = s.account!.label
  return !compact && s.plan && s.plan.toLowerCase() !== label.toLowerCase() ? `${label} · ${s.plan}` : label
}

/**
 * The Usage popover (UsagePopover.png, KERNEL-619, KERNEL-674). It opens upward from the footer's bottom left with a row for Claude Code and one for Codex.
 * Detailed shows each provider's two windows even folded, and Compact shows one number. A row expands in place to its account, every window and the
 * provider's other signed-in accounts with their numbers. It only reports: switching is in the account menu and Settings, Accounts (KERNEL-949). A key in use says it is billed per token, and a provider that isn't signed in is one line with Sign in.
 * The numbers follow `usage` and `accounts` pushes, so they change while it is open.
 */
export function UsagePopover({ open, onClose, anchorRef, busy, onSignIn }: {
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement | null>
  busy: UsageBusy | null
  onSignIn: (provider: Provider, cli: boolean) => void
}) {
  const accounts = useStore((s) => s.accounts)
  const usage = useStore((s) => s.usage)
  const view = useStore((s) => s.ui.usageView)
  const expanded = useStore((s) => s.ui.usageOpen)
  const chats = useStore((s) => s.chats)
  // A running session answers with fresh numbers. Without one, main returns the last ones it saw.
  useFreshUsage(open)
  const sections = open ? planSections(accounts, usage, Date.now()) : []
  return (
    <Popover open={open} onClose={onClose} label="Usage" side="top" className="usage-pop" anchorRef={anchorRef}>
      <div className="pm-top">
        <span className="pm-title">Usage</span>
        <SegmentedControl label="Usage view" value={view} onChange={(v) => actions.ui.setUsageView(v as typeof view)} options={[{ value: 'detailed', label: 'Detailed' }, { value: 'compact', label: 'Compact' }]} />
      </div>
      {sections.map((s) => <Row key={s.provider} s={s} compact={view === 'compact'} open={expanded.includes(s.provider)} counts={chatsPerAccount(chats, s.provider)} busy={busy} onSignIn={onSignIn} />)}
      <div className="plan-foot">
        <button type="button" className="menu-item" onClick={() => go({ name: 'settings', page: 'accounts' })}>
          <span className="grow">Account and usage</span><Icon name="right" size={14} />
        </button>
      </div>
    </Popover>
  )
}

function Row({ s, compact, open, counts, busy, onSignIn }: { s: PlanSection; compact: boolean; open: boolean; counts: Record<string, number>; busy: UsageBusy | null; onSignIn: (provider: Provider, cli: boolean) => void }) {
  const body = useId()
  const { account } = s
  if (!account) {
    return (
      <section className="pm-sec" aria-label={s.name}>
        <div className="pm-head">
          <span className="pm-mark"><ProviderMark provider={s.provider} size={14} /></span>
          <span className="pm-who"><span className="pm-line"><span className="pm-name">{s.name}</span><span className="pm-acct">Not signed in</span></span></span>
          <Button size="xs" aria-label={`Sign in to ${s.name}`} busy={busy === `signin:${s.provider}`} busyPattern="ripple" busyLabel="Signing in" disabled={busy !== null} onClick={() => onSignIn(s.provider, !s.signedOut || s.signedOut.cli)}>Sign in</Button>
        </div>
      </section>
    )
  }
  const top = s.billed ? undefined : tightestWindow(s.windows)
  const minis = s.windows.filter((w) => (w.id === 'five_hour' || w.id === 'seven_day') && w.reported)
  return (
    <section className="pm-sec" aria-label={s.name}>
      <button type="button" className="pm-head" aria-expanded={open} aria-controls={body} aria-label={`${s.name}, ${account.label}${top ? `, ${top.title.toLowerCase()} ${pct(top.value)}` : s.billed ? ', billed per token' : ''}`} onClick={() => actions.ui.toggleUsageProvider(s.provider)}>
        <span className="pm-mark"><ProviderMark provider={s.provider} size={14} /></span>
        <span className="pm-who"><span className="pm-line"><span className="pm-name">{s.name}</span><span className="pm-acct">{accountLine(s, compact)}</span></span></span>
        {compact && top && <span className="pm-cw"><span className="pm-cl">{top.title}</span><span className="pm-mp" data-tone={tone(top.value)}>{pct(top.value)}</span></span>}
        <span className="pm-chev" data-open={open || undefined} aria-hidden="true"><Icon name="chevron" size={12} /></span>
      </button>
      {!compact && !open && (
        <div className="pm-minis">
          {s.billed && <span className="pm-mini"><span className="pm-ml">Billed per token</span></span>}
          {minis.map((w) => (
            <span key={w.id} className="pm-mini">
              <span className="pm-ml" aria-hidden="true">{w.id === 'five_hour' ? '5h' : 'wk'}</span>
              <Meter label={`${s.name} ${w.title}`} value={w.value} />
              <span className="pm-mp" data-tone={tone(w.value)}>{pct(w.value)}</span>
            </span>
          ))}
        </div>
      )}
      {open && (
        <div id={body} className="pm-body">
          {(s.email || counts[account.id]) && <span className="plan-email">{[s.email, chatsLabel(counts[account.id])].filter(Boolean).join(' · ')}</span>}
          {s.billed
            ? <span className="plan-billed">Billed per token</span>
            : (
              <div className="plan-rows">
                {s.windows.map((w) => (
                  <div key={w.id} className="plan-win">
                    <span className="plan-wl">{windowTitle(w.title)}</span>
                    <Meter label={`${s.name} ${w.title}`} value={w.value} />
                    {w.reported ? <span className="pm-mp" data-tone={tone(w.value)}>{pct(w.value)}</span> : <span className="plan-wr">Not reported</span>}
                    {w.reset && <span className="plan-wr ellipsis">{w.reset}</span>}
                  </div>
                ))}
              </div>
            )}
          {s.others.length > 0 && (
            <ul className="plan-switch" aria-label={`Other ${s.name} accounts`}>
              <li className="plan-switch-title" aria-hidden="true">Other accounts</li>
              {s.others.map((o) => (
                <li key={o.id} className="plan-other">
                  <span className="plan-other-name">{o.label}</span>
                  <span className="plan-other-plan ellipsis">{[o.plan, chatsLabel(counts[o.id])].filter(Boolean).join(' · ')}</span>
                  {!compact && o.nums.length > 0
                    ? <span className="plan-other-use">{o.nums.map((n, i) => <span key={n.short} className="plan-num">{i > 0 && <span className="plan-sep" aria-hidden="true">·</span>}{n.short} <span className="pm-mp" data-tone={tone(n.value)}>{pct(n.value)}</span></span>)}</span>
                    : o.use && <span className="plan-other-use">{o.use}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
