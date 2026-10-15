import type { AgentDef } from '@shared/types'
import { isPlanApproval, permissionTitle, planReadyLine } from '../../screens/workspace/cards/steps'
import type { Wait } from './chatWaits'

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** "Should we keep Google sign in?" reads as "whether to keep Google sign in". Any other question is lowercased as asked. */
function questionText(title: string): string {
  const q = title.trim().replace(/[?.]+$/, '')
  const asks = q.match(/^(?:should (?:we|i)|do you want to|would you like to) (.+)$/i)
  return asks ? `whether to ${asks[1]}` : lowerFirst(q)
}

/**
 * The line under the title for the wait that has gone longest. A question reads "{name} asks {what}". A plan or a permission uses the
 * line the app already shows for it (the Home list and the approval card), with the tab or workspace name in front, so no new copy.
 */
export function waitLine({ approval: a, name }: Wait, who: string): string {
  if (a.kind === 'question') return `${name} asks ${questionText(a.title)}.`
  if (isPlanApproval(a)) return `${name}: ${planReadyLine(a)}`
  return `${name}: ${permissionTitle(a, who)}`
}

/**
 * The card's line: the longest wait, naming the agent who asks (Noor in her workspace, the Lead in its own tabs), or that nothing waits.
 * `agents` are the project's, and an agent that isn't in them reads as the Lead.
 */
export function chatLine(waits: Wait[], agents: AgentDef[] | undefined): string {
  const lead = agents?.find((x) => x.lead)?.name ?? 'The Lead'
  const w = waits[0]
  if (!w) return 'Nothing is waiting on you.'
  return waitLine(w, (w.agentId && agents?.find((x) => x.id === w.agentId)?.name) || lead)
}

/** The time on the card's right: how long the longest wait has gone, else the last thing that happened in any tab, else when the chat started. */
export function chatSince(waits: Wait[], lastItem: number, started: number): number {
  return waits[0]?.approval.createdAt ?? (lastItem || started)
}
