import { useEffect, useRef } from 'react'
import { actions, useStore } from '../../store'
import { Icon, ProviderMark, Spinner } from '../../ui'
import { pctLabel as pct } from '@shared/usage'
import { footerGroups, footerTone, groupLabel, tone, type FooterChip, type FooterGroup } from './usageModel'
import { UsagePopover } from './UsagePopover'
import { useUsageActions } from './useUsageActions'

/**
 * Usage for Claude Code and Codex, behind the chart icon in the sidebar footer (KERNEL-1101, Pen 14.1). The icon is muted, turns amber near a limit and red at one, and is a dot loader while an
 * account switches. Hovering it lists each provider's account numbers, and pressing it opens the Usage popover upward from the footer. It only reports: switching is in the account menu
 * and Settings, Accounts, so a stray click here never moves agents to another account (KERNEL-949).
 */
export function UsageButton() {
  const accounts = useStore((s) => s.accounts)
  const usage = useStore((s) => s.usage)
  const switching = useStore((s) => s.ui.switching ?? null)
  const open = useStore((s) => s.ui.menu === 'plan')
  const anchor = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const { busy, signIn } = useUsageActions()
  const groups = footerGroups(accounts, usage, Date.now(), switching)
  const level = footerTone(groups)
  const here = groups.some((g) => g.chip?.switching)

  // Escape closes the popover with focus inside it, which leaves focus on the page. It goes back to the button that opened it.
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open && (!document.activeElement || document.activeElement === document.body)) button.current?.focus()
    wasOpen.current = open
  }, [open])

  return (
    <div ref={anchor} className="sbf-usage">
      <button
        ref={button} type="button" className="icon-btn sbf-btn" data-tone={level} data-tip="" aria-haspopup="dialog" aria-expanded={open} aria-busy={here || undefined}
        aria-label={`Usage. ${groups.map(groupLabel).join('. ')}`} onClick={() => actions.ui.toggleMenu('plan')}
      >
        {here ? <Spinner label={null} pattern="ripple" /> : <Icon name="usage" />}
      </button>
      {groups.length > 0 && (
        <div className="sbf-tip" aria-hidden="true">
          {groups.map((g) => <TipRow key={g.provider} g={g} />)}
          <span className="sbf-tip-hint">Click for usage and accounts</span>
        </div>
      )}
      <div className="sbf-popwrap"><UsagePopover open={open} onClose={actions.ui.closeMenu} anchorRef={anchor} busy={busy} onSignIn={signIn} /></div>
    </div>
  )
}

/** One provider in the hover card: its mark and name, then the numbers of the account it runs on. */
function TipRow({ g }: { g: FooterGroup }) {
  const c = g.chip
  return (
    <div className="sbf-tip-row">
      <span className="sbf-tip-mark"><ProviderMark provider={g.provider} size={13} /></span>
      <span className="sbf-tip-name">{g.name}</span>
      <span className="sbf-tip-nums">
        {g.signedOut ? <span className="sbf-tip-l">Signed out</span>
          : c?.switching ? <span className="sbf-tip-l">Switching to {c.name}</span>
          : c?.billed ? <span className="sbf-tip-l">Billed per token</span>
          : <Nums c={c} />}
      </span>
    </div>
  )
}

function Nums({ c }: { c: FooterChip | undefined }) {
  return (
    <>
      <Num short="5h" value={c?.five} />
      <span className="sbf-tip-sep" aria-hidden="true">·</span>
      <Num short="wk" value={c?.week} />
    </>
  )
}

function Num({ short, value }: { short: string; value: number | undefined }) {
  return (
    <span className="sbf-tip-num">
      <span className="sbf-tip-l">{short}</span>
      {value !== undefined && <span className="sbf-tip-pc" data-tone={tone(value)}>{pct(value)}</span>}
    </span>
  )
}
