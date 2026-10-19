import { Fragment, useEffect, useRef } from 'react'
import { actions, useStore } from '../../store'
import { IconButton, Meter, ProviderMark, Spinner, useBusy } from '../../ui'
import { call } from '../../api'
import { pctLabel as pct } from '@shared/usage'
import { chipLabel, footerGroups, tightest, tone, type FooterChip, type FooterGroup } from './usageModel'
import { UsagePopover } from './UsagePopover'
import { useUsageActions } from './useUsageActions'


/**
 * Usage for Claude Code and Codex, always in the footer's bottom left (UsageFooter.png, KERNEL-674). Each provider shows the account it runs on: its mark, a 5-hour
 * bar and its numbers inline (5h, wk, and Fable 5.1 when reported). Pressing it opens the Usage popover on its provider, which has every other account's numbers.
 * The row only reports: switching is in the account menu and Settings, Accounts, so a stray click here never moves agents to another account (KERNEL-949). The
 * refresh button follows the row. Claude Code, a hairline, then Codex. The popover's Detailed and Compact switch picks how much each chip says.
 */
export function UsageRow() {
  const accounts = useStore((s) => s.accounts)
  const usage = useStore((s) => s.usage)
  const view = useStore((s) => s.ui.usageView)
  const switching = useStore((s) => s.ui.switching ?? null)
  const open = useStore((s) => s.ui.menu === 'plan')
  const anchor = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const { busy, signIn } = useUsageActions()
  const compact = view === 'compact'
  const now = Date.now()
  const groups = footerGroups(accounts, usage, now, switching)

  // Escape closes the popover with focus inside it, which leaves focus on the page. It goes back to the chip that opened it.
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open && (!document.activeElement || document.activeElement === document.body)) opener.current?.focus()
    wasOpen.current = open
  }, [open])

  const expanded = useStore((s) => s.ui.usageOpen)
  // A second press on a chip whose provider is already expanded closes the popover. A press on another provider's chip expands that provider alone.
  const openUsage = (provider: FooterGroup['provider'], el: HTMLElement) => {
    opener.current = el
    if (open && expanded.includes(provider)) actions.ui.closeMenu()
    else actions.ui.openUsage(provider)
  }
  return (
    <div ref={anchor} className="ft-usage">
      {groups.map((g, i) => (
        <Fragment key={g.provider}>
          {i > 0 && <span className="ft-div" aria-hidden="true" />}
          {g.signedOut
            ? <button type="button" className="ft-chip" aria-label={`${g.name}, not signed in. Opens usage`} aria-haspopup="dialog" aria-expanded={open} onClick={(e) => openUsage(g.provider, e.currentTarget)}><span className="ft-mark"><ProviderMark provider={g.provider} size={13} /></span><span className="ft-out">Sign in</span></button>
            : g.chip && <Chip g={g} c={g.chip} compact={compact} open={open} onOpen={openUsage} />}
        </Fragment>
      ))}
      <RefreshButton />
      <UsagePopover open={open} onClose={actions.ui.closeMenu} anchorRef={anchor} busy={busy} onSignIn={signIn} />
    </div>
  )
}

function Chip({ g, c, compact, open, onOpen }: { g: FooterGroup; c: FooterChip; compact: boolean; open: boolean; onOpen: (provider: FooterGroup['provider'], el: HTMLElement) => void }) {
  const label = chipLabel(g, c, compact)
  const top = compact ? tightest(c) : undefined
  return (
    <button type="button" className="ft-chip" data-on="" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-busy={c.switching || undefined} onClick={(e) => onOpen(g.provider, e.currentTarget)}>
      <span className="ft-mark"><ProviderMark provider={g.provider} size={13} /></span>
      {(c.billed || c.switching || !compact) && <span className="ft-name">{c.name}</span>}
      {c.switching && <span className="ft-switching"><Spinner label={null} pattern="ripple" /><span>Switching</span></span>}
      {!c.switching && !c.billed && !compact && (
        <>
          <span aria-hidden="true" className="ft-bar"><Meter label={`${g.name} 5-hour`} value={c.five ?? 0} /></span>
          <span className="ft-nums">
            <Num short="5h" value={c.five} />
            <Num short="wk" value={c.week} />
            {c.fable !== undefined && <Num short="Fable 5.1" value={c.fable} fable />}
          </span>
        </>
      )}
      {!c.switching && !c.billed && compact && <Window label={`${g.name} ${top?.title ?? 'usage'}`} value={top?.value} />}
    </button>
  )
}

/** One labelled number, "wk 100%". Fable's drops out first when the window is narrow. */
function Num({ short, value, fable }: { short: string; value: number | undefined; fable?: boolean }) {
  return (
    <span className="ft-num" data-fable={fable || undefined}>
      <span className="ft-sep" aria-hidden="true">·</span>
      <span className="ft-wl">{short}</span>
      {value !== undefined && <span className="ft-pc" data-tone={tone(value)}>{pct(value)}</span>}
    </span>
  )
}

/** A bar and its number, for Compact. The chip's label already says both, so the bar is hidden from a screen reader. */
function Window({ label, value }: { label: string; value: number | undefined }) {
  return (
    <span className="ft-win">
      <span aria-hidden="true" className="ft-bar"><Meter label={label} value={value ?? 0} /></span>
      {value !== undefined && <span className="ft-pc" data-tone={tone(value)}>{pct(value)}</span>}
    </span>
  )
}

/** Reads every signed-in account again, whatever it read in the last minute. Their numbers arrive as `usage` pushes, and a failed read leaves the last ones. */
function RefreshButton() {
  const [busy, run] = useBusy<'refresh'>()
  const refresh = () => run('refresh', async () => {
    try { actions.usage.set(await call('usage.get', { force: true })) } catch { /* a failed read keeps the last numbers */ }
  })
  return <IconButton className="ft-refresh" icon="refresh" size={14} label="Refresh usage" busy={busy !== null} busyPattern="ripple" busyLabel="Refreshing usage" onClick={refresh} />
}
