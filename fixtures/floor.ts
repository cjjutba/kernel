import type { ActivityEvent, AgentDef, AgentStatus, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { Fixture } from './types'
import { agent, at, ids, scene, team } from './base'

// Floor lane: the floor and its room states (KERNEL-22). Seating follows the canvas roster: Rowan, Kai, Noor, Ivy, Theo.

const floor = { route: { name: 'floor', roomId: ids.roomA } } as const
const A = ids.roomA
const seatTeam: AgentDef[] = ['rowan', 'kai', 'noor', 'ivy', 'theo'].map((id) => team.find((a) => a.id === id)!)

const calm: Record<string, AgentStatus> = { rowan: 'idle', kai: 'working', noor: 'working', ivy: 'idle', theo: 'working' }

/** Local time today, so the Logs heading reads "Today" whatever day the shots run. */
const clock = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() }
const retime = (e: ActivityEvent): ActivityEvent => { const d = new Date(e.ts); return { ...e, ts: clock(d.getHours(), d.getMinutes()) } }

/** The Monday after today at 9:00 AM, when the weekly limit resets on FloorLimit.png. */
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); return d.getTime() }

/** What each agent says they are doing, as the engine would push it with the status. */
const saying = (status: Record<string, AgentStatus>, says: Record<string, string>): PushEvent[] =>
  Object.entries(says).map(([agentId, activity]) => ({ type: 'agent.status', roomId: A, agentId, status: status[agentId] ?? 'idle', activity }))

const says = { rowan: 'Waiting for your next brief', kai: 'Building the invoice table', noor: 'Writing the invoice schema', ivy: 'Waiting for the next task', theo: 'Reviewing org invites' }

const floorScene = (f: Fixture, patch: Partial<Fixture> & { extra?: ActivityEvent[]; says?: Record<string, string> } = {}): Partial<Fixture> => {
  const { extra = [], says: sayMore = {}, ...rest } = patch
  const status = (rest.status?.[A] ?? calm) as Record<string, AgentStatus>
  return {
    agents: { ...f.agents, [A]: seatTeam },
    status: { [A]: status },
    activity: [...extra, ...f.activity].map(retime),
    push: saying(status, { ...says, ...sayMore }),
    ui: floor,
    ...rest
  }
}

const paused = Object.fromEntries(seatTeam.map((a) => [a.id, 'paused' as const]))
const roomWith = (f: Fixture, change: Partial<Fixture['rooms'][number]>) => f.rooms.map((r) => (r.id === A ? { ...r, ...change } : r))

export const floorFixtures: Record<string, Fixture> = {
  Main: scene((f) => floorScene(f)),
  FloorEmpty: scene((f) => ({
    agents: { ...f.agents, [A]: [] },
    status: {},
    workspaces: f.workspaces.filter((w) => w.roomId !== A),
    chats: [], items: {}, changes: {}, diffs: {}, push: [],
    activity: [],
    ui: floor
  })),
  FloorPaused: scene((f) => floorScene(f, {
    rooms: roomWith(f, { paused: true, pausedBy: 'you' }),
    status: { [A]: paused },
    extra: [{ id: 'ev5', ts: at(11, 2), roomId: A, actor: 'you', kind: 'room.paused', text: 'paused', object: 'Client A' }]
  })),
  FloorLimit: scene((f) => floorScene(f, {
    rooms: roomWith(f, { paused: true, pausedBy: 'limit' }),
    status: { [A]: paused },
    usage: [{ type: 'seven_day', status: 'rejected', utilization: 1, resetsAt: nextMonday() }],
    extra: [{ id: 'ev5', ts: at(11, 2), roomId: A, agentId: 'rowan', kind: 'limit', text: 'paused the room for', object: 'weekly limit' }]
  })),
  FloorBlocked: scene((f) => {
    const orgSettings: Workspace = { ...f.workspaces[1], id: 'ws-org-settings', name: 'org-settings', branch: 'feat/t-11-org-settings', agentId: 'ivy', port: 4315, path: '/Users/cj/kernel/worktrees/client-a/org-settings' }
    return floorScene(f, {
      status: { [A]: { ...calm, ivy: 'blocked' } },
      workspaces: [...f.workspaces, orgSettings],
      says: { ivy: 'Blocked by the TaskCompleted hook' },
      extra: [{
        id: 'ev5', ts: at(11, 2), roomId: A, workspaceId: orgSettings.id, agentId: 'ivy', kind: 'agent.status', text: 'was blocked on', object: 'T-11', warn: true,
        data: { detail: 'The TaskCompleted hook needs test output before the task can close.', output: 'exit 2: no test output attached to T-11' }
      }]
    })
  }),
  FloorOffline: scene((f) => floorScene(f, {
    status: { [A]: { ...calm, kai: 'offline' } },
    says: { kai: 'Session ended in invoice-table' },
    extra: [{
      id: 'ev5', ts: at(11, 2), roomId: A, workspaceId: ids.table, agentId: 'kai', kind: 'session.end', text: 'went offline in', object: 'invoice-table', warn: true,
      data: { detail: 'Claude Code exited in invoice-table (out of memory). The worktree and chat are saved.' }
    }]
  })),
  FloorFull: scene((f) => {
    const crowd = [...seatTeam, agent('sol', 'Sol', 'Security', 'sonnet'), agent('pax', 'Pax', 'Docs', 'haiku')]
    return floorScene(f, {
      agents: { ...f.agents, [A]: crowd },
      rooms: roomWith(f, { desks: seatTeam.map((a) => a.id) }),
      status: { [A]: { ...calm, sol: 'working', pax: 'idle' } }
    })
  })
}
