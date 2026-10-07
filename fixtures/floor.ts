import type { Fixture } from './types'
import { agent, at, ids, scene, team } from './base'

// Floor lane: floor states that come from room, agent status and usage data (KERNEL-22).

const floor = { route: { name: 'floor', roomId: ids.roomA } } as const
const busy = { rowan: 'idle', kai: 'working', noor: 'working', theo: 'working', ivy: 'idle' } as const

export const floorFixtures: Record<string, Fixture> = {
  Main: scene(() => ({ ui: floor })),
  FloorEmpty: scene((f) => ({
    agents: { ...f.agents, [ids.roomA]: [] },
    status: {},
    workspaces: f.workspaces.filter((w) => w.roomId !== ids.roomA),
    chats: [], items: {}, changes: {}, diffs: {}, push: [],
    activity: [],
    ui: floor
  })),
  FloorPaused: scene((f) => ({
    rooms: f.rooms.map((r) => (r.id === ids.roomA ? { ...r, paused: true } : r)),
    status: { [ids.roomA]: Object.fromEntries(team.map((a) => [a.id, 'paused' as const])) },
    ui: floor
  })),
  FloorLimit: scene(() => ({
    status: { [ids.roomA]: Object.fromEntries(team.map((a) => [a.id, 'paused' as const])) },
    usage: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: at(13, 0) }],
    ui: floor
  })),
  FloorBlocked: scene(() => ({
    status: { [ids.roomA]: { ...busy, noor: 'blocked' } },
    push: [{ type: 'agent.status', roomId: ids.roomA, agentId: 'noor', status: 'blocked', activity: 'Blocked by a PreToolUse hook' }],
    ui: floor
  })),
  FloorOffline: scene(() => ({
    status: { [ids.roomA]: { ...busy, kai: 'offline' } },
    ui: floor
  })),
  FloorFull: scene((f) => {
    const crowd = [...team, agent('sol', 'Sol', 'Security', 'sonnet'), agent('pax', 'Pax', 'Docs', 'haiku')]
    return {
      agents: { ...f.agents, [ids.roomA]: crowd },
      status: { [ids.roomA]: { ...busy, sol: 'working', pax: 'idle' } },
      ui: floor
    }
  })
}
