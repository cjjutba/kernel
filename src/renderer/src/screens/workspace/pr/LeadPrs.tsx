import type { MergeAllResult } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, Icon, useBusy } from '../../../ui'
import { PanelTools, RefreshButton } from '../PanelTools'
import { MergeButton, PrStatusTag } from './MergeButton'
import { failTitle, prDisplayTitle } from './model'
import { useLeadPrs, type LeadPr } from './leadPrList'
import './pr.css'

/**
 * The Lead's PRs tab (LeadPrs.png, LeadPrsEmpty.png, KERNEL-354): every open PR in the room, so what can merge is in one place.
 * Ready ones come first with Merge, the rest follow muted with what they wait on, in the words every place uses (KERNEL-417). One
 * that only blockers hold back says Blockers found and offers Merge anyway, and never counts as ready (KERNEL-501).
 * Each row opens its workspace. The strip beside the tabs holds the tab's actions (PanelToolbarPrs.png, KERNEL-515): Refresh, which reads
 * every listed PR again, and, with two or more ready PRs, Merge all, which merges them in order and stops at the first that
 * can't merge (KERNEL-411).
 */
export function LeadPrs({ roomId }: { roomId: string }) {
  const rows = useLeadPrs(roomId)
  const stop = useStore((s) => s.mergeStops[roomId])
  const stopped = stop ? stoppedText(stop) : null
  const ready = rows.filter((r) => r.ready)
  const rest = rows.filter((r) => !r.ready)
  return (
    <>
      <PanelTools>
        <MergeAll roomId={roomId} rows={ready} />
        {rows.length > 0 && <RefreshButton ids={rows.map((r) => r.ws.id)} label="Refresh pull requests" failTitle="Could not refresh pull requests" />}
      </PanelTools>
      {!rows.length && !stopped
        ? <div className="panel-empty"><span className="ink2" style={{ fontWeight: 500 }}>Nothing to merge</span><span>PRs your agents open appear here.</span></div>
        : (
          <div className="panel-scroll" aria-label="Pull requests">
            {stopped && <p className="lp-notice" role="status">{stopped}</p>}
            {ready.length > 0 && <Section title="Ready to merge" rows={ready} />}
            {rest.length > 0 && <Section title="Still open" rows={rest} />}
          </div>
        )}
    </>
  )
}

/**
 * Where a run stopped and why, for one that stopped: "Merged" with the PR numbers it merged, "Stopped at" the one it couldn't,
 * then the reason. Nothing for a run that merged everything. (PR numbers stay out of this comment: the theme test reads "#" and
 * three digits as a color.)
 */
export function stoppedText(r: MergeAllResult): string | null {
  if (!r.stopped) return null
  const merged = r.merged.length ? `Merged ${r.merged.map((n) => `#${n}`).join(', ')}. ` : ''
  const at = r.stopped.prNumber ? `#${r.stopped.prNumber}` : 'the next pull request'
  return `${merged}Stopped at ${at}. ${r.stopped.reason}`
}

/**
 * Merge all in the panel's strip, with two or more PRs that can merge. While it runs, the button says which PR of how
 * many is merging, from the run's `pr.queue` pushes. The row merging spins as every place showing it does (KERNEL-417), and the
 * rows still to come say Next. Where a run stopped comes back on the last push, so the tab shows it from the store. A PR with an
 * action pending, such as a Merge pressed in a Team update a moment ago, is left out of what it sends (KERNEL-520).
 */
function MergeAll({ roomId, rows }: { roomId: string; rows: LeadPr[] }) {
  const queue = useStore((s) => s.mergeQueues[roomId])
  const pending = useStore((s) => s.prPending)
  const [busy, run] = useBusy()
  const ids = rows.filter((r) => r.ws.prState !== 'merging' && !pending[r.ws.id]).map((r) => r.ws.id)
  if (!queue && !busy && ids.length < 2) return null
  const label = queue ? `Merging ${queue.ids.indexOf(queue.current ?? '') + 1} of ${queue.ids.length}` : 'Merging'
  const start = () => void run('all', async () => {
    try { await call('pr.mergeAll', { roomId, workspaceIds: ids }) } catch (e) { actions.ui.toast({ title: failTitle.merge, sub: cleanError(e) }) }
  })
  return (
    <span className="pr-tone lp-all" data-tone="ready">
      <Button className="pr-soft" aria-label={busy || queue ? undefined : 'Merge all ready pull requests'} busy={!!busy || !!queue} busyLabel={label} onClick={start}>Merge all</Button>
    </span>
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
