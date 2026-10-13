import { Fragment, useEffect, useRef } from 'react'
import { actions, useStore } from '../../store'
import { Meter, ProviderMark } from '../../ui'
import { chipLabel, footerGroups, tightest, tone, type FooterChip, type FooterGroup } from './usageModel'
import { UsagePopover } from './UsagePopover'
import { useUsageActions } from './useUsageActions'

const pct = (v: number) => `${Math.round(v * 100)}%`

/**
 * Usage for Claude Code and Codex, always in the footer's bottom left (UsageFooter.png, KERNEL-674). Each provider lists its signed-in accounts: the one it runs on first
 * with its mark and windows, the others as a name and one number. The active chip opens the Usage popover. Another chip switches to that account, by the same rules as
 * the popover's Switch. Claude Code, a hairline, then Codex. The popover's Detailed and Compact switch picks how much each active chip says.
 */
export function UsageRow() {
  const accounts = useStore((s) => s.accounts)
  const usage = useStore((s) => s.usage)
  const view = useStore((s) => s.ui.usageView)
  const open = useStore((s) => s.ui.menu === 'plan')
  const anchor = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const { busy, switchTo, signIn } = useUsageActions()
  const compact = view === 'compact'
  const groups = footerGroups(accounts, usage, Date.now())

  // Escape closes the popover with focus inside it, which leaves focus on the page. It goes back to the chip that opened it.
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open && (!document.activeElement || document.activeElement === document.body)) opener.current?.focus()
    wasOpen.current = open
  }, [open])

  const toggle = (el: HTMLElement) => { opener.current = el; actions.ui.toggleMenu('plan') }
  return (
    <div ref={anchor} className="ft-usage">
      {groups.map((g, i) => (
        <Fragment key={g.provider}>
          {i > 0 && <span className="ft-div" aria-hidden="true" />}
          {g.signedOut
            ? <button type="button" className="ft-chip" aria-label={`${g.name}, not signed in. Opens usage`} aria-haspopup="dialog" aria-expanded={open} onClick={(e) => toggle(e.currentTarget)}><span className="ft-mark"><ProviderMark provider={g.provider} size={13} /></span><span className="ft-out">Sign in</span></button>
            : g.chips.map((c) => <Chip key={c.id} g={g} c={c} compact={compact} open={open} busy={busy} onOpen={toggle} onSwitch={switchTo} />)}
        </Fragment>
      ))}
      <UsagePopover open={open} onClose={actions.ui.closeMenu} anchorRef={anchor} busy={busy} onSwitch={switchTo} onSignIn={signIn} />
    </div>
  )
}

function Chip({ g, c, compact, open, busy, onOpen, onSwitch }: { g: FooterGroup; c: FooterChip; compact: boolean; open: boolean; busy: string | null; onOpen: (el: HTMLElement) => void; onSwitch: (provider: FooterGroup['provider'], accountId: string) => void }) {
  const label = chipLabel(g, c, compact)
  if (!c.active) {
    const switching = busy === `switch:${g.provider}:${c.id}`
    return (
      <button type="button" className="ft-chip" aria-label={label} aria-busy={switching || undefined} disabled={busy !== null} onClick={() => onSwitch(g.provider, c.id)}>
        <span className="ft-name" data-dim="">{c.name}</span>
        {switching ? <span className="spin" aria-hidden="true" /> : c.five !== undefined && <span className="ft-pc" data-tone={tone(c.five)}>{pct(c.five)}</span>}
      </button>
    )
  }
  const top = compact ? tightest(c) : undefined
  return (
    <button type="button" className="ft-chip" data-on="" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={(e) => onOpen(e.currentTarget)}>
      <span className="ft-mark"><ProviderMark provider={g.provider} size={13} /></span>
      {(c.billed || !compact) && <span className="ft-name">{c.name}</span>}
      {!c.billed && !compact && (
        <>
          <Window short="5h" label={`${g.name} 5-hour`} value={c.five} />
          <Window short="wk" label={`${g.name} weekly`} value={c.week} />
        </>
      )}
      {!c.billed && compact && <Window label={`${g.name} ${top?.title ?? 'usage'}`} value={top?.value} />}
    </button>
  )
}

/** A bar and its number. The chip's label already says both, so the bar is hidden from a screen reader. */
function Window({ short, label, value }: { short?: string; label: string; value: number | undefined }) {
  return (
    <span className="ft-win">
      {short && <span className="ft-wl">{short}</span>}
      <span aria-hidden="true" className="ft-bar"><Meter label={label} value={value ?? 0} /></span>
      {value !== undefined && <span className="ft-pc" data-tone={tone(value)}>{pct(value)}</span>}
    </span>
  )
}
