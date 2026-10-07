import type { AgentDef, Approval, ChatItem, Room, Workspace } from '@shared/types'
import type { Fixture } from './types'

// The seed every fixture starts from. Names, branches and times follow the canvas (Main.png, Workspace.png).

/** Local time on the canvas day, so clocks read 10:55, 11:01 like the PNGs. */
export const at = (h: number, m: number, s = 0) => new Date(2026, 9, 7, h, m, s).getTime()

export const ids = {
  roomA: 'room-a', roomB: 'room-b', roomOwn: 'room-own', roomPortfolio: 'room-portfolio',
  lead: 'ws-lead', table: 'ws-invoice-table', schema: 'ws-invoice-schema', invites: 'ws-org-invites',
  leadChat: 'chat-lead', tableChat: 'chat-invoice-table', schemaChat: 'chat-invoice-schema', invitesChat: 'chat-org-invites'
} as const

const room = (id: string, name: string, path: string, repo?: string): Room => ({ id, name, path, repo, defaultBranch: 'main', paused: false, createdAt: at(9, 0) })

export const agent = (id: string, name: string, role: string, model: string, lead = false): AgentDef => ({
  id, name, role, description: `${role} for this room.`, model, lead, prompt: '', file: `.claude/agents/${id}.md`
})

export const team: AgentDef[] = [
  agent('rowan', 'Rowan', 'Lead', 'opus', true),
  agent('kai', 'Kai', 'Frontend', 'sonnet'),
  agent('noor', 'Noor', 'Engine', 'opus'),
  agent('theo', 'Theo', 'Reviewer', 'sonnet'),
  agent('ivy', 'Ivy', 'QA', 'sonnet')
]

const ws = (id: string, name: string, branch: string, agentId: string, port: number, extra: Partial<Workspace> = {}): Workspace => ({
  id, roomId: ids.roomA, name, branch, baseRef: 'origin/main', path: `/Users/cj/kernel/worktrees/client-a/${name}`, mode: 'worktree',
  agentId, port, status: 'ready', prState: 'none', createdAt: at(10, 2), ...extra
})

const tool = (n: number, name: string, label: string, detail: string, ms: number): ChatItem =>
  ({ kind: 'tool', id: `t${n}`, ts: at(10, 27, n * 10), toolUseId: `toolu_${n}`, name, label, detail, status: 'done', durationMs: ms })

export const tableItems: ChatItem[] = [
  { kind: 'user', id: 'u1', ts: at(10, 27), parts: [
    { type: 'text', text: 'Build T-14 from the plan: invoice table with sorting, plus empty, loading and error states. Follow DESIGN.md and add Playwright coverage.' },
    { type: 'file', name: 'plan.md', path: 'docs/plan.md', lines: 42 }
  ] },
  tool(1, 'Read', 'Read', 'DESIGN.md', 40),
  tool(2, 'Read', 'Read', 'docs/plan.md', 30),
  tool(3, 'Edit', 'Edit', 'src/app/invoices/table.tsx', 120),
  tool(4, 'Write', 'Write', 'src/app/invoices/empty-state.tsx', 90),
  tool(5, 'Edit', 'Edit', 'src/app/invoices/page.tsx', 80),
  tool(6, 'Write', 'Write', 'tests/invoices.spec.ts', 110),
  tool(7, 'Bash', 'Ran', 'pnpm vitest run', 8400),
  tool(8, 'Bash', 'Ran', 'pnpm playwright test invoices', 21300),
  { kind: 'text', id: 'x1', ts: at(10, 31), text: 'Done. The table sorts by date, client and amount, and each state has its own component. Vitest and Playwright pass locally, and I attached the output for Ivy.' },
  { kind: 'result', id: 'r1', ts: at(10, 31), durationMs: 252_000, ok: true }
]

/** Pending in other rooms, so the Inbox shows 3 while Client A's floor shows nothing waiting (Main.png). */
const waiting: Approval[] = [
  { id: 'ap-migrate', kind: 'tool', source: 'sdk', roomId: ids.roomB, agentId: 'noor', toolName: 'Bash', input: { command: 'pnpm db:migrate' }, title: 'Run pnpm db:migrate', detail: 'Applies 2 pending migrations to the local database.', status: 'pending', createdAt: at(10, 48) },
  { id: 'ap-plan', kind: 'plan', source: 'sdk', roomId: ids.roomOwn, agentId: 'rowan', title: 'Plan for the settings page', detail: '1. Kai builds the form\n2. Noor adds the settings table\n3. Ivy covers both with tests', status: 'pending', createdAt: at(10, 44) },
  { id: 'ap-question', kind: 'question', source: 'sdk', roomId: ids.roomPortfolio, agentId: 'kai', title: 'Should the case studies page keep the old URLs?', options: ['Keep them with redirects', 'Use the new URLs only'], status: 'pending', createdAt: at(10, 40) }
]

export const base: Fixture = {
  rooms: [
    room(ids.roomA, 'Client A', '/Users/cj/code/client-a', 'cjjutba/client-a'),
    room(ids.roomB, 'Client B', '/Users/cj/code/client-b', 'cjjutba/client-b'),
    room(ids.roomOwn, 'Own app', '/Users/cj/code/own-app', 'cjjutba/own-app'),
    room(ids.roomPortfolio, 'Portfolio', '/Users/cj/code/portfolio', 'cjjutba/portfolio')
  ],
  agents: { [ids.roomA]: team, [ids.roomB]: team, [ids.roomOwn]: team, [ids.roomPortfolio]: team },
  status: {
    [ids.roomA]: { rowan: 'idle', kai: 'working', noor: 'working', theo: 'working', ivy: 'idle' }
  },
  workspaces: [
    ws(ids.lead, 'lead', 'main', 'rowan', 4300, { path: '/Users/cj/code/client-a', mode: 'current', baseRef: 'main', createdAt: at(9, 5) }),
    ws(ids.table, 'invoice-table', 'feat/t-14-invoice-table', 'kai', 4312),
    ws(ids.schema, 'invoice-schema', 'feat/t-12-invoice-schema', 'noor', 4313, { createdAt: at(10, 3) }),
    ws(ids.invites, 'org-invites', 'feat/t-09-org-invites', 'kai', 4314, { prNumber: 41, prUrl: 'https://github.com/cjjutba/client-a/pull/41', prState: 'open', createdAt: at(10, 4) })
  ],
  chats: [
    { id: ids.leadChat, workspaceId: ids.lead, title: 'Lead', kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: true, createdAt: at(9, 5) },
    { id: ids.tableChat, workspaceId: ids.table, title: 'Invoice table', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: at(10, 2) },
    { id: ids.schemaChat, workspaceId: ids.schema, title: 'Invoice schema', kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, createdAt: at(10, 3) },
    { id: ids.invitesChat, workspaceId: ids.invites, title: 'Org invites', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: at(10, 4) }
  ],
  items: { [ids.tableChat]: tableItems },
  approvals: waiting,
  activity: [
    { id: 'ev4', ts: at(11, 1), roomId: ids.roomA, workspaceId: ids.invites, agentId: 'theo', kind: 'tool.end', text: 'opened the diff for', object: 'T-09' },
    { id: 'ev3', ts: at(10, 59), roomId: ids.roomA, workspaceId: ids.schema, agentId: 'noor', kind: 'tool.end', text: 'edited', object: 'schema.ts' },
    { id: 'ev2', ts: at(10, 57), roomId: ids.roomA, workspaceId: ids.table, agentId: 'kai', kind: 'tool.end', text: 'edited', object: 'table.tsx' },
    { id: 'ev1', ts: at(10, 55), roomId: ids.roomA, agentId: 'ivy', kind: 'task.completed', text: 'passed', object: 'T-11' }
  ],
  usage: [],
  preflight: [
    { id: 'claude', ok: true, title: 'Claude Code', detail: 'v2.1.292' },
    { id: 'gh', ok: true, title: 'GitHub CLI', detail: 'Signed in as cjjutba' },
    { id: 'hooks', ok: true, title: 'Hook server', detail: 'Listening on localhost:7420' }
  ],
  changes: {
    [ids.table]: [
      { path: 'src/app/invoices/table.tsx', status: 'M', added: 212, removed: 20 },
      { path: 'src/app/invoices/empty-state.tsx', status: 'A', added: 64, removed: 0 },
      { path: 'src/app/invoices/page.tsx', status: 'M', added: 18, removed: 9 },
      { path: 'tests/invoices.spec.ts', status: 'A', added: 118, removed: 9 }
    ]
  },
  diffs: {
    [ids.table]: [
      'diff --git a/src/app/invoices/page.tsx b/src/app/invoices/page.tsx',
      '--- a/src/app/invoices/page.tsx',
      '+++ b/src/app/invoices/page.tsx',
      '@@ -1,6 +1,8 @@',
      " import { getInvoices } from '@/lib/invoices'",
      "-import { List } from './list'",
      "+import { InvoiceTable } from './table'",
      "+import { EmptyState } from './empty-state'",
      ''
    ].join('\n')
  },
  ui: { route: { name: 'home' } },
  push: [
    { type: 'script.output', workspaceId: ids.table, kind: 'run', line: '$ pnpm dev --port $KERNEL_PORT', stream: 'stdout' },
    { type: 'script.output', workspaceId: ids.table, kind: 'run', line: 'Next.js ready on http://localhost:4312', stream: 'stdout' },
    { type: 'script.output', workspaceId: ids.table, kind: 'run', line: 'Compiled /invoices', stream: 'stdout' },
    { type: 'script.output', workspaceId: ids.table, kind: 'run', line: 'GET /invoices 200 in 84ms', stream: 'stdout' }
  ]
}

/** A fixture is the seed with a patch on top. The seed is cloned first, so patches can't leak between fixtures. */
export function scene(patch: (f: Fixture) => Partial<Fixture>): Fixture {
  const f = structuredClone(base)
  return { ...f, ...patch(f) }
}

/** Swap one workspace in a fixture's list. */
export const withWorkspace = (f: Fixture, id: string, change: Partial<Workspace>) => f.workspaces.map((w) => (w.id === id ? { ...w, ...change } : w))
