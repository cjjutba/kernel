import type { ActivityEvent, AgentDef, AgentDraft, Approval, Integration, LinearIssueDetail, LinearScope, Notification, Room, RoomSetupStep, Skill, Task, Workspace } from '@shared/types'
import type { Fixture } from './types'
import { agent, at, ids, invaderIcon, scene, team, withWorkspace } from './base'

// Team lane: Home and Inbox (KERNEL-17), rooms and the sidebar menus (KERNEL-20), Team and agents (KERNEL-19).

const empty = { rooms: [], agents: {}, status: {}, workspaces: [], chats: [], items: {}, approvals: [], activity: [], changes: {}, diffs: {}, push: [] }

const ago = (ms: number) => Date.now() - ms
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

/** Rooms.png: five rooms, one of each source, one archived. Times are relative so "2 min ago" always reads the same. */
const roomsScene = (f: Fixture): Partial<Fixture> => {
  const rooms: Room[] = [
    { ...f.rooms[0], desc: 'Invoicing SaaS · MVP Sprint', kind: 'repo', path: '/Users/you/Projects/client-a', createdAt: ago(2 * MIN) },
    { ...f.rooms[1], desc: 'Discovery Sprint', kind: 'repo', createdAt: ago(14 * MIN) },
    { ...f.rooms[2], desc: 'Nights and weekends', kind: 'folder', repo: undefined, path: '/Users/you/Projects/own-app', createdAt: ago(HOUR) },
    { ...f.rooms[3], icon: undefined, desc: 'Personal site refresh', kind: 'repo', createdAt: ago(2 * DAY) },
    { id: 'room-sandbox', name: 'Sandbox', desc: 'Trying out new agent roles', kind: 'scratch', repo: 'samrivera/starter-kit', path: '/Users/you/Projects/sandbox', defaultBranch: 'main', paused: false, archived: true, createdAt: ago(21 * DAY) }
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
  { id: 'clone', title: 'Clone samrivera/client-c', detail: '~/Projects/client-c', state: 'ok', meta: '4s' },
  { id: 'worktrees', title: 'Create the worktree folder', detail: '~/kernel/worktrees/client-c', state: 'ok' },
  { id: 'install', title: 'Install dependencies', detail: 'pnpm install', state: 'run', meta: 'running' },
  { id: 'copy', title: 'Copy local files', detail: '.env.local, .env.test', state: 'wait' },
  { id: 'hooks', title: 'Install hooks', detail: '10 events to localhost:7420', state: 'wait' },
  { id: 'agents', title: 'Seat agents', detail: 'Rowan, Kai, Noor, Ivy, Theo from .claude/agents', state: 'wait' }
]

const clientC: Room = { id: 'room-client-c', name: 'Client C', desc: 'Booking dashboard for a dental clinic', kind: 'repo', repo: 'samrivera/client-c', path: '/Users/you/Projects/client-c', defaultBranch: 'main', paused: false, createdAt: ago(MIN) }
const repos = [
  ['client-c', true, 2 * HOUR], ['personal-site', false, DAY], ['habit-tracker', true, 3 * DAY], ['recipe-box', true, 7 * DAY], ['starter-kit', true, 14 * DAY], ['starter-kit-mobile', true, 21 * DAY]
].map(([name, priv, age]) => ({ fullName: `samrivera/${name}`, name: name as string, private: priv as boolean, updatedAt: ago(age as number) }))

/** Local time today or yesterday, so Home groups rows under Today and Yesterday whatever day the shots run. */
const clock = (daysAgo: number, h: number, m: number) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.getTime() }

/** The three things waiting on the user in Client A (Inbox.png, Home.png): two approvals and a PR ready to merge. */
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
    ({ id, roomId, name: id, title, prTitle: title, branch: `feat/${id}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/${id}`, mode: 'worktree' as const, agentId, port: 4400, status: 'archived' as const, prState: 'merged' as const, prNumber: 30, stat: { files: 3, added, removed }, createdAt: at - HOUR, mergedAt: at })
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
    id, roomId, name, branch, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/${name}`, mode: 'worktree', agentId, port: 4400, status: 'archived',
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

/** Board.png: ten tasks across the six columns, in Client A. Branches follow the canvas (wt/t-14-invoice-table). */
const boardScene = (f: Fixture): Partial<Fixture> => {
  const A = ids.roomA
  const task = (id: string, title: string, column: Task['column'], state: Task['state'], agentId: string, extra: Partial<Task> = {}): Task =>
    ({ id, roomId: A, title, column, state, agentId, steps: [], milestone: 'Invoices v1', createdAt: at(10, 5), updatedAt: at(10, 31), ...extra })
  const merged = (id: string, name: string, branch: string, agentId: string, n: number, prTitle: string): Workspace => ({
    id, roomId: A, name, branch, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/client-a/${name}`, mode: 'worktree', agentId, port: 4400, status: 'archived',
    prState: 'merged', prNumber: n, prTitle, createdAt: at(9, 10), mergedAt: at(9, 50), archivedAt: at(9, 52)
  })
  const branchOf = (id: string, branch: string) => (w: Workspace) => (w.id === id ? { ...w, branch, stat: id === ids.table ? { files: 4, added: 412, removed: 38 } : w.stat } : w)
  const workspaces = [
    ...f.workspaces.map(branchOf(ids.table, 'wt/t-14-invoice-table')).map(branchOf(ids.schema, 'wt/t-12-invoice-schema')).map((w) => (w.id === ids.invites ? { ...w, prState: 'ready' as const } : w)),
    merged('ws-t10', 'invoice-model-types', 'feat/t-10-invoice-model-types', 'noor', 33, 'feat(invoices): model and zod schema'),
    merged('ws-t08', 'auth-orgs', 'feat/t-08-auth-orgs', 'noor', 36, 'feat(auth): orgs and roles'),
    merged('ws-t07', 'seed-data', 'chore/t-07-seed-data', 'kai', 29, 'chore(db): seed invoices')
  ]
  const tasks: Task[] = [
    task('T-16', 'Client portal login', 'spec', 'working', 'rowan'),
    task('T-15', 'Export invoices as PDF', 'plan', 'needs', 'rowan'),
    task('T-14', 'Invoice table and empty states', 'build', 'working', 'kai', {
      workspaceId: ids.table, spec: 'Show invoices in a sortable table with empty, loading and error states. Follow DESIGN.md. Playwright covers each state.',
      steps: [
        { text: 'Table with sortable headers', state: 'done' }, { text: 'Empty, loading and error states', state: 'done' },
        { text: 'Playwright coverage', state: 'doing' }, { text: 'Ivy verifies with test output', state: 'next' }
      ]
    }),
    task('T-12', 'Invoice schema and migration', 'build', 'needs', 'noor', { workspaceId: ids.schema }),
    task('T-13', 'Rate limit the public API', 'qa', 'working', 'ivy'),
    task('T-11', 'Org settings page', 'qa', 'blocked', 'ivy'),
    task('T-09', 'Org invites', 'review', 'needs', 'theo', { workspaceId: ids.invites }),
    task('T-10', 'Invoice model types', 'done', 'done', 'noor', { workspaceId: 'ws-t10', completedAt: at(9, 50) }),
    task('T-08', 'Auth with organisations', 'done', 'done', 'noor', { workspaceId: 'ws-t08', completedAt: at(9, 40) }),
    task('T-07', 'Realistic seed data', 'done', 'done', 'kai', { workspaceId: 'ws-t07', completedAt: at(9, 30) })
  ]
  const log = (id: string, h: number, m: number, extra: Partial<ActivityEvent>): ActivityEvent => ({ id, ts: at(h, m), roomId: A, workspaceId: ids.table, taskId: 'T-14', kind: 'note', text: '', ...extra })
  const activity = [
    ...f.activity,
    log('t14-4', 10, 31, { agentId: 'kai', text: 'attached test output' }),
    log('t14-3', 10, 24, { agentId: 'kai', text: 'added empty and error states' }),
    log('t14-2', 10, 12, { agentId: 'rowan', kind: 'task.assigned', text: 'assigned it to', object: 'Kai' }),
    log('t14-1', 10, 5, { actor: 'you', kind: 'task.created', text: 'approved the plan' })
  ]
  return { activity, workspaces, tasks: { [A]: tasks }, status: { [A]: { rowan: 'idle', kai: 'working', noor: 'working', theo: 'working', ivy: 'working' } } }
}


/** Team.png and AgentProfile.png: six agents in Client A with the canvas's models, states and workspaces. Kai's recent work is four tasks. */
const teamScene = (f: Fixture): Partial<Fixture> => {
  const A = ids.roomA
  const who = (id: string, name: string, role: string, model: string, description: string, o: Partial<AgentDef> = {}): AgentDef =>
    ({ ...agent(id, name, role, model, !!o.lead), description, effort: 'high', prompt: `You are ${name}, the ${role.toLowerCase()} in this room. ${description} Work in your own worktree and tell Rowan when you finish.`, ...o })
  const crew: AgentDef[] = [
    who('rowan', 'Rowan', 'Lead', 'opus', 'Plans, splits tasks, hands them out. Never edits code.', { lead: true, tools: ['Read', 'Grep', 'Glob'], skills: ['/plan'] }),
    who('kai', 'Kai', 'Frontend', 'sonnet', 'UI work. Follows DESIGN.md.', {
      tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], skills: ['/feature', '/verify', '/image'],
      prompt: 'You are Kai, the frontend engineer in this room. Build the screens in the plan exactly as the PNGs show them.\n\nFollow DESIGN.md: tokens only, no hex values, hairlines instead of shadows.\nOpen the compare image after every change and fix what a person would notice.\nAdd a Playwright test for each state before you ask for review.'
    }),
    who('noor', 'Noor', 'Backend', 'sonnet', 'Schema, API and migrations.', { tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'] }),
    who('ivy', 'Ivy', 'QA', 'sonnet', 'Runs tests and attaches the output.', { tools: ['Read', 'Bash', 'Grep', 'Glob'], skills: ['/verify'] }),
    who('theo', 'Theo', 'Reviewer', 'opus', 'Types at boundaries, security, tenant isolation.', { tools: ['Read', 'Grep', 'Glob'] }),
    who('lumi', 'Lumi', 'Designer', 'sonnet', 'Checks every screen against DESIGN.md.', { tools: ['Read', 'Grep', 'Glob', 'Bash'], joinedAt: Date.now() - 2 * HOUR })
  ]
  const table = f.workspaces.find((w) => w.id === ids.table)!
  const open = (id: string, name: string, agentId: string, mins: number): Workspace => ({ ...table, id, name, branch: `wt/${name}`, agentId, prState: 'none', prNumber: undefined, prUrl: undefined, stat: undefined, createdAt: at(10, mins) })
  const done = (id: string, name: string, n: number, mins: number): Workspace => ({ ...table, id, name, branch: `wt/${name}`, agentId: 'kai', status: 'archived', prState: 'merged', prNumber: n, createdAt: at(8, mins), archivedAt: at(8, mins + 30) })
  const workspaces = [
    ...f.workspaces,
    open('ws-pdf-button', 'invoice-pdf-button', 'kai', 41), open('ws-pdf-renderer', 'invoice-pdf-renderer', 'noor', 42), open('ws-pdf-tests', 'invoice-pdf-tests', 'ivy', 43), open('ws-pdf-review', 'invoice-pdf-review', 'theo', 44),
    done('ws-t14', 'invoice-table-v1', 42, 5), done('ws-t09', 'org-settings-page', 38, 3), done('ws-t06', 'sign-in-screens', 31, 1)
  ]
  const task = (id: string, title: string, column: Task['column'], agentId: string, workspaceId: string | undefined, hour: number, min: number): Task =>
    ({ id, roomId: A, title, column, state: column === 'done' ? 'done' : 'working', agentId, workspaceId, steps: [], createdAt: at(8, 0), updatedAt: at(hour, min) })
  const skills: Skill[] = [['plan', 'Plan before editing'], ['feature', 'Build a feature from a spec'], ['verify', 'Run tests and attach the output'], ['image', 'Generate or edit an image']].map(([name, description]) => ({ name, description, source: 'project' as const, enabled: true }))
  return {
    agents: { [A]: crew, [ids.roomB]: crew.slice(0, 1), [ids.roomOwn]: crew.filter((a) => ['rowan', 'kai', 'ivy'].includes(a.id)), [ids.roomPortfolio]: crew.slice(0, 1) },
    status: { [A]: { rowan: 'idle', kai: 'working', noor: 'needs', ivy: 'working', theo: 'idle', lumi: 'idle' } },
    workspaces, skills,
    // The other rooms only seat some of the crew, so a question from someone who is not there comes from Rowan.
    approvals: f.approvals.map((a) => (a.roomId === ids.roomB || a.roomId === ids.roomPortfolio ? { ...a, agentId: 'rowan' } : a)),
    tasks: { [A]: [
      task('T-15b', 'Download PDF button', 'build', 'kai', 'ws-pdf-button', 10, 41), task('T-14', 'Invoice table', 'done', 'kai', 'ws-t14', 9, 40),
      task('T-09', 'Org settings page', 'done', 'kai', 'ws-t09', 9, 10), task('T-06', 'Sign-in screens', 'done', 'kai', 'ws-t06', 8, 40)
    ] }
  }
}

/** The team as it is before Lumi is hired, behind the New agent modal. */
const beforeLumi = (f: Fixture): Partial<Fixture> => {
  const t = teamScene(f)
  const { lumi: _, ...status } = t.status![ids.roomA]
  return { ...t, agents: { ...t.agents, [ids.roomA]: t.agents![ids.roomA].filter((a) => a.id !== 'lumi') }, status: { [ids.roomA]: status } }
}

const lumiDraft: AgentDraft = {
  id: 'lumi', name: 'Lumi', model: 'sonnet', tools: ['Read', 'Grep', 'Glob', 'Bash(pnpm screenshot:*)'], file: '.claude/agents/lumi.md',
  description: 'A designer who checks every screen against DESIGN.md before review.',
  text: '---\nname: lumi\ndescription: A designer who checks every screen against DESIGN.md before review.\nmodel: sonnet\ntools: Read, Grep, Glob, Bash(pnpm screenshot:*)\n---\nYou are Lumi. Before Theo reviews a PR, open each changed screen, compare it with DESIGN.md, and list drift in spacing, type and color with file and line.\n'
}
const lumiPrefill = { name: 'Lumi', description: 'A designer who checks every screen against DESIGN.md before review.', model: 'sonnet' }

const home = { route: { name: 'home' } } as const

/** Ask Rowan open over the invoice-table workspace. The Lead has two chats and the question went to the second. */
const askedFromTable = (f: Fixture, leadGone: boolean): Partial<Fixture> => {
  const h = homeScene(f)
  const question = "What's the status of T-15? Who is blocked?"
  const second = { id: 'chat-lead-status', workspaceId: ids.lead, title: 'Status question', kind: 'chat' as const, model: 'claude-opus-5-5' as const, effort: 'high' as const, plan: false, createdAt: at(10, 32) }
  return {
    ...h,
    workspaces: h.workspaces!.map((w) => (leadGone && w.id === ids.lead ? { ...w, status: 'archived' as const } : w)),
    chats: [...f.chats, second],
    items: {
      ...f.items,
      [second.id]: [
        { kind: 'user', id: 'qs-q', ts: at(10, 32), parts: [{ type: 'text', text: question }] },
        { kind: 'text', id: 'qs-a', ts: at(10, 33), text: 'T-15 is in review: Theo has the PR open. Nobody is blocked.' }
      ]
    },
    ui: { route: { name: 'workspace', workspaceId: ids.table }, menu: 'quickAsk', quickAsk: { [ids.roomA]: { draft: '', asked: { chatId: second.id, since: at(10, 32), question } } } }
  }
}

/** The Lead's workspace with three chats, on the first, and invoice-table as the second workspace (KERNEL-199). The test walks through Settings and back. */
const navMemory = (f: Fixture): Partial<Fixture> => {
  const chat = (id: string, title: string, minute: number) => ({ id, workspaceId: ids.lead, title, kind: 'chat' as const, model: 'claude-opus-5-5' as const, effort: 'high' as const, plan: false, createdAt: at(10, minute) })
  return {
    ...homeScene(f),
    chats: [...f.chats, chat('chat-lead-two', 'Second chat', 20), chat('chat-lead-three', 'Third chat', 21)],
    ui: { route: { name: 'workspace', workspaceId: ids.lead } }
  }
}

/** An open chat of the Lead's workspace, for the sidebar fixtures. */
const leadChatRow = (id: string, title: string, minute: number) => ({ id, workspaceId: ids.lead, title, kind: 'chat' as const, model: 'claude-opus-5-5' as const, effort: 'high' as const, plan: false, createdAt: at(9, minute) })

/**
 * SidebarLeadChats (no PNG, KERNEL-165): Client A with four open Lead chats. One waits on a plan, one is running and started three
 * workspaces, one has a title too long for the sidebar, and one workspace has no owning chat. Rooms fill in the rest of the sidebar.
 */
const sidebarLeadChats = (f: Fixture): Partial<Fixture> => {
  const chat = leadChatRow
  const ownedBy = (leadChatId: string) => ({ leadChatId })
  const review: Workspace = { ...f.workspaces.find((w) => w.id === ids.schema)!, id: 'ws-review-pr-146', name: 'review-pr-146', branch: 'feat/t-14-invoice-table-review', agentId: 'theo', port: 4315, prNumber: undefined }
  const rooms = roomsScene(f)
  return {
    ...rooms,
    chats: [
      ...f.chats.filter((c) => c.workspaceId !== ids.lead),
      chat('chat-lead-ui', 'Conductor app UI review', 5), chat('chat-lead-inbox', 'Inbox clutter and old messages in the list', 6),
      chat('chat-lead-tools', 'Tool call display mode', 7), chat('chat-lead-new', 'New chat', 8)
    ],
    workspaces: [
      ...withWorkspace(f, ids.table, { ...ownedBy('chat-lead-inbox'), stat: { files: 4, added: 412, removed: 38 } })
        .map((w) => (w.id === ids.schema || w.id === ids.invites ? { ...w, ...ownedBy('chat-lead-inbox') } : w)),
      review
    ],
    approvals: [
      ...(rooms.approvals ?? []),
      { id: 'ap-lead-plan', kind: 'plan', source: 'sdk', roomId: ids.roomA, agentId: 'rowan', workspaceId: ids.lead, chatId: 'chat-lead-ui', title: 'Plan for the sidebar review', detail: '1. Kai lists the chats\n2. Ivy checks the shots', status: 'pending', createdAt: at(10, 44) }
    ],
    push: [{ type: 'chat.running', chatId: 'chat-lead-inbox', running: true }],
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false }, tabs: { [ids.lead]: { tab: 'chat-lead-tools', files: [], diffs: [] } } }
  }
}

/**
 * SidebarChatFolded.png (KERNEL-207): Client A on Home, with three Lead chats. The first waits on a plan, the second is running and
 * folded over two workspaces, one of which asks to run a command, so its row shows the needs-you icon. org-invites has no chat.
 */
const sidebarChatFolded = (f: Fixture): Partial<Fixture> => {
  const home = homeScene(f)
  const owner = 'chat-lead-table'
  return {
    ...home,
    chats: [
      ...f.chats.filter((c) => c.workspaceId !== ids.lead),
      leadChatRow('chat-lead-export', 'Export invoices as PDF', 5), leadChatRow(owner, 'Invoice table and empty states', 6), leadChatRow('chat-lead-login', 'Client portal login', 7)
    ],
    workspaces: home.workspaces!.map((w) => (w.id === ids.table || w.id === ids.schema ? { ...w, leadChatId: owner } : w)),
    approvals: home.approvals!.map((a) => (a.id === 'ap-plan15' ? { ...a, workspaceId: ids.lead, chatId: 'chat-lead-export' } : a)),
    push: [{ type: 'chat.running', chatId: owner, running: true }],
    ui: { route: { name: 'home' }, foldedChats: [owner] }
  }
}

// ---------- Issues (KERNEL-160)

const KERNEL = { id: 'team-kernel', key: 'KERNEL', name: 'Kernel' }
const linearScope: LinearScope = {
  teams: [KERNEL],
  projects: [
    { id: 'proj-invoices', name: 'Invoices', teamIds: [KERNEL.id] },
    { id: 'proj-accounts', name: 'Accounts', teamIds: [KERNEL.id] },
    { id: 'proj-billing', name: 'Billing', teamIds: [KERNEL.id] }
  ],
  cycles: [{ id: 'cycle-12', number: 12, teamId: KERNEL.id, active: true }, { id: 'cycle-13', number: 13, teamId: KERNEL.id, active: false }]
}

const cj = { name: 'CJ Jutba', me: true }
const maya = { name: 'Maya Chen', me: false }
const states = {
  triage: { id: 's-triage', name: 'Triage', type: 'triage' as const, position: 0 },
  started: { id: 's-started', name: 'In progress', type: 'started' as const, position: 2 },
  todo: { id: 's-todo', name: 'Todo', type: 'unstarted' as const, position: 1 },
  backlog: { id: 's-backlog', name: 'Backlog', type: 'backlog' as const, position: 0 }
}
const projects = { invoices: linearScope.projects[0], accounts: linearScope.projects[1], billing: linearScope.projects[2] }

/** Times are relative, so a row reads "2d" whatever day the shots run. */
const issue = (n: number, title: string, state: keyof typeof states, priority: number, project: keyof typeof projects, age: number, extra: Partial<LinearIssueDetail> = {}): LinearIssueDetail => ({
  id: `KERNEL-${n}`, uuid: `uuid-kernel-${n}`, title, url: `https://linear.app/cj-jutba/issue/KERNEL-${n}`, branchName: `feat/kernel-${n}`,
  state: states[state], priority, assignee: cj, labels: [], team: KERNEL, project: projects[project], updatedAt: new Date(Date.now() - age).toISOString(),
  description: '', comments: [], ...extra
})
const comment = (id: string, author: string, body: string, age: number) => ({ id, author, body, createdAt: new Date(Date.now() - age).toISOString() })

/** Issues.png: nine assigned to CJ and twenty-nine to others, so the pills read Mine 9 and All 38. */
const linearIssues = (): LinearIssueDetail[] => {
  const mine = [
    issue(24, 'Invoice table with sorting and empty states', 'started', 2, 'invoices', 3 * DAY, {
      cycle: { id: 'cycle-12', number: 12 }, labels: ['Feature', 'Frontend'],
      description: 'The invoice list needs a table that sorts and handles every state.\n\n## Scope\n\n- Sort by date, client and amount\n- Empty, loading and error states\n- Playwright coverage for each state',
      comments: [comment('c24a', 'Maya Chen', 'Newest first by default, please.', 4 * DAY), comment('c24b', 'CJ Jutba', 'Reuse the empty state from the dashboard.', 2 * DAY)]
    }),
    issue(27, 'Rate limit the invite endpoint', 'started', 3, 'accounts', DAY),
    issue(31, 'Export invoices as PDF', 'todo', 2, 'invoices', 2 * DAY, {
      cycle: { id: 'cycle-12', number: 12 }, labels: ['Feature', 'Billing'],
      description: 'Clients want a PDF copy of any invoice they can send to their accountant.\n\n## Acceptance criteria\n\n- A Download PDF action on every invoice row\n- The PDF matches the on-screen layout, on one page\n- Fonts are embedded, so it looks the same on every device',
      comments: [comment('c31a', 'Maya Chen', 'Billing asked for this twice this week. One page per invoice is fine, no custom templates yet.', 3 * DAY), comment('c31b', 'CJ Jutba', 'Use the on-screen design as the layout. Rowan can split it once we agree on the scope.', DAY)]
    }),
    issue(33, 'Send a reminder for overdue invoices', 'todo', 3, 'billing', 3 * DAY),
    issue(35, 'Show the invoice total in the page title', 'todo', 4, 'invoices', 4 * DAY),
    issue(36, 'Invoice emails send twice', 'todo', 1, 'billing', 4 * DAY),
    issue(40, 'Dark mode for the invoice PDF', 'backlog', 0, 'invoices', 7 * DAY),
    issue(42, 'Import clients from a CSV file', 'backlog', 4, 'accounts', 7 * DAY),
    issue(44, 'Add a tax breakdown to invoices', 'backlog', 3, 'billing', 14 * DAY)
  ]
  const others = [
    issue(46, 'Clients cannot reset their password', 'triage', 2, 'accounts', 3 * HOUR, { assignee: maya }),
    ...Array.from({ length: 28 }, (_, i) => issue(50 + i, [
      'Paginate the client list', 'Audit log for invoice edits', 'Webhook retries for failed deliveries', 'Currency rounding on credit notes', 'Bulk archive for old invoices', 'Search clients by VAT number',
      'Invite emails land in spam', 'Two factor sign in', 'Remember the last invoice filter', 'Print stylesheet for statements', 'Export clients as CSV', 'Show payment terms on the invoice',
      'Fix the date picker on Safari', 'Reminder emails in the client language', 'Draft invoices autosave', 'Link payments to bank lines', 'Tidy the settings page copy', 'Role for read only accountants',
      'Stripe webhook signature check', 'Slow query on the dashboard', 'Add a status filter to the client list', 'Credit note numbering', 'Rate limit the login endpoint', 'Keyboard shortcuts for the table',
      'Empty state for new rooms', 'Archive clients instead of deleting', 'Per client invoice prefix', 'Timezone on due dates'
    ][i], (['started', 'todo', 'todo', 'backlog', 'backlog'] as const)[i % 5], [3, 0, 2, 4, 3][i % 5], (['invoices', 'accounts', 'billing'] as const)[i % 3], (2 + i) * 6 * HOUR, { assignee: i % 4 === 0 ? undefined : maya }))
  ]
  return [...mine, ...others]
}

const linearIntegrations: Integration[] = [
  { id: 'github', name: 'GitHub', connected: true, detail: 'Through the GitHub CLI as samrivera' },
  { id: 'linear', name: 'Linear', connected: true, detail: 'Token saved. Create workspaces from issues' },
  { id: 'vercel', name: 'Vercel', connected: false, detail: 'Preview deployments show up in Checks' },
  { id: 'remote', name: 'Remote Control', connected: false, detail: 'Approvals and briefs from your phone' }
]

/** Everything the Issues screen reads. Client A's Linear team is KERNEL, unless `linkedRoom` is off (IssuesNoRoom.png). */
const issuesScene = (f: Fixture, opts: { issueId?: string; working?: boolean; linkedRoom?: boolean; issues?: LinearIssueDetail[] } = {}): Partial<Fixture> => {
  const { issueId = 'KERNEL-31', working = false, linkedRoom = true, issues = linearIssues() } = opts
  const home = homeScene(f)
  const fromIssue = (id: string, title: string) => ({ source: { kind: 'issue' as const, id, title, url: `https://linear.app/cj-jutba/issue/${id}` } })
  // KERNEL-24 has Kai's PR. Working adds Ivy's tests and Noor on KERNEL-27, with their chats running.
  const table = { ...fromIssue('KERNEL-24', 'Invoice table with sorting and empty states'), branch: 'feat/kernel-24-invoice-table', prNumber: 41, prUrl: 'https://github.com/samrivera/client-a/pull/41', prState: 'open' as const }
  const links: Record<string, Partial<Workspace>> = linkedRoom || working ? { [ids.table]: table } : {}
  if (working) links[ids.schema] = fromIssue('KERNEL-27', 'Rate limit the invite endpoint')
  const tests: Workspace = {
    id: 'ws-invoice-tests', roomId: ids.roomA, name: 'invoice-table-tests', branch: 'feat/kernel-24-invoice-tests', baseRef: 'origin/main', path: '/Users/you/kernel/worktrees/client-a/invoice-table-tests',
    mode: 'worktree', agentId: 'ivy', port: 4315, status: 'ready', prState: 'none', createdAt: at(10, 6), ...fromIssue('KERNEL-24', 'Invoice table with sorting and empty states')
  }
  return {
    ...home,
    workspaces: [...(home.workspaces ?? f.workspaces).map((w) => ({ ...w, ...links[w.id] })), ...(working ? [tests] : [])],
    chats: [...(home.chats ?? f.chats), ...(working ? [{ id: 'chat-invoice-tests', workspaceId: tests.id, title: 'Invoice table tests', kind: 'chat' as const, model: 'claude-sonnet-5-5' as const, effort: 'high' as const, plan: false, createdAt: at(10, 6) }] : [])],
    integrations: linearIntegrations,
    linear: { issues, scope: linearScope },
    roomSettings: { [ids.roomA]: { scripts: {}, files: { copy: ['.env', '.env.local'] }, workspace: {}, ...(linkedRoom ? { linear: { team: 'KERNEL' } } : {}) } },
    push: working ? [{ type: 'chat.running', chatId: ids.schemaChat, running: true }, { type: 'chat.running', chatId: 'chat-invoice-tests', running: true }] : [],
    ui: { route: { name: 'issues', issueId } }
  }
}

export const teamFixtures: Record<string, Fixture> = {
  Home: scene((f) => ({ ...homeScene(f), ui: { route: { name: 'home' } } })),
  // KERNEL-253: Client B has its GitHub avatar, in grayscale, in the sidebar and on its card in the Rooms list.
  HomeRoomIcon: scene((f) => {
    const home = homeScene(f)
    return {
      ...home,
      rooms: home.rooms!.map((r) => (r.id === ids.roomB ? { ...r, icon: { kind: 'github' as const, file: `${ids.roomB}-1.png`, at: at(9, 0) } } : r)),
      roomIcons: { [ids.roomB]: invaderIcon },
      ui: { route: { name: 'home' } }
    }
  }),
  CommandPalette: scene((f) => ({ ...homeScene(f), ui: { route: { name: 'workspace', workspaceId: ids.table }, modal: { name: 'search' } } })),
  AccountMenu: scene((f) => ({ ...homeScene(f), ui: { ...home, menu: 'account' } })),
  QuickAsk: scene((f) => ({ ...homeScene(f), ui: { ...home, menu: 'quickAsk' } })),
  // No PNG: the popover reopened after a question, with Rowan's answer in (KERNEL-146).
  QuickAskAnswered: scene((f) => ({
    ...homeScene(f),
    push: [{ type: 'chat.item', chatId: ids.leadChat, item: { kind: 'text', id: 'qa-answer', ts: at(10, 33), text: 'T-15 is in review: Theo has the PR open. Nobody is blocked.' } }],
    ui: { ...home, menu: 'quickAsk', quickAsk: { [ids.roomA]: { draft: '', asked: { chatId: ids.leadChat, since: at(10, 32), question: "What's the status of T-15? Who is blocked?" } } } }
  })),
  // No PNG: Open chat from a workspace that isn't the Lead's, with the question in the Lead's second chat (KERNEL-146). The test opens it in Electron.
  QuickAskOpenChat: scene((f) => askedFromTable(f, false)),
  // No PNG: the same, but the Lead's workspace is gone, so `lead.open` fails and Open chat must leave the tab alone.
  QuickAskLeadGone: scene((f) => askedFromTable(f, true)),
  // No PNG: Lead chat 3, then Settings and back, then another workspace and back (KERNEL-199). The test opens it in Electron.
  NavMemory: scene(navMemory),
  History: scene((f) => ({ ...historyScene(f), ui: { route: { name: 'history' } } })),
  Board: scene((f) => ({ ...boardScene(f), ui: { route: { name: 'board', roomId: ids.roomA } } })),
  TaskDetail: scene((f) => ({ ...boardScene(f), ui: { route: { name: 'task', roomId: ids.roomA, taskId: 'T-14' } } })),
  BoardEmpty: scene((f) => ({ ...boardScene(f), tasks: { [ids.roomA]: [] }, ui: { route: { name: 'board', roomId: ids.roomA } } })),
  Team: scene((f) => ({ ...teamScene(f), ui: { route: { name: 'team', roomId: ids.roomA } } })),
  // No PNG: a new room with no agents offers the team templates the empty floor had (D-104).
  TeamEmpty: scene((f) => ({ ...teamScene(f), rooms: [...f.rooms, clientC], ui: { route: { name: 'team', roomId: clientC.id } } })),
  AgentProfile: scene((f) => ({ ...teamScene(f), ui: { route: { name: 'agent', roomId: ids.roomA, agentId: 'kai' } } })),
  NewAgent: scene((f) => ({ ...beforeLumi(f), ui: { route: { name: 'team', roomId: ids.roomA }, modal: { name: 'newAgent', roomId: ids.roomA, step: 'describe', prefill: { name: 'Lumi', model: 'sonnet' } } } })),
  NewAgentDraft: scene((f) => ({ ...beforeLumi(f), ui: { route: { name: 'team', roomId: ids.roomA }, modal: { name: 'newAgent', roomId: ids.roomA, step: 'draft', prefill: { ...lumiPrefill, draft: lumiDraft } } } })),
  NewAgentDone: scene((f) => ({ ...beforeLumi(f), ui: { route: { name: 'team', roomId: ids.roomA }, modal: { name: 'newAgent', roomId: ids.roomA, step: 'done', prefill: { ...lumiPrefill, draft: lumiDraft } } } })),
  ConfirmRetire: scene((f) => ({ ...teamScene(f), ui: { route: { name: 'agent', roomId: ids.roomA, agentId: 'kai' }, modal: { name: 'confirm', kind: 'retire', roomId: ids.roomA, agentId: 'kai' } } })),
  UpdateReady: scene((f) => ({ ...homeScene(f), update: { status: 'ready', current: '0.1.0', version: '0.2.0' }, ui: home })),
  HomeEmpty: scene(() => ({ ...empty, ui: { route: { name: 'home' } } })),
  Inbox: scene((f) => ({ ...homeScene(f), ui: { route: { name: 'inbox' } } })),
  InboxEmpty: scene((f) => ({ ...homeScene(f), approvals: [], notifications: [], ui: { route: { name: 'inbox' } } })),
  // No PNG: two agents in the same file, which the floor showed until D-104. The newest row, so the detail pane opens on it.
  InboxOverlap: scene((f) => ({
    ...homeScene(f),
    overlaps: [{
      id: 'ov-invoices', roomId: ids.roomA, path: 'src/app/invoices/invoices.ts', ts: Date.now(),
      parties: [{ agentId: 'kai', workspaceId: ids.table, lines: 'lines 20-34' }, { agentId: 'noor', workspaceId: ids.schema, lines: 'lines 18-40' }]
    }],
    ui: { route: { name: 'inbox' } }
  })),
  Rooms: scene((f) => ({ ...roomsScene(f), ui: { route: { name: 'rooms' } } })),
  NewRoom: scene((f) => ({
    ...roomsScene(f),
    ui: { route: { name: 'rooms' }, modal: { name: 'newRoom', prefill: { source: 'repo', name: 'Client C', desc: 'Booking dashboard for a dental clinic', from: 'samrivera/client-c', baseBranch: 'main' } } }
  })),
  ConnectRepo: scene((f) => ({ ...roomsScene(f), repos, ui: { route: { name: 'home' }, modal: { name: 'connectRepo' } } })),
  OpenFolder: scene((f) => ({
    ...roomsScene(f),
    folders: [
      { path: '/Users/you/Projects/habit-tracker', git: true, branch: 'main', dirty: 0 },
      { path: '/Users/you/Projects/recipe-box', git: true, branch: 'dev', dirty: 3 },
      { path: '/Users/you/Projects/personal-site', git: true, branch: 'main', dirty: 0 },
      { path: '/Users/you/Desktop/sandbox', git: false }
    ],
    ui: { route: { name: 'home' }, modal: { name: 'openFolder' } }
  })),
  RoomSetup: scene((f) => ({
    ...roomsScene(f),
    rooms: [...f.rooms, clientC],
    push: [{ type: 'room.setup', roomId: clientC.id, steps: setupSteps }],
    ui: { route: { name: 'onboarding', step: 'room', roomId: clientC.id } }
  })),
  Issues: scene((f) => issuesScene(f)),
  IssuesWorking: scene((f) => issuesScene(f, { issueId: 'KERNEL-24', working: true })),
  IssuesNoRoom: scene((f) => issuesScene(f, { linkedRoom: false })),
  // Nothing assigned to CJ, so the default Mine filter finds nothing.
  IssuesEmpty: scene((f) => issuesScene(f, { issues: linearIssues().map((i) => ({ ...i, assignee: maya })) })),
  IssuesConnect: scene((f) => ({ ...issuesScene(f), integrations: linearIntegrations.map((i) => (i.id === 'linear' ? { ...i, connected: false, detail: 'Create workspaces from issues' } : i)) })),
  // Offline: the screen says Linear can't be reached whatever the last answer was.
  IssuesError: scene((f) => ({ ...issuesScene(f), push: [{ type: 'online', online: false }] })),
  SidebarRoomsMenu: withMenu('rooms', { name: 'home' }),
  SidebarLeadChats: scene(sidebarLeadChats),
  SidebarChatFolded: scene(sidebarChatFolded),
  SidebarRoomMenu: withMenu(`room:${ids.roomA}`, { name: 'team', roomId: ids.roomA }),
  ConfirmRemoveRoom: scene((f) => ({ ...roomsScene(f), ui: { route: { name: 'team', roomId: ids.roomA }, modal: { name: 'confirm', kind: 'removeRoom', roomId: ids.roomA } } }))
}
