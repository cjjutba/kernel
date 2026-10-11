import { actions } from '../../../store'
import { Icon } from '../../../ui'
import { useLeadPrs } from './leadPrList'
import './pr.css'

/** The band's words for `ready` PRs that can merge out of `open` (KERNEL-354, KERNEL-411). */
export function summaryText(ready: number, open: number): string {
  if (ready) return `${ready} ready to merge`
  return open ? `${open} open, none ready` : 'No open PRs'
}

/**
 * What the Lead's header says in place of the PR actions, which never apply on main: how many PRs can merge. Clicking opens the
 * PRs tab, and the panel with it when it is hidden (LeadPrs.png, KERNEL-354). `spread` is the right panel's band, in the ready tone
 * while something can merge; in the chat header (`capsule`) it sits in a capsule of the same tone, like `PrHeader`. Open PRs
 * that can't merge yet are counted as such, never as "No open PRs" (KERNEL-411).
 */
export function LeadPrSummary({ roomId, spread, capsule }: { roomId: string; spread?: boolean; capsule?: boolean }) {
  const rows = useLeadPrs(roomId)
  const ready = rows.filter((r) => r.ready).length
  const text = summaryText(ready, rows.length)
  const tone = ready ? 'ready' : 'idle'
  const open = () => { actions.ui.setWorkspaceView({ leadRight: 'prs' }); actions.ui.setRightPanel(true) }
  const state = <span className="pr-state"><Icon name="pr" size={14} /><span className="pr-label">{text}</span></span>
  return (
    <span className={capsule ? 'pr-tone pr-cap' : 'pr-tone'} data-tone={tone}>
      <button type="button" className="lp-summary" data-spread={spread || undefined} aria-label={`${text}, open the PRs tab`} onClick={open}>
        {state}
        {rows.length > 0 && <span className="lp-go"><Icon name="right" size={12} /></span>}
      </button>
    </span>
  )
}
