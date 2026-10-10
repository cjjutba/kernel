import type { PushEvent } from '@shared/ipc'
import type { Approval, Chat, ChatItem, Checkpoint, FileEntry, Hunk, PrInfo, Skill, TeamUpdateRow, Workspace } from '@shared/types'
import type { Fixture } from './types'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { at, ids, scene, tableItems, withWorkspace } from './base'

// Workspace lane: the workspace screen (KERNEL-10), PR states (KERNEL-15), agent turns and requests (KERNEL-14).

const open = { route: { name: 'workspace', workspaceId: ids.table } } as const
const pr = { prNumber: 42, prUrl: 'https://github.com/samrivera/client-a/pull/42' }
/** The transcript up to the last tool call, before Kai's summary. */
const midTurn = tableItems.filter((i) => i.kind !== 'text' && i.kind !== 'result')

const prTitle = 'feat(invoices): table and empty states'

/** The "create-pr.md sent" card, the agent's tool calls, its reply and the end of its turn. */
const prTurn = (id: string, lines: string[], tools: number, reply: string): ChatItem[] => [
  { kind: 'user', id: `${id}-md`, ts: at(10, 33), parts: [{ type: 'file', name: 'create-pr.md', text: lines.join('\n') }] },
  ...folded(id, tools, 0),
  { kind: 'text', id: `${id}-reply`, ts: at(10, 34), text: reply },
  { kind: 'result', id: `${id}-res`, ts: at(10, 34), durationMs: 65_000, ok: true }
]
const prNote = (id: string, text: string): ChatItem => ({ kind: 'note', id, ts: at(10, 40), text })

/** PR #42 on the invoice table in one state, with the transcript, checks and comments the canvas shows for it. */
const prScene = (prState: Workspace['prState'], items: ChatItem[], extra: Partial<Fixture> = {}, right: 'changes' | 'checks' = 'changes') =>
  scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { ...pr, prTitle, prState }),
    items: { [ids.tableChat]: [...tableItems, ...items] },
    ...extra,
    ui: { ...open, workspace: { right, bottom: 'run', checkpoints: false, toolsOpen: false }, ...extra.ui }
  }))

/** KERNEL-249: the Run tab of an open PR's workspace, with the room's three run scripts and `frontend` running. The port is the workspace's first. */
function runScripts(): Fixture {
  const open = prScene('open', [], { prs: prInfo('open') })
  const frontend = ['$ pnpm --filter web dev --port $KERNEL_PORT', 'Next.js ready on http://localhost:4312', 'Studio ready on http://localhost:4314', 'Compiled /invoices', 'GET /invoices 200 in 84ms', 'GET /api/invoices 200 in 31ms']
  return {
    ...open,
    roomSettings: { [ids.roomA]: {
      scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' },
      runScripts: [
        { name: 'run', command: 'pnpm dev --port $KERNEL_PORT' },
        { name: 'frontend', command: 'pnpm --filter web dev --port $KERNEL_PORT' },
        { name: 'backend', command: 'pnpm --filter api dev --port $((KERNEL_PORT + 1))' }
      ],
      files: { copy: [] }, workspace: {}
    } },
    // The seed's output belongs to `run`, which is idle here, so only `frontend` has lines.
    push: [
      ...open.push.filter((e) => e.type !== 'script.output' || e.kind !== 'run'),
      ...frontend.map((line): PushEvent => ({ type: 'script.output', workspaceId: ids.table, kind: 'run', name: 'frontend', line, stream: 'stdout' }))
    ]
  }
}

const prInfo = (prState: Workspace['prState'], o: Partial<PrInfo> = {}): Record<string, PrInfo> => ({
  [ids.table]: { workspaceId: ids.table, number: 42, url: pr.prUrl, title: prTitle, state: prState, baseRef: 'main', checks: [], comments: [], conflicts: [], ...o }
})

const PLAN = [
  'Add "Download PDF" to the row actions menu', 'Call /api/invoices/:id/pdf and stream the file', 'Show progress on the item while it downloads', 'Toast on failure with a retry action', 'Playwright test for the download'
].map((t, i) => `${i + 1}. ${t}`).join('\n')

const pending = (kind: 'tool' | 'plan' | 'question' | 'agent', agentId: string, extra: object): Approval =>
  ({ id: `ap-${kind}-${agentId}`, kind, source: 'sdk', roomId: ids.roomA, workspaceId: ids.table, agentId, status: 'pending', createdAt: at(10, 30), title: '', ...extra })

const userMsg = (id: string, text: string, plan = false): ChatItem =>
  ({ kind: 'user', id, ts: at(10, 27), parts: [{ type: 'text', text }, ...(plan ? [{ type: 'file' as const, name: 'plan.md', path: 'docs/plan.md', lines: 42 }] : [])] })

/** `tools` tool calls and `messages` thinking rows, which a finished turn folds into one "N tool calls" row. */
const folded = (prefix: string, tools: number, messages: number): ChatItem[] => [
  ...Array.from({ length: tools }, (_, i) => tool(`${prefix}-f${i}`, `Step ${i + 1}`, 'rg -n "invoice" src')),
  ...Array.from({ length: messages }, (_, i): ChatItem => ({ kind: 'thinking', id: `${prefix}-fm${i}`, ts: at(10, 28), text: 'Checking the next step.' }))
]

const tool = (id: string, label: string, detail: string, extra: Partial<Extract<ChatItem, { kind: 'tool' }>> = {}): ChatItem =>
  ({ kind: 'tool', id, ts: at(10, 28), toolUseId: `toolu_${id}`, name: 'Bash', label, detail, status: 'done', durationMs: 100, ...extra })

/** Ivy's snapshot-test turn, still going (WorkspaceRunning.png). Times count back from now so the clock reads 2m 14s. */
const runningItems = (): ChatItem[] => {
  const now = Date.now()
  const t = (secs: number) => now - secs * 1000
  return [
    { kind: 'user', id: 'ru1', ts: t(134), parts: [{ type: 'text', text: 'T-15c: snapshot tests for three invoice types. Use stable fixture dates.' }, { type: 'file', name: 'plan.md', path: 'docs/plan.md', lines: 42 }] },
    { kind: 'thinking', id: 'rth1', ts: t(130), text: 'I should check how invoices render before writing fixtures.' },
    tool('rt1', 'Read the PDF renderer', 'cat src/pdf/render.ts', { name: 'Read', ts: t(120) }),
    { kind: 'thinking', id: 'rth2', ts: t(110), text: 'Three types: standard, credit note, and multi-currency.' },
    tool('rt2', 'Find the existing snapshot setup', 'rg -n "toMatchSnapshot" tests', { ts: t(100) }),
    { kind: 'text', id: 'rx1', ts: t(90), text: 'Vitest already snapshots the invoice table, so I will reuse that setup and add fixtures with frozen dates.' },
    tool('rt3', 'Create the test file', "cat > tests/invoice-pdf.spec.ts <<'EOF'", { ts: t(60) }),
    { kind: 'thinking', id: 'rth3', ts: t(40), text: 'Freezing time at 2026-10-01 keeps every snapshot stable.' },
    tool('rt4', 'Run the new tests', 'pnpm vitest run tests/invoice-pdf.spec.ts', { ts: t(20), status: 'running', durationMs: undefined })
  ]
}

/** A turn in progress with a long thinking row, a Bash call that printed output, an Edit and a Bash call still running. */
const rowsOpenItems: ChatItem[] = [
  userMsg('ro-u', 'Add a sort to the invoice table and run the tests.'),
  { kind: 'thinking', id: 'ro-th', ts: at(10, 28), text: 'The table already has a sortable header for the amount column, so the date and client columns can reuse it.\n\nThe sort state lives in the URL, which keeps a reload on the same order. I will keep that and only add the two keys.' },
  tool('ro-t1', 'Run unit tests', 'pnpm vitest run invoices', { durationMs: 8400, input: { command: 'pnpm vitest run invoices --reporter=verbose' }, output: ' ✓ src/app/invoices/table.test.tsx (9)\n ✓ src/app/invoices/empty-state.test.tsx (4)\n ✓ src/app/invoices/page.test.tsx (8)\n\nTest Files  3 passed (3)\nTests  21 passed (21)', outputCut: true }),
  tool('ro-t2', 'Edit table.tsx', 'src/app/invoices/table.tsx', { name: 'Edit', durationMs: 120, input: { file_path: 'src/app/invoices/table.tsx', old_string: "const rows = sortBy(invoices, 'amount')\nreturn <Table rows={rows} />", new_string: "const rows = sortBy(invoices, sort.key, sort.dir)\nreturn <Table rows={rows} sort={sort} />" } }),
  tool('ro-t3', 'Run Playwright', 'pnpm playwright test invoices', { status: 'running', durationMs: undefined, input: { command: 'pnpm playwright test invoices --project=chromium' } })
]

/** The folded list (WorkspaceToolCalls) with a thinking row, a message and inputs on Edit and Write, for the rows a shot opens inside it. */
const foldedRowsItems: ChatItem[] = [
  tableItems[0],
  { kind: 'thinking', id: 'fr-th', ts: at(10, 28), text: 'The table needs a sort key and a direction.\n\nI will read the plan, find where the table renders, then edit it.' },
  tool('fr1', 'Read the plan', 'cat plans/t-14-invoice-table.md', { name: 'Read', durationMs: 100, input: { file_path: 'plans/t-14-invoice-table.md', offset: 1, limit: 80 } }),
  tool('fr2', 'Find the invoices page', 'rg -n "InvoiceTable" src', { durationMs: 200, input: { command: 'rg -n "InvoiceTable" src' }, output: 'src/app/invoices/page.tsx:12:  <InvoiceTable invoices={rows} />' }),
  { kind: 'text', id: 'fr-x', ts: at(10, 28), text: 'I will build the table first, then the empty state and the tests.' },
  tool('fr3', 'Edit table.tsx', 'src/app/invoices/table.tsx', { name: 'Edit', durationMs: 120, input: { file_path: 'src/app/invoices/table.tsx', old_string: "const rows = sortBy(invoices, 'amount')", new_string: 'const rows = sortBy(invoices, sort.key, sort.dir)' } }),
  tool('fr4', 'Create empty-state.tsx', 'src/app/invoices/empty-state.tsx', { name: 'Write', durationMs: 90, input: { file_path: 'src/app/invoices/empty-state.tsx', content: "export function EmptyState() {\n  return <p>No invoices yet</p>\n}" } }),
  tool('fr5', 'Run unit tests', 'pnpm vitest run invoices', { durationMs: 8400, input: { command: 'pnpm vitest run invoices' }, output: 'Test Files  3 passed (3)\nTests  21 passed (21)' }),
  ...tableItems.slice(-2)
]

const toolCalls: ChatItem[] = [
  tableItems[0],
  tool('c1', 'Read the plan', 'cat plans/t-14-invoice-table.md', { name: 'Read', durationMs: 100 }),
  tool('c2', 'Find the invoices page', 'rg -n "InvoiceTable" src', { durationMs: 200, output: 'src/app/invoices/page.tsx:12:  <InvoiceTable invoices={rows} />' }),
  tool('c3', 'Edit table.tsx', 'src/app/invoices/table.tsx', { name: 'Edit', durationMs: 120 }),
  tool('c4', 'Create empty-state.tsx', 'src/app/invoices/empty-state.tsx', { name: 'Write', durationMs: 90 }),
  tool('c5', 'Run unit tests', 'pnpm vitest run invoices', { durationMs: 8400, output: 'Test Files  3 passed (3)\nTests  21 passed (21)' }),
  tool('c6', 'Run Playwright', 'pnpm playwright test invoices', { durationMs: 41_000, output: '4 passed (38.2s)' }),
  ...tableItems.slice(-2)
]

/** Composer shots: the same screen, with the composer already holding something. */
const composing = (composer: { parts: import('@shared/types').ChatPart[]; draft: string }, extra: Partial<Fixture> = {}) =>
  scene(() => ({ ...extra, ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false, composer } } }))

/** A chat 34% full, with the rows Claude Code's /context lists, adding up to the 200k window. */
const contextChat = (f: Fixture) => f.chats.map((c) => c.id === ids.tableChat ? {
  ...c,
  context: 34,
  contextUsage: { used: 68_000, max: 200_000, rows: [
    { name: 'System prompt', tokens: 3_200, kind: 'used' as const },
    { name: 'System tools', tokens: 11_800, kind: 'used' as const },
    { name: 'MCP tools', tokens: 6_400, kind: 'used' as const },
    { name: 'Memory files', tokens: 2_600, kind: 'used' as const },
    { name: 'Messages', tokens: 44_000, kind: 'used' as const },
    { name: 'Free space', tokens: 99_000, kind: 'free' as const },
    { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' as const }
  ] }
} : c)

const file = (path: string): FileEntry => ({ path, dir: false })
/** A stand-in for a pasted screenshot, so hovering the image chip in WorkspacePaste shows a preview. */
const pastedLog = Array.from({ length: 212 }, (_, i) => `2025-03-11T10:${String(i % 60).padStart(2, '0')}:07Z ${i % 9 === 4 ? 'ERROR invoices.list: relation "invoice_lines" does not exist' : `INFO  request ${1000 + i} GET /api/invoices 200 ${12 + (i % 7)}ms`}`).join('\n')
const screenshot = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#141518"/><rect width="240" height="800" fill="#1b1c20"/><rect x="300" y="60" width="520" height="22" rx="4" fill="#3a3c42"/><rect x="300" y="120" width="920" height="420" rx="10" fill="#1f2024" stroke="#2c2e33"/><rect x="330" y="160" width="400" height="14" rx="3" fill="#5a2a2a"/><rect x="330" y="196" width="760" height="12" rx="3" fill="#2f3136"/><rect x="330" y="224" width="680" height="12" rx="3" fill="#2f3136"/></svg>')}`
/** What @inv finds, in the order the canvas lists it. */
const mentionTree: FileEntry[] = ['src/app/invoices/table.tsx', 'tests/invoices.spec.ts', 'src/pdf/invoice-pdf.ts', 'src/db/schema/invoices.ts', 'src/app/invoices/invoice-row.tsx', 'package.json'].map(file)

const skills: Skill[] = [
  ['plan', 'Plan before editing'], ['feature', 'Build a feature from a spec'], ['verify', 'Run tests and attach the output'], ['image', 'Generate or edit an image'], ['setup', 'Set up the project']
].map(([name, description]) => ({ name, description, source: 'project' as const, enabled: true }))

const hunk = (owner: Hunk['owner'], lines: string, added: number, removed: number): Hunk => ({ id: `src/lib/checkout.ts#${owner}#0`, path: 'src/lib/checkout.ts', owner, lines, added, removed, patch: '' })

/** WorkspaceQueued.png: Kai is mid-turn with two follow-ups waiting. */
const queuedItems = (): ChatItem[] => {
  const now = Date.now()
  const t = (secs: number) => now - secs * 1000
  return [
    { ...tableItems[0], ts: t(48) },
    { kind: 'thinking', id: 'qth1', ts: t(40), text: 'The sort hook should live next to the table.' },
    tool('qt1', 'Edit table.tsx', 'src/app/invoices/table.tsx', { name: 'Edit', ts: t(30) }),
    tool('qt2', 'Run unit tests', 'pnpm vitest run invoices', { ts: t(10), status: 'running', durationMs: undefined })
  ]
}

/** The invoice-table workspace (or the Lead's) retitled for one agent request: its name, chat title and transcript. */
function scene2(f: Fixture, ws: Partial<Workspace>, title: string, items: ChatItem[], extra: Partial<Fixture>, chat: Partial<Chat> = {}): Partial<Fixture> {
  const id = ws.id ?? ids.table
  const chatId = id === ids.lead ? ids.leadChat : ids.tableChat
  const { id: _id, ...patch } = ws
  return {
    workspaces: withWorkspace(f, id, patch),
    chats: f.chats.map((c) => (c.id === chatId ? { ...c, title, ...chat } : c)),
    // The engine writes an approval item where the request was made, so the card keeps its place once answered.
    items: { [chatId]: [...items, ...(extra.approvals ? [{ kind: 'approval' as const, id: `approval-${extra.approvals[0].id}`, ts: at(10, 30), approvalId: extra.approvals[0].id }] : [])] },
    approvals: extra.approvals && [{ ...extra.approvals[0], workspaceId: id, chatId }, ...extra.approvals.slice(1)],
    ui: { route: { name: 'workspace', workspaceId: id } }
  }
}

/** Two team updates in Rowan's chat after a hand-off: Kai's PR passed checks, then Theo approved it (KERNEL-127). */
const leadUpdate = (f: Fixture): Partial<Fixture> => {
  const header = 'Team update from Kernel, not from the user.'
  const kai: TeamUpdateRow = {
    workspaceId: ids.table, agentId: 'kai', name: 'Kai', task: 'Remove the Try section from the sidebar', prNumber: 108,
    events: [{ kind: 'pr.opened', text: 'Opened PR #108', actionable: false }, { kind: 'pr.ready', text: 'Passed checks, no conflicts. Nobody has reviewed it yet', actionable: true }],
    reply: 'Removed the Try section from the sidebar. Connect a repo and Open a folder stay in the rooms plus menu and on Home\'s empty state, and Check hooks stays in the footer.\n\nOpened https://github.com/samrivera/client-a/pull/108'
  }
  const theo: TeamUpdateRow = {
    workspaceId: 'ws-review-108', agentId: 'theo', name: 'Theo', task: 'Review PR #108',
    events: [{ kind: 'review', text: 'Approved PR #108', actionable: true }],
    reply: 'The Try rows are gone and nothing else in the sidebar moved. Connect a repo and Open a folder are still reachable from the rooms plus menu. No blockers.'
  }
  const update = (id: string, m: number, row: TeamUpdateRow, todo: string): ChatItem => ({
    kind: 'user', id, ts: at(10, m), from: 'kernel', update: { rows: [row] },
    parts: [{ type: 'text', text: [header, '', `${row.name} (${row.agentId}) · ${row.task} · workspace ${row.workspaceId}`, ...row.events.map((e) => `- ${e.text}.`), '', 'To do:', `- ${todo}`].join('\n') }]
  })
  const done = (id: string, m: number): ChatItem => ({ kind: 'result', id, ts: at(10, m), durationMs: 9_000, ok: true })
  const s = scene2(f, { id: ids.lead, agentId: 'rowan' }, 'Remove the Try section', [
    userMsg('lu1', 'Remove the Try section from the sidebar, and have Theo review it before I merge.'),
    { kind: 'text', id: 'lu1-r', ts: at(10, 28), text: 'Kai has it. Once its checks pass, Theo reviews the PR.' },
    done('lu1-res', 28),
    update('lu2', 41, kai, 'PR #108 needs a review. Theo (theo) reviews on this team: call create_workspace with agent "theo" and review_of "ws-invoice-table".'),
    { kind: 'text', id: 'lu2-r', ts: at(10, 41), text: "Kai's PR #108 passed checks. Theo is reviewing it." },
    done('lu2-res', 41),
    update('lu3', 49, theo, 'PR #108 passed checks, has no conflicts and Theo approved it. Tell the user it is ready to merge.'),
    { kind: 'text', id: 'lu3-r', ts: at(10, 49), text: 'Theo approved PR #108. It is ready for you to merge.' },
    done('lu3-res', 49)
  ], {}, { model: 'claude-opus-5-5' })
  const review: Workspace = { id: 'ws-review-108', roomId: ids.roomA, name: 'review-pr-108', title: 'Review PR #108', branch: 'feat/t-14-invoice-table-review', baseRef: 'feat/t-14-invoice-table', path: '/Users/you/kernel/worktrees/client-a/review-pr-108', mode: 'worktree', agentId: 'theo', port: 4316, status: 'ready', prState: 'none', reviewOf: ids.table, createdAt: at(10, 42) }
  // scene2 sets approvals only when it is given some; an undefined one would hide the seed's.
  const { approvals: _none, ...rest } = s
  return { ...rest, workspaces: [...(s.workspaces ?? f.workspaces), review] }
}

/** Rowan's plan waiting in the Lead's workspace. `ws` retitles that workspace. */
const leadPlan = (f: Fixture, ws: Partial<Workspace>): Partial<Fixture> => ({
  ...scene2(f, { id: ids.lead, stat: { files: 1, added: 64, removed: 0 }, ...ws }, 'Export invoices as PDF', [
    userMsg('l1', 'Add PDF export to invoices. Spec first.'),
    { kind: 'thinking', id: 'l-th', ts: at(10, 28), text: 'Renderer, button, tests and review can run in parallel.' },
    tool('l-t1', 'Read the invoices module', 'cat src/app/invoices/page.tsx', { name: 'Read' }),
    tool('l-t2', 'Write the plan', 'cat > plans/t-15-invoice-pdf.md', { name: 'Write' }),
    { kind: 'text', id: 'l-tx', ts: at(10, 29), text: 'I split PDF export into four tasks that can run in parallel. Approve it and I will hand them out.' }
  ], {
    approvals: [pending('plan', 'rowan', { workspaceId: ids.lead, title: 'Plan for T-15', steps: [
      { title: 'T-15a PDF renderer with embedded fonts', taskId: 'T-15a', agentId: 'noor' }, { title: 'T-15b Download PDF in the row actions', taskId: 'T-15b', agentId: 'kai' },
      { title: 'T-15c Snapshot tests for three invoice types', taskId: 'T-15c', agentId: 'ivy' }, { title: 'T-15d Review each PR as it lands', taskId: 'T-15d', agentId: 'theo' }
    ] }), ...f.approvals]
  }, { plan: true, model: 'claude-opus-5-5' }),
  changes: { [ids.lead]: [{ path: 'plans/t-15-invoice-pdf.md', status: 'A', added: 64, removed: 0 }] }
})

/**
 * The new chat modal over Client A's Team (NewWorkspace.png and its four popovers). It starts from the Lead's model, so the label
 * reads Opus 5.5, not the PNG's Sonnet 5.5. Plan mode is off here, as the PNG draws it. The app's default (Settings, Models) is on.
 */
const newWorkspace = (menu?: 'branch' | 'from' | 'model' | 'plus') => scene(() => ({
  settings: { ...DEFAULT_SETTINGS('/Users/you'), models: { ...DEFAULT_SETTINGS('/Users/you').models, leadPlanMode: false } },
  branches: ['origin/main', 'origin/dev', 'main', 'feat/t-14-invoice-table', 'feat/t-12-invoice-schema', 'fix/docker-local-startup'],
  openPrs: [
    { number: 44, title: 'feat(invoices): PDF renderer with embedded fonts', branch: 'feat/invoice-pdf', author: 'samrivera' },
    { number: 43, title: 'fix(auth): invite links expire after 7 days', branch: 'fix/invite-expiry', author: 'jordan' },
    { number: 41, title: 'feat(org): invite members by email', branch: 'feat/org-invites', author: 'samrivera' },
    { number: 39, title: 'chore(db): seed realistic invoices', branch: 'chore/seed-invoices', author: 'jordan' }
  ],
  issues: [{ id: 'T-16', title: 'Client portal login' }, { id: 'T-17', title: 'Bulk export for accountants' }, { id: 'T-18', title: 'Dark mode for invoice PDFs' }],
  ui: { route: { name: 'team', roomId: ids.roomA }, modal: { name: 'newWorkspace', roomId: ids.roomA }, menu: menu ?? null }
}))

/** The invoice table's turns, newest first, as the Checkpoints drawer lists them (WorkspaceCheckpoints.png). */
const checkpoints: Checkpoint[] = ([
  ['4', 10, 31, 'Done. The table sorts by date, client and amount', [4, 412, 38]],
  ['3', 10, 24, 'Added the empty and error states', [2, 88, 9]],
  ['2', 10, 18, 'Sorting on the table header', [1, 96, 12]],
  ['1', 10, 14, 'Read the plan and the current table', [0, 0, 0]],
  ['0', 10, 12, 'Build T-14 from the plan', [0, 0, 0]]
] as const).map(([id, h, m, title, [files, added, removed]]) => ({
  id, workspaceId: ids.table, chatId: ids.tableChat, ts: at(h, m), title, stat: { files, added, removed },
  ref: `refs/kernel/checkpoints/${ids.table}/${id}`, current: id === '4', ...(id === '0' ? { start: true } : {})
}))

const tabsView = (tab: string) => ({ ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false }, tabs: { [ids.table]: { tab, files: [] as string[], diffs: [] as string[] } } } as const)
const extraChat = (id: string, title: string, kind: 'chat' | 'terminal' = 'chat'): Chat =>
  ({ id, workspaceId: ids.table, title, kind, model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: at(10, 30) })

/** What Claude Code's own screen prints when it starts in the worktree (WorkspaceTerminal.png). */
const termScreen = '\r\n'.repeat(24) + [
  'you@mac t-14-invoice-table % claude --dangerously-skip-permissions', '',
  '\x1b[1mClaude Code v2.1\x1b[0m', 'Opus 5.5 with high effort · Claude Max', '~/kernel/worktrees/client-a/t-14-invoice-table', '',
  'Hooks connected. This session reports to Kernel as Kai.', '', '> Try "fix lint errors"', '',
  'bypass permissions on · worktree only                    Opus 5.5 · high'
].join('\r\n')

export const workspaceFixtures: Record<string, Fixture> = {
  NewWorkspace: newWorkspace(),
  NewWorkspaceBranch: newWorkspace('branch'),
  NewWorkspaceFrom: newWorkspace('from'),
  NewWorkspaceModel: newWorkspace('model'),
  NewWorkspacePlus: newWorkspace('plus'),
  Workspace: scene(() => ({ ui: open })),
  // KERNEL-161: the workspace started on a Linear issue shows its key after the branch.
  WorkspaceIssue: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { branch: 'feat/kernel-24-invoice-table', source: { kind: 'issue', id: 'KERNEL-24', title: 'Invoice table', url: 'https://linear.app/cj-jutba/issue/KERNEL-24' } }),
    ui: open
  })),
  WorkspaceLoading: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { status: 'setup' }),
    items: { [ids.tableChat]: [] },
    ui: open
  })),
  WorkspaceToolCalls: scene(() => ({
    items: { [ids.tableChat]: toolCalls },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: true } }
  })),
  /** Rows opened in place (KERNEL-198). Local open state can't be set from a fixture, so scripts/shots.ts clicks the rows named there. */
  WorkspaceRowsOpen: scene(() => ({
    items: { [ids.tableChat]: rowsOpenItems },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
  })),
  /** The folded list with a Thinking, a Message and an Edit row opened inside it (KERNEL-198). */
  WorkspaceRowsFolded: scene(() => ({
    items: { [ids.tableChat]: foldedRowsItems },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: true } }
  })),
  WorkspaceCheckpoints: scene(() => ({
    checkpoints: { [ids.table]: checkpoints },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: true, toolsOpen: false } }
  })),
  WorkspaceNewChat: scene((f) => ({
    chats: [...f.chats, extraChat('chat-new', 'New chat')],
    items: { 'chat-new': [] },
    ui: { ...tabsView('chat-new'), menu: 'newTab' }
  })),
  WorkspaceTabMenu: scene((f) => ({
    chats: [...f.chats, extraChat('chat-copy', 'Empty state copy')],
    items: { 'chat-copy': [userMsg('c1', 'Shorten the empty state copy.'), tool('c-t1', 'Read the empty state', 'cat src/app/invoices/empty-state.tsx', { name: 'Read' }), tool('c-t2', 'Edit the copy', 'sed -i empty-state.tsx'), { kind: 'text', id: 'c-reply:0', ts: at(10, 31), text: 'Changed it to "No invoices yet. Create your first one."' }, { kind: 'result', id: 'c-res', ts: at(10, 31), durationMs: 20_000, ok: true }] },
    ui: { ...tabsView('chat-copy'), menu: 'tab' }
  })),
  // No PNG draws a tab's state icon (D-098). One chat waits on a question, one runs and one is idle, all with titles long enough to truncate.
  WorkspaceTabStates: scene((f) => ({
    chats: [
      ...f.chats,
      extraChat('chat-ask', 'Should the download keep the invoice number in the file name'),
      extraChat('chat-run', 'Snapshot tests for the invoice PDF renderer'),
      extraChat('chat-term', 'Terminal (claude)', 'terminal')
    ],
    approvals: [{ ...pending('question', 'kai', { title: 'Keep the invoice number in the file name?', options: ['Yes', 'No'] }), chatId: 'chat-ask' }, ...f.approvals],
    push: [...f.push, { type: 'chat.running', chatId: 'chat-run', running: true }],
    ui: open
  })),
  WorkspaceTerminal: scene((f) => ({
    chats: [...f.chats, extraChat('chat-term', 'Terminal (claude)', 'terminal')],
    push: [...f.push, { type: 'terminal.data', chatId: 'chat-term', data: termScreen }],
    ui: tabsView('chat-term')
  })),
  WorkspaceFile: scene(() => ({
    ui: { ...open, workspace: { right: 'files', bottom: 'run', checkpoints: false, toolsOpen: false }, tabs: { [ids.table]: { tab: 'file:src/app/invoices/table.tsx', files: ['src/app/invoices/table.tsx'], diffs: [] } } }
  })),
  // No PNG draws a diff tab (KERNEL-144). The diff opens in a tab of its own next to the chat, with the composer below it.
  WorkspaceDiffTab: scene(() => ({
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false }, tabs: { [ids.table]: { tab: 'diff:src/app/invoices/page.tsx', files: [], diffs: ['src/app/invoices/page.tsx'] } } }
  })),
  // Focus mode hides both sides the way Conductor does (D-063), so this shot has no rail where the PNG draws one.
  WorkspaceFocus: scene(() => ({
    ui: { ...open, sidebar: false, rightPanel: false, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
  })),
  WorkspaceRunning: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { name: 'invoice-pdf-tests', branch: 'feat/t-15c-invoice-pdf-tests', agentId: 'ivy' }),
    chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: 'Snapshot tests' } : c)),
    items: { [ids.tableChat]: runningItems() },
    changes: { [ids.table]: [
      { path: 'tests/invoice-pdf.spec.ts', status: 'A', added: 96, removed: 0 },
      { path: 'tests/fixtures/invoices.ts', status: 'A', added: 42, removed: 0 }
    ] },
    push: [...f.push, { type: 'chat.running', chatId: ids.tableChat, running: true }],
    ui: { ...open, workspace: { right: 'files', bottom: 'run', checkpoints: false, toolsOpen: false } }
  })),
  WorkspacePerm: scene((f) => scene2(f, { name: 'invoice-pdf-renderer', branch: 'feat/t-15a-pdf-renderer', agentId: 'noor' }, 'PDF renderer', [
    userMsg('p1', 'T-15a: PDF renderer with embedded fonts. Store generated files in the invoices bucket.', true),
    ...folded('p', 11, 2),
    { kind: 'text', id: 'p-reply', ts: at(10, 29), text: 'The renderer works and the fonts are embedded. The schema needs a pdf_url column, so I need to push it to the dev database.' },
    { kind: 'result', id: 'p-res', ts: at(10, 29), durationMs: 90_000, ok: true }
  ], {
    approvals: [pending('tool', 'noor', { toolName: 'Bash', input: { command: 'pnpm drizzle-kit push' }, title: 'Run pnpm drizzle-kit push', detail: 'Dev database from .env.local. Adds invoices.pdf_url.' }), ...f.approvals]
  })),
  WorkspacePlan: scene((f) => scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Plan T-15b', [
    userMsg('pl1', 'Plan T-15b: a Download PDF button on each invoice row. Do not edit anything yet.'),
    { kind: 'thinking', id: 'pl-th', ts: at(10, 28), text: 'Row actions already live in a menu. A second button would crowd the row.' },
    tool('pl-t1', 'Read the row actions', 'cat src/app/invoices/row-actions.tsx', { name: 'Read' }),
    tool('pl-t2', 'Check the PDF endpoint', 'rg -n "renderInvoicePdf" src')
  ], {
    approvals: [pending('plan', 'kai', { toolName: 'ExitPlanMode', input: { plan: PLAN }, title: 'Plan for invoice-pdf-button', detail: PLAN }), ...f.approvals]
  }, { plan: true, model: 'claude-opus-5-5' })),
  WorkspaceQuestion: scene((f) => scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Download button', [
    userMsg('q1', 'Build T-15b from the approved plan.', true),
    ...folded('q', 6, 0),
    { kind: 'result', id: 'q-res', ts: at(10, 29), durationMs: 60_000, ok: true }
  ], {
    approvals: [pending('question', 'kai', { title: 'Should the download keep the invoice number in the file name?', options: ['Yes, invoice-009.pdf', 'Add the client name, acme-invoice-009.pdf'] }), ...f.approvals]
  })),
  WorkspaceInterrupted: scene(() => ({
    items: { [ids.tableChat]: [
      userMsg('i0', 'Refactor the invoice table to use the shared DataTable component.'),
      { kind: 'thinking', id: 'i-th', ts: at(10, 28), text: 'DataTable expects column defs. The sorting hook will need to move.' },
      tool('i-t1', 'Read the shared DataTable', 'cat src/components/data-table.tsx', { name: 'Read' }),
      tool('i-t2', 'Rewrite the invoice columns', "python3 - <<'EOF' p='src/app/invoices/columns.ts'"),
      { kind: 'interrupted', id: 'i1', ts: at(10, 44) },
      { kind: 'result', id: 'i-res', ts: at(10, 44), durationMs: 28_000, ok: false, error: 'Interrupted' },
      userMsg('i2', 'Stop, keep the current table. Only fix the empty state copy.')
    ] },
    ui: open
  })),
  WorkspaceError: scene(() => ({
    items: { [ids.tableChat]: [
      userMsg('e0', 'Run the full test suite before I open the PR.'),
      tool('e-t1', 'Run unit tests', 'pnpm vitest run', { status: 'failed', durationMs: 19_800, output: 'FAIL tests/invoices.spec.ts > sorts by date\n  Expected: 2026-10-01  Received: 01/10/2026\nFAIL tests/invoices.spec.ts > empty state\n  Snapshot mismatch: 1 line changed' }),
      { kind: 'result', id: 'e-res', ts: at(10, 30), durationMs: 184_000, ok: false, error: '2 tests failed' }
    ] },
    ui: open
  })),
  // The canvas draws Rowan's plan in a worktree called export-invoices-as-pdf. WorkspaceLeadPlan keeps the Lead's real workspace, on the main checkout.
  WorkspaceLead: scene((f) => leadPlan(f, { name: 'export-invoices-as-pdf', branch: 'feat/export-invoices-as-pdf', agentId: 'rowan', mode: 'worktree' })),
  WorkspaceLeadPlan: scene((f) => leadPlan(f, { agentId: 'rowan' })),
  // Kernel's team updates in Rowan's chat (KERNEL-127). No PNG: the card follows the canvas card and note values.
  WorkspaceLeadUpdate: scene((f) => leadUpdate(f)),
  WorkspaceHire: scene((f) => ({
    ...scene2(f, { id: ids.lead, name: 'hire-a-designer', branch: 'main', baseRef: 'main', mode: 'current', agentId: 'rowan', stat: { files: 1, added: 28, removed: 0 } }, 'Hire a designer', [
      userMsg('h0', 'We need a designer on the team who checks every screen against DESIGN.md before review.'),
      { kind: 'thinking', id: 'h-th', ts: at(10, 28), text: 'This fits as a subagent with read access and the screenshot skill.' },
      tool('h-t1', 'Read DESIGN.md', 'cat DESIGN.md', { name: 'Read' }),
      { kind: 'text', id: 'h-tx', ts: at(10, 29), text: 'Here is the agent file. Once you approve, I will save it and Lumi joins the team.' }
    ], {
      approvals: [pending('agent', 'rowan', { workspaceId: ids.lead, title: 'Add lumi to the team', agentFile: { path: '.claude/agents/lumi.md', text: [
        '---', 'name: lumi', 'description: Designer. Checks every screen against DESIGN.md', '  before Theo reviews it. Flags spacing, type and color drift.', 'model: sonnet', 'tools: Read, Grep, Glob, Bash(pnpm screenshot:*)', '---'
      ].join('\n') } }), ...f.approvals]
    }, { plan: false, model: 'claude-opus-5-5' }),
    changes: { [ids.lead]: [{ path: '.claude/agents/lumi.md', status: 'A', added: 28, removed: 0 }] }
  })),
  WorkspacePRMenu: scene(() => ({ ui: { ...open, menu: 'pr' } })),
  WorkspaceDraftPR: prScene('draft', prTurn('d', ['# Create a pull request', 'Open as draft'], 5, 'Opened draft PR #42. Mark it ready when you want Theo to review.'), { prs: prInfo('draft') }),
  WorkspaceCIFailed: prScene('cifail', [
    ...prTurn('c', ['# Create a pull request', '1. Rebase on origin/main and run pnpm test'], 6, 'Opened PR #42.'),
    prNote('c-note', 'playwright failed on the PR: the download test timed out in CI.')
  ], {
    prs: prInfo('cifail', {
      checks: [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'typecheck', state: 'pass', meta: '31s' }, { name: 'vitest', state: 'pass', meta: '48s' }, { name: 'playwright', state: 'fail' }],
      comments: [
        { id: 'rc1', author: 'Theo', body: 'Empty state copy', resolved: true },
        { id: 'rc2', author: 'Theo', body: 'Shorten empty state copy', resolved: false }
      ]
    })
  }, 'checks'),
  WorkspaceChangesRequested: prScene('changes', [
    ...prTurn('r', ['# Create a pull request', '1. Rebase on origin/main and run pnpm test'], 6, 'Opened PR #42 and asked Theo for review.')
  ], {
    prs: prInfo('changes', {
      reviewDecision: 'changes',
      comments: [
        { id: 'rv1', author: 'Theo', path: 'src/app/invoices/table.tsx', line: 42, body: 'Use the shared EmptyState from components/ui.', resolved: false },
        { id: 'rv2', author: 'Theo', path: 'src/app/invoices/page.tsx', line: 18, body: 'Keep the skeleton up for at least 200ms to avoid flashing.', resolved: false }
      ]
    })
  }),
  WorkspaceMerged: prScene('merged', [
    ...prTurn('m', ['# Create a pull request', '1. Rebase on origin/main and run pnpm test', '2. Title it as a Conventional Commit'], 6, 'Opened PR #42. Theo approved it and every check passed.'),
    prNote('m-note', 'PR #42 was squashed into main.')
  ], { prs: prInfo('merged') }),
  WorkspacePRClosed: prScene('closed', [prNote('x-note', 'PR #42 was closed without merging on GitHub.')], { prs: prInfo('closed') }),
  // The PR header in the states the canvas above doesn't draw (KERNEL-274, design/redesign/Pr*.png).
  WorkspacePRNoChanges: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { prState: 'none', stat: { files: 0, added: 0, removed: 0 } }),
    changes: { [ids.table]: [] },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
  })),
  WorkspacePRNone: prScene('none', []),
  WorkspacePRCreating: prScene('creating', []),
  WorkspacePROpen: prScene('open', [], { prs: prInfo('open') }),
  WorkspaceRunScripts: runScripts(),
  WorkspacePRChecks: prScene('checks', [], { prs: prInfo('checks') }),
  WorkspacePRConflict: prScene('conflict', [], { prs: prInfo('conflict') }),
  WorkspacePRResolving: prScene('resolving', [], { prs: prInfo('resolving') }),
  WorkspacePRReady: prScene('ready', [], { prs: prInfo('ready') }),
  WorkspacePRMerging: prScene('merging', [], { prs: prInfo('merging') }),
  WorkspaceToast: prScene('merged', [], {
    prs: prInfo('merged'),
    ui: { toasts: [
      { id: 't1', title: 'PR #42 merged', sub: 'Squashed into main', action: { label: 'View', href: pr.prUrl } },
      { id: 't2', title: 'Copied', sub: 'Message copied to clipboard' }
    ] }
  }),
  WorkspacePaste: composing({
    parts: [
      { type: 'text', text: 'Staging breaks on the invoices page. Here is the log ' },
      { type: 'file', name: 'pasted_text_1.txt', lines: 212, text: pastedLog },
      { type: 'text', text: ' and what I see ' },
      { type: 'image', name: 'image.png', width: 1280, height: 800, dataUrl: screenshot }
    ],
    draft: ''
  }),
  WorkspaceContextRing: scene((f) => ({ chats: contextChat(f), ui: open })),
  WorkspaceContextPopover: scene((f) => ({ chats: contextChat(f), ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false, contextOpen: true } } })),
  WorkspaceMention: composing({ parts: [], draft: '@inv' }, { tree: { [ids.table]: mentionTree } }),
  WorkspaceSlash: composing({ parts: [], draft: '/' }, { skills }),
  WorkspaceQueued: scene((f) => ({
    items: { [ids.tableChat]: queuedItems() },
    queue: { [ids.tableChat]: [
      { id: 'q1', chatId: ids.tableChat, ts: at(10, 30), parts: [{ type: 'text', text: 'Also add a loading skeleton to the table' }] },
      { id: 'q2', chatId: ids.tableChat, ts: at(10, 31), parts: [{ type: 'text', text: 'Use the shared EmptyState component' }] }
    ] },
    push: [...f.push, { type: 'chat.running', chatId: ids.tableChat, running: true }],
    ui: open
  })),
  /** A brief held because every agent slot is in use (KERNEL-273). Not on the canvas, see docs/decisions/KERNEL-273.md. */
  WorkspaceQueuedCapacity: scene((f) => {
    const queue = [{ id: 'q1', chatId: ids.tableChat, ts: at(10, 30), parts: [{ type: 'text' as const, text: 'Build the loading skeleton from the plan' }] }]
    return {
      queue: { [ids.tableChat]: queue },
      push: [...f.push, { type: 'chat.queue', chatId: ids.tableChat, queue, why: 'capacity' }],
      ui: open
    }
  }),
  WorkspaceHunks: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { name: 'checkout-rounding', mode: 'current', branch: 'main', baseRef: 'main' }),
    items: { [ids.tableChat]: [
      { kind: 'user', id: 'h1', ts: at(10, 20), parts: [{ type: 'text', text: 'Fix the rounding bug in checkout totals.' }] },
      ...['Read checkout.ts', 'Find the callers', 'Edit checkout.ts', 'Run unit tests', 'Run the checkout flow', 'Read the diff', 'Run unit tests'].map((label, i) => tool(`ht${i}`, label, 'src/lib/checkout.ts')),
      { kind: 'text', id: 'h2', ts: at(10, 28), text: 'Fixed it. Totals now round once, at the end, instead of per line.' },
      { kind: 'result', id: 'h3', ts: at(10, 28), durationMs: 120_000, ok: true }
    ] },
    changes: { [ids.table]: [{ path: 'src/lib/checkout.ts', status: 'M', added: 9, removed: 3 }] },
    hunks: { [ids.table]: [hunk('agent', '40-52', 9, 3), hunk('mine', '12-18', 4, 1)] },
    ui: open
  }))
}
