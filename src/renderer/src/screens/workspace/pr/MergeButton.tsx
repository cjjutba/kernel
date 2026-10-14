import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PrInfo, Workspace } from '@shared/types'
import { mergeBlock, mergeNeedsPr, mergeableState } from '@shared/merge'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, Spinner, useBusy } from '../../../ui'
import { ConfirmMergeAnyway } from '../ConfirmMergeAnyway'
import { NO_RULES, PR_STATUS, blockersHold, busyLabel, failTitle, prStatus, type PrAction, type PrStatus, type Rules } from './model'
import { request } from './PrHeader'
import './pr.css'

/**
 * What a PR's Merge button place shows (KERNEL-351, KERNEL-411): nothing, the button, why it can't, the merge running, the
 * merge done, or where an open PR that can't merge yet stands (`state`), in the words and tone every place uses (KERNEL-417).
 * `override` is a PR that only blockers on its latest commit hold back: a quiet outline Merge anyway takes the Merge button's
 * place (KERNEL-501, KERNEL-757).
 */
export type MergeView = { kind: 'none' } | { kind: 'ready' } | { kind: 'override'; reviewer: string; count: number } | { kind: 'blocked'; reason: string } | { kind: 'merging' } | { kind: 'merged' } | ({ kind: 'state' } & PrStatus)

/**
 * Decides from the same rule as the header's Merge PR (`mergeBlock`, KERNEL-349). A merge pending on the PR reads merging
 * before GitHub's state moves, whoever pressed it, so a row never offers Merge while one runs (`pending`, KERNEL-520).
 */
export function mergeView(ws: Workspace, pr: PrInfo | null | undefined, rules: Rules, name?: (agentId: string) => string, pending?: PrAction): MergeView {
  if (ws.prState === 'merged') return { kind: 'merged' }
  if (ws.prState === 'merging' || pending === 'merge') return { kind: 'merging' }
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
 * caller knows nothing about when a PR may merge. The click spins the pressed button at once. Main then announces the merge
 * (`prPending`), which spins every place showing the PR in the same frame, and the PR reading merging keeps them spinning
 * (KERNEL-417, KERNEL-520). Merge anyway asks first, in a confirm of its own (KERNEL-501).
 */
export function MergeButton({ ws, short }: { ws: Workspace; short?: boolean }) {
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const pr = useStore((s) => s.prs[ws.id])
  const reviewer = useStore((s) => s.agents[ws.roomId])
  const pending = useStore((s) => s.prPending[ws.id])
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

  const view = mergeView(ws, pr, rules, (id) => reviewer?.find((a) => a.id === id)?.name ?? id, pending)
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
 * that reads merging, or has a merge pending, spins in every place it shows, whoever started the merge: a button or the Lead
 * (KERNEL-417, KERNEL-520).
 */
export function MergeSlot({ ws, view, busy, short, onMerge }: { ws: Workspace; view: MergeView; busy?: string | null; short?: boolean; onMerge: () => void }) {
  switch (view.kind) {
    case 'none': return null
    case 'merged': return <span className="tucard-merged">Merged</span>
    case 'blocked': return <span className="tucard-why" data-tip={view.reason}>{firstSentence(view.reason)}</span>
    case 'state': return <PrStatusTag status={view} />
    case 'merging': return <PrStatusTag status={PR_STATUS.merging} />
    case 'ready': return (
      <span className="pr-tone" data-tone="ready">
        <Button className="pr-soft tucard-merge" busy={!!busy} busyPattern="ripple-in" busyLabel={busy ?? undefined} aria-label={ws.prNumber ? `Merge PR #${ws.prNumber}` : 'Merge PR'} onClick={onMerge}>{ws.prNumber && !short ? `Merge #${ws.prNumber}` : 'Merge'}</Button>
      </span>
    )
    case 'override': return (
      <span className="pr-tone" data-tone="idle">
        <Button className="pr-outline tucard-merge" aria-label={ws.prNumber ? `Merge anyway, PR #${ws.prNumber}` : 'Merge anyway'} onClick={onMerge}>Merge anyway</Button>
      </span>
    )
  }
}

/**
 * An open PR's state in a PRs tab or Team update row, in the words and tone the PR band uses (KERNEL-417): the word, red for what
 * needs fixing, and while something runs the spinner before it. It is never a button, so nothing looks pressable but the one
 * button a person pressed (KERNEL-757). `why` is its tooltip.
 */
export function PrStatusTag({ status, why }: { status: PrStatus; why?: string }) {
  if (status.spin) return <span className="pr-word pr-run" data-tone={status.tone} aria-busy="true" data-tip={why}><Spinner label={null} pattern="checker" />{status.label}</span>
  return <span className="pr-word" data-tone={status.tone} data-tip={why}>{status.label}</span>
}
