import { useEffect, useRef } from 'react'
import type { PrInfo, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, Icon } from '../../ui'
import { MergeButton, mergeView } from '../workspace/pr/MergeButton'
import { NO_RULES } from '../workspace/pr/model'
import { checksCell } from '../prs/model'
import { workState, type WorkState } from './model'

/**
 * Reads GitHub's view of each of these workspaces' open PRs once, when the store has none, so a row can say how many checks fail and the
 * card can show checks and review. Main pushes the changes after that.
 */
export function useReadPrs(list: Workspace[]) {
  const prs = useStore((s) => s.prs)
  const asked = useRef(new Set<string>())
  useEffect(() => {
    for (const w of list) {
      if (!w.prNumber || ['none', 'merged', 'closed'].includes(w.prState) || prs[w.id] || asked.current.has(w.id)) continue
      asked.current.add(w.id)
      call('pr.get', { workspaceId: w.id }).then((info) => { if (info) actions.prs.set(info) }).catch(() => undefined)
    }
  }, [list, prs])
}

/** The agent and the words of a row's right end: "Kai · Ready to merge". Color is only on the words, red for what needs a person and green for what can merge. */
export function RowStatus({ who, state }: { who?: string; state: WorkState }) {
  return (
    <span className="is-status">
      {who && <><span>{who}</span><span aria-hidden="true">·</span></>}
      <span className="is-word" data-tone={state.tone}>{state.word}</span>
    </span>
  )
}

/** The PR's review in a few words, from what GitHub decided. */
export function reviewWords(pr: PrInfo | null | undefined, ws: Workspace): { text: string; tone: 'plain' | 'bad' } {
  if (ws.prState === 'changes' || pr?.reviewDecision === 'changes') return { text: 'Changes requested', tone: 'bad' }
  if (pr?.reviewDecision === 'approved') return { text: 'Review approved', tone: 'plain' }
  return { text: 'Review waiting', tone: 'plain' }
}

/** One workspace working on the issue: its agent, branch, state and the way in. */
function WorkspaceRow({ ws }: { ws: Workspace }) {
  const agent = useStore((s) => s.agents[ws.roomId]?.find((a) => a.id === ws.agentId))
  const running = useStore((s) => (s.chats[ws.id] ?? []).some((c) => s.running[c.id]))
  const pr = useStore((s) => s.prs[ws.id])
  const state = workState(ws, running, pr, true)
  return (
    <li className="is-wrow">
      <Icon name="branch" size={16} />
      <span className="col grow">
        <span className="is-wtitle ellipsis">{ws.title ?? ws.name}</span>
        <span className="is-wsub ellipsis">{agent && <span>{agent.name}</span>}<span className="mono ellipsis">{ws.branch}</span></span>
      </span>
      <span className="is-word" data-tone={state.tone}>{state.word}</span>
      <Button aria-label={`Open ${ws.name}`} onClick={() => go({ name: 'workspace', workspaceId: ws.id })}>Open</Button>
    </li>
  )
}

/** A workspace's PR: its checks and review, and Merge when it can merge, else View. */
function PrRow({ ws }: { ws: Workspace }) {
  const pr = useStore((s) => s.prs[ws.id])
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const agents = useStore((s) => s.agents[ws.roomId])
  const checks = checksCell(ws, pr)
  const review = reviewWords(pr, ws)
  const view = mergeView(ws, pr, rules, (id) => agents?.find((a) => a.id === id)?.name ?? id)
  // Without GitHub's read yet, a ready PR's Merge button reads it itself.
  const canMerge = view.kind === 'ready' || view.kind === 'merging' || (ws.prState === 'ready' && !pr)
  return (
    <li className="is-wrow">
      <Icon name={ws.prState === 'draft' ? 'prDraft' : 'pr'} size={16} />
      <span className="col grow">
        <span className="is-wtitle ellipsis">Pull request #{ws.prNumber}</span>
        <span className="is-wsub">
          <span className="is-word" data-tone={checks.tone === 'bad' ? 'bad' : 'plain'}>Checks {checks.text.toLowerCase()}</span>
          <span aria-hidden="true">·</span>
          <span className="is-word" data-tone={review.tone}>{review.text}</span>
        </span>
      </span>
      {canMerge
        ? <MergeButton ws={ws} short icon={false} />
        : ws.prUrl && <a className="btn" href={ws.prUrl} target="_blank" rel="noreferrer" aria-label={`View pull request #${ws.prNumber}`}>View<Icon name="ext" size={12} /></a>}
    </li>
  )
}

/**
 * "Work on this issue": every workspace started from the issue and the PR each opened, on the card surface. Left out when no work
 * is linked, so the issue reads as it did before.
 */
export function WorkCard({ linked }: { linked: Workspace[] }) {
  useReadPrs(linked)
  if (linked.length === 0) return null
  return (
    <section aria-label="Work on this issue" className="card is-work">
      <h3 className="is-work-head"><span>Work on this issue</span><span className="muted">{linked.length === 1 ? '1 workspace' : `${linked.length} workspaces`}</span></h3>
      <ul>
        {linked.flatMap((w) => [
          <WorkspaceRow key={w.id} ws={w} />,
          ...(w.prNumber && !['none', 'merged', 'closed'].includes(w.prState) ? [<PrRow key={`${w.id}-pr`} ws={w} />] : [])
        ])}
      </ul>
    </section>
  )
}
