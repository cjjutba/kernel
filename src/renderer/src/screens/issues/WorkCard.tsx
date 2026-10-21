import { useEffect, useRef } from 'react'
import type { PrInfo, Workspace } from '@shared/types'
import { call } from '../../api'
import { actions, go, useStore } from '../../store'
import { AgentAvatar, Button, Icon, Spinner } from '../../ui'
import { MergeButton, mergeView } from '../workspace/pr/MergeButton'
import { NO_RULES } from '../workspace/pr/model'
import { checksCell } from '../prs/model'
import type { WorkState } from './model'

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

/**
 * The agent and the words of a row's right end: its avatar, its name and "Working", "Needs you" or "Checks failing". Color is only on the words: red for what needs a person,
 * amber for waiting on you, green for what can merge and purple for merged. A running chat shows the wave loader beside Working.
 */
export function RowStatus({ who, state }: { who?: string; state: WorkState }) {
  return (
    <span className="is-status">
      {who && <><AgentAvatar name={who} size={14} /><span className="is-who-name">{who}</span></>}
      {state.word === 'Working' && <Spinner label={null} pattern="wave" />}
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

/** One workspace working on the issue: its title, agent and branch, and the way in. */
function WorkspaceRow({ ws }: { ws: Workspace }) {
  const agent = useStore((s) => s.agents[ws.projectId]?.find((a) => a.id === ws.agentId))
  return (
    <li className="is-wrow">
      <Icon name="branch" size={14} />
      <span className="col grow">
        <span className="is-wtitle ellipsis">{ws.title ?? ws.name}</span>
        <span className="is-wsub ellipsis">{agent && <span>{agent.name}</span>}{agent && <span aria-hidden="true" className="is-dot">·</span>}<span className="mono ellipsis">{ws.branch}</span></span>
      </span>
      <Button size="sm" aria-label={`Open ${ws.name}`} onClick={() => go({ name: 'workspace', workspaceId: ws.id })}>Open</Button>
    </li>
  )
}

/** A workspace's PR: its checks and review, and Merge when it can merge, else View. */
function PrRow({ ws }: { ws: Workspace }) {
  const pr = useStore((s) => s.prs[ws.id])
  const rules = useStore((s) => s.settings?.pr) ?? NO_RULES
  const agents = useStore((s) => s.agents[ws.projectId])
  const checks = checksCell(ws, pr)
  const review = reviewWords(pr, ws)
  const view = mergeView(ws, pr, rules, (id) => agents?.find((a) => a.id === id)?.name ?? id)
  // Without GitHub's read yet, a ready PR's Merge button reads it itself.
  const canMerge = view.kind === 'ready' || view.kind === 'merging' || (ws.prState === 'ready' && !pr)
  return (
    <li className="is-wrow">
      <Icon name={ws.prState === 'draft' ? 'prDraft' : 'pr'} size={14} />
      <span className="col grow">
        <span className="is-wtitle ellipsis">Pull request #{ws.prNumber}</span>
        <span className="is-wsub">
          <span className="is-word" data-tone={checks.tone === 'bad' ? 'bad' : 'plain'}>Checks {checks.text.toLowerCase()}</span>
          <span aria-hidden="true" className="is-dot">·</span>
          <span className="is-word" data-tone={review.tone}>{review.text}</span>
        </span>
      </span>
      {canMerge
        ? <MergeButton ws={ws} short icon={false} />
        : ws.prUrl && <a className="btn sm" href={ws.prUrl} target="_blank" rel="noreferrer" aria-label={`View pull request #${ws.prNumber}`}><Icon name="ext" size={12} />View</a>}
    </li>
  )
}

/** What the card offers when nothing works on the issue: plan it with the Lead, or hand it to an agent. */
export interface HandOff { id: string; lead: string; disabled?: boolean; planBusy?: boolean; onPlan: () => void; onHand: () => void }

/**
 * "Work on this issue": every workspace started from the issue and the PR each opened, on the card surface. With none, the card says
 * so and offers the two ways to start (Pen 11.12, IssuesSelectedHidden).
 */
export function WorkCard({ linked, handOff }: { linked: Workspace[]; handOff?: HandOff }) {
  useReadPrs(linked)
  if (linked.length === 0) {
    return (
      <section aria-label="Work on this issue" className="is-work is-work-empty">
        <h3 className="is-work-head"><span>Work on this issue</span><span className="is-work-n">No one yet</span></h3>
        <div className="is-work-body">
          <p>{handOff ? `No agent is on ${handOff.id}. Hand it to ${handOff.lead} to plan, or straight to a teammate.` : 'No work in Kernel yet'}</p>
          {handOff && (
            <div className="is-actions">
              <Button variant="primary" busy={handOff.planBusy} busyPattern="ripple" busyLabel="Sending" disabled={handOff.disabled} onClick={handOff.onPlan}>Plan with {handOff.lead}</Button>
              <Button disabled={handOff.disabled} onClick={handOff.onHand}>Hand to an agent</Button>
            </div>
          )}
        </div>
      </section>
    )
  }
  return (
    <section aria-label="Work on this issue" className="is-work is-work-full">
      <h3 className="is-work-head"><span>Work on this issue</span><span className="is-work-n">{linked.length === 1 ? '1 workspace' : `${linked.length} workspaces`}</span></h3>
      <ul>
        {linked.flatMap((w) => [
          <WorkspaceRow key={w.id} ws={w} />,
          ...(w.prNumber && !['none', 'merged', 'closed'].includes(w.prState) ? [<PrRow key={`${w.id}-pr`} ws={w} />] : [])
        ])}
      </ul>
    </section>
  )
}
