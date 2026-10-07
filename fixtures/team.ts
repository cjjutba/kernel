import type { AgentDef, Approval, Notification, Room, RoomSetupStep, Workspace } from '@shared/types'
import type { Fixture } from './types'
import { ids, scene, team, withWorkspace } from './base'
import { floorFixtures } from './floor'

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

/** Local time today or yesterday, so Home groups rows under Today and Yesterday whatever day the shots run. */
const clock = (daysAgo: number, h: number, m: number) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.getTime() }

/** The three things waiting on CJ in Client A (Inbox.png, Home.png): two approvals and a PR ready to merge. */
const homeApprovals: Approval[] = [
  { id: 'ap-push', kind: 'tool', source: 'sdk', roomId: ids.roomA, workspaceId: ids.schema, agentId: 'noor', toolName: 'Bash', input: { command: 'pnpm drizzle-kit push' }, title: 'Run pnpm drizzle-kit push', detail: 'T-12 adds the invoices table. Kai is waiting on it to finish T-14.', status: 'pending', createdAt: ago(2 * MIN) },
  { id: 'ap-plan15', kind: 'plan', source: 'sdk', roomId: ids.roomA, agentId: 'rowan', title: 'Plan for T-15', detail: '1. T-15a PDF renderer · Noor\n2. T-15b Export button · Kai', status: 'pending', createdAt: ago(6 * MIN) }
]
const note = (n: Partial<Notification> & Pick<Notification, 'id' | 'title' | 'sub' | 'createdAt'>): Notification => ({ kind: 'system', roomId: ids.roomA, needsYou: false, read: false, ...n })
const homeNotifications: Notification[] = [
  note({ id: 'n1', kind: 'approval', agentId: 'noor', approvalId: 'ap-push', title: 'Wants to run drizzle-kit push', sub: 'Permission · Client A', heading: 'Noor wants to run a command that changes the database', needsYou: true, createdAt: ago(2 * MIN) }),
  note({ id: 'n2', kind: 'approval', agentId: 'rowan', approvalId: 'ap-plan15', title: 'Plan ready: Export invoices as PDF', sub: 'Plan review · Client A', heading: 'Rowan has a plan for you to review', needsYou: true, createdAt: ago(6 * MIN) }),
  note({ id: 'n3', kind: 'merge', agentId: 'theo', workspaceId: ids.invites, title: 'PR #41 is ready to merge', sub: 'Merge · Client A', heading: 'PR #41 is ready to merge', body: 'org-invites has passing checks and no open review comments.', needsYou: true, createdAt: ago(12 * MIN) }),
  note({ id: 'n4', kind: 'blocked', agentId: 'ivy', title: 'T-11 was blocked by a hook', sub: 'Check failed · Client A', heading: 'T-11 was blocked by a hook', body: 'The test-output hook stopped Ivy. She needs the run output attached.', createdAt: ago(18 * MIN) }),
  note({ id: 'n5', kind: 'finished', agentId: 'kai', workspaceId: ids.table, title: 'Finished T-14 invoice table', sub: 'Workspace ready · Client A', heading: 'Finished T-14 invoice table', body: 'Kai pushed the table, its states and the tests. Vitest and Playwright pass.', createdAt: ago(31 * MIN) }),
  note({ id: 'n6', kind: 'standup', agentId: 'rowan', title: 'Daily standup', sub: 'Summary · Client A', heading: 'Daily standup', body: 'T-11 passed, T-12 and T-14 are in progress, T-09 waits on your merge.', read: true, createdAt: ago(9 * HOUR) }),
  note({ id: 'n7', title: 'Hooks reconnected', sub: 'System', roomId: undefined, heading: 'Hooks reconnected', body: 'Kernel is listening on localhost:7420 again.', read: true, createdAt: ago(11 * HOUR) })
]

/** Home.png: four rooms (A needs you), five merged PRs, three things waiting. */
const homeScene = (f: Fixture): Partial<Fixture> => {
  const merged = (id: string, roomId: string, agentId: string, title: string, added: number, removed: number, at: number) =>
    ({ id, roomId, name: id, title, prTitle: title, branch: `feat/${id}`, baseRef: 'origin/main', path: `/Users/cj/kernel/worktrees/${id}`, mode: 'worktree' as const, agentId, port: 4400, status: 'archived' as const, prState: 'merged' as const, prNumber: 30, stat: { files: 3, added, removed }, createdAt: at - HOUR, mergedAt: at })
  const crew = (...names: string[]): AgentDef[] => names.map((n) => team.find((a) => a.id === n)!)
  return {
    ...roomsScene(f),
    rooms: roomsScene(f).rooms!.filter((r) => !r.archived),
    approvals: homeApprovals,
    notifications: homeNotifications,
    agents: { [ids.roomA]: team, [ids.roomB]: crew('rowan', 'kai'), [ids.roomOwn]: crew('rowan', 'kai', 'ivy'), [ids.roomPortfolio]: crew('rowan', 'kai') },
    status: {
      [ids.roomA]: { rowan: 'idle', kai: 'working', noor: 'working', theo: 'idle', ivy: 'idle' },
      [ids.roomB]: { rowan: 'working', kai: 'working' },
      [ids.roomOwn]: { rowan: 'working', kai: 'working', ivy: 'working' },
      [ids.roomPortfolio]: { rowan: 'idle', kai: 'idle' }
    },
    workspaces: [
      ...f.workspaces,
      merged('ws-m1', ids.roomA, 'kai', 'feat(invoices): table and empty states', 412, 38, clock(0, 10, 31)),
      merged('ws-m2', ids.roomA, 'noor', 'fix(auth): invite links expire after 7 days', 26, 9, clock(0, 9, 58)),
      merged('ws-m3', ids.roomOwn, 'kai', 'chore(db): seed realistic data', 188, 4, clock(0, 9, 12)),
      merged('ws-m4', ids.roomPortfolio, 'kai', 'Landing page polish', 926, 383, clock(1, 18, 40)),
      merged('ws-m5', ids.roomB, 'rowan', 'docs: onboarding questions', 18, 11, clock(1, 16, 5))
    ].map((w) => (w.id === ids.table ? { ...w, stat: { files: 4, added: 412, removed: 38 } } : w))
  }
}


/** History.png: six archived workspaces, four merged. Times are relative so Today and This week group the same on any day. */
const historyScene = (f: Fixture): Partial<Fixture> => {
  const archived = (id: string, name: string, branch: string, roomId: string, agentId: string, pr: { n: number; state: Workspace['prState'] } | null, when: number): Workspace => ({
    id, roomId, name, branch, baseRef: 'origin/main', path: `/Users/cj/kernel/worktrees/${name}`, mode: 'worktree', agentId, port: 4400, status: 'archived',
    prState: pr?.state ?? 'none', ...(pr ? { prNumber: pr.n } : {}), createdAt: when - 3 * HOUR, archivedAt: when, ...(pr?.state === 'merged' ? { mergedAt: when - 5 * MIN } : {})
  })
  return {
    ...roomsScene(f),
    rooms: roomsScene(f).rooms!.filter((r) => !r.archived),
    workspaces: [
      ...f.workspaces,
      archived('ws-h1', 'org-invites', 'feat/t-10-org-invites', ids.roomA, 'theo', { n: 41, state: 'merged' }, clock(0, 14, 2)),
      archived('ws-h2', 'docker-local-startup', 'fix/docker-local-startup', ids.roomA, 'noor', { n: 40, state: 'merged' }, clock(0, 11, 20)),
      archived('ws-h3', 'try-datatable', 'spike/try-datatable', ids.roomA, 'kai', null, clock(0, 9, 48)),
      archived('ws-h4', 'auth-orgs', 'feat/t-08-auth-orgs', ids.roomA, 'noor', { n: 36, state: 'merged' }, clock(3, 10, 12)),
      archived('ws-h5', 'landing-polish', 'feat/landing-polish', ids.roomPortfolio, 'kai', { n: 12, state: 'merged' }, clock(3, 9, 30)),
      archived('ws-h6', 'pricing-experiment', 'spike/pricing-experiment', ids.roomOwn, 'rowan', { n: 7, state: 'closed' }, clock(4, 16, 4))
    ].map((w) => (w.id === ids.table ? { ...w, stat: { files: 4, added: 412, removed: 38 } } : w))
  }
}

const home = { route: { name: 'home' } } as const

export const teamFixtures: Record<string, Fixture> = {
  Home: scene((f) => ({ ...homeScene(f), ui: { route: { name: 'home' } } })),
  CommandPalette: scene((f) => ({ ...homeScene(f), ui: { route: { name: 'workspace', workspaceId: ids.table }, modal: { name: 'search' } } })),
  AccountMenu: scene((f) => ({ ...homeScene(f), ui: { ...home, menu: 'account' } })),
  QuickAsk: { ...floorFixtures.Main, ui: { ...floorFixtures.Main.ui, menu: 'quickAsk' } },
  History: scene((f) => ({ ...historyScene(f), ui: { route: { name: 'history' } } })),
  UpdateReady: scene((f) => ({ ...homeScene(f), update: { status: 'ready', current: '0.1.0', version: '0.2.0' }, ui: home })),
  HomeEmpty: scene(() => ({ ...empty, ui: { route: { name: 'home' } } })),
  Inbox: scene((f) => ({ ...homeScene(f), ui: { route: { name: 'inbox' } } })),
  InboxEmpty: scene((f) => ({ ...homeScene(f), approvals: [], notifications: [], ui: { route: { name: 'inbox' } } })),
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
