import { useMemo } from 'react'
import type { AgentDef, AgentStatus, Room } from '@shared/types'
import { useStore } from '../store'
import { seating, type Seating, type SeatingContext } from './layout'

const NO_AGENTS: AgentDef[] = []
const NO_STATUS: Record<string, AgentStatus> = {}
const NO_TIMES: Record<string, number> = {}

/** Who sits where for a room's agents. The floor and New agent both go through this, so a desk is the same on both. */
export function roomSeating(agents: AgentDef[], room: Pick<Room, 'desks'> | undefined, ctx: SeatingContext): Seating {
  return seating(agents.filter((a) => !a.retired), { desks: room?.desks }, ctx)
}

/**
 * The room's seating, read from the store: its desks, and the workspaces, status and last activity that order the rest.
 * Last activity comes from the whole log (`rooms.lastActivity`), so an agent doesn't lose its desk when its events
 * leave the store's event window. Desks follow the store's own status, not what the floor shows, so a walk doesn't move anyone's desk.
 */
export function useSeating(roomId: string): Seating {
  const desks = useStore((s) => s.rooms.find((r) => r.id === roomId)?.desks)
  const agents = useStore((s) => s.agents[roomId] ?? NO_AGENTS)
  const status = useStore((s) => s.status[roomId] ?? NO_STATUS)
  const lastActivity = useStore((s) => s.lastActivity[roomId] ?? NO_TIMES)
  // Select the store's own list and filter once per change to it, not on every store change.
  const allWorkspaces = useStore((s) => s.workspaces)
  const workspaces = useMemo(() => allWorkspaces.filter((w) => w.roomId === roomId), [allWorkspaces, roomId])
  return useMemo(() => roomSeating(agents, { desks }, { workspaces, status, lastActivity }), [agents, desks, workspaces, status, lastActivity])
}
