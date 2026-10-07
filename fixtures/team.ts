import type { AgentDef, Room, RoomSetupStep } from '@shared/types'
import type { Fixture } from './types'
import { ids, scene, team, withWorkspace } from './base'

// Team lane: Home and Inbox (KERNEL-17), rooms and the sidebar menus (KERNEL-20).

const empty = { rooms: [], agents: {}, status: {}, workspaces: [], chats: [], items: {}, approvals: [], activity: [], changes: {}, diffs: {}, push: [] }

const ago = (ms: number) => Date.now() - ms
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

/** Rooms.png: five rooms, one of each source, one archived. Times are relative so "2 min ago" always reads the same. */
const roomsScene = (f: Fixture): Partial<Fixture> => {
  const rooms: Room[] = [
    { ...f.rooms[0], desc: 'Invoicing SaaS · MVP Sprint', kind: 'repo', path: '/Users/cj/Projects/client-a', createdAt: ago(2 * MIN) },
    { ...f.rooms[1], desc: 'Discovery Sprint', kind: 'repo', createdAt: ago(14 * MIN) },
    { ...f.rooms[2], desc: 'Nights and weekends', kind: 'folder', repo: undefined, path: '/Users/cj/Projects/own-app', createdAt: ago(HOUR) },
    { ...f.rooms[3], desc: 'Personal site refresh', kind: 'repo', createdAt: ago(2 * DAY) },
    { id: 'room-sandbox', name: 'Sandbox', desc: 'Trying out new agent roles', kind: 'scratch', repo: 'cjjutba/starter-kit', path: '/Users/cj/Projects/sandbox', defaultBranch: 'main', paused: false, archived: true, createdAt: ago(21 * DAY) }
  ]
  const crew = (...names: string[]): AgentDef[] => names.map((n) => team.find((a) => a.id === n)!)
  return {
    rooms,
    activity: [],
    // Three things wait on Client A, the Inbox count in the sidebar.
    approvals: f.approvals.map((a) => ({ ...a, roomId: ids.roomA })),
    agents: { [ids.roomA]: team, [ids.roomB]: crew('rowan', 'kai'), [ids.roomOwn]: crew('rowan', 'kai', 'ivy'), [ids.roomPortfolio]: crew('rowan', 'kai'), 'room-sandbox': crew('rowan') },
    status: {
      [ids.roomA]: { rowan: 'idle', kai: 'idle', noor: 'idle', theo: 'idle', ivy: 'idle' },
      [ids.roomB]: { rowan: 'working', kai: 'idle' },
      [ids.roomOwn]: { rowan: 'idle', kai: 'working', ivy: 'idle' },
      [ids.roomPortfolio]: { rowan: 'idle', kai: 'idle' },
      'room-sandbox': { rowan: 'idle' }
    },
    // +412 -38 on invoice-table, as in the sidebar of Rooms.png.
    workspaces: withWorkspace(f, ids.table, { stat: { files: 4, added: 412, removed: 38 } })
  }
}

const withMenu = (menu: 'rooms' | `room:${string}`, route: Fixture['ui']['route']) => scene((f) => ({ ...roomsScene(f), ui: { route, menu } }))

const setupSteps: RoomSetupStep[] = [
  { id: 'clone', title: 'Clone cjjutba/client-c', detail: '~/Projects/client-c', state: 'ok', meta: '4s' },
  { id: 'worktrees', title: 'Create the worktree folder', detail: '~/kernel/worktrees/client-c', state: 'ok' },
  { id: 'install', title: 'Install dependencies', detail: 'pnpm install', state: 'run', meta: 'running' },
  { id: 'copy', title: 'Copy local files', detail: '.env.local, .env.test', state: 'wait' },
  { id: 'hooks', title: 'Install hooks', detail: '10 events to localhost:7420', state: 'wait' },
  { id: 'agents', title: 'Seat agents', detail: 'Rowan, Kai, Noor, Ivy, Theo from .claude/agents', state: 'wait' }
]

const clientC: Room = { id: 'room-client-c', name: 'Client C', desc: 'Booking dashboard for a dental clinic', kind: 'repo', repo: 'cjjutba/client-c', path: '/Users/cj/Projects/client-c', defaultBranch: 'main', paused: false, createdAt: ago(MIN) }
const repos = [
  ['client-c', true, 2 * HOUR], ['cjjutba.dev', false, DAY], ['upnext', true, 3 * DAY], ['kalinga', true, 7 * DAY], ['starter-kit', true, 14 * DAY], ['starter-kit-mobile', true, 21 * DAY]
].map(([name, priv, age]) => ({ fullName: `cjjutba/${name}`, name: name as string, private: priv as boolean, updatedAt: ago(age as number) }))

export const teamFixtures: Record<string, Fixture> = {
  Home: scene(() => ({ ui: { route: { name: 'home' } } })),
  HomeEmpty: scene(() => ({ ...empty, ui: { route: { name: 'home' } } })),
  Inbox: scene(() => ({ ui: { route: { name: 'inbox' } } })),
  InboxEmpty: scene(() => ({ approvals: [], ui: { route: { name: 'inbox' } } })),
  Rooms: scene((f) => ({ ...roomsScene(f), ui: { route: { name: 'rooms' } } })),
  NewRoom: scene((f) => ({
    ...roomsScene(f),
    ui: { route: { name: 'rooms' }, modal: { name: 'newRoom', prefill: { source: 'repo', name: 'Client C', desc: 'Booking dashboard for a dental clinic', from: 'cjjutba/client-c', baseBranch: 'main' } } }
  })),
  ConnectRepo: scene((f) => ({ ...roomsScene(f), repos, ui: { route: { name: 'home' }, modal: { name: 'connectRepo' } } })),
  OpenFolder: scene((f) => ({
    ...roomsScene(f),
    folders: [
      { path: '/Users/cj/Projects/upnext', git: true, branch: 'main', dirty: 0 },
      { path: '/Users/cj/Projects/kalinga', git: true, branch: 'dev', dirty: 3 },
      { path: '/Users/cj/Projects/cjjutba.dev', git: true, branch: 'main', dirty: 0 },
      { path: '/Users/cj/Desktop/sandbox', git: false }
    ],
    ui: { route: { name: 'home' }, modal: { name: 'openFolder' } }
  })),
  RoomSetup: scene((f) => ({
    ...roomsScene(f),
    rooms: [...f.rooms, clientC],
    push: [{ type: 'room.setup', roomId: clientC.id, steps: setupSteps }],
    ui: { route: { name: 'onboarding', step: 'room', roomId: clientC.id } }
  })),
  SidebarRoomsMenu: withMenu('rooms', { name: 'home' }),
  SidebarRoomMenu: withMenu(`room:${ids.roomA}`, { name: 'floor', roomId: ids.roomA }),
  ConfirmRemoveRoom: scene((f) => ({ ...roomsScene(f), ui: { route: { name: 'floor', roomId: ids.roomA }, modal: { name: 'confirm', kind: 'removeRoom', roomId: ids.roomA } } }))
}
