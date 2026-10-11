import { actions } from '../../../store'
import { Icon } from '../../../ui'
import { useLeadPrs } from './leadPrList'
import './pr.css'

/**
 * What the Lead's header says in place of the PR actions, which never apply on main: how many PRs can merge. Clicking opens the
 * PRs tab, and the panel with it when it is hidden (LeadPrs.png, KERNEL-354). `spread` is the right panel's band, in the ready tone
 * while something can merge; in the chat header it stays neutral, like `PrHeader`.
 */
export function LeadPrSummary({ roomId, spread }: { roomId: string; spread?: boolean }) {
  const ready = useLeadPrs(roomId).filter((r) => r.ready).length
  const text = ready ? `${ready} ready to merge` : 'No open PRs'
  const tone = spread && ready ? 'ready' : 'idle'
  const open = () => { actions.ui.setWorkspaceView({ leadRight: 'prs' }); actions.ui.setRightPanel(true) }
  const state = <span className="pr-state"><Icon name="pr" size={14} /><span className="pr-label">{text}</span></span>
  return (
    <span className="pr-tone" data-tone={tone}>
      <button type="button" className="lp-summary" data-spread={spread || undefined} aria-label={`${text}, open the PRs tab`} onClick={open}>
        {state}
        {ready > 0 && <span className="lp-go"><Icon name="right" size={12} /></span>}
      </button>
    </span>
  )
}
