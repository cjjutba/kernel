import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MergeQueue, PrInfo, Workspace } from '@shared/types'
import { mergeBlock, mergeNeedsPr, mergeableState } from '@shared/merge'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { ConfirmMergeAnyway } from '../ConfirmMergeAnyway'
import { NO_RULES, PR_STATUS, blockersHold, busyLabel, failTitle, prStatus, type PrStatus, type Rules } from './model'
import { request } from './PrHeader'
import './pr.css'

/**
 * What a PR's Merge button place shows (KERNEL-351, KERNEL-411): nothing, the button, why it can't, the merge running, the
 * merge done, its turn still to come in a Merge all run (`next`), or where an open PR that can't merge yet stands (`state`),
 * in the words and tone every place uses (KERNEL-417). `override` is a PR that only blockers on its latest commit hold back:
 * a soft Merge anyway takes the Merge button's place (KERNEL-501).
 */
export type MergeView = { kind: 'none' } | { kind: 'ready' } | { kind: 'override'; reviewer: string; count: number } | { kind: 'blocked'; reason: string } | { kind: 'merging' } | { kind: 'merged' } | { kind: 'next' } | ({ kind: 'state' } & PrStatus)

/**
 * Decides from the same rule as the header's Merge PR (`mergeBlock`, KERNEL-349). A PR a Merge all run will get to reads
 * Next until its turn (`queue`, KERNEL-411).
 */
export function mergeView(ws: Workspace, pr: PrInfo | null | undefined, rules: Rules, name?: (agentId: string) => string, queue?: MergeQueue): MergeView {
  if (ws.prState === 'merged') return { kind: 'merged' }
  if (ws.prState === 'merging') return { kind: 'merging' }
  if (queue && queue.current !== ws.id && queue.ids.indexOf(ws.id) > queue.ids.indexOf(queue.current ?? '')) return { kind: 'next' }
  const status = prStatus(ws.prState)
  if (status) return ws.prNumber ? { kind: 'state', ...status } : { kind: 'none' }
  if (!mergeableState(ws.prState)) return { kind: 'none' }
  const reason = mergeBlock(ws, pr, rules, name)
  if (!reason) return { kind: 'ready' }
  const blockers = blockersHold(ws, pr, rules, name ?? ((id) => id))
  return blockers ? { kind: 'override', ...blockers } : { kind: 'blocked', reason }
}

/** The reason's first sentence: the rest says where to change the rule, which the tooltip keeps. */
const firstSentence = (reason: string) => reason.split(/(?<=\.)\s/)[0]

/**
 * Merge for one workspace's PR, wherever a PR is listed: the row of a Team update, the Lead's PRs tab. Give it the workspace
 * whose PR merges (a reviewer's row passes the reviewed one). `short` drops the number from the label, for a row that already shows it. It reads the rules, the PR and the reviewer's name itself, so a
 * caller knows nothing about when a PR may merge. The click spins the pressed button until the PR reads merging, and from then
 * on every place showing the PR spins (KERNEL-417). Merge anyway asks first, in a confirm of its own (KERNEL-501).
 */
export function MergeButton({ ws, short }: { ws: Workspace; short?: boolean }) {
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const pr = useStore((s) => s.prs[ws.id])
  const reviewer = useStore((s) => s.agents[ws.roomId])
  const queue = useStore((s) => s.mergeQueues[ws.roomId])
  const [busy, run] = useBusy()
  const [confirm, setConfirm] = useState<{ reviewer: string; count: number } | null>(null)
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
  const merge = () => (view.kind === 'override' ? setConfirm({ reviewer: view.reviewer, count: view.count }) : void run(busyLabel.merge, () => mergeAndToast(ws.id)))
  return (
    <>
      <MergeSlot ws={ws} view={view} busy={busy} short={short} onMerge={merge} />
      {confirm && createPortal(<ConfirmMergeAnyway ws={ws} {...confirm} onClose={() => setConfirm(null)} />, document.body)}
    </>
  )
}

/** Merges and toasts "Could not merge" with the reason when it fails, so the caller's busy state ends either way. */
export async function mergeAndToast(workspaceId: string) {
  try { await request.merge(workspaceId) } catch (e) { actions.ui.toast({ title: failTitle.merge, sub: cleanError(e) }) }
}

/**
 * What `MergeButton` draws for a view. `busy` is the label while this button's own merge call runs, such as "Merging". A PR
 * that reads merging spins in every place it shows, whoever started the merge: a button, Rowan or Merge all (KERNEL-417).
 */
export function MergeSlot({ ws, view, busy, short, onMerge }: { ws: Workspace; view: MergeView; busy?: string | null; short?: boolean; onMerge: () => void }) {
  switch (view.kind) {
    case 'none': return null
    case 'merged': return <span className="tucard-merged">Merged</span>
    case 'blocked': return <span className="tucard-why" data-tip={view.reason}>{firstSentence(view.reason)}</span>
    case 'next': return <span className="tucard-why">Next</span>
    case 'state': return <PrStatusTag status={view} />
    case 'merging': return <PrStatusTag status={PR_STATUS.merging} />
    case 'ready': return (
      <span className="pr-tone" data-tone="ready">
        <Button className="pr-soft tucard-merge" busy={!!busy} busyLabel={busy ?? undefined} aria-label={ws.prNumber ? `Merge PR #${ws.prNumber}` : 'Merge PR'} onClick={onMerge}>{ws.prNumber && !short ? `Merge #${ws.prNumber}` : 'Merge'}</Button>
      </span>
    )
    case 'override': return (
      <span className="pr-tone" data-tone="fail">
        <Button className="pr-soft tucard-merge" aria-label={ws.prNumber ? `Merge anyway, PR #${ws.prNumber}` : 'Merge anyway'} onClick={onMerge}>Merge anyway</Button>
      </span>
    )
  }
}

/**
 * An open PR's state in a PRs tab or Team update row, drawn as the PR band draws it (KERNEL-417): while something runs, a spinner
 * with the word in the band's tone, as the band's own busy button; otherwise the word, red for what needs fixing. `why` is its tooltip.
 */
export function PrStatusTag({ status, why }: { status: PrStatus; why?: string }) {
  if (status.spin) return <span className="pr-tone" data-tone={status.tone}><Button className="pr-soft tucard-merge" busy>{status.label}</Button></span>
  return <span className="pr-word" data-tone={status.tone} data-tip={why}>{status.label}</span>
}
