import type { AgentDef, Room, Workspace } from '@shared/types'
import { getState, go } from '../../store'
import { leadOf, openLead } from '../../lead'
import { roomInView } from '../../screens/search/model'

/** The ⌘1 to ⌘9 shortcuts reach this many rows. */
const MAX_SLOTS = 9

/** One numbered row: the room's Team, its Lead, or a live workspace. */
export type Slot = { kind: 'team' } | { kind: 'lead' } | { kind: 'workspace'; workspaceId: string }

/** The workspace rows under a room, in store order. The sidebar lists these and the shortcuts count them, so the two can't disagree. */
export const liveWorkspaces = (workspaces: Workspace[], roomId: string): Workspace[] =>
  workspaces.filter((w) => w.roomId === roomId && w.status !== 'archived' && w.name !== 'lead')

/** A stable key for a row, so the sidebar can look up its number without holding slot objects (a store selector needs shallow-equal results). */
export const slotKey = (slot: Slot): string => (slot.kind === 'workspace' ? `workspace:${slot.workspaceId}` : slot.kind)

/** The room's numbered rows, top to bottom: Team, the Lead when the room has one, then live workspaces. A room without a Lead shifts them up one. */
export function slotsFor(room: Room, agents: Record<string, AgentDef[]>, workspaces: Workspace[]): Slot[] {
  return [
    { kind: 'team' as const },
    ...(leadOf(agents, room.id) ? [{ kind: 'lead' as const }] : []),
    ...liveWorkspaces(workspaces, room.id).map((w) => ({ kind: 'workspace' as const, workspaceId: w.id })),
  ].slice(0, MAX_SLOTS)
}

/**
 * Opens the n-th row (1 to 9) of the room in view, which falls back to the first room on Home, Inbox and History.
 * A number past the last row does nothing.
 */
export function openSlot(n: number): void {
  const s = getState()
  const room = roomInView(s.ui.route, s.rooms, s.workspaces)
  const slot = room && slotsFor(room, s.agents, s.workspaces)[n - 1]
  if (!room || !slot) return
  if (slot.kind === 'team') go({ name: 'team', roomId: room.id })
  else if (slot.kind === 'lead') void openLead(room.id)
  else go({ name: 'workspace', workspaceId: slot.workspaceId })
}
