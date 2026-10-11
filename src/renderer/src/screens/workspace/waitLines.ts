import type { AgentDef, NoteRef, Workspace } from '@shared/types'
import { isMerged, joinLabels, waitersOf, waitingOn, waitLabel } from '@shared/waits'

/** A line that names workspaces, each opening its own. */
export interface WaitLine { text: string; refs: NoteRef[] }

const refOf = (w: Workspace, agents: AgentDef[]): NoteRef => ({ text: waitLabel(w, agents.find((a) => a.id === w.agentId)?.name ?? w.agentId), workspaceId: w.id })

const line = (refs: NoteRef[], one: string, many: string, wrap: (names: string, verb: string) => string): WaitLine | undefined =>
  refs.length ? { text: wrap(joinLabels(refs.map((r) => r.text)), refs.length > 1 ? many : one), refs } : undefined

/** "Queued. Sends when PR 164 by Noor merges.": what a held brief still waits for. Nothing once all of it merged. */
export function heldLine(ws: Workspace, workspaces: Workspace[], agents: AgentDef[]): WaitLine | undefined {
  return line(waitingOn(ws, workspaces).map((t) => refOf(t, agents)), 'merges', 'merge', (names, verb) => `Queued. Sends when ${names} ${verb}.`)
}

/** "KERNEL-12 by Kai waits for this to merge.", in the workspace others wait for, until it merges. */
export function waitersLine(ws: Workspace, workspaces: Workspace[], agents: AgentDef[]): WaitLine | undefined {
  if (isMerged(ws)) return undefined
  return line(waitersOf(ws.id, workspaces).map((w) => refOf(w, agents)), 'waits', 'wait', (names, verb) => `${names} ${verb} for this to merge.`)
}
