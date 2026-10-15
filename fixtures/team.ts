import type { AgentDef, AgentDraft, Approval, Chat, ChatItem, GithubIssueDetail, HeldChat, Integration, LinearIssueDetail, LinearScope, Notification, PrInfo, Room, RoomSetupStep, Skill, Task, TeamConfig, Thread, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { Fixture } from './types'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { describeTool } from '../src/main/services/approvals'
import { agent, at, ids, invaderIcon, scene, team, withWorkspace } from './base'
import { grouped, sharedFiles, sharedStills } from './workspace'

// Team lane: Inbox (KERNEL-17), rooms and the sidebar menus (KERNEL-20), Team and agents (KERNEL-19).

const empty = { rooms: [], agents: {}, status: {}, workspaces: [], chats: [], items: {}, approvals: [], activity: [], changes: {}, diffs: {}, push: [] }

const ago = (ms: number) => Date.now() - ms
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

/** Rooms.png: five rooms, one of each source, one archived. Times are relative so "2 min ago" always reads the same. */
const roomsScene = (f: Fixture): Partial<Fixture> => {
  const rooms: Room[] = [
    { ...f.rooms[0], desc: 'Invoicing SaaS · MVP Sprint', kind: 'repo', path: '/Users/you/Projects/client-a', createdAt: ago(2 * MIN) },
    { ...f.rooms[1], desc: 'Discovery Sprint', kind: 'repo', createdAt: ago(14 * MIN) },
    { ...f.rooms[2], desc: 'Nights and weekends', kind: 'folder', repo: undefined, path: '/Users/you/Projects/own-app', createdAt: ago(HOUR) },
    { ...f.rooms[3], desc: 'Personal site refresh', kind: 'repo', createdAt: ago(2 * DAY) },
    { id: 'room-sandbox', name: 'Sandbox', desc: 'Trying out new agent roles', kind: 'scratch', repo: 'samrivera/starter-kit', path: '/Users/you/Projects/sandbox', defaultBranch: 'main', paused: false, archived: true, createdAt: ago(21 * DAY) }
  ]
  const crew = (...names: string[]): AgentDef[] => names.map((n) => team.find((a) => a.id === n)!)
  return {
    rooms,
    activity: [],
    // Three things wait on Client A, the Inbox count in the sidebar.
    approvals: f.approvals.map((a) => ({ ...a, roomId: ids.roomA })),
    agents: { [ids.roomA]: team, [ids.roomB]: crew('kernel-lead', 'kai'), [ids.roomOwn]: crew('kernel-lead', 'kai', 'ivy'), [ids.roomPortfolio]: crew('kernel-lead', 'kai'), 'room-sandbox': crew('kernel-lead') },
    status: {
      [ids.roomA]: { 'kernel-lead': 'idle', kai: 'idle', noor: 'idle', theo: 'idle', ivy: 'idle' },
      [ids.roomB]: { 'kernel-lead': 'working', kai: 'idle' },
      [ids.roomOwn]: { 'kernel-lead': 'idle', kai: 'working', ivy: 'idle' },
      [ids.roomPortfolio]: { 'kernel-lead': 'idle', kai: 'idle' },
      'room-sandbox': { 'kernel-lead': 'idle' }
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
  { id: 'push', title: 'Check push access', detail: 'samrivera can push to samrivera/client-c', state: 'wait' },
  { id: 'agents', title: 'Seat agents', detail: 'Kernel, Kai, Noor, Ivy, Theo from .claude/agents', state: 'wait' }
]
// KERNEL-449: setup is done, and two of the copied files look like production. KERNEL-460: git can't push, because it
// isn't using gh's login. Both are warnings, so the room still opens.
const warnSteps: RoomSetupStep[] = [
  { id: 'clone', title: 'Clone cjjutba/client-c', detail: '~/Projects/client-c', state: 'ok', meta: '4s' },
  { id: 'worktrees', title: 'Create the worktree folder', detail: '~/kernel/worktrees/client-c', state: 'ok' },
  { id: 'install', title: 'Install dependencies', detail: 'pnpm install', state: 'ok', meta: '12s' },
  { id: 'copy', title: 'Copy local files', detail: '.env, .env.local, .env.production', state: 'warn', production: ['.env', '.env.production'] },
  { id: 'hooks', title: 'Install hooks', detail: '10 events to localhost:7420', state: 'ok' },
  { id: 'push', title: 'Git can\u2019t push to cjjutba/client-c', detail: 'gh is signed in as cjjutba, but git isn\u2019t using that login, so agents can\u2019t push yet.', state: 'warn', fix: { command: 'gh auth setup-git', action: 'recheck' } },
  { id: 'agents', title: 'Seat agents', detail: 'Kernel, Kai, Noor, Ivy, Theo from .claude/agents', state: 'ok' }
]

const shop: Room = { id: 'room-shop', name: 'Shop', kind: 'folder', path: '/Users/you/Projects/shop', defaultBranch: 'main', paused: false, createdAt: ago(MIN) }
const shopSteps: RoomSetupStep[] = [
  { id: 'clone', title: 'Use your folder', detail: '~/Projects/shop', state: 'ok' },
  { id: 'worktrees', title: 'Create the worktree folder', detail: '~/kernel/worktrees/shop', state: 'ok' },
  { id: 'install', title: 'Install dependencies', detail: 'pnpm install', state: 'ok', meta: '12s' },
  { id: 'copy', title: 'Copy local files', detail: '.env.local, .env.test', state: 'ok' },
  { id: 'hooks', title: 'Install hooks', detail: '10 events to localhost:7420', state: 'ok' },
  { id: 'agents', title: 'Seat agents', detail: 'Api, Architect, Web from .claude/agents, Kernel leads', state: 'ok', brought: 3 }
]
/** KERNEL-477: the code host read from the checkout, after its first step. A folder with no remote has no push step. */
const hostSteps = (first: RoomSetupStep, host: string, folder: string, o: { push: boolean }): RoomSetupStep[] => [
  first,
  { id: 'host', title: 'Code host', detail: host, state: 'ok' },
  { id: 'worktrees', title: 'Create the worktree folder', detail: `~/kernel/worktrees/${folder}`, state: 'ok' },
  ...setupSteps.filter((s) => s.id === 'install' || s.id === 'copy' || s.id === 'hooks' || s.id === 'agents' || (o.push && s.id === 'push'))
]

const clientC: Room = { id: 'room-client-c', name: 'Client C', desc: 'Booking dashboard for a dental clinic', kind: 'repo', repo: 'samrivera/client-c', path: '/Users/you/Projects/client-c', defaultBranch: 'main', paused: false, createdAt: ago(MIN) }
const repos = [
  ['client-c', true, 2 * HOUR], ['personal-site', false, DAY], ['habit-tracker', true, 3 * DAY], ['recipe-box', true, 7 * DAY], ['starter-kit', true, 14 * DAY], ['starter-kit-mobile', true, 21 * DAY]
].map(([name, priv, age]) => ({ fullName: `samrivera/${name}`, name: name as string, private: priv as boolean, updatedAt: ago(age as number) }))

/** Local time today or yesterday, so lists group rows under Today and Yesterday whatever day the shots run. */
const clock = (daysAgo: number, h: number, m: number) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.getTime() }

/** The three things waiting on the user in Client A (Inbox.png): two approvals and a PR ready to merge. */
const homeApprovals: Approval[] = [
  { id: 'ap-push', kind: 'tool', source: 'sdk', roomId: ids.roomA, workspaceId: ids.schema, agentId: 'noor', toolName: 'Bash', input: { command: 'pnpm drizzle-kit push' }, title: 'Run pnpm drizzle-kit push', detail: 'T-12 adds the invoices table. Kai is waiting on it to finish T-14.', status: 'pending', createdAt: ago(2 * MIN) },
  { id: 'ap-plan15', kind: 'plan', source: 'sdk', roomId: ids.roomA, agentId: 'kernel-lead', title: 'Plan for T-15', detail: '1. T-15a PDF renderer · Noor\n2. T-15b Export button · Kai', status: 'pending', createdAt: ago(6 * MIN) }
]
const note = (n: Partial<Notification> & Pick<Notification, 'id' | 'title' | 'sub' | 'createdAt'>): Notification => ({ kind: 'system', roomId: ids.roomA, needsYou: false, read: false, ...n })
const homeNotifications: Notification[] = [
  note({ id: 'n1', kind: 'approval', agentId: 'noor', approvalId: 'ap-push', title: 'Wants to run drizzle-kit push', sub: 'Permission · Client A', heading: 'Noor wants to run a command that changes the database', needsYou: true, createdAt: ago(2 * MIN) }),
  note({ id: 'n2', kind: 'approval', agentId: 'kernel-lead', approvalId: 'ap-plan15', title: 'Plan ready: Export invoices as PDF', sub: 'Plan review · Client A', heading: 'Kernel has a plan for you to review', needsYou: true, createdAt: ago(6 * MIN) }),
  note({ id: 'n3', kind: 'merge', agentId: 'theo', workspaceId: ids.invites, title: 'PR #41 is ready to merge', sub: 'Merge · Client A', heading: 'PR #41 is ready to merge', body: 'org-invites has passing checks and no open review comments.', needsYou: true, createdAt: ago(12 * MIN) }),
  note({ id: 'n4', kind: 'blocked', agentId: 'ivy', title: 'T-11 was blocked by a hook', sub: 'Check failed · Client A', heading: 'T-11 was blocked by a hook', body: 'The test-output hook stopped Ivy. She needs the run output attached.', createdAt: ago(18 * MIN) }),
  note({ id: 'n5', kind: 'finished', agentId: 'kai', workspaceId: ids.table, title: 'Finished T-14 invoice table', sub: 'Workspace ready · Client A', heading: 'Finished T-14 invoice table', body: 'Kai pushed the table, its states and the tests. Vitest and Playwright pass.', createdAt: ago(31 * MIN) }),
  note({ id: 'n6', kind: 'standup', agentId: 'kernel-lead', title: 'Daily standup', sub: 'Summary · Client A', heading: 'Daily standup', body: 'T-11 passed, T-12 and T-14 are in progress, T-09 waits on your merge.', read: true, createdAt: ago(9 * HOUR) }),
  note({ id: 'n7', title: 'Hooks reconnected', sub: 'System', roomId: undefined, heading: 'Hooks reconnected', body: 'Kernel is listening on localhost:7420 again.', read: true, createdAt: ago(11 * HOUR) })
]
/** Four rooms (A needs you), five merged PRs, three things waiting. */
const homeScene = (f: Fixture): Partial<Fixture> => {
  const merged = (id: string, roomId: string, agentId: string, title: string, added: number, removed: number, at: number) =>
    ({ id, roomId, name: id, title, prTitle: title, branch: `feat/${id}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/${id}`, mode: 'worktree' as const, agentId, port: 4400, status: 'archived' as const, prState: 'merged' as const, prNumber: 30, stat: { files: 3, added, removed }, createdAt: at - HOUR, mergedAt: at })
  const crew = (...names: string[]): AgentDef[] => names.map((n) => team.find((a) => a.id === n)!)
  return {
    ...roomsScene(f),
    rooms: roomsScene(f).rooms!.filter((r) => !r.archived),
    approvals: homeApprovals,
    notifications: homeNotifications,
    agents: { [ids.roomA]: team, [ids.roomB]: crew('kernel-lead', 'kai'), [ids.roomOwn]: crew('kernel-lead', 'kai', 'ivy'), [ids.roomPortfolio]: crew('kernel-lead', 'kai') },
    status: {
      [ids.roomA]: { 'kernel-lead': 'idle', kai: 'working', noor: 'working', theo: 'idle', ivy: 'idle' },
      [ids.roomB]: { 'kernel-lead': 'working', kai: 'working' },
      [ids.roomOwn]: { 'kernel-lead': 'working', kai: 'working', ivy: 'working' },
      [ids.roomPortfolio]: { 'kernel-lead': 'idle', kai: 'idle' }
    },
    workspaces: [
      ...f.workspaces,
      merged('ws-m1', ids.roomA, 'kai', 'feat(invoices): table and empty states', 412, 38, clock(0, 10, 31)),
      merged('ws-m2', ids.roomA, 'noor', 'fix(auth): invite links expire after 7 days', 26, 9, clock(0, 9, 58)),
      merged('ws-m3', ids.roomOwn, 'kai', 'chore(db): seed realistic data', 188, 4, clock(0, 9, 12)),
      merged('ws-m4', ids.roomPortfolio, 'kai', 'Landing page polish', 926, 383, clock(1, 18, 40)),
      merged('ws-m5', ids.roomB, 'kernel-lead', 'docs: onboarding questions', 18, 11, clock(1, 16, 5))
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
      archived('ws-h6', 'pricing-experiment', 'spike/pricing-experiment', ids.roomOwn, 'kernel-lead', { n: 7, state: 'closed' }, clock(4, 16, 4))
    ].map((w) => (w.id === ids.table ? { ...w, stat: { files: 4, added: 412, removed: 38 } } : w))
  }
}

/** Six agents in Client A with the canvas's models, states and workspaces. Kai's recent work is four tasks. */
const teamScene = (f: Fixture): Partial<Fixture> => {
  const A = ids.roomA
  const who = (id: string, name: string, role: string, model: string, description: string, o: Partial<AgentDef> = {}): AgentDef =>
    ({ ...agent(id, name, role, model, !!o.lead), description, effort: 'high', prompt: `You are ${name}, the ${role.toLowerCase()} in this room. ${description} Work in your own worktree and tell Kernel when you finish.`, ...o })
  const crew: AgentDef[] = [
    who('kernel-lead', 'Kernel', 'Lead', 'opus', 'Plans, splits tasks, hands them out. Never edits code.', { lead: true, tools: ['Read', 'Grep', 'Glob'], skills: ['/plan'] }),
    who('kai', 'Kai', 'Frontend', 'sonnet', 'UI work. Follows DESIGN.md.', {
      tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], skills: ['/feature', '/verify', '/image'],
      prompt: 'You are Kai, the frontend engineer in this room. Build the screens in the plan exactly as the PNGs show them.\n\nFollow DESIGN.md: tokens only, no hex values, hairlines instead of shadows.\nOpen the compare image after every change and fix what a person would notice.\nAdd a Playwright test for each state before you ask for review.'
    }),
    who('noor', 'Noor', 'Backend', 'sonnet', 'Schema, API and migrations.', { tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'] }),
    who('ivy', 'Ivy', 'QA', 'sonnet', 'Runs tests and attaches the output.', { tools: ['Read', 'Bash', 'Grep', 'Glob'], skills: ['/verify'] }),
    who('theo', 'Theo', 'Reviewer', 'opus', 'Types at boundaries, security, tenant isolation.', { tools: ['Read', 'Grep', 'Glob'] }),
    who('wren', 'Wren', 'Designer', 'sonnet', 'Checks every screen against DESIGN.md.', { tools: ['Read', 'Grep', 'Glob', 'Bash'], joinedAt: Date.now() - 2 * HOUR })
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
    agents: { [A]: crew, [ids.roomB]: crew.slice(0, 1), [ids.roomOwn]: crew.filter((a) => ['kernel-lead', 'kai', 'ivy'].includes(a.id)), [ids.roomPortfolio]: crew.slice(0, 1) },
    status: { [A]: { 'kernel-lead': 'idle', kai: 'working', noor: 'needs', ivy: 'working', theo: 'idle', wren: 'idle' } },
    workspaces, skills,
    // The other rooms only seat some of the crew, so a question from someone who is not there comes from Kernel.
    approvals: f.approvals.map((a) => (a.roomId === ids.roomB || a.roomId === ids.roomPortfolio ? { ...a, agentId: 'kernel-lead' } : a)),
    tasks: { [A]: [
      task('T-15b', 'Download PDF button', 'build', 'kai', 'ws-pdf-button', 10, 41), task('T-14', 'Invoice table', 'done', 'kai', 'ws-t14', 9, 40),
      task('T-09', 'Org settings page', 'done', 'kai', 'ws-t09', 9, 10), task('T-06', 'Sign-in screens', 'done', 'kai', 'ws-t06', 8, 40)
    ] }
  }
}

/**
 * A repo that brought its own agents and has no Lead or reviewer, so Kernel's own Kernel and Theo fill in (KERNEL-397).
 * Architect's tools can't open a PR, so it is a helper. RoomSetupTeam.png and SettingsTeam.
 */
const ownCrew: AgentDef[] = [
  {
    id: 'kernel-lead', name: 'Kernel', role: 'Lead', builtIn: 'lead', lead: true, reviewer: false, member: false, file: '',
    description: 'Lead. Plans features, gets your approval, and hands each task to the right teammate in its own workspace.',
    prompt: 'You are Kernel, the lead of this room\'s team in Kernel.\n- While the chat is in plan mode: plan first, then call request_plan_approval with the full plan as markdown in plan (context, approach, files, checks) and one line per task in steps.\n- With plan mode off, don\'t ask for plan approval. Answer in the chat, suggest what you would hand off and to whom, and ask before calling create_workspace.\n- Give every create_workspace a complete brief: goal, files, acceptance criteria.\n- Use list_agents to see who is on the team.\n- If the team lacks a skill, propose a new teammate with hire_agent.'
  },
  { id: 'api', name: 'Api', role: 'Backend', description: 'Backend engineer. Builds the API.', lead: false, reviewer: false, member: true, prompt: 'You build the API.', file: '.claude/agents/api.md' },
  {
    id: 'architect', name: 'Architect', role: 'Architect', description: 'Designs the system. Writes no code.', model: 'opus', tools: ['Read', 'Grep', 'Glob'],
    lead: false, reviewer: false, member: false, warnings: [{ kind: 'cant-open-pr' }], prompt: 'You design.', file: '.claude/agents/architect.md'
  },
  {
    id: 'kernel-reviewer', name: 'Theo', role: 'Reviewer', builtIn: 'reviewer', lead: false, reviewer: true, member: false, file: '', tools: ['Read', 'Grep', 'Glob', 'Bash'],
    description: 'Reviewer. Reviews diffs for correctness, security and maintainability before merge. Read-only.', prompt: 'You are Theo, the reviewer.'
  },
  { id: 'web', name: 'Web', role: 'Frontend', description: 'Frontend engineer.', lead: false, reviewer: false, member: true, prompt: 'You build the UI.', file: '.claude/agents/web.md' }
]

/** Client A with `ownCrew` in place of Kernel's starter team. Its workspaces and questions go to whoever does the same job. */
const ownTeamScene = (f: Fixture): Partial<Fixture> => {
  const A = ids.roomA
  const t = teamScene(f)
  const swap: Record<string, string> = { kai: 'web', noor: 'api', ivy: 'web', theo: 'kernel-reviewer', wren: 'web' }
  const mapped = <T extends { roomId?: string; agentId?: string }>(x: T): T => (x.roomId === A && x.agentId && swap[x.agentId] ? { ...x, agentId: swap[x.agentId] } : x)
  return {
    ...t,
    agents: { ...t.agents, [A]: ownCrew },
    workspaces: t.workspaces!.map(mapped),
    approvals: t.approvals!.map(mapped),
    tasks: { [A]: [] },
    status: { [A]: { 'kernel-lead': 'idle', api: 'working', architect: 'idle', 'kernel-reviewer': 'idle', web: 'working' } }
  }
}

/** The team as it is before Wren is hired, behind the New agent modal. */
const beforeWren = (f: Fixture): Partial<Fixture> => {
  const t = teamScene(f)
  const { wren: _, ...status } = t.status![ids.roomA]
  return { ...t, agents: { ...t.agents, [ids.roomA]: t.agents![ids.roomA].filter((a) => a.id !== 'wren') }, status: { [ids.roomA]: status } }
}

const wrenDraft: AgentDraft = {
  id: 'wren', name: 'Wren', model: 'sonnet', tools: ['Read', 'Grep', 'Glob', 'Bash(pnpm screenshot:*)'], file: '.claude/agents/wren.md',
  description: 'A designer who checks every screen against DESIGN.md before review.',
  text: '---\nname: wren\ndescription: A designer who checks every screen against DESIGN.md before review.\nmodel: sonnet\ntools: Read, Grep, Glob, Bash(pnpm screenshot:*)\n---\nYou are Wren. Before Theo reviews a PR, open each changed screen, compare it with DESIGN.md, and list drift in spacing, type and color with file and line.\n'
}
const wrenPrefill = { name: 'Wren', description: 'A designer who checks every screen against DESIGN.md before review.', model: 'sonnet' }

const home = { route: { name: 'inbox' } } as const

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
      { id: 'ap-lead-plan', kind: 'plan', source: 'sdk', roomId: ids.roomA, agentId: 'kernel-lead', workspaceId: ids.lead, chatId: 'chat-lead-ui', title: 'Plan for the sidebar review', detail: '1. Kai lists the chats\n2. Ivy checks the shots', status: 'pending', createdAt: at(10, 44) }
    ],
    push: [{ type: 'chat.running', chatId: 'chat-lead-inbox', running: true }],
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', bottom: 'run' }, tabs: { [ids.lead]: { tab: 'chat-lead-tools', files: [], diffs: [] } } }
  }
}

/**
 * SidebarChatFolded.png (KERNEL-207): Client A on Inbox, with three Lead chats, the way `grouped` builds them. The first waits on a plan, the second is running and
 * folded over two workspaces, one of which asks to run a command, so its row shows the needs-you icon and its spinner. org-invites has no chat, and its row
 * reads its task title (KERNEL-587).
 */
const sidebarChatFolded = (f: Fixture): Partial<Fixture> => {
  const home = homeScene(f)
  const sent: Record<string, number> = { 't-export': at(10, 30), 't-table': at(10, 20), 't-login': at(10, 10) }
  const g = grouped(f, {
    threads: (t) => t.filter((x) => x.id in sent).map((x) => ({ ...x, lastSentAt: sent[x.id] })),
    chats: (c) => c.filter((x) => !x.threadId || x.threadId in sent)
  })
  return {
    ...home,
    threads: g.threads, chats: g.chats,
    // The export chat started nothing here. The merged workspaces stay.
    workspaces: [...g.workspaces!.filter((w) => !w.id.startsWith('ws-pdf')), ...home.workspaces!.filter((w) => w.id.startsWith('ws-m'))].map((w) => (w.id === ids.invites ? { ...w, title: 'Invite people to an org' } : w)),
    prs: {},
    approvals: home.approvals!.map((a) => (a.id === 'ap-plan15' ? { ...a, workspaceId: ids.lead, chatId: ids.leadChat } : a)),
    push: [{ type: 'chat.running', chatId: 'chat-table', running: true }],
    ui: { route: { name: 'inbox' }, foldedChats: ['t-table'] }
  }
}

/**
 * SidebarChatGroups.png (KERNEL-600, KERNEL-601): the room Kernel at rest, with five Lead chats in the order the sidebar lists them. The first is running and started
 * nothing. The second is unread and started one running workspace. The third waits on a plan, and is folded over the two ready PRs the right panel lists, so they stay out
 * of the sidebar as the PNG leaves them out. The fourth started five workspaces, one running. The fifth is on screen and started three, two of them running and unread.
 * The last two workspaces have diff counts, which show from 300px of sidebar and not in the PNG. The other rooms are hidden, and two approvals in them with the plan make the 3 on Inbox.
 */
const sidebarChatGroups = (f: Fixture): Partial<Fixture> => {
  const A = ids.roomA
  const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  type Row = { title: string; run?: boolean; unread?: boolean; stat?: [number, number] }
  const CHATS: (Row & { key: string; plan?: boolean; ws?: Row[] })[] = [
    { key: 'jitter', title: 'Chat archive screen jitter', run: true },
    { key: 'popup', title: 'Popup closure in composer menus', unread: true, ws: [{ title: 'Limit banners: close control and retry', run: true }] },
    { key: 'changed', title: 'Changed indicator not clearing after commit', plan: true },
    { key: 'multi', title: 'Multi-account switching when a limit hits', ws: [
      { title: 'Accounts sign-in and the picker', run: true }, { title: 'Switch accounts at a limit, keep the chat going' }, { title: 'One-button Add account, no terminal' },
      { title: 'Auto-switch toggle, a warning on switch' }, { title: 'End-to-end check of seamless account switching' }] },
    { key: 'review', title: 'Kernel review pipeline rollout', ws: [
      { title: 'End-to-end check of the review pipeline' }, { title: 'Land KERNEL-557 review states', run: true, unread: true, stat: [48, 6] }, { title: 'Reviews page: required and optional reviews', run: true, unread: true, stat: [212, 34] }] }
  ]
  const model = { model: 'claude-opus-5-5' as const, effort: 'high' as const, plan: false }
  const threads: Thread[] = CHATS.map((c, i) => ({ id: `t-${c.key}`, roomId: A, title: c.title, createdAt: at(10, 50 - i * 10) }))
  const workspaces: Workspace[] = []
  const chats: Chat[] = []
  const running: string[] = []
  CHATS.forEach((c, i) => {
    const own: Workspace = {
      id: `ws-chat-${c.key}`, roomId: A, name: slug(c.title), branch: `kernel/${slug(c.title)}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/kernel/kernel-${slug(c.title)}`, mode: 'worktree',
      agentId: 'kernel-lead', lead: true, threadId: `t-${c.key}`, port: 4300 + i * 10, status: 'ready', prState: 'none', createdAt: at(10, 50 - i * 10)
    }
    workspaces.push(own)
    chats.push({ id: `chat-${c.key}`, workspaceId: own.id, title: c.title, kind: 'chat', ...model, threadId: `t-${c.key}`, createdAt: own.createdAt, ...(c.unread ? { unreadAt: at(10, 45) } : {}) })
    if (c.run) running.push(`chat-${c.key}`)
    c.ws?.forEach((w, j) => {
      const id = `ws-${c.key}-${j}`
      workspaces.push({
        id, roomId: A, name: slug(w.title), branch: `feat/${slug(w.title)}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/kernel/${slug(w.title)}`, mode: 'worktree',
        agentId: 'kai', port: 4400 + workspaces.length, status: 'ready', prState: 'none', createdAt: at(10, 51 - i * 10 + j), title: w.title, threadId: `t-${c.key}`,
        ...(w.stat ? { stat: { files: 3, added: w.stat[0], removed: w.stat[1] } } : {})
      })
      chats.push({ id: `chat-${id}`, workspaceId: id, title: w.title, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: at(10, 51 - i * 10 + j), ...(w.unread ? { unreadAt: at(10, 45) } : {}) })
      if (w.run) running.push(`chat-${id}`)
    })
  })
  // The two ready PRs sit on workspaces of the folded chat, which the sidebar doesn't draw.
  const pr = (key: string, agentId: string, n: number, issue: string, title: string, stat: [number, number]) => {
    const id = `ws-pr-${n}`
    const prTitle = `feat(workspace): ${title.charAt(0).toLowerCase()}${title.slice(1)} (${issue})`
    workspaces.push({
      id, roomId: A, name: `${issue.toLowerCase()}-${key}`, branch: `feat/${issue.toLowerCase()}-${key}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/kernel/${issue.toLowerCase()}-${key}`, mode: 'worktree',
      agentId, port: 4500 + n % 50, status: 'ready', createdAt: at(10, 12), threadId: 't-changed', title, source: { kind: 'issue', id: issue, title }, prState: 'ready', prNumber: n,
      prUrl: `https://github.com/cjjutba/kernel/pull/${n}`, prTitle, prHead: `h${n}`, stat: { files: 3, added: stat[0], removed: stat[1] },
      reviews: [{ workspaceId: `${id}-review`, agentId: 'theo', verdict: 'approved', summary: 'No blockers.', sha: `h${n}`, prNumber: n, ts: at(10, 30) }]
    })
    chats.push({ id: `chat-${id}`, workspaceId: id, title, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: at(10, 12) })
    const info: PrInfo = { workspaceId: id, number: n, url: `https://github.com/cjjutba/kernel/pull/${n}`, title: prTitle, state: 'ready', baseRef: 'main', comments: [], conflicts: [], head: `h${n}`, checks: [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'pass', meta: '48s' }] }
    return [id, info] as const
  }
  const prs: Record<string, PrInfo> = Object.fromEntries([
    pr('review-states', 'kai', 524, 'KERNEL-557', 'Reviews page and the review states', [110, 10]),
    pr('room-setup', 'ivy', 522, 'KERNEL-590', 'Room setup says No reviewer when review is off', [23, 4])
  ])
  const open = { ws: 'ws-chat-review', tab: 'chat-review' }
  const items: ChatItem[] = [
    { kind: 'user', id: 'cg-u', ts: at(10, 41), parts: [{ type: 'text', text: 'Roll out the review pipeline. Check it end to end once the review states land.' }] },
    { kind: 'thinking', id: 'cg-th', ts: at(10, 42), text: 'Two workspaces are running. The end-to-end check needs both.' },
    { kind: 'tool', id: 'cg-tool', ts: at(10, 42), toolUseId: 'toolu_cg', name: 'Bash', label: "List this chat's workspaces", detail: 'kernel workspaces', status: 'done', durationMs: 100 },
    { kind: 'text', id: 'cg-tx', ts: at(10, 42), text: 'Land KERNEL-557 review states and Reviews page are both running. The end-to-end check of the review pipeline starts when they open pull requests.' },
    { kind: 'result', id: 'cg-r', ts: at(10, 42), durationMs: 7000, ok: true }
  ]
  const plan: Approval = { id: 'ap-plan-changed', kind: 'plan', source: 'sdk', roomId: A, agentId: 'kernel-lead', workspaceId: 'ws-chat-changed', chatId: 'chat-changed', title: 'Plan for the changed indicator', detail: '1. Find where the indicator reads\n2. Clear it on commit', status: 'pending', createdAt: at(10, 44) }
  return {
    rooms: f.rooms.map((r) => (r.id === A ? { ...r, name: 'Kernel' } : { ...r, hidden: true })),
    threads, workspaces, chats, prs,
    items: { [open.tab]: items },
    approvals: [...f.approvals.slice(0, 2), plan],
    activity: [], changes: {}, diffs: {}, tree: {}, fileText: {},
    push: running.map((chatId): PushEvent => ({ type: 'chat.running', chatId, running: true })),
    ui: {
      route: { name: 'workspace', workspaceId: open.ws }, foldedChats: ['t-changed'],
      workspace: { right: 'changes', leadRight: 'prs', bottom: 'run' },
      tabs: { [open.ws]: { tab: open.tab, lastChat: open.tab, files: [], diffs: [] } }
    }
  }
}

/**
 * SidebarTrustHeld (no PNG, KERNEL-342): Client A on Inbox with no approvals. invoice-table is held in `trust` and invoice-schema is idle beside it,
 * and a folded chat hides org-invites, which is held too, so the chat row shows the same icon. invoice-table's row reads its task title and
 * invoice-schema has none, so its row falls back to the slug (KERNEL-587).
 */
const sidebarTrustHeld = (f: Fixture): Partial<Fixture> => {
  const home = homeScene(f)
  const owner = 'chat-lead-invites'
  const held = new Set<string>([ids.table, ids.invites])
  return {
    ...home,
    chats: [...f.chats.filter((c) => c.workspaceId !== ids.lead), leadChatRow(owner, 'Org invites and roles', 5), leadChatRow('chat-lead-spare', 'Client portal login', 6)],
    workspaces: home.workspaces!.map((w) => ({
      ...w,
      ...(held.has(w.id) ? { status: 'trust' as const } : {}),
      ...(w.id === ids.invites ? { leadChatId: owner } : {}),
      ...(w.id === ids.table ? { title: 'Build the invoice table' } : {}),
      ...(w.id === ids.schema || w.id === ids.table ? { prState: 'none' as const } : {})
    })),
    approvals: [],
    notifications: [],
    push: [],
    ui: { route: { name: 'inbox' }, foldedChats: [owner] }
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
      comments: [comment('c31a', 'Maya Chen', 'Billing asked for this twice this week. One page per invoice is fine, no custom templates yet.', 3 * DAY), comment('c31b', 'CJ Jutba', 'Use the on-screen design as the layout. Kernel can split it once we agree on the scope.', DAY)]
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
  { id: 'linear', name: 'Linear', connected: true, detail: 'Token saved. Create workspaces from issues' }
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

/** IssuesGitHub.png: Client B's open issues. Nine, three of them CJ's, so the pills read Mine 3 and All 9. Times are relative. */
const githubIssues = (): GithubIssueDetail[] => {
  const gh = (n: number, title: string, labels: string[], assignees: string[], age: number, extra: Partial<GithubIssueDetail> = {}): GithubIssueDetail => ({
    number: n, id: `#${n}`, title, url: `https://github.com/cjjutba/client-b/issues/${n}`, labels, assignees, author: 'maya-chen', updatedAt: new Date(Date.now() - age).toISOString(),
    mine: assignees.includes('cjjutba'), body: '', comments: [], ...extra
  })
  return [
    gh(24, 'Invoice table with sorting and empty states', ['feature', 'frontend'], ['cjjutba'], 5 * HOUR, { milestone: 'Invoices v1' }),
    gh(27, 'Rate limit the invite endpoint', ['security', 'backend'], ['maya-chen'], DAY),
    gh(31, 'Export invoices as PDF', ['feature', 'billing'], ['cjjutba'], 2 * DAY, {
      milestone: 'Invoices v1',
      body: 'Clients want a PDF copy of any invoice they can send to their accountant.\n\n## Acceptance criteria\n\n- A Download PDF action on every invoice row\n- The PDF matches the on-screen layout, on one page\n- Fonts are embedded, so it looks the same on every device',
      comments: [comment('c31a', 'maya-chen', 'Billing asked for this twice this week. One page per invoice is fine, no custom templates yet.', 3 * DAY), comment('c31b', 'cjjutba', 'Use the on-screen design as the layout. Kernel can split it once we agree on the scope.', DAY)]
    }),
    gh(33, 'Send a reminder for overdue invoices', ['feature', 'billing'], [], 3 * DAY),
    gh(35, 'Show the invoice total in the page title', ['bug'], ['kai-okoye'], 4 * DAY),
    gh(36, 'Invoice emails send twice', ['bug', 'billing'], ['maya-chen'], 4 * DAY + 2 * HOUR),
    gh(40, 'Dark mode for the invoice PDF', ['enhancement'], [], 7 * DAY),
    gh(42, 'Import clients from a CSV file', ['feature', 'accounts'], [], 7 * DAY + 3 * HOUR),
    gh(44, 'Add a tax breakdown to invoices', ['billing', 'feature', 'tax'], ['cjjutba'], 14 * DAY, { milestone: 'Invoices v2' })
  ]
}

/** Client B reads GitHub Issues and Portfolio has no tracker. The other rooms read Linear, as every fixture before KERNEL-438 drew them. */
const trackerRooms = { trackers: { [ids.roomB]: { kind: 'github' as const, where: 'cjjutba/client-b' }, [ids.roomPortfolio]: { kind: 'none' as const } } }

/** The Issues page on Client B (GitHub) or Portfolio (no tracker). */
const issuesTrackerScene = (f: Fixture, route: { issueId?: string; roomId: string }): Partial<Fixture> => ({
  ...homeScene(f), integrations: linearIntegrations, trackers: trackerRooms.trackers, githubIssues: { [ids.roomB]: githubIssues() },
  ui: { route: { name: 'issues', ...route } }
})

// ---------- Pull requests

/** The Pull requests page: seven open PRs across the four rooms, one of each state, and the five merged ones from `homeScene`. `open` and `merged` pick the filter, `none` leaves out every open PR. */
const prsScene = (f: Fixture, o: { filter: 'open' | 'merged'; none?: 'open' | 'merged'; failed?: boolean; manyMerged?: number }): Partial<Fixture> => {
  const home = homeScene(f)
  const mk = (n: number, roomId: string, agentId: string, title: string, state: Workspace['prState'], stat: [number, number], extra: Partial<Workspace> = {}, info: Partial<PrInfo> = {}) => {
    const id = `ws-prs-${n}`
    const w: Workspace = {
      id, roomId, name: `pr-${n}`, branch: `feat/pr-${n}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/pr-${n}`, mode: 'worktree', agentId, port: 4600 + n,
      status: 'ready', createdAt: at(10, 12), title, prTitle: title, prState: state, prNumber: n, prUrl: `https://github.com/cjjutba/pr/pull/${n}`, prHead: `h${n}`, stat: { files: 3, added: stat[0], removed: stat[1] }, ...extra
    }
    const pr: PrInfo = { workspaceId: id, number: n, url: w.prUrl!, title, state, baseRef: 'main', comments: [], conflicts: [], head: `h${n}`, checks: [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'pass', meta: '48s' }], ...info }
    return [w, pr] as const
  }
  const approved = (n: number) => ({ reviews: [{ workspaceId: `ws-prs-${n}-review`, agentId: 'theo', verdict: 'approved' as const, summary: 'No blockers.', sha: `h${n}`, prNumber: n, ts: at(10, 30) }] })
  const rows = [
    mk(61, ids.roomA, 'kai', 'feat(invoices): PDF export for a single invoice', 'ready', [212, 18], approved(61), { reviewDecision: 'approved' }),
    mk(58, ids.roomB, 'kai', 'fix(portal): keep the session after a refresh', 'ready', [34, 6], approved(58)),
    mk(60, ids.roomA, 'noor', 'feat(billing): proration for mid-cycle upgrades', 'cifail', [305, 41], {}, { checks: [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'fail', meta: '51s' }] }),
    mk(57, ids.roomOwn, 'ivy', 'test(auth): cover the invite expiry', 'changes', [96, 3], {}, { reviewDecision: 'changes' }),
    mk(55, ids.roomPortfolio, 'kai', 'Landing page: new case study layout', 'conflict', [188, 77], {}, { conflicts: ['src/pages/index.tsx', 'src/styles/home.css'] }),
    mk(62, ids.roomA, 'kai', 'refactor(table): share the sort hook', 'checks', [64, 52], {}, { checks: [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'running' }] }),
    mk(59, ids.roomOwn, 'kai', 'chore(db): index invoice lookups', 'draft', [12, 0], {}, { checks: [] })
  ]
  const none = o.none === 'open'
  const minutes = (n: number) => Date.now() - n * 60_000
  const reads = Object.fromEntries([ids.roomA, ids.roomB, ids.roomPortfolio].map((id, i) => [id, o.failed ? { at: minutes(14 + i), failed: 'rate-limited' as const } : { at: minutes(2 + i) }]))
  const more = Array.from({ length: o.manyMerged ?? 0 }, (_, i): Workspace => {
    const n = 100 + i
    return { id: `ws-prs-m${n}`, roomId: ids.roomA, name: `merged-${n}`, branch: `feat/merged-${n}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/merged-${n}`, mode: 'worktree', agentId: 'kai', port: 4700 + i, status: 'archived', createdAt: at(8, 0) - i * 3_600_000, mergedAt: at(8, 30) - i * 3_600_000, title: `chore: change ${n}`, prTitle: `chore: change ${n}`, prState: 'merged', prNumber: n, prUrl: `https://github.com/cjjutba/pr/pull/${n}`, stat: { files: 2, added: 20 + i, removed: i } }
  })
  return {
    ...home,
    github: { reads },
    // The base workspaces keep their own PRs in the list, except where the page is to be empty.
    workspaces: [
      ...home.workspaces!.map((w, i) => (w.prState === 'merged' ? { ...w, prNumber: 56 - i } : none && w.prNumber ? { ...w, prState: 'none' as const } : w)),
      ...(none ? [] : rows.map(([w]) => w)),
      ...more
    ].filter((w) => o.none !== 'merged' || w.prState !== 'merged'),
    prs: Object.fromEntries(rows.map(([w, pr]) => [w.id, pr])),
    ui: { route: { name: 'prs', filter: o.filter } }
  }
}

/** The New chat the issue check held back in ConfirmIssueTaken (KERNEL-500). */
const invoicePdfPrompt = 'KERNEL-31: Export invoices as PDF'
const invoicePdfChat: HeldChat = {
  roomId: ids.roomA, source: { kind: 'issue', id: 'KERNEL-31', title: 'Export invoices as PDF' }, parts: [{ type: 'text', text: invoicePdfPrompt }],
  picks: { mode: 'worktree', model: 'claude-opus-5-5', effort: 'high', plan: false, baseRef: '' }
}

/** Room setup done in a repo that brought its own agents (RoomSetupTeam.png). `team` is the repo's `[team]` table, if it has one. */
const roomSetupTeam = (f: Fixture, team?: TeamConfig): Partial<Fixture> => {
  const r = roomsScene(f)
  return {
    ...r,
    rooms: [...f.rooms, shop],
    agents: { ...(r.agents ?? f.agents), [shop.id]: ownCrew.filter((a) => a.id !== 'kernel-reviewer') },
    ...(team ? { roomSettings: { ...f.roomSettings, [shop.id]: { scripts: {}, files: { copy: ['.env', '.env.local'] }, workspace: {}, team } } } : {}),
    push: [{ type: 'room.setup', roomId: shop.id, steps: shopSteps }],
    ui: { route: { name: 'onboarding', step: 'room', roomId: shop.id } }
  }
}

/** Audit states (docs/audits/ux-team.md): a Linear list far past a screenful, with titles that wrap. */
const manyIssues = (): LinearIssueDetail[] => {
  const base = linearIssues()
  return Array.from({ length: 120 }, (_, i) => {
    const b = base[i % base.length]
    return { ...b, id: `KERNEL-${200 + i}`, identifier: `KERNEL-${200 + i}`, title: i % 7 === 0 ? `${b.title}, including every edge case the billing team listed in the long planning thread from last quarter` : b.title }
  })
}

/** Setup that stopped on its install step. */
const failedSteps: RoomSetupStep[] = setupSteps.map((s) => (s.id === 'install' ? { ...s, state: 'fail' as const, meta: '38s', error: 'pnpm install exited with code 1' } : s.id === 'clone' || s.id === 'worktrees' ? s : { ...s, state: 'wait' as const }))

export const teamFixtures: Record<string, Fixture> = {
  // KERNEL-253: Client B has its GitHub avatar, in grayscale, in the sidebar and on its card in the Rooms list.
  SidebarRoomIcon: scene((f) => {
    const home = homeScene(f)
    return {
      ...home,
      rooms: home.rooms!.map((r) => (r.id === ids.roomB ? { ...r, icon: { kind: 'github' as const, file: `${ids.roomB}-1.png`, at: at(9, 0) } } : r)),
      roomIcons: { [ids.roomB]: invaderIcon },
      ui: { route: { name: 'inbox' } }
    }
  }),
  CommandPalette: scene((f) => ({ ...homeScene(f), ui: { route: { name: 'workspace', workspaceId: ids.table }, modal: { name: 'search' } } })),
  // KERNEL-339: the palette in Kernel's chat. It lists the room's open chats with their tab counts, and New tab adds a tab to this one.
  GroupedPalette: scene((f) => { const g = grouped(f); return { ...g, ui: { ...g.ui!, modal: { name: 'search' } } } }),
  // KERNEL-307: the palette in Noor's workspace, with the four files she shared in it. Kai's file is in another workspace, so it only turns up by typing.
  SearchShared: scene((f) => ({ ...homeScene(f), shared: sharedFiles().filter((x) => x.workspaceId === ids.table), sharedData: sharedStills, ui: { route: { name: 'workspace', workspaceId: ids.table }, modal: { name: 'search' } } })),
  // No PNG: Lead chat 3, then Settings and back, then another workspace and back (KERNEL-199). The test opens it in Electron.
  NavMemory: scene(navMemory),
  History: scene((f) => ({ ...historyScene(f), ui: { route: { name: 'history' } } })),
  // No PNG (KERNEL-871): the second row focused from the keyboard.
  HistoryRowFocused: scene((f) => ({ ...historyScene(f), ui: { route: { name: 'history' } } })),
  // Audit (docs/audits/ux-team.md): nothing archived yet.
  HistoryEmpty: scene((f) => ({ ...roomsScene(f), ui: { route: { name: 'history' } } })),
  // Archived in a room's menu: History for Client A alone.
  HistoryRoom: scene((f) => ({ ...historyScene(f), ui: { route: { name: 'history', roomId: ids.roomA } } })),
  // Search with "archived" typed: the archived workspaces, which a pick restores and opens.
  SearchArchived: scene((f) => ({ ...historyScene(f), ui: { route: { name: 'inbox' }, modal: { name: 'search' } } })),
  // No PNG: Delete in History (KERNEL-333). The bulk confirm over every archived row, two branches with unpushed commits among them.
  HistoryConfirmDelete: scene((f) => {
    const h = historyScene(f)
    return { ...h, deletePreview: { workspaces: 6, skipped: [], unpushedBranches: 2, transcriptBytes: 640 * 1048576 }, ui: { route: { name: 'history' }, modal: { name: 'confirm', kind: 'deleteHistory', workspaceIds: h.workspaces!.filter((w) => w.status === 'archived').map((w) => w.id) } } }
  }),
  // No PNG: the same confirm from one row.
  // No PNG: the same confirm when the count fails (KERNEL-868). Delete stays off, and Try again counts once more.
  HistoryConfirmDeleteFailed: scene((f) => {
    const h = historyScene(f)
    return { ...h, fails: { 'workspaces.deletePreview': 'The database is busy.' }, ui: { route: { name: 'history' }, modal: { name: 'confirm', kind: 'deleteHistory', workspaceIds: h.workspaces!.filter((w) => w.status === 'archived').map((w) => w.id) } } }
  }),
  HistoryConfirmDeleteOne: scene((f) => ({ ...historyScene(f), deletePreview: { workspaces: 1, skipped: [], unpushedBranches: 1, transcriptBytes: 3_460_300 }, ui: { route: { name: 'history' }, modal: { name: 'confirm', kind: 'deleteHistory', workspaceIds: ['ws-h3'] } } })),
  NewAgent: scene((f) => ({ ...beforeWren(f), ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents' }, modal: { name: 'newAgent', roomId: ids.roomA, step: 'describe', prefill: { name: 'Wren', model: 'sonnet' } } } })),
  // No PNG: New agent from Settings, Agents with no room added. NewAgent.png without a room, so Kernel and the room's team are not named.
  NewAgentNoRoom: scene((f) => ({ ...f, ...empty, ui: { route: { name: 'settings', page: 'agents' }, modal: { name: 'newAgent', step: 'describe', prefill: { name: 'Wren', model: 'sonnet' } } } })),
  NewAgentDraft: scene((f) => ({ ...beforeWren(f), ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents' }, modal: { name: 'newAgent', roomId: ids.roomA, step: 'draft', prefill: { ...wrenPrefill, draft: wrenDraft } } } })),
  NewAgentDone: scene((f) => ({ ...beforeWren(f), ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents' }, modal: { name: 'newAgent', roomId: ids.roomA, step: 'done', prefill: { ...wrenPrefill, draft: wrenDraft } } } })),
  // KERNEL-642: a repo's own agents in Settings, Agents: Architect's warning on its row, New agent and Add a starter agent at the top of In this repo, and Retired with Restore.
  SettingsTeamOwnAgents: scene((f) => {
    const t = ownTeamScene(f)
    const retired: AgentDef = { id: 'scout', name: 'Scout', role: 'Research', description: 'Reads the repo and reports.', lead: false, reviewer: false, member: true, prompt: 'You research.', file: '.claude/retired-agents/scout.md', retired: true }
    return { ...t, agents: { ...t.agents, [ids.roomA]: [...t.agents![ids.roomA], retired] }, ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents' } } }
  }),
  ConfirmRetire: scene((f) => ({ ...teamScene(f), ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents', agentId: 'kai' }, modal: { name: 'confirm', kind: 'retire', roomId: ids.roomA, agentId: 'kai' } } })),
  // KERNEL-438: someone else may be on the issue. New chat opens it when the issue it starts from has findings (KERNEL-500).
  ConfirmIssueTaken: scene((f) => ({
    ...teamScene(f),
    ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents' }, modal: { name: 'confirm', kind: 'issueTaken', issue: 'KERNEL-31', findings: [{ kind: 'branch', ref: 'origin/feat/kernel-31-export-pdf' }, { kind: 'pr', number: 41, title: 'Export invoices as PDF' }, { kind: 'assignee', name: 'Maya Chen' }], held: invoicePdfChat } }
  })),
  UpdateReady: scene((f) => ({ ...homeScene(f), update: { status: 'ready', current: '0.1.0', version: '0.2.0' }, ui: home })),
  // The update pill stays in the footer while the sidebar is hidden (KERNEL-588).
  UpdateReadyNoSidebar: scene((f) => ({ ...homeScene(f), update: { status: 'ready', current: '0.1.0', version: '0.2.0' }, ui: { ...home, sidebar: false } })),
  Inbox: scene((f) => ({ ...homeScene(f), ui: { route: { name: 'inbox' } } })),
  InboxRowFocused: scene((f) => ({ ...homeScene(f), ui: { route: { name: 'inbox' } } })),
  InboxApprovalFold: { ...scene((f) => ({ ...homeScene(f), ui: { route: { name: 'inbox' } } })), motion: { action: { click: 'Approve' }, ms: 700, area: '.ib-body-wrap' } },
  // KERNEL-785: an MCP call's approval is titled as the chat's row says it, the newest row, so the detail pane opens on it.
  InboxMcp: scene((f) => {
    const home = homeScene(f)
    const input = { title: 'Export invoices as PDF', team: 'Kernel' }
    const { title } = describeTool('mcp__claude_ai_Linear__save_issue', input)
    const ap: Approval = { id: 'ap-linear', kind: 'tool', source: 'sdk', roomId: ids.roomA, workspaceId: ids.schema, agentId: 'noor', toolName: 'mcp__claude_ai_Linear__save_issue', input, title, status: 'pending', createdAt: ago(MIN) }
    const said = `${title.charAt(0).toLowerCase()}${title.slice(1)}`
    const n = note({ id: 'n-linear', kind: 'approval', agentId: 'noor', approvalId: ap.id, title: `Wants to ${said}`, sub: 'Permission · Client A', heading: `Noor wants to ${said}`, needsYou: true, createdAt: ap.createdAt })
    return { ...home, approvals: [ap, ...home.approvals!], notifications: [n, ...home.notifications!], ui: { route: { name: 'inbox' } } }
  }),
  InboxEmpty: scene((f) => ({ ...homeScene(f), approvals: [], notifications: [], ui: { route: { name: 'inbox' } } })),
  // Audit: 80 notifications, to see the list scroll and the detail pane keep its place.
  InboxMany: scene((f) => { const h = homeScene(f); return { ...h, notifications: Array.from({ length: 80 }, (_, i) => ({ ...h.notifications![i % h.notifications!.length], id: `n-many-${i}`, createdAt: ago((i + 1) * 20 * MIN) })), ui: { route: { name: 'inbox' } } } }),
  // No PNG: Settings, Appearance, Density set to Compact, which tightens the inbox rows too (KERNEL-538).
  InboxCompact: scene((f) => ({ ...homeScene(f), settings: { ...DEFAULT_SETTINGS('/Users/you'), appearance: { ...DEFAULT_SETTINGS('/Users/you').appearance, density: 'compact' } }, ui: { route: { name: 'inbox' } } })),
  // No PNG: two agents in the same file. The newest row, so the detail pane opens on it.
  InboxOverlap: scene((f) => ({
    ...homeScene(f),
    overlaps: [{
      id: 'ov-invoices', roomId: ids.roomA, path: 'src/app/invoices/invoices.ts', ts: Date.now(),
      parties: [{ agentId: 'kai', workspaceId: ids.table, lines: 'lines 20-34' }, { agentId: 'noor', workspaceId: ids.schema, lines: 'lines 18-40' }]
    }],
    ui: { route: { name: 'inbox' } }
  })),
  // No PNG (KERNEL-395): invoice-table is held for script trust beside the approvals, as the newest row, so the detail pane opens on it.
  InboxTrustHeld: scene((f) => {
    const home = homeScene(f)
    return { ...home, workspaces: home.workspaces!.map((w) => (w.id === ids.table ? { ...w, status: 'trust' as const, createdAt: Date.now() } : w)), ui: { route: { name: 'inbox' } } }
  }),
  Rooms: scene((f) => ({ ...roomsScene(f), ui: { route: { name: 'rooms' } } })),
  RoomsRowFocused: scene((f) => ({ ...roomsScene(f), ui: { route: { name: 'rooms' } } })),
  // Audit: no room added yet, and the Rooms page on its own.
  RoomsEmpty: scene((f) => ({ ...f, ...empty, ui: { route: { name: 'rooms' } } })),
  NewRoom: scene((f) => ({
    ...roomsScene(f),
    ui: { route: { name: 'rooms' }, modal: { name: 'newRoom', prefill: { source: 'repo', name: 'Client C', desc: 'Booking dashboard for a dental clinic', from: 'samrivera/client-c', baseBranch: 'main' } } }
  })),
  ConnectRepo: scene((f) => ({ ...roomsScene(f), repos, ui: { route: { name: 'inbox' }, modal: { name: 'connectRepo' } } })),
  // Audit: the repo list never answers, and the signed-in account has no repos.
  ConnectRepoLoading: scene((f) => ({ ...roomsScene(f), hold: ['github.repos'], ui: { route: { name: 'inbox' }, modal: { name: 'connectRepo' } } })),
  ConnectRepoEmpty: scene((f) => ({ ...roomsScene(f), repos: [], ui: { route: { name: 'inbox' }, modal: { name: 'connectRepo' } } })),
  // KERNEL-863: the repo list fails to load, and gh is signed out.
  ConnectRepoFailed: scene((f) => ({ ...roomsScene(f), fails: { 'github.repos': 'GitHubError[offline]: Could not reach GitHub.' }, ui: { route: { name: 'inbox' }, modal: { name: 'connectRepo' } } })),
  ConnectRepoSignedOut: scene((f) => ({
    ...roomsScene(f),
    preflight: f.preflight.map((c) => (c.id === 'gh' ? { ...c, ok: false, detail: 'Not signed in' } : c)),
    fails: { 'github.repos': 'GitHubError[signed-out]: You are not signed in to GitHub.' },
    ui: { route: { name: 'inbox' }, modal: { name: 'connectRepo' } }
  })),
  // Audit: the recent folders never answer, and there are none.
  OpenFolderLoading: scene((f) => ({ ...roomsScene(f), hold: ['rooms.recentFolders'], ui: { route: { name: 'inbox' }, modal: { name: 'openFolder' } } })),
  OpenFolderFailed: scene((f) => ({ ...roomsScene(f), fails: { 'rooms.recentFolders': 'Permission denied reading the folder list.' }, ui: { route: { name: 'inbox' }, modal: { name: 'openFolder' } } })),
  OpenFolderEmpty: scene((f) => ({ ...roomsScene(f), folders: [], ui: { route: { name: 'inbox' }, modal: { name: 'openFolder' } } })),
  OpenFolder: scene((f) => ({
    ...roomsScene(f),
    folders: [
      { path: '/Users/you/Projects/habit-tracker', git: true, branch: 'main', dirty: 0 },
      { path: '/Users/you/Projects/recipe-box', git: true, branch: 'dev', dirty: 3 },
      { path: '/Users/you/Projects/personal-site', git: true, branch: 'main', dirty: 0 },
      { path: '/Users/you/Desktop/sandbox', git: false }
    ],
    ui: { route: { name: 'inbox' }, modal: { name: 'openFolder' } }
  })),
  RoomSetup: scene((f) => ({
    ...roomsScene(f),
    rooms: [...f.rooms, clientC],
    push: [{ type: 'room.setup', roomId: clientC.id, steps: setupSteps }],
    ui: { route: { name: 'onboarding', step: 'room', roomId: clientC.id } }
  })),
  RoomSetupWarnings: scene((f) => ({
    ...roomsScene(f),
    rooms: [...f.rooms, clientC],
    push: [{ type: 'room.setup', roomId: clientC.id, steps: warnSteps }],
    ui: { route: { name: 'onboarding', step: 'room', roomId: clientC.id } }
  })),
  // Audit: the install step failed and the later steps never ran.
  RoomSetupFailed: scene((f) => ({
    ...roomsScene(f),
    rooms: [...f.rooms, clientC],
    push: [{ type: 'room.setup', roomId: clientC.id, steps: failedSteps }],
    ui: { route: { name: 'onboarding', step: 'room', roomId: clientC.id } }
  })),
  RoomSetupGitHub: scene((f) => ({
    ...roomsScene(f),
    rooms: [...f.rooms, { ...clientC, host: 'github' }],
    push: [{ type: 'room.setup', roomId: clientC.id, steps: hostSteps(setupSteps[0], 'GitHub, samrivera/client-c', 'client-c', { push: true }) }],
    ui: { route: { name: 'onboarding', step: 'room', roomId: clientC.id } }
  })),
  RoomSetupLocal: scene((f) => ({
    ...roomsScene(f),
    rooms: [...f.rooms, { ...shop, host: 'local' }],
    push: [{ type: 'room.setup', roomId: shop.id, steps: hostSteps(shopSteps[0], 'Local, no GitHub remote. Kernel merges branches on this Mac.', 'shop', { push: false }) }],
    ui: { route: { name: 'onboarding', step: 'room', roomId: shop.id } }
  })),
  // KERNEL-397: setup is done in a repo that brought its own agents, and shows the team to check before the room opens.
  // KERNEL-555: Kernel is the only built-in agent, so this team has no reviewer and the picker opens on Kernel's code review.
  RoomSetupTeam: scene((f) => roomSetupTeam(f)),
  // KERNEL-590: the repo's `[team] reviewer = "none"` turned review off, so the picker says No reviewer and no line claims a review.
  RoomSetupTeamNoReviewer: scene((f) => roomSetupTeam(f, { reviewer: 'none' })),
  Issues: scene((f) => issuesScene(f)),
  IssuesRowFocused: scene((f) => issuesScene(f)),
  // KERNEL-874: the Work page's header over each tab.
  WorkIssues: scene((f) => issuesScene(f)),
  // The Pull requests page: open PRs across the rooms, the merged ones, and each empty.
  PullRequests: scene((f) => prsScene(f, { filter: 'open' })),
  PullRequestsRowFocused: scene((f) => prsScene(f, { filter: 'open' })),
  WorkPullRequests: scene((f) => prsScene(f, { filter: 'open' })),
  PullRequestsMerged: scene((f) => prsScene(f, { filter: 'merged' })),
  // No PNG (KERNEL-868): the last status read failed on a rate limit, with the read from before it kept. The cap note shows past 50 merged.
  PullRequestsReadFailed: scene((f) => prsScene(f, { filter: 'open', failed: true })),
  PullRequestsMergedCapped: scene((f) => prsScene(f, { filter: 'merged', manyMerged: 48 })),
  PullRequestsEmpty: scene((f) => prsScene(f, { filter: 'open', none: 'open' })),
  PullRequestsNoMerged: scene((f) => prsScene(f, { filter: 'merged', none: 'merged' })),
  // KERNEL-759: the tracker read never answers, so the page shows Loading issues with the load loader.
  IssuesLoading: scene((f) => ({ ...issuesScene(f), hold: ['issues.tracker'] })),
  // Audit: the list is there and the opened issue never answers; 120 issues with long titles; and the same two for GitHub.
  IssuesDetailLoading: scene((f) => ({ ...issuesScene(f), hold: ['linear.issue'] })),
  IssuesMany: scene((f) => issuesScene(f, { issueId: 'KERNEL-200', issues: manyIssues() })),
  IssuesGitHubLoading: scene((f) => ({ ...issuesTrackerScene(f, { roomId: ids.roomB }), hold: ['github.issueList'] })),
  IssuesGitHubEmpty: scene((f) => ({ ...issuesTrackerScene(f, { roomId: ids.roomB }), githubIssues: { [ids.roomB]: [] } })),
  IssuesGitHubOffline: scene((f) => ({ ...issuesTrackerScene(f, { roomId: ids.roomB }), push: [{ type: 'online', online: false }] })),
  IssuesGitHubDetailLoading: scene((f) => ({ ...issuesTrackerScene(f, { issueId: '#31', roomId: ids.roomB }), hold: ['github.issue'] })),
  IssuesRejected: scene((f) => ({ ...issuesScene(f), fails: { 'linear.issues': 'Linear rejected the token. Reconnect it in Settings > Integrations.' } })),
  IssuesDetailFailed: scene((f) => ({ ...issuesScene(f), fails: { 'linear.issue': 'Linear could not reach the issue.' } })),
  IssuesGitHubSignedOut: scene((f) => ({ ...issuesTrackerScene(f, { roomId: ids.roomB }), fails: { 'github.issueList': "GitHubError[signed-out]: The GitHub CLI isn't signed in. Run gh auth login in a terminal." } })),
  IssuesGitHubRepoGone: scene((f) => ({ ...issuesTrackerScene(f, { roomId: ids.roomB }), fails: { 'github.issueList': 'GitHubError[not-found]: Could not read GitHub issues: GraphQL: Could not resolve to a Repository with the name cjjutba/client-b.' } })),
  IssuesGitHubRateLimited: scene((f) => ({ ...issuesTrackerScene(f, { roomId: ids.roomB }), fails: { 'github.issueList': 'GitHubError[rate-limited]: Could not read GitHub issues: API rate limit exceeded.' } })),
  IssuesGitHubFailed: scene((f) => ({ ...issuesTrackerScene(f, { roomId: ids.roomB }), fails: { 'github.issueList': 'GitHubError[other]: Could not read GitHub issues: unexpected response.' } })),
  IssuesGitHubDetailFailed: scene((f) => ({ ...issuesTrackerScene(f, { issueId: '#31', roomId: ids.roomB }), fails: { 'github.issue': 'GitHubError[other]: Could not read GitHub issues: unexpected response.' } })),
  IssuesWorking: scene((f) => issuesScene(f, { issueId: 'KERNEL-24', working: true })),
  IssuesNoRoom: scene((f) => issuesScene(f, { linkedRoom: false })),
  // Nothing assigned to CJ, so the default Mine filter finds nothing.
  IssuesEmpty: scene((f) => issuesScene(f, { issues: linearIssues().map((i) => ({ ...i, assignee: maya })) })),
  IssuesConnect: scene((f) => ({ ...issuesScene(f), integrations: linearIntegrations.map((i) => (i.id === 'linear' ? { ...i, connected: false, detail: 'Create workspaces from issues' } : i)) })),
  // Offline: the screen says Linear can't be reached whatever the last answer was.
  IssuesError: scene((f) => ({ ...issuesScene(f), push: [{ type: 'online', online: false }] })),
  // KERNEL-438: a room on GitHub Issues lists its own issues, with the room in the header. Linear's list is the account's and has no room.
  IssuesGitHub: scene((f) => issuesTrackerScene(f, { issueId: '#31', roomId: ids.roomB })),
  // A room with no tracker says so and points at its settings, where the tracker is chosen.
  IssuesNoTracker: scene((f) => issuesTrackerScene(f, { roomId: ids.roomPortfolio })),
  // The From popover's Issues tab for each: the room's GitHub issues with their assignees, and the line for a room with none.
  SidebarRoomsMenu: withMenu('rooms', { name: 'inbox' }),
  SidebarLeadChats: scene(sidebarLeadChats),
  SidebarChatFolded: scene(sidebarChatFolded),
  SidebarChatGroups: scene(sidebarChatGroups),
  SidebarTrustHeld: scene(sidebarTrustHeld),
  SidebarRoomMenu: withMenu(`room:${ids.roomA}`, { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents' }),
  // The room's menu now ends its first group with Archived, which opens History for that room.
  SidebarRoomMenuArchived: withMenu(`room:${ids.roomA}`, { name: 'inbox' }),
  ConfirmRemoveRoom: scene((f) => ({ ...roomsScene(f), ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents' }, modal: { name: 'confirm', kind: 'removeRoom', roomId: ids.roomA } } }))
}
