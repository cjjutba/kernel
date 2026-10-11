import { useEffect, useState } from 'react'
import type { AppSettings, PrInfo, Workspace } from '@shared/types'
import { mergeBlock, mergeNeedsPr, mergeableState } from '@shared/merge'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, useBusy } from '../../../ui'
import { busyLabel, failTitle } from './model'
import { request } from './PrHeader'
import './pr.css'

type Rules = Pick<AppSettings['pr'], 'requireGreen' | 'requireReviewer'>

/** What a PR's Merge button place shows: nothing, the button, why it can't, the merge running, or the merge done (KERNEL-351). */
export type MergeView = { kind: 'none' } | { kind: 'ready' } | { kind: 'blocked'; reason: string } | { kind: 'merging' } | { kind: 'merged' }

/**
 * Decides from the same rule as the header's Merge PR (`mergeBlock`, KERNEL-349). A PR in any other state than ready or open
 * has nothing to say here: the row's events already tell what it waits on.
 */
export function mergeView(ws: Workspace, pr: PrInfo | null | undefined, rules: Rules, name?: (agentId: string) => string): MergeView {
  if (ws.prState === 'merged') return { kind: 'merged' }
  if (ws.prState === 'merging') return { kind: 'merging' }
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
 * caller knows nothing about when a PR may merge.
 */
export function MergeButton({ ws, short }: { ws: Workspace; short?: boolean }) {
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const pr = useStore((s) => s.prs[ws.id])
  const reviewer = useStore((s) => s.agents[ws.roomId])
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

  const view = mergeView(ws, pr, rules, (id) => reviewer?.find((a) => a.id === id)?.name ?? id)
  return <MergeSlot ws={ws} view={view} busy={busy} short={short} onMerge={() => void run(busyLabel.merge, () => mergeAndToast(ws.id))} />
}

/** Merges and toasts "Could not merge" with the reason when it fails, so the caller's busy state ends either way. */
export async function mergeAndToast(workspaceId: string) {
  try { await request.merge(workspaceId) } catch (e) { actions.ui.toast({ title: failTitle.merge, sub: cleanError(e) }) }
}

/** What `MergeButton` draws for a view. `busy` is the label while the button's own merge runs, such as "Merging". */
export function MergeSlot({ ws, view, busy, short, onMerge }: { ws: Workspace; view: MergeView; busy?: string | null; short?: boolean; onMerge: () => void }) {
  switch (view.kind) {
    case 'none': return null
    case 'merged': return <span className="tucard-merged">Merged</span>
    case 'blocked': return <span className="tucard-why" data-tip={view.reason}>{firstSentence(view.reason)}</span>
    // Either this button started it or the engine did: the same dimmed, spinning label.
    case 'merging': return <span className="pr-tone" data-tone="ready"><Button className="pr-soft tucard-merge" busy>Merging</Button></span>
    case 'ready': return (
      <span className="pr-tone" data-tone="ready">
        <Button className="pr-soft tucard-merge" busy={!!busy} busyLabel={busy ?? undefined} aria-label={ws.prNumber ? `Merge PR #${ws.prNumber}` : 'Merge PR'} onClick={onMerge}>{ws.prNumber && !short ? `Merge #${ws.prNumber}` : 'Merge'}</Button>
      </span>
    )
  }
}
