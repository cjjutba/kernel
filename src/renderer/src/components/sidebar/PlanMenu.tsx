import { useEffect, useRef } from 'react'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { Icon, Meter, Popover } from '../../ui'
import { usageNote, usageRows } from '../../screens/settings/pages/Account'

/**
 * The plan pill at the bottom of the sidebar. It opens a popover with the account and the same usage windows as Settings > Account:
 * the 5-hour session, the week, and each model with its own weekly limit (Fable, Opus, Sonnet).
 */
export function PlanButton({ plan }: { plan: string }) {
  const open = useStore((s) => s.ui.menu === 'plan')
  const account = useStore((s) => s.account)
  const usage = useStore((s) => s.usage)
  const anchor = useRef<HTMLDivElement>(null)
  // A running session answers with fresh numbers. Without one, main returns the last ones it saw.
  useEffect(() => {
    if (open) void call('usage.get', undefined).then(actions.usage.set).catch(() => undefined)
  }, [open])
  const who = [...new Set([account?.name, account?.email ?? account?.login].filter(Boolean))].join(' · ')
  const now = Date.now()
  return (
    <div ref={anchor} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" className="plan-pill" aria-haspopup="dialog" aria-expanded={open} onClick={() => actions.ui.toggleMenu('plan')}>{plan}</button>
      <Popover open={open} onClose={actions.ui.closeMenu} label={`${plan} usage`} side="top" className="plan-pop" anchorRef={anchor}>
        <div className="plan-head">
          <span className="plan-name">{plan}</span>
          {who && <span className="plan-who ellipsis">{who}</span>}
        </div>
        <div className="plan-rows">
          {usageRows(usage).map((r) => (
            <div key={r.id} className="plan-row">
              <span className="plan-title">{r.title}</span>
              <Meter label={r.title} value={r.limit?.utilization ?? 0} />
              <span className="plan-note">{usageNote(r.limit, now)}</span>
            </div>
          ))}
        </div>
        <div className="plan-foot">
          <button type="button" className="menu-item" onClick={() => go({ name: 'settings', page: 'account' })}>
            <span className="grow">Account and usage</span><Icon name="right" size={14} />
          </button>
        </div>
      </Popover>
    </div>
  )
}
