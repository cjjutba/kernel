import { go } from '../../../store'
import { Icon } from '../../../ui'
import { PanelTools, RefreshButton } from '../PanelTools'
import { MergeButton, PrStatusTag } from './MergeButton'
import { prDisplayTitle } from './model'
import { useLeadPrs, type LeadPr } from './leadPrList'
import './pr.css'

/**
 * The Lead's PRs tab (LeadPrs.png, LeadPrsEmpty.png, KERNEL-354): every open PR in the room, so what can merge is in one place.
 * Ready ones come first with Merge, the rest follow muted with what they wait on, in the words every place uses (KERNEL-417). One
 * that only blockers hold back says Blockers found and offers Merge anyway, and never counts as ready (KERNEL-501).
 * Each row opens its workspace. The strip beside the tabs holds the tab's action (PanelToolbarPrs.png, KERNEL-515): Refresh, which reads
 * every listed PR again. Each PR merges from its own row (KERNEL-757).
 */
export function LeadPrs({ roomId }: { roomId: string }) {
  const rows = useLeadPrs(roomId)
  const ready = rows.filter((r) => r.ready)
  const rest = rows.filter((r) => !r.ready)
  return (
    <>
      <PanelTools>
        {rows.length > 0 && <RefreshButton ids={rows.map((r) => r.ws.id)} label="Refresh pull requests" failTitle="Could not refresh pull requests" />}
      </PanelTools>
      {!rows.length
        ? <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>Nothing to merge</span><span>PRs your agents open appear here.</span></div>
        : (
          <div className="panel-scroll" aria-label="Pull requests">
            {ready.length > 0 && <Section title="Ready to merge" rows={ready} />}
            {rest.length > 0 && <Section title="Still open" rows={rest} />}
          </div>
        )}
    </>
  )
}

function Section({ title, rows }: { title: string; rows: LeadPr[] }) {
  return (
    <section>
      <div className="lp-sec"><h3>{title}</h3><span className="mono">{rows.length}</span></div>
      <ul className="lp-list">{rows.map((r) => <Row key={r.ws.id} row={r} />)}</ul>
    </section>
  )
}

function Row({ row }: { row: LeadPr }) {
  const { ws, state } = row
  const stat = ws.stat
  return (
    <li className="lp-row" data-ready={row.ready || undefined}>
      <div className="lp-l1">
        <span className="lp-name">{row.name}</span>
        {row.key && <span className="lp-key">{row.key}</span>}
        <span className="lp-key">#{ws.prNumber}</span>
        <span className="lp-act">
          {row.ready
            ? <MergeButton ws={ws} short />
            : (
              <>
                {state && <PrStatusTag status={state} why={state.why} />}
                {row.blockers && <MergeButton ws={ws} short />}
              </>
            )}
          <button type="button" className="lp-open" aria-label={`Open ${row.name}'s workspace${row.key ? ` for ${row.key}` : ''}`} onClick={() => go({ name: 'workspace', workspaceId: ws.id })}>
            Open<Icon name="ext" size={12} />
          </button>
        </span>
      </div>
      <div className="lp-title ellipsis">{prDisplayTitle(ws)}</div>
      <div className="lp-l3">
        <span className="lp-review" data-tone={row.review.tone}>{row.review.text}</span>
        {stat && <span className="mono lp-stat"><span className="add">+{stat.added}</span> <span className="del">-{stat.removed}</span></span>}
      </div>
    </li>
  )
}
