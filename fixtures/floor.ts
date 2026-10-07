import type { ActivityEvent, AgentDef, AgentStatus, Approval, Task, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { Fixture } from './types'
import { agent, at, ids, scene, team } from './base'

// Floor lane: the floor and its room states (KERNEL-22), the briefing sequence (KERNEL-23) and the floor moments (KERNEL-24).
// Seating, roles and models follow the canvas roster: Rowan, Kai, Noor, Ivy, Theo.

const floor = { route: { name: 'floor', roomId: ids.roomA } } as const
const A = ids.roomA
const roster: Record<string, Partial<AgentDef>> = { noor: { role: 'Backend', model: 'sonnet' }, theo: { model: 'opus' } }
const seatTeam: AgentDef[] = ['rowan', 'kai', 'noor', 'ivy', 'theo'].map((id) => ({ ...team.find((a) => a.id === id)!, ...roster[id] }))

const calm: Record<string, AgentStatus> = { rowan: 'idle', kai: 'working', noor: 'working', ivy: 'idle', theo: 'working' }

/** Local time today, so the Logs heading reads "Today" whatever day the shots run. Seconds order events within a minute. */
const clock = (h: number, m: number, s = 0) => { const d = new Date(); d.setHours(h, m, s, 0); return d.getTime() }
const retime = (e: ActivityEvent): ActivityEvent => { const d = new Date(e.ts); return { ...e, ts: clock(d.getHours(), d.getMinutes(), d.getSeconds()) } }

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
    // The renderer learns the account from a push; CJ's name and initials show in the sidebar and on his log lines.
    push: [{ type: 'account', account: { signedIn: true, name: 'CJ Jutba', login: 'cjjutba', plan: 'Claude Max' } }, ...saying(status, { ...says, ...sayMore })],
    ui: floor,
    ...rest
  }
}

const paused = Object.fromEntries(seatTeam.map((a) => [a.id, 'paused' as const]))

// ---------- the briefing sequence (KERNEL-23). `ui.stage` is the canvas `%%STAGE%%` value of each PNG; legs, bubble and cards come from the events.

const staged = (stage: string) => ({ ...floor, stage })
const ev = (id: string, h: number, m: number, s: number, e: Omit<ActivityEvent, 'id' | 'ts' | 'roomId'>): ActivityEvent => ({ id, ts: at(h, m, s), roomId: A, ...e })
const say = (id: string, h: number, m: number, s: number, text: string) => ev(id, h, m, s, { agentId: 'rowan', workspaceId: ids.lead, kind: 'agent.say', text })

const brief = ev('b-brief', 11, 2, 0, { actor: 'you', agentId: 'rowan', workspaceId: ids.lead, kind: 'brief', text: 'briefed Rowan', quote: 'Add PDF export to invoices. Spec first.' })
const read = ev('b-read', 11, 3, 0, { agentId: 'rowan', workspaceId: ids.lead, kind: 'tool.end', text: 'read', object: 'invoices.ts' })
const wrote = ev('b-wrote', 11, 3, 20, { agentId: 'rowan', workspaceId: ids.lead, kind: 'tool.end', text: 'wrote', object: 'plans/t-15-invoice-pdf.md' })
const asked = ev('b-asked', 11, 4, 0, { agentId: 'rowan', workspaceId: ids.lead, kind: 'approval.requested', text: 'asked you to review', object: 'T-15 plan', warn: true })
const approved = ev('b-approved', 11, 4, 30, { actor: 'you', agentId: 'rowan', kind: 'approval.decided', text: 'approved', object: 'T-15 plan' })
const created = ev('b-created', 11, 5, 0, { agentId: 'rowan', workspaceId: ids.lead, kind: 'note', text: 'created 4 workspaces for', object: 'T-15' })

/** The plan on FloorPlan.png: one task per agent, each handed off in its own workspace. */
const T15 = [
  { task: 'T-15a', title: 'PDF renderer', agent: 'noor', name: 'Noor', ws: 'invoice-pdf-renderer' },
  { task: 'T-15b', title: 'Download button', agent: 'kai', name: 'Kai', ws: 'invoice-pdf-button' },
  { task: 'T-15c', title: 'Snapshot tests', agent: 'ivy', name: 'Ivy', ws: 'invoice-pdf-tests' },
  { task: 'T-15d', title: 'Review each PR', agent: 'theo', name: 'Theo', ws: 'invoice-pdf-review' }
]
/** What `create_workspace` logs for each hand-off. The assignee walks Rowan to that desk. */
const assigned = (i: number) => ev(`b-assign-${i}`, 11, 5, 10 + i * 10, {
  agentId: 'rowan', workspaceId: `ws-${T15[i].ws}`, kind: 'workspace.created', text: `assigned ${T15[i].task} to`, object: T15[i].name, data: { assignee: T15[i].agent }
})
/** The workspaces the hand-off created, listed first so each agent's card shows the new one. */
const t15Workspaces = (f: Fixture, extra: (i: number) => Partial<Workspace> = () => ({})): Workspace[] => T15.map((t, i) => ({
  ...f.workspaces[1], id: `ws-${t.ws}`, name: t.ws, branch: `feat/${t.task.toLowerCase()}-${t.ws}`, agentId: t.agent, port: 4316 + i,
  path: `/Users/cj/kernel/worktrees/client-a/${t.ws}`, createdAt: clock(11, 5, 10 + i * 10), ...extra(i)
}))
const t15Plan = (status: Approval['status']): Approval => ({
  id: 'ap-t15-plan', kind: 'plan', source: 'sdk', roomId: A, workspaceId: ids.lead, agentId: 'rowan', title: 'T-15 · Export invoices as PDF',
  steps: T15.map((t) => ({ title: t.title, taskId: t.task, agentId: t.agent })), status, createdAt: clock(11, 4)
})
const t15Tasks: Task[] = T15.map((t) => ({
  id: t.task, roomId: A, title: t.title, column: 'review', state: 'idle', agentId: t.agent, workspaceId: `ws-${t.ws}`, parentId: 'T-15', steps: [],
  createdAt: clock(11, 5), updatedAt: clock(11, 16)
}))

const working: Record<string, AgentStatus> = { rowan: 'idle', kai: 'working', noor: 'working', ivy: 'working', theo: 'idle' }
const workingSays = { rowan: 'Watching the team', noor: 'Building the PDF renderer', kai: 'Adding the download button', ivy: 'Writing snapshot tests', theo: 'Waiting for the first PR' }
const workingEvents = [
  ev('b-ivy', 11, 6, 30, { agentId: 'ivy', workspaceId: 'ws-invoice-pdf-tests', kind: 'tool.end', text: 'created', object: 'invoice-pdf.spec.ts' }),
  ev('b-kai', 11, 6, 20, { agentId: 'kai', workspaceId: 'ws-invoice-pdf-button', kind: 'tool.end', text: 'edited', object: 'row-actions.tsx' }),
  ev('b-noor', 11, 6, 10, { agentId: 'noor', workspaceId: 'ws-invoice-pdf-renderer', kind: 'tool.end', text: 'edited', object: 'pdf/render.ts' }),
  assigned(3), assigned(2), assigned(1), assigned(0)
]
const drizzle: Approval = {
  id: 'ap-drizzle', kind: 'tool', source: 'sdk', roomId: A, workspaceId: 'ws-invoice-pdf-renderer', agentId: 'noor', toolName: 'Bash',
  input: { command: 'pnpm drizzle-kit push' }, title: 'Run pnpm drizzle-kit push', status: 'pending', createdAt: clock(11, 7)
}

/** The briefing stages, FloorSent to FloorReview. Other rooms' waiting approvals make way for this room's, so the Inbox count stays at 3. */
const briefing: Record<string, Fixture> = {
  FloorSent: scene((f) => floorScene(f, {
    status: { [A]: { ...calm, rowan: 'planning' } },
    says: { rowan: 'Reading your brief' },
    extra: [say('b-say-sent', 11, 2, 5, 'Got it. Planning PDF export now.'), brief],
    ui: staged('sent')
  })),
  FloorPlanning: scene((f) => floorScene(f, {
    status: { [A]: { ...calm, rowan: 'planning' } },
    says: { rowan: 'Writing the plan on the task wall' },
    extra: [say('b-say-planning', 11, 3, 25, 'Splitting this into four tasks.'), wrote, read, brief],
    ui: staged('planning')
  })),
  FloorPlan: scene((f) => floorScene(f, {
    status: { [A]: { ...calm, rowan: 'needs' } },
    says: { rowan: 'Plan ready for your review' },
    approvals: [...f.approvals.filter((a) => a.id !== 'ap-plan'), t15Plan('pending')],
    extra: [asked, wrote, brief],
    ui: staged('plan')
  })),
  FloorHandoff: scene((f) => floorScene(f, {
    status: { [A]: { rowan: 'working', kai: 'planning', noor: 'working', ivy: 'idle', theo: 'working' } },
    says: { rowan: 'Handing out tasks', noor: 'Building the PDF renderer', kai: 'Reading T-15b' },
    approvals: [...f.approvals, t15Plan('allowed')],
    workspaces: [...t15Workspaces(f), ...f.workspaces],
    extra: [say('b-say-kai', 11, 5, 21, 'Kai, T-15b is yours. A Download PDF button on each row.'), assigned(1), assigned(0), created, approved],
    ui: staged('handoff')
  })),
  FloorWorking: scene((f) => ({
    ...floorScene(f, {
      status: { [A]: working }, says: workingSays,
      approvals: [...f.approvals, t15Plan('allowed')],
      workspaces: [...t15Workspaces(f), ...f.workspaces],
      ui: staged('working')
    }),
    activity: workingEvents.map(retime)
  })),
  FloorNeeds: scene((f) => ({
    ...floorScene(f, {
      status: { [A]: { ...working, noor: 'needs' } }, says: { ...workingSays, noor: 'Wants to run drizzle-kit push' },
      approvals: [...f.approvals.filter((a) => a.id !== 'ap-migrate'), t15Plan('allowed'), drizzle],
      workspaces: [...t15Workspaces(f), ...f.workspaces],
      ui: staged('needs')
    }),
    activity: [ev('b-perm', 11, 7, 0, { agentId: 'noor', workspaceId: 'ws-invoice-pdf-renderer', kind: 'approval.requested', text: 'asked to run', object: 'drizzle-kit push', warn: true }), ...workingEvents].map(retime)
  })),
  FloorReview: scene((f) => {
    const status: Record<string, AgentStatus> = { rowan: 'working', kai: 'idle', noor: 'idle', ivy: 'idle', theo: 'working' }
    const base = floorScene(f, {
      status: { [A]: status },
      says: { rowan: 'Posting the standup', theo: 'Approved 4 PRs', noor: 'Done with T-15a', kai: 'Done with T-15b', ivy: 'Done with T-15c' },
      workspaces: [...t15Workspaces(f, (i) => ({ prState: 'ready', prNumber: 43 + i, prUrl: `https://github.com/cjjutba/client-a/pull/${43 + i}` })), ...f.workspaces],
      tasks: { [A]: t15Tasks },
      ui: staged('review')
    })
    return {
      ...base,
      push: [...(base.push ?? []), ...t15Tasks.map((task) => ({ type: 'task' as const, task }))],
      activity: [
        ev('b-standup', 11, 17, 0, { agentId: 'rowan', workspaceId: ids.lead, kind: 'note', text: 'posted', object: 'standup' }),
        say('b-say-review', 11, 16, 40, 'T-15 is ready. Four PRs passed review.'),
        ev('b-theo', 11, 16, 0, { agentId: 'theo', workspaceId: 'ws-invoice-pdf-review', kind: 'tool.end', text: 'approved', object: 'PR #43 to #46' }),
        ev('b-ivy-pass', 11, 13, 0, { agentId: 'ivy', workspaceId: 'ws-invoice-pdf-tests', kind: 'task.completed', text: 'passed', object: 'T-15c' }),
        ev('b-pr44', 11, 12, 30, { agentId: 'kai', workspaceId: 'ws-invoice-pdf-button', kind: 'pr.changed', text: 'opened', object: 'PR #44' }),
        ev('b-pr43', 11, 12, 0, { agentId: 'noor', workspaceId: 'ws-invoice-pdf-renderer', kind: 'pr.changed', text: 'opened', object: 'PR #43' }),
        ev('b-perm-ok', 11, 7, 30, { actor: 'you', agentId: 'noor', kind: 'approval.decided', text: 'approved', object: 'drizzle-kit push' })
      ].map(retime)
    }
  })
}

// ---------- floor moments (KERNEL-24): FloorQuestion, FloorTalk, FloorOverlap and FloorHired.

/** Rowan's own workspace on the moment screens (the canvas card reads "plan-invoice-pdf"). Listed first so the agent card finds it. */
const planWs = (f: Fixture): Workspace => ({
  ...f.workspaces[1], id: 'ws-plan-invoice-pdf', name: 'plan-invoice-pdf', branch: 'feat/t-15-plan-invoice-pdf', agentId: 'rowan', port: 4320,
  path: '/Users/cj/kernel/worktrees/client-a/plan-invoice-pdf', createdAt: clock(11, 1, 50)
})
const question: Approval = {
  id: 'ap-scope', kind: 'question', source: 'sdk', roomId: A, workspaceId: 'ws-plan-invoice-pdf', agentId: 'rowan',
  title: 'Should PDF export cover credit notes too, or only invoices?', options: ['Invoices only', 'Invoices and credit notes', 'Decide in the plan'],
  status: 'pending', createdAt: clock(11, 2, 50)
}
const lumi: AgentDef = { ...agent('lumi', 'Lumi', 'Designer', 'sonnet'), description: 'Checks every screen against DESIGN.md.', joinedAt: clock(11, 2, 50) }

const moments: Record<string, Fixture> = {
  FloorQuestion: scene((f) => floorScene(f, {
    status: { [A]: { ...calm, rowan: 'needs' } },
    says: { rowan: 'Asking before planning' },
    // The Inbox keeps its count of 3: this room's question takes the place of Client B's migration.
    approvals: [...f.approvals.filter((a) => a.id !== 'ap-migrate'), question],
    workspaces: [planWs(f), ...f.workspaces],
    extra: [
      say('b-say-q', 11, 2, 45, 'Quick question before I plan.'),
      ev('b-asked-q', 11, 2, 50, { agentId: 'rowan', workspaceId: 'ws-plan-invoice-pdf', kind: 'approval.requested', text: 'asked', object: 'scope question', warn: true }),
      brief
    ]
  })),
  FloorTalk: scene((f) => floorScene(f, {
    status: { [A]: { ...calm, rowan: 'working' } },
    says: { rowan: 'Chatting with you' },
    workspaces: [planWs(f), ...f.workspaces],
    extra: [
      ev('b-replied', 11, 2, 40, { agentId: 'rowan', workspaceId: 'ws-plan-invoice-pdf', kind: 'turn.done', text: 'replied in', object: 'plan-invoice-pdf' }),
      ev('b-chat', 11, 2, 30, { actor: 'you', agentId: 'rowan', workspaceId: 'ws-plan-invoice-pdf', kind: 'prompt', text: 'opened a chat with Rowan in', object: 'plan-invoice-pdf' })
    ]
  })),
  FloorOverlap: scene((f) => ({
    ...floorScene(f, {
      extra: [ev('b-overlap', 11, 2, 30, {
        agentId: 'rowan', kind: 'overlap', text: 'flagged an overlap in', object: 'invoices.ts', warn: true,
        data: { overlapId: 'ov-invoices', path: 'src/app/invoices/invoices.ts', workspaceIds: [ids.table, ids.schema] }
      })]
    }),
    overlaps: [{
      id: 'ov-invoices', roomId: A, path: 'src/app/invoices/invoices.ts', ts: clock(11, 2, 30),
      parties: [
        { agentId: 'kai', workspaceId: ids.table, lines: 'lines 20-34' },
        { agentId: 'noor', workspaceId: ids.schema, lines: 'lines 18-40' }
      ]
    }]
  })),
  FloorHired: scene((f) => floorScene(f, {
    agents: { ...f.agents, [A]: [...seatTeam, lumi] },
    status: { [A]: { ...calm, lumi: 'idle' } },
    says: { lumi: 'Joining the room' },
    extra: [
      ev('b-joined', 11, 2, 50, { agentId: 'lumi', kind: 'agent.joined', text: 'joined from', object: '.claude/agents/lumi.md' }),
      ev('b-created-lumi', 11, 2, 45, { agentId: 'rowan', workspaceId: ids.lead, kind: 'tool.end', text: 'created', object: '.claude/agents/lumi.md' }),
      ev('b-hire-ask', 11, 2, 30, { actor: 'you', agentId: 'rowan', kind: 'note', text: 'asked Rowan to', object: 'hire a designer' })
    ],
    // The arrival is held at the door so the shot is the same every run.
    ui: staged('hired')
  }))
}
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
  ...briefing,
  ...moments,
  FloorFull: scene((f) => {
    const crowd = [...seatTeam, agent('sol', 'Sol', 'Security', 'sonnet'), agent('pax', 'Pax', 'Docs', 'haiku')]
    return floorScene(f, {
      agents: { ...f.agents, [A]: crowd },
      rooms: roomWith(f, { desks: seatTeam.map((a) => a.id) }),
      status: { [A]: { ...calm, sol: 'working', pax: 'idle' } }
    })
  })
}
