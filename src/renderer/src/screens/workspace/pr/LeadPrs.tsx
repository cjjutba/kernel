import type { FocusEvent, PointerEvent } from 'react'
import { go, useStore } from '../../../store'
import { Icon, Spinner } from '../../../ui'
import { PanelTools, RefreshButton } from '../PanelTools'
import { MergeButton } from './MergeButton'
import { prDisplayTitle } from './model'
import { rowGlyph, rowState, useLeadPrs, type LeadPr, type PrGroup } from './leadPrList'
import './pr.css'

/** The tab's lists, in the order they show (KERNEL-757). An empty one is left out. */
const SECTIONS: { group: PrGroup; title: string }[] = [
  { group: 'ready', title: 'Ready to merge' },
  { group: 'attention', title: 'Needs attention' },
  { group: 'progress', title: 'In progress' }
]

/**
 * The Lead's PRs tab (LeadPrs.png, LeadPrsEmpty.png, KERNEL-354): every open PR in the project, so what can merge is in one place.
 * Its rows sit in three lists, Ready to merge, Needs attention and In progress, each title first with one line under it, in the
 * words every place uses (KERNEL-417, KERNEL-757). One that only blockers hold back offers Merge anyway, and never counts as
 * ready (KERNEL-501). Each PR merges from its own row. The strip beside the tabs holds the tab's action (PanelToolbarPrs.png,
 * KERNEL-515): Refresh, which reads every listed PR again.
 */
export function LeadPrs({ projectId }: { projectId: string }) {
  const rows = useLeadPrs(projectId)
  const sections = SECTIONS.map((s) => ({ ...s, rows: rows.filter((r) => r.group === s.group) })).filter((s) => s.rows.length)
  return (
    <>
      <PanelTools>
        {rows.length > 0 && <RefreshButton ids={rows.map((r) => r.ws.id)} label="Refresh pull requests" failTitle="Could not refresh pull requests" />}
      </PanelTools>
      {!rows.length
        ? <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>Nothing to merge</span><span>PRs your agents open appear here.</span></div>
        : (
          <div className="panel-scroll" aria-label="Pull requests">
            {sections.map((s) => <Section key={s.group} title={s.title} rows={s.rows} />)}
          </div>
        )}
    </>
  )
}

function Section({ title, rows }: { title: string; rows: LeadPr[] }) {
  return (
    <section aria-label={title}>
      <div className="lp-sec"><h3>{title}</h3><span className="mono">{rows.length}</span></div>
      <ul className="lp-list">{rows.map((r) => <Row key={r.ws.id} row={r} />)}</ul>
    </section>
  )
}

/** The full title as a tooltip, only when the row cuts it short. It is set before the app's tooltip reads it. */
const tipIfCut = (e: PointerEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>) => {
  const el = e.currentTarget
  el.dataset.tip = el.scrollWidth > el.clientWidth ? el.textContent ?? '' : ''
}

/**
 * One PR (KERNEL-757). Line one: the state icon the sidebar shows, the title, and Merge or Merge anyway on the right, or an arrow
 * on hover for a row with nothing to press. Line two: where it stands, the agent, the PR on GitHub and its size. The title's
 * button covers the row, so a click anywhere opens the workspace.
 */
function Row({ row }: { row: LeadPr }) {
  const { ws } = row
  const pending = useStore((s) => s.prPending[ws.id])
  const glyph = rowGlyph(row, pending)
  const state = rowState(row)
  const stat = ws.stat
  return (
    <li className="lp-row" data-group={row.group}>
      <span className="lp-glyph" data-tone={glyph.tone} role="img" aria-label={glyph.label}>
        {glyph.icon === 'spin' ? <Spinner label={null} pattern="checker" /> : <Icon name={glyph.icon} size={14} />}
      </span>
      <div className="lp-body">
        <div className="lp-l1">
          <button type="button" className="lp-open" onPointerOver={tipIfCut} onFocus={tipIfCut} onClick={() => go({ name: 'workspace', workspaceId: ws.id })}>
            {prDisplayTitle(ws)}
          </button>
          {row.ready || row.blockers
            ? <span className="lp-act"><MergeButton ws={ws} short icon={false} /></span>
            : <span className="lp-chev" aria-hidden="true"><Icon name="right" size={14} /></span>}
        </div>
        <div className="lp-l2">
          <span className="lp-state" data-tone={state.tone} data-tip={state.why}>{state.text}</span>
          <span className="lp-dot" aria-hidden="true">·</span>
          <span className="lp-name">{row.name}</span>
          {ws.prNumber
            ? (
              <>
                <span className="lp-dot" aria-hidden="true">·</span>
                {ws.prUrl
                  ? <a className="lp-num" href={ws.prUrl} target="_blank" rel="noreferrer" aria-label={`Open PR ${ws.prNumber} on GitHub`}>#{ws.prNumber}<Icon name="ext" size={12} /></a>
                  : <span className="lp-num">#{ws.prNumber}</span>}
              </>
            )
            : null}
          {stat && (stat.added || stat.removed) ? <span className="lp-stat"><span className="add">+{stat.added}</span> <span className="del">-{stat.removed}</span></span> : null}
        </div>
      </div>
    </li>
  )
}
