import { useEffect, useState } from 'react'
import type { AppSettings, MergeQueue, PrInfo, PrState, Workspace } from '@shared/types'
import { mergeBlock, mergeNeedsPr, mergeableState } from '@shared/merge'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { workspaceGlyph } from '../../../components/sidebar/workspaceGlyph'
import { busyLabel, failTitle } from './model'
import { request } from './PrHeader'
import './pr.css'

type Rules = Pick<AppSettings['pr'], 'requireGreen' | 'requireReviewer'>

/**
 * What a PR's Merge button place shows (KERNEL-351, KERNEL-411): nothing, the button, why it can't, the merge running, the
 * merge done, its turn still to come in a Merge all run (`next`), or where an open PR that can't merge yet stands (`state`).
 */
export type MergeView = { kind: 'none' } | { kind: 'ready' } | { kind: 'blocked'; reason: string } | { kind: 'merging' } | { kind: 'merged' } | { kind: 'next' } | { kind: 'state'; label: string }

/** Open PRs that can't merge yet, whose state word stands in the button's place, as the PRs tab's Still open rows say it. */
const WAITING: PrState[] = ['creating', 'checks', 'cifail', 'changes', 'conflict', 'resolving', 'draft']

/**
 * Decides from the same rule as the header's Merge PR (`mergeBlock`, KERNEL-349). A PR a Merge all run will get to reads
 * Next until its turn (`queue`, KERNEL-411).
 */
export function mergeView(ws: Workspace, pr: PrInfo | null | undefined, rules: Rules, name?: (agentId: string) => string, queue?: MergeQueue): MergeView {
  if (ws.prState === 'merged') return { kind: 'merged' }
  if (ws.prState === 'merging') return { kind: 'merging' }
  if (queue && queue.current !== ws.id && queue.ids.indexOf(ws.id) > queue.ids.indexOf(queue.current ?? '')) return { kind: 'next' }
  if (WAITING.includes(ws.prState)) return ws.prNumber ? { kind: 'state', label: workspaceGlyph({ ...ws, status: 'ready' }, { waiting: [], running: false }).label } : { kind: 'none' }
  if (!mergeableState(ws.prState)) return { kind: 'none' }
  const reason = mergeBlock(ws, pr, rules, name)
  return reason ? { kind: 'blocked', reason } : { kind: 'ready' }
}

/** The reason's first sentence: the rest says where to change the rule, which the tooltip keeps. */
const firstSentence = (reason: string) => reason.split(/(?<=\.)\s/)[0]

const NO_RULES: Rules = { requireGreen: false, requireReviewer: false }

/**
 * Merge for one workspace's PR, wherever a PR is listed: the row of a Team update, the Lead's PRs tab. Give it the workspace
 * whose PR merges (a reviewer's row passes the reviewed one). `short` drops the number from the label, for a row that already shows it. It reads the rules, the PR and the reviewer's name itself, so a
 * caller knows nothing about when a PR may merge. Each button keeps its own busy state, so only the one pressed spins (KERNEL-411).
 */
export function MergeButton({ ws, short }: { ws: Workspace; short?: boolean }) {
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const pr = useStore((s) => s.prs[ws.id])
  const reviewer = useStore((s) => s.agents[ws.roomId])
  const queue = useStore((s) => s.mergeQueues[ws.roomId])
  const [busy, run] = useBusy()
  // The rule reads the PR's checks or head commit from GitHub. Until they arrive there is nothing true to say.
  const mergeable = mergeableState(ws.prState)
  const needsPr = mergeable && !pr && mergeNeedsPr(ws, rules)
  const [read, setRead] = useState(false)
  useEffect(() => {
    if (!needsPr) return
    let live = true
    call('pr.get', { workspaceId: ws.id }).then((info) => { if (live && info) actions.prs.set(info) }).catch(() => undefined).finally(() => { if (live) setRead(true) })
    return () => { live = false }
  }, [needsPr, ws.id])
  if (needsPr && !read) return null

  const view = mergeView(ws, pr, rules, (id) => reviewer?.find((a) => a.id === id)?.name ?? id, queue)
  return <MergeSlot ws={ws} view={view} busy={busy} short={short} onMerge={() => void run(busyLabel.merge, () => mergeAndToast(ws.id))} />
}

/** Merges and toasts "Could not merge" with the reason when it fails, so the caller's busy state ends either way. */
export async function mergeAndToast(workspaceId: string) {
  try { await request.merge(workspaceId) } catch (e) { actions.ui.toast({ title: failTitle.merge, sub: cleanError(e) }) }
}

/**
 * What `MergeButton` draws for a view. `busy` is the label while this button's own merge runs, such as "Merging". Only that
 * button spins: anywhere else the same PR shows, and for a merge Rowan or Merge all started, Merging is muted text (KERNEL-411).
 */
export function MergeSlot({ ws, view, busy, short, onMerge }: { ws: Workspace; view: MergeView; busy?: string | null; short?: boolean; onMerge: () => void }) {
  switch (view.kind) {
    case 'none': return null
    case 'merged': return <span className="tucard-merged">Merged</span>
    case 'blocked': return <span className="tucard-why" data-tip={view.reason}>{firstSentence(view.reason)}</span>
    case 'next': return <span className="tucard-why">Next</span>
    case 'state': return <span className="tucard-why">{view.label}</span>
    case 'merging': return busy
      ? <span className="pr-tone" data-tone="ready"><Button className="pr-soft tucard-merge" busy>{busy}</Button></span>
      : <span className="tucard-why">Merging</span>
    case 'ready': return (
      <span className="pr-tone" data-tone="ready">
        <Button className="pr-soft tucard-merge" busy={!!busy} busyLabel={busy ?? undefined} aria-label={ws.prNumber ? `Merge PR #${ws.prNumber}` : 'Merge PR'} onClick={onMerge}>{ws.prNumber && !short ? `Merge #${ws.prNumber}` : 'Merge'}</Button>
      </span>
    )
  }
}
