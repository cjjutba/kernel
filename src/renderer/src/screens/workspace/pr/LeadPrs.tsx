import { go } from '../../../store'
import { Icon } from '../../../ui'
import { MergeButton } from './MergeButton'
import { useLeadPrs, type LeadPr } from './leadPrList'
import './pr.css'

/**
 * The Lead's PRs tab (LeadPrs.png, LeadPrsEmpty.png, KERNEL-354): every open PR in the room, so what can merge is in one place.
 * Ready ones come first with Merge, the rest follow muted with what they wait on. Each row opens its workspace.
 */
export function LeadPrs({ roomId }: { roomId: string }) {
  const rows = useLeadPrs(roomId)
  if (!rows.length) return <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>Nothing to merge</span><span>PRs your agents open appear here.</span></div>
  const ready = rows.filter((r) => r.ready)
  const rest = rows.filter((r) => !r.ready)
  return (
    <div className="panel-scroll" aria-label="Pull requests">
      {ready.length > 0 && <Section title="Ready to merge" rows={ready} />}
      {rest.length > 0 && <Section title="Still open" rows={rest} />}
    </div>
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
            : state && <span className="lp-state" data-tone={state.tone} data-tip={state.why}>{state.label}</span>}
          <button type="button" className="lp-open" aria-label={`Open ${row.name}'s workspace${row.key ? ` for ${row.key}` : ''}`} onClick={() => go({ name: 'workspace', workspaceId: ws.id })}>
            Open<Icon name="ext" size={11} stroke={1.5} />
          </button>
        </span>
      </div>
      <div className="lp-title ellipsis">{ws.prTitle ?? ws.title ?? ws.name}</div>
      <div className="lp-l3">
        <span className="lp-review" data-tone={row.review.tone}>{row.review.text}</span>
        {stat && <span className="mono lp-stat"><span className="add">+{stat.added}</span> <span className="del">-{stat.removed}</span></span>}
      </div>
    </li>
  )
}
