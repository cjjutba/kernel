import type { PushEvent } from '@shared/ipc'
import type { Approval, AskedQuestion, Chat, ChatItem, Checkpoint, FileEntry, Hunk, PrInfo, ScriptTrust, SharedAnchor, SharedComment, SharedFile, SharedVersion, Skill, TeamUpdateRow, Thread, Workspace } from '@shared/types'
import type { Fixture } from './types'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { at, ids, scene, tableItems, withWorkspace } from './base'
import { downloadFlowMarkdown, fontsCheckImage, invoiceLayoutStill, invoicePdfStill, pdfNotesMarkdown, pricingStill } from './sharedStills'

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
const prNote = (id: string, text: string, pr: 'merged' | 'closed' | 'cifail'): ChatItem => ({ kind: 'note', id, ts: at(10, 40), text, pr })

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
      ...frontend.map((line): PushEvent => ({ type: 'script.output', workspaceId: ids.table, kind: 'run', name: 'frontend', lines: [{ line, stream: 'stdout' }] }))
    ]
  }
}

/**
 * KERNEL-250: the Checks tab of an open PR with the Open menu showing. The room has two preview URLs and `run` printed a third, so
 * the menu lists the named ones, a hairline and Detected. The workspace's first port is 4312 and `run` prints 4314.
 */
function preview(): Fixture {
  const open = prScene('open', [], {
    prs: prInfo('open', { checks: [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'typecheck', state: 'pass', meta: '31s' }, { name: 'vitest', state: 'pass', meta: '48s' }, { name: 'playwright', state: 'pass', meta: '2m 4s' }] })
  }, 'checks')
  const run = ['$ pnpm dev --port $KERNEL_PORT', 'Next.js ready on http://localhost:4314', 'Compiled /inbox', 'GET /inbox 200 in 84ms', 'GET /api/requests 200 in 31ms']
  return {
    ...open,
    roomSettings: { [ids.roomA]: {
      scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' },
      runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }],
      files: { copy: [] }, workspace: {},
      preview: { urls: [{ name: 'Web app', url: 'http://localhost:$KERNEL_PORT' }, { name: 'API docs', url: 'http://localhost:$((KERNEL_PORT + 1))/docs' }] }
    } },
    push: [
      ...open.push.filter((e) => e.type !== 'script.output' || e.kind !== 'run'),
      ...run.map((line): PushEvent => ({ type: 'script.output', workspaceId: ids.table, kind: 'run', lines: [{ line, stream: 'stdout' }] }))
    ],
    ui: { ...open.ui, menu: 'preview' }
  }
}

/**
 * KERNEL-251: the tab strip's + menu with every terminal preset, on the open PR the KERNEL-274 look draws. Codex is on the PATH, one custom
 * command is saved and a Codex terminal tab is open next to the chat.
 */
function terminalPresets(): Fixture {
  const open = prScene('open', [], { prs: prInfo('open') })
  return {
    ...open,
    chats: [...open.chats, extraChat('chat-term', 'Terminal (codex)', 'terminal')],
    settings: { ...DEFAULT_SETTINGS('/Users/you'), terminal: { ...DEFAULT_SETTINGS('/Users/you').terminal, custom: [{ id: 'custom-dev-server-logs', name: 'Dev server logs', command: 'tail -f logs/dev.log' }] } },
    terminalClis: [{ id: 'codex', name: 'Codex', command: 'codex', builtin: true, skipsPermissions: false }],
    ui: { ...open.ui, menu: 'newTab' }
  }
}

const prInfo = (prState: Workspace['prState'], o: Partial<PrInfo> = {}): Record<string, PrInfo> => ({
  [ids.table]: { workspaceId: ids.table, number: 42, url: pr.prUrl, title: prTitle, state: prState, baseRef: 'main', checks: [], comments: [], conflicts: [], ...o }
})

const EXIT_PLAN = [
  'Add "Download PDF" to the row actions menu', 'Call /api/invoices/:id/pdf and stream the file', 'Show progress on the item while it downloads', 'Toast on failure with a retry action', 'Playwright test for the download'
].map((t, i) => `${i + 1}. ${t}`).join('\n')

/** Three questions in one AskUserQuestion call: a single-select, a multi-select and a single-select. */
const DOWNLOAD_QUESTIONS: AskedQuestion[] = [
  { question: 'Should the download keep the invoice number in the file name?', header: 'File name', options: [{ label: 'Yes, invoice-009.pdf' }, { label: 'Add the client name, acme-invoice-009.pdf' }] },
  {
    question: 'Where should the Download PDF action appear?', header: 'Placement', multiSelect: true,
    options: [
      { label: 'Row actions menu', description: 'Next to Duplicate and Void on every invoice row.' },
      { label: 'Invoice detail header', description: 'Beside the status badge when an invoice is open.' },
      { label: 'Bulk actions bar', description: 'Download the selected invoices as one zip.' }
    ]
  },
  {
    question: 'What should happen when the download fails?', header: 'On failure',
    options: [{ label: 'Show a toast with a retry action' }, { label: 'Fail quietly and write it to the log' }]
  }
]

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

/**
 * A chat with the rows Claude Code's /context lists, adding up to the 200k window. `messages` sets how full it is: 44k is 34%, 132k is 78%, 160k is 92%.
 * Past the 167k auto compact line there is no free space left and the buffer shrinks to what remains.
 */
const contextChat = (f: Fixture, messages = 44_000) => {
  const max = 200_000
  const used = 3_200 + 11_800 + 6_400 + 2_600 + messages
  const free = Math.max(0, max - used - 33_000)
  return f.chats.map((c) => c.id === ids.tableChat ? {
    ...c,
    context: Math.round((used / max) * 100),
    contextUsage: { used, max, rows: [
      { name: 'System prompt', tokens: 3_200, kind: 'used' as const },
      { name: 'System tools', tokens: 11_800, kind: 'used' as const },
      { name: 'MCP tools', tokens: 6_400, kind: 'used' as const },
      { name: 'Memory files', tokens: 2_600, kind: 'used' as const },
      { name: 'Messages', tokens: messages, kind: 'used' as const },
      { name: 'Free space', tokens: free, kind: 'free' as const },
      { name: 'Autocompact buffer', tokens: max - used - free, kind: 'buffer' as const }
    ] }
  } : c)
}

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

/** What Rowan sends with request_plan_approval (KERNEL-373): a write-up in `detail`, next to `steps`. */
const LEAD_PLAN = [
  '# Export invoices as PDF',
  '',
  'Invoices get a PDF renderer and a Download PDF action in each row. Four tasks, run in parallel, and Theo reviews each PR as it lands.',
  '',
  'T-15b needs the renderer from T-15a to merge first, since both change `row-actions.tsx`. Each PR runs `pnpm test`, `pnpm typecheck` and `pnpm shots`.'
].join('\n')

/** Rowan's plan for T-15 waiting on you in plan mode, in the Lead's chat: its write-up, then one row per task. */
const planWaiting = (f: Fixture): Partial<Fixture> => leadPlan(f, { agentId: 'rowan' }, { detail: LEAD_PLAN })

/** The same plan once approved: it keeps its place with its Plan approved line, plan mode is off and each task has a workspace to open. */
const planApproved = (f: Fixture): Partial<Fixture> => {
  const s = planWaiting(f)
  const reply: ChatItem = { kind: 'text', id: 'pl-go', ts: at(10, 31), text: 'Handed off. Noor has the renderer, Kai has the button and Ivy has the tests. Theo reviews each PR as it lands.' }
  return {
    ...s,
    chats: s.chats?.map((c) => (c.id === ids.leadChat ? { ...c, plan: false } : c)),
    approvals: s.approvals?.map((a, i) => (i === 0 ? { ...a, status: 'allowed' as const, steps: a.steps?.map((st, j) => ({ ...st, workspaceId: `ws-t15-${j}` })) } : a)),
    items: { [ids.leadChat]: [...(s.items?.[ids.leadChat] ?? []), reply] }
  }
}

/** Kai's plan for T-15b from ExitPlanMode, waiting on you in plan mode: markdown in `detail` and `input`, no `steps` (KERNEL-374). */
const planExit = (f: Fixture): Partial<Fixture> => scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Plan T-15b', [
  userMsg('pl1', 'Plan T-15b: a Download PDF button on each invoice row. Do not edit anything yet.'),
  { kind: 'thinking', id: 'pl-th', ts: at(10, 28), text: 'Row actions already live in a menu. A second button would crowd the row.' },
  tool('pl-t1', 'Read the row actions', 'cat src/app/invoices/row-actions.tsx', { name: 'Read' }),
  tool('pl-t2', 'Check the PDF endpoint', 'rg -n "renderInvoicePdf" src')
], {
  approvals: [pending('plan', 'kai', { toolName: 'ExitPlanMode', input: { plan: EXIT_PLAN }, title: 'Plan for invoice-pdf-button', detail: EXIT_PLAN }), ...f.approvals]
}, { plan: true, model: 'claude-opus-5-5' })

/** The same chat in plan mode with nothing waiting: Kai answered and the box waits for the next message. */
const planMode = (f: Fixture): Partial<Fixture> => {
  // scene2 sets approvals from the ones a scene passes. This one passes none and keeps the seed's.
  const { approvals: _none, ...patch } = scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Invoice row actions', [
    userMsg('pm1', 'Look at how the invoice rows show their actions.'),
    tool('pm-t1', 'Read the row actions', 'cat src/app/invoices/row-actions.tsx', { name: 'Read' }),
    { kind: 'text', id: 'pm-reply', ts: at(10, 28), text: 'Each row ends in a menu with Duplicate, Send and Void. A new action fits there without crowding the row.' },
    { kind: 'result', id: 'pm-res', ts: at(10, 28), durationMs: 24_000, ok: true }
  ], {}, { plan: true, model: 'claude-opus-5-5' })
  return patch
}

/** A fixture with a draft in the box. */
const withDraft = (p: Partial<Fixture>, draft: string): Partial<Fixture> =>
  ({ ...p, ui: { ...p.ui, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false, composer: { parts: [], draft } } } })

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
const leadPlan = (f: Fixture, ws: Partial<Workspace>, plan: Partial<Approval> = {}): Partial<Fixture> => ({
  ...scene2(f, { id: ids.lead, stat: { files: 1, added: 64, removed: 0 }, ...ws }, 'Export invoices as PDF', [
    userMsg('l1', 'Add PDF export to invoices. Spec first.'),
    { kind: 'thinking', id: 'l-th', ts: at(10, 28), text: 'Renderer, button, tests and review can run in parallel.' },
    tool('l-t1', 'Read the invoices module', 'cat src/app/invoices/page.tsx', { name: 'Read' }),
    tool('l-t2', 'Write the plan', 'cat > plans/t-15-invoice-pdf.md', { name: 'Write' }),
    { kind: 'text', id: 'l-tx', ts: at(10, 29), text: 'I split PDF export into four tasks that can run in parallel. Approve it and I will hand them out.' }
  ], {
    approvals: [pending('plan', 'rowan', { workspaceId: ids.lead, title: 'Plan for T-15', steps: T15_STEPS, ...plan }), ...f.approvals]
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

// ---------- Shared files (KERNEL-305)

const HOUR = 3_600_000
const sharedVersion = (n: number, h: number, m: number, mime: string, extra: Partial<SharedVersion> = {}): SharedVersion =>
  ({ n, at: at(h, m), file: `v${n}`, mime, bytes: 48_000, sha256: `${mime}-${n}`, thumb: true, ...extra })
const sharedFile = (id: string, agentId: string, workspaceId: string, title: string, kind: SharedFile['kind'], source: string, versions: SharedVersion[], ago: number): SharedFile =>
  ({ id, roomId: ids.roomA, workspaceId, agentId, source, title, kind, versions, createdAt: versions[0].at, updatedAt: Date.now() - ago })

/**
 * The five files the canvas shares, newest first. Noor shares four in the PDF renderer's workspace and Kai one in org-invites. `html` is
 * on v3 unless a shot draws the chat card, which says v2 because that is the newest version the file has there. Times in the
 * panel are relative to now, so they read 2h to 1d on any day, and the clocks in the tab are fixed.
 */
export const sharedFiles = (htmlLatest = 3): SharedFile[] => [
  sharedFile('sh-html', 'noor', ids.table, 'Invoice layout options', 'html', '.kernel/shared/invoice-layout.html', [
    sharedVersion(1, 13, 12, 'text/html', { outside: 1 }), sharedVersion(2, 13, 58, 'text/html', { note: 'Totals moved under the table', outside: 1 }),
    sharedVersion(3, 14, 41, 'text/html', { note: 'Added the detailed layout', outside: 1 })
  ].slice(0, htmlLatest), 2 * HOUR),
  sharedFile('sh-image', 'noor', ids.table, 'Embedded fonts check', 'image', '.kernel/shared/fonts-check.png', [sharedVersion(1, 13, 20, 'image/png', { width: 616, height: 385 })], 3 * HOUR),
  sharedFile('sh-pdf', 'noor', ids.table, 'Invoice 009 sample', 'pdf', '.kernel/shared/invoices-009.pdf', [sharedVersion(1, 12, 5, 'application/pdf')], 4 * HOUR),
  sharedFile('sh-md', 'noor', ids.table, 'PDF renderer notes', 'markdown', '.kernel/shared/notes.md', [
    sharedVersion(1, 10, 52, 'text/markdown', { thumb: false }), sharedVersion(2, 11, 48, 'text/markdown', { note: 'Added the open questions', thumb: false })
  ], 5 * HOUR),
  sharedFile('sh-flow', 'kai', ids.invites, 'Download button flow', 'markdown', '.kernel/shared/download-flow.md', [sharedVersion(1, 9, 12, 'text/markdown', { thumb: false })], 24 * HOUR)
]
export const sharedStills: NonNullable<Fixture['sharedData']> = {
  'sh-html': { 1: { text: '', thumb: invoiceLayoutStill }, 2: { text: '', thumb: invoiceLayoutStill }, 3: { text: '', thumb: invoiceLayoutStill } },
  'sh-image': { 1: { dataUrl: fontsCheckImage, thumb: fontsCheckImage } },
  'sh-pdf': { 1: { dataUrl: invoicePdfStill, thumb: invoicePdfStill } },
  'sh-md': { 1: { text: pdfNotesMarkdown }, 2: { text: pdfNotesMarkdown } },
  'sh-flow': { 1: { text: downloadFlowMarkdown } }
}

/** Noor's workspace on the canvas: invoice-pdf-renderer, whose chat shared the layout, a sample PDF and the notes. */
const renderer = (f: Fixture) => ({
  workspaces: withWorkspace(f, ids.table, { name: 'invoice-pdf-renderer', branch: 'feat/t-15a-pdf-renderer', agentId: 'noor', stat: { files: 2, added: 194, removed: 1 } }),
  chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: 'PDF renderer' } : c)),
  items: { [ids.tableChat]: [
    userMsg('sh-u', 'Show me the invoice layout as a page I can click through.'),
    { kind: 'text' as const, id: 'sh-t', ts: at(14, 41), text: 'Here is the layout as a page, with a sample PDF and my notes so far.' },
    { kind: 'shared' as const, id: 'sh-i1', ts: at(14, 41), sharedId: 'sh-html', version: 2 },
    { kind: 'shared' as const, id: 'sh-i2', ts: at(14, 42), sharedId: 'sh-pdf', version: 1 },
    { kind: 'shared' as const, id: 'sh-i3', ts: at(14, 42), sharedId: 'sh-md', version: 2 }
  ] },
  changes: { [ids.table]: [{ path: 'src/pdf/render.ts', status: 'A' as const, added: 188, removed: 0 }, { path: 'src/db/schema.ts', status: 'M' as const, added: 6, removed: 1 }] },
  sharedData: sharedStills
})

/** The chat card shots show v2 of the page, the tab shots its three versions. `file` is the shared id the tab opens on. */
const sharedTab = (file?: string, htmlLatest = 3) => scene((f) => ({
  ...renderer(f),
  shared: sharedFiles(htmlLatest).filter((x) => x.workspaceId === ids.table),
  ui: {
    ...open,
    workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false },
    ...(file ? { tabs: { [ids.table]: { tab: `shared:${file}`, lastChat: ids.tableChat, files: [], diffs: [], shared: [file] } } } : {})
  }
}))

// Comment mode on a shared file (KERNEL-311). The canvas comments on a pricing page Noor shared, so these shots swap it in for the invoice layout.
// A fixture run has no live page: `sharedHits` is what `system.preview.hit` finds, and the pins come from `sharedComments`.
const pricingFile = (latest = 2): SharedFile => sharedFile('sh-pricing', 'noor', ids.table, 'Pricing page draft', 'html', '.kernel/shared/pricing.html', [
  sharedVersion(1, 14, 20, 'text/html'), sharedVersion(2, 15, 7, 'text/html', { note: 'Prices are placeholders' }), sharedVersion(3, 15, 32, 'text/html', { note: 'Added the Team plan' })
].slice(0, latest), HOUR)
const commentFiles = (latest = 2): SharedFile[] => [pricingFile(latest), ...sharedFiles().filter((x) => x.id !== 'sh-html')]
const commentData: NonNullable<Fixture['sharedData']> = {
  ...sharedStills,
  'sh-pricing': { 1: { text: '', thumb: pricingStill }, 2: { text: '', thumb: pricingStill }, 3: { text: '', thumb: pricingStill } }
}
const WINDOW = { width: 1280, height: 800, scrollY: 0 }
const pricingHits: SharedAnchor[] = [
  { x: 412, y: 188, viewport: WINDOW, element: { selector: 'section.hero > div.actions > button.cta', tag: 'button', text: 'Start free trial', rect: { x: 40, y: 160, width: 120, height: 36 } } },
  { x: 880, y: 300, viewport: WINDOW, element: { selector: 'section.plans > div.plan:nth-of-type(3)', tag: 'div', text: 'Team $49 per month Five seats Shared client list', rect: { x: 501, y: 225, width: 216, height: 149 } } }
]
const comment = (id: string, sharedId: string, version: number, note: string, anchor: SharedAnchor): SharedComment =>
  ({ id, sharedId, version, at: at(15, 8), note, anchor, chatId: ids.tableChat, itemId: `${id}-item` })
const commentNotes: SharedComment[] = [
  comment('cm-1', 'sh-pricing', 2, 'Tighten this headline.', { x: 503, y: 88, viewport: WINDOW, element: { selector: 'section.hero > h1', tag: 'h1', text: 'Invoicing that gets out of the way', rect: { x: 40, y: 68, width: 520, height: 36 } } }),
  comment('cm-2', 'sh-pricing', 2, 'Make this one an outline.', { x: 256, y: 157, viewport: WINDOW, element: { selector: 'section.hero > div.actions > button:nth-of-type(2)', tag: 'button', text: 'See plans', rect: { x: 170, y: 160, width: 100, height: 36 } } }),
  comment('cm-3', 'sh-image', 1, 'This weight looks too light.', { x: 449, y: 234, viewport: { width: 616, height: 385, scrollY: 0 } }),
  comment('cm-4', 'sh-image', 1, 'The digits need more space.', { x: 481, y: 342, viewport: { width: 616, height: 385, scrollY: 0 } })
]

/** Noor's workspace with one of the two files open in a tab, in comment shots. `latest` is how many versions the page has. */
const commentTab = (file: 'sh-pricing' | 'sh-image', latest = 2, picked?: number) => scene((f) => ({
  ...renderer(f),
  shared: commentFiles(latest).filter((x) => x.workspaceId === ids.table),
  sharedData: commentData,
  sharedComments: commentNotes,
  sharedHits: pricingHits,
  ui: {
    ...open,
    workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false },
    tabs: { [ids.table]: { tab: `shared:${file}`, lastChat: ids.tableChat, files: [], diffs: [], shared: [file], ...(picked ? { sharedVersion: { [file]: picked } } : {}) } }
  }
}))

/** The comment as the agent got it, in the chat after Send (WorkspaceSharedCommentSent). */
const commentSent = scene((f) => ({
  ...renderer(f),
  items: { [ids.tableChat]: [
    userMsg('cs-u', 'Draft the pricing page so I can click through it.'),
    { kind: 'text' as const, id: 'cs-t', ts: at(15, 7), text: 'Here is the pricing page draft. The prices are placeholders.' },
    {
      kind: 'user' as const, id: 'cs-c', ts: at(15, 9), parts: [
        { type: 'text' as const, text: 'Comment on "Pricing page draft" v2 (.kernel/shared/pricing.html).\nWhere: the <button> "Start free trial" (section.hero > div.actions > button.cta), at 412, 188 in a 1280 px wide window.\n> Make this button the same blue as the header.' },
        { type: 'image' as const, name: 'pricing-page-draft-v2-comment.png', width: 320, height: 200 }
      ]
    }
  ] },
  shared: commentFiles().filter((x) => x.workspaceId === ids.table),
  sharedData: commentData,
  ui: {
    ...open,
    workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false },
    tabs: { [ids.table]: { tab: ids.tableChat, lastChat: ids.tableChat, files: [], diffs: [], shared: ['sh-pricing'] } },
    toasts: [{ id: 'cs-toast', title: 'Sent to Noor', action: { label: 'Open chat', tab: { workspaceId: ids.table, id: ids.tableChat } } }]
  }
}))

/** Rowan's workspace, with the page Noor shared from a workspace that has been archived since (WorkspaceSharedCommentArchived). */
const commentArchived = (f: Fixture): Partial<Fixture> => {
  const p = sharedPanel(f)
  return {
    ...p,
    workspaces: (p.workspaces ?? f.workspaces).map((w) => (w.id === ids.table ? { ...w, status: 'archived' as const } : w)),
    shared: commentFiles(),
    sharedData: commentData,
    sharedComments: commentNotes,
    sharedHits: pricingHits,
    ui: { ...p.ui, tabs: { [ids.lead]: { tab: 'shared:sh-pricing', lastChat: ids.leadChat, files: [], diffs: [], shared: ['sh-pricing'] } } }
  }
}

/** Rowan's workspace with the room's five files, the HTML open in a tab. The Lead's panel lists every file shared in the room. */
const sharedPanel = (f: Fixture): Partial<Fixture> => {
  // scene2 sets approvals only when it is given some; an undefined one would hide the seed's.
  const { approvals: _none, ...lead } = scene2(f, { id: ids.lead, name: 'export-invoices-as-pdf', branch: 'feat/export-invoices-as-pdf', mode: 'worktree', lead: undefined, agentId: 'rowan', stat: { files: 1, added: 64, removed: 0 } }, 'Export invoices as PDF', [
    userMsg('sp-u', 'Add PDF export to invoices. Spec first.'),
    { kind: 'text', id: 'sp-t', ts: at(14, 41), text: 'I split PDF export into four tasks. Noor shared the layout, a sample and the notes in the meantime.' }
  ], {}, { model: 'claude-opus-5-5' })
  return {
    ...lead,
    changes: { [ids.lead]: [{ path: 'plans/t-15-invoice-pdf.md', status: 'A', added: 64, removed: 0 }] },
    shared: sharedFiles(),
    sharedData: sharedStills,
    ui: {
      route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'shared', bottom: 'run', checkpoints: false, toolsOpen: false },
      tabs: { [ids.lead]: { tab: 'shared:sh-html', lastChat: ids.leadChat, files: [], diffs: [], shared: ['sh-html'] } }
    }
  }
}

/** Kernel's Team update in Rowan's chat with a file under each of two teammates (TeamUpdateShared.png). */
const teamUpdateShared = (f: Fixture): Partial<Fixture> => {
  const header = 'Team update from Kernel, not from the user.'
  const noor: TeamUpdateRow = {
    workspaceId: ids.table, agentId: 'noor', name: 'Noor', task: 'KERNEL-188 PDF renderer with embedded fonts',
    events: [{ kind: 'turn', text: 'Finished a turn', actionable: false }],
    reply: "The layout options are ready as a page you can click through, and I rendered a sample PDF from the compact one. I'd go with compact, since the line items stay readable at twelve rows.",
    shared: [{ sharedId: 'sh-html', version: 3, title: 'Invoice layout options', kind: 'html' }]
  }
  const kai: TeamUpdateRow = {
    workspaceId: ids.invites, agentId: 'kai', name: 'Kai', task: 'KERNEL-189 Download PDF in the row actions',
    events: [{ kind: 'turn', text: 'Finished a turn', actionable: false }],
    reply: 'The button flow is written up in a short note, so you can check the states before I build them.',
    shared: [{ sharedId: 'sh-flow', version: 1, title: 'Download button flow', kind: 'markdown' }]
  }
  const rows = [noor, kai]
  const update: ChatItem = {
    kind: 'user', id: 'tus-u', ts: at(14, 41), from: 'kernel', update: { rows },
    parts: [{ type: 'text', text: [header, '', ...rows.flatMap((r) => [`${r.name} (${r.agentId}) · ${r.task} · workspace ${r.workspaceId}`, ...r.events.map((e) => `- ${e.text}.`), ...(r.shared ?? []).map((x) => `- Shared "${x.title}" (v${x.version}).`), '']), 'To do:', '- Look at both files, then tell the user what you found.'].join('\n') }]
  }
  const s = scene2(f, { id: ids.lead, agentId: 'rowan' }, 'Composer focus', [
    update,
    { kind: 'text', id: 'tus-r', ts: at(14, 42), text: "Noor shared the invoice layouts and Kai shared a note on the download button. I'll look at both before I pass anything on." },
    { kind: 'result', id: 'tus-res', ts: at(14, 42), durationMs: 45_000, ok: true }
  ], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  return { ...rest, shared: sharedFiles(), sharedData: sharedStills }
}

// ---------- Lead chats that hold several tabs (KERNEL-338)

const GROUPED = { export: 't-export', table: 't-table', login: 't-login', demo: 't-demo', csv: 't-csv' } as const
const groupedThread = (id: string, title: string, m: number): Thread => ({ id, roomId: ids.roomA, title, createdAt: at(9, m) })
/** A tab of the Lead's workspace in the Lead chat `threadId`. */
const leadTab = (id: string, threadId: string, title: string, m: number, over: Partial<Chat> = {}): Chat =>
  ({ id, workspaceId: ids.lead, title, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, threadId, createdAt: at(9, m), ...over })
/** A workspace the Lead's chat `threadId` handed off, from its first tab. */
const handedOff = (id: string, name: string, task: string, agentId: string, port: number, over: Partial<Workspace> = {}): Workspace =>
  ({ id, roomId: ids.roomA, name, branch: `feat/${task}-${name}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/client-a/${name}`, mode: 'worktree', agentId, port, status: 'ready', prState: 'none', createdAt: at(10, 2), threadId: GROUPED.export, leadChatId: ids.leadChat, ...over })

const T15_STEPS = [
  { title: 'T-15a PDF renderer with embedded fonts', taskId: 'T-15a', agentId: 'noor' }, { title: 'T-15b Download PDF in the row actions', taskId: 'T-15b', agentId: 'kai' },
  { title: 'T-15c Snapshot tests for three invoice types', taskId: 'T-15c', agentId: 'ivy' }, { title: 'T-15d Review each PR as it lands', taskId: 'T-15d', agentId: 'theo' }
]

/** The first tab of the Export chat: the plan Rowan wrote and you approved, then the hand-off. */
const exportItems = (): ChatItem[] => [
  userMsg('g1', 'Add PDF export to invoices. Spec first.'),
  { kind: 'thinking', id: 'g1-th', ts: at(10, 8), text: 'Renderer, button, tests and review can run in parallel.' },
  tool('g1-t1', 'Read the invoices module', 'cat src/app/invoices/page.tsx', { name: 'Read' }),
  tool('g1-t2', 'Write the plan', 'cat > plans/t-15-invoice-pdf.md', { name: 'Write' }),
  { kind: 'text', id: 'g1-tx', ts: at(10, 9), text: 'I split PDF export into four tasks that can run in parallel.' },
  { kind: 'approval', id: 'approval-ap-plan-rowan', ts: at(10, 12), approvalId: 'ap-plan-rowan' },
  { kind: 'text', id: 'g1-done', ts: at(10, 13), text: 'Handed off. Noor has the renderer, Kai has the button and Ivy has the tests. Theo reviews each PR as it lands.' }
]

/** The Lead's workspace on the sidebar the Grouped PNGs share: four Lead chats, two of them with several tabs, and their workspaces. Each shot picks what is open. */
export function grouped(f: Fixture, o: { tab?: string; files?: string[]; right?: 'changes' | 'files'; running?: string[]; items?: Record<string, ChatItem[]>; chats?: (c: Chat[]) => Chat[]; threads?: (t: Thread[]) => Thread[] } = {}): Partial<Fixture> {
  const T = GROUPED
  const chats = [
    leadTab(ids.leadChat, T.export, 'Export invoices as PDF', 5),
    leadTab('chat-kai-pr', T.export, "How is Kai's PR going?", 6),
    leadTab('chat-per-client', T.export, 'One PDF per client', 7),
    leadTab('chat-table', T.table, 'Invoice table and empty states', 8),
    leadTab('chat-table-copy', T.table, 'Empty state copy', 9),
    leadTab('chat-login', T.login, 'Client portal login', 10),
    leadTab('chat-login-redirect', T.login, 'Fix the login redirect', 11),
    leadTab('chat-demo', T.demo, 'Seed realistic demo data', 12)
  ]
  const threads = [
    groupedThread(T.export, 'Export invoices as PDF', 5), groupedThread(T.table, 'Invoice table and empty states', 8),
    groupedThread(T.login, 'Client portal login', 10), groupedThread(T.demo, 'Seed realistic demo data', 12)
  ]
  const plan: Approval = { ...pending('plan', 'rowan', { workspaceId: ids.lead, chatId: ids.leadChat, title: 'Plan for T-15', steps: T15_STEPS }), status: 'allowed', createdAt: at(10, 12) }
  const tab = o.tab ?? ids.leadChat
  const handed: Workspace[] = [
    handedOff('ws-pdf-renderer', 'invoice-pdf-renderer', 't-15a', 'noor', 4320, { stat: { files: 3, added: 188, removed: 0 } }),
    handedOff('ws-pdf-button', 'invoice-pdf-button', 't-15b', 'kai', 4321, { prNumber: 43, prUrl: 'https://github.com/samrivera/client-a/pull/43', prState: 'open' }),
    handedOff('ws-pdf-tests', 'invoice-pdf-tests', 't-15c', 'ivy', 4322, { stat: { files: 2, added: 138, removed: 9 } })
  ]
  return {
    threads: (o.threads ?? ((t) => t))(threads),
    // The seed's single Lead chat gives way to the tabs above. The table and schema workspaces were handed off by the table chat.
    chats: [...(o.chats ?? ((c) => c))(chats), ...f.chats.filter((c) => c.workspaceId !== ids.lead)],
    workspaces: [...withWorkspace(f, ids.table, { threadId: T.table }).map((w) => (w.id === ids.schema ? { ...w, threadId: T.table, stat: { files: 2, added: 54, removed: 6 } } : w)), ...handed],
    items: { [ids.leadChat]: exportItems(), [ids.tableChat]: [], ...o.items },
    approvals: [plan, ...f.approvals],
    push: [...f.push, ...(o.running ?? ['chat-table']).map((chatId): PushEvent => ({ type: 'chat.running', chatId, running: true }))],
    // The Lead works on the main checkout, so no file differs from the base.
    tree: { ...f.tree, [ids.lead]: (f.tree?.[ids.table] ?? []).map(({ status: _s, ...e }) => e) },
    fileText: { ...f.fileText, [ids.lead]: f.fileText?.[ids.table] ?? {} },
    ui: {
      route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: o.right ?? 'changes', bottom: 'run', checkpoints: false, toolsOpen: false },
      tabs: { [ids.lead]: { tab, lastChat: tab.startsWith('file:') ? undefined : tab, files: o.files ?? [], diffs: [] } }
    }
  }
}

/** Rowan, mid-turn `ago` seconds in, as the running tabs of the Grouped shots show it. */
const groupedTurn = (id: string, ago: number, ask: string, thought: string, tools: ChatItem[], reply?: string): ChatItem[] => [
  { ...userMsg(id, ask), ts: Date.now() - ago * 1000 }, { kind: 'thinking', id: `${id}-th`, ts: at(10, 28), text: thought }, ...tools, ...(reply ? [{ kind: 'text' as const, id: `${id}-tx`, ts: at(10, 29), text: reply }] : [])
]

/** What a freshly cloned repo's settings.toml asks the user to trust (KERNEL-209, KERNEL-218). */
export const scriptTrust: ScriptTrust = {
  roomId: ids.roomA, hash: 'a41f0c9e', workspaceIds: [ids.table],
  scripts: { setup: 'pnpm install --frozen-lockfile\ncp ../../.env.local .env.local', run: 'pnpm dev --port $KERNEL_PORT', archive: 'pnpm clean' },
  runScripts: [{ name: 'storybook', command: 'pnpm storybook --port $KERNEL_PORT' }],
  copy: ['.env.local', 'certs/*.pem']
}

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
  // KERNEL-218: KERNEL-209 holds the workspace until the room's scripts are trusted. The brief waits in the queue.
  WorkspaceTrustHeld: scene((f) => {
    const queue = [{ id: 'q-trust', chatId: ids.tableChat, parts: [{ type: 'text' as const, text: 'Build the invoice table.' }], ts: at(10, 2) }]
    return {
      workspaces: withWorkspace(f, ids.table, { status: 'trust' }),
      items: { [ids.tableChat]: [] },
      queue: { [ids.tableChat]: queue },
      push: [...f.push, { type: 'room.trust', roomId: ids.roomA, trust: scriptTrust }, { type: 'chat.queue', chatId: ids.tableChat, queue, why: 'setup' }],
      ui: open
    }
  }),
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
  // The "..." menu under Kai's summary, open: both forks (KERNEL-346). The time and the actions share the summary's last line.
  WorkspaceReplyMenu: scene(() => ({ ui: { ...open, menu: 'reply:x1' } })),
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
  WorkspacePlan: scene(planWaiting),
  WorkspacePlanApproved: scene(planApproved),
  WorkspacePlanExit: scene(planExit),
  // The other plan mode states (KERNEL-322, design/redesign/PlanStates.png). The typing shots also focus the box (scripts/shots.ts).
  WorkspacePlanMode: scene((f) => planMode(f)),
  WorkspacePlanModeTyping: scene((f) => withDraft(planMode(f), 'Plan the Download PDF action for the row menu. Do not edit anything yet.')),
  WorkspacePlanTyping: scene((f) => withDraft(planWaiting(f), 'Split step 2 into its own PR, after step 1 merges.')),
  WorkspaceQuestion: scene((f) => scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Download button', [
    userMsg('q1', 'Build T-15b from the approved plan.', true),
    ...folded('q', 6, 0),
    { kind: 'result', id: 'q-res', ts: at(10, 29), durationMs: 60_000, ok: true }
  ], {
    approvals: [pending('question', 'kai', { title: 'Should the download keep the invoice number in the file name?', options: ['Yes, invoice-009.pdf', 'Add the client name, acme-invoice-009.pdf'] }), ...f.approvals]
  })),
  WorkspaceQuestionSteps: scene((f) => scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Download button', [
    userMsg('qs1', 'Build T-15b from the approved plan.', true),
    ...folded('qs', 6, 0),
    { kind: 'result', id: 'qs-res', ts: at(10, 29), durationMs: 60_000, ok: true }
  ], {
    approvals: [pending('question', 'kai', { title: DOWNLOAD_QUESTIONS[0].question, options: DOWNLOAD_QUESTIONS[0].options.map((o) => o.label), questions: DOWNLOAD_QUESTIONS }), ...f.approvals]
  })),
  // Drawn on question 3 with the first two answered and Something else typed; the step and the typing are local to the card (scripts/shots.ts).
  WorkspaceQuestionOther: scene((f) => scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Download button', [
    userMsg('qo1', 'Build T-15b from the approved plan.', true),
    ...folded('qo', 6, 0),
    { kind: 'result', id: 'qo-res', ts: at(10, 29), durationMs: 60_000, ok: true }
  ], {
    approvals: [pending('question', 'kai', { title: DOWNLOAD_QUESTIONS[0].question, options: DOWNLOAD_QUESTIONS[0].options.map((o) => o.label), questions: DOWNLOAD_QUESTIONS }), ...f.approvals]
  })),
  // The card keeps its place in the transcript once answered, and the agent's reply comes after it.
  WorkspaceQuestionAnswers: scene((f) => {
    const s = scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Download button', [
      userMsg('qa1', 'Build T-15b from the approved plan.', true),
      ...folded('qa', 6, 0),
      { kind: 'result', id: 'qa-res', ts: at(10, 29), durationMs: 60_000, ok: true }
    ], {
      approvals: [{
        ...pending('question', 'kai', { title: DOWNLOAD_QUESTIONS[0].question, options: DOWNLOAD_QUESTIONS[0].options.map((o) => o.label), questions: DOWNLOAD_QUESTIONS }),
        status: 'answered',
        answer: 'Yes, invoice-009.pdf · Row actions menu, Invoice detail header · Show a toast with a retry action',
        answers: {
          [DOWNLOAD_QUESTIONS[0].question]: 'Yes, invoice-009.pdf',
          [DOWNLOAD_QUESTIONS[1].question]: 'Row actions menu, Invoice detail header',
          [DOWNLOAD_QUESTIONS[2].question]: 'Show a toast with a retry action'
        }
      }, ...f.approvals]
    })
    const reply: ChatItem[] = [
      { kind: 'text', id: 'qa-reply', ts: at(10, 31), text: 'Got it. I will keep the invoice number in the file name, add Download PDF to the row menu and the invoice header, and show a toast with a retry if it fails.' }
    ]
    return { ...s, items: { [ids.tableChat]: [...(s.items?.[ids.tableChat] ?? []), ...reply] } }
  }),
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
  WorkspaceLead: scene((f) => leadPlan(f, { name: 'export-invoices-as-pdf', branch: 'feat/export-invoices-as-pdf', agentId: 'rowan', mode: 'worktree', lead: undefined })),
  WorkspaceLeadPlan: scene((f) => leadPlan(f, { agentId: 'rowan' })),
  // Kernel's team updates in Rowan's chat (KERNEL-127). No PNG: the card follows the canvas card and note values.
  WorkspaceLeadUpdate: scene((f) => leadUpdate(f)),
  // Lead chats that hold several tabs (KERNEL-338). The sidebar lists one row per chat, and the tab row shows that chat's tabs.
  GroupedNewChat: scene((f) => {
    const csv = leadTab('chat-csv', GROUPED.csv, 'Add CSV export', 13, { plan: true })
    const g = grouped(f, {
      tab: csv.id, running: ['chat-table', csv.id], chats: (c) => [...c, csv], threads: (t) => [...t, groupedThread(GROUPED.csv, 'Add CSV export', 13)],
      items: { [csv.id]: groupedTurn('csv', 9, 'Add CSV export next to the PDF one. Spec first.', 'PDF export already lives in the row actions. CSV can sit in the same menu.', [tool('csv-t1', 'Read the invoices module', 'cat src/app/invoices/page.tsx', { name: 'Read' })]) }
    })
    return g
  }),
  GroupedTabs: scene((f) => grouped(f)),
  GroupedSwitchChat: scene((f) => grouped(f, {
    tab: 'chat-table', right: 'files', files: ['src/app/invoices/table.tsx'],
    items: { 'chat-table': groupedTurn('gt', 38, 'Build the invoice table with sorting, plus the empty, loading and error states.', 'The table and the schema change are independent. Kai and Noor can start together.', [
      tool('gt-t1', 'Write the plan', 'cat > plans/t-14-invoice-table.md', { name: 'Write' })
    ], 'Kai has the table and its states. Noor has the schema change the table needs. I will tell you when either opens a PR.').concat([
      tool('gt-t2', 'Check on Kai and Noor', 'kernel workspaces')
    ]) }
  })),
  GroupedNewTabMenu: scene((f) => { const g = grouped(f); return { ...g, ui: { ...g.ui!, menu: 'newTab' } } }),
  GroupedSharedWork: scene((f) => grouped(f, {
    tab: 'chat-kai-pr',
    items: { 'chat-kai-pr': [
      userMsg('sw', "How is Kai's PR going?"),
      tool('sw-t1', "List this chat's workspaces", 'kernel workspaces', { name: 'Bash' }),
      tool('sw-t2', 'Read the approved plan', 'cat plans/t-15-invoice-pdf.md', { name: 'Read' }),
      { kind: 'text', id: 'sw-tx', ts: at(10, 56), text: [
        "Kai's PR is open as #43 on invoice-pdf-button. Checks pass and Theo is reviewing it. Here is where your other workspaces in this chat stand.", '',
        '**Your workspaces in this chat**', '', '```', 'invoice-pdf-renderer  Noor  working', 'invoice-pdf-button    Kai   PR #43 open', 'invoice-pdf-tests     Ivy   waiting on the renderer', '```', '',
        '**From the plan you approved in the first tab**', '', '1. T-15a PDF renderer with embedded fonts · Noor', '2. T-15b Download PDF in the row actions · Kai', '3. T-15c Snapshot tests for three invoice types · Ivy'
      ].join('\n') },
      { kind: 'result', id: 'sw-res', ts: at(10, 56), durationMs: 11_000, ok: true }
    ] }
  })),
  GroupedContextFull: scene((f) => grouped(f, { chats: (c) => c.map((x) => (x.id === ids.leadChat ? { ...x, context: 92 } : x)) })),
  // The same chat after New tab in the banner: a fourth tab, empty, in the same chat.
  GroupedContextFullAfter: scene((f) => grouped(f, { tab: 'chat-new', chats: (c) => [...c.slice(0, 3), leadTab('chat-new', GROUPED.export, 'New tab', 14), ...c.slice(3)] })),
  // Kai finished in the first tab, which you closed since. The update goes to a tab that is still open, and says where the work came from.
  GroupedUpdateRouted: scene((f) => {
    const row: TeamUpdateRow = {
      workspaceId: 'ws-pdf-button', agentId: 'kai', name: 'Kai', task: 'T-15b Download PDF in the row actions', prNumber: 43, fromChat: 'Export invoices as PDF', fromTab: true,
      events: [{ kind: 'turn', text: 'Finished a turn', actionable: false }, { kind: 'pr.opened', text: 'Opened PR #43', actionable: false }],
      reply: 'PR #43 is ready to merge. Checks pass and Theo approved it.'
    }
    return grouped(f, {
      tab: 'chat-kai-pr', chats: (c) => c.map((x) => (x.id === ids.leadChat ? { ...x, closed: true } : x)),
      items: { 'chat-kai-pr': [
        userMsg('ur', "How is Kai's PR going?"),
        { kind: 'text', id: 'ur-tx', ts: at(10, 30), text: "Kai's PR is open as #43 on invoice-pdf-button. Checks are still running." },
        { kind: 'user', id: 'ur-up', ts: at(10, 41), from: 'kernel', update: { rows: [row] }, parts: [{ type: 'text', text: ['Team update from Kernel, not from the user.', '', 'From "Export invoices as PDF", a tab you closed:', '- Kai (kai) · T-15b Download PDF in the row actions · workspace ws-pdf-button: PR #43 is ready to merge.'].join('\n') }] }
      ] }
    })
  }),
  // Chat rows say what waits on you and what is running: the login chat has a question open in its second tab, the table chat is working.
  GroupedRowStatus: scene((f) => {
    const g = grouped(f)
    const ask: Approval = { ...pending('question', 'rowan', { workspaceId: ids.lead, chatId: 'chat-login-redirect', title: 'Should we keep Google sign in?', options: ['Keep it', 'Drop it'] }), createdAt: Date.now() - 4.5 * 60_000 }
    return { ...g, approvals: [ask, ...(g.approvals ?? [])] }
  }),
  // Ask Rowan from inside the chat: the answer is a fifth tab of Export invoices as PDF and the sidebar gains no row (KERNEL-339).
  GroupedAskRowan: scene((f) => {
    const status = leadTab('chat-status', GROUPED.export, "What's the status of T-15?", 7)
    const tests = leadTab('chat-tests', GROUPED.export, 'Which tests cover the PDF fonts?', 7)
    return grouped(f, {
      tab: tests.id, chats: (c) => [...c.slice(0, 3), status, tests, ...c.slice(3)],
      items: { [tests.id]: [
        userMsg('ar', 'Which tests cover the PDF fonts?'),
        { kind: 'thinking', id: 'ar-th', ts: at(10, 52), text: 'Ivy owns the snapshot tests. I should check what they assert.' },
        tool('ar-t1', 'Search the tests', 'rg -n "font" tests', { name: 'Grep' }),
        { kind: 'text', id: 'ar-tx', ts: at(10, 52), text: "Ivy's snapshot tests in invoice-pdf.spec.ts check the embedded fonts for all three invoice types. Noor's renderer has no unit test of its own yet." },
        { kind: 'result', id: 'ar-res', ts: at(10, 52), durationMs: 8_000, ok: true }
      ] }
    })
  }),
  // The last tab of a chat that is still running asks first. Closing it leaves the chat's two workspaces in the sidebar.
  GroupedCloseLastTab: scene((f) => {
    const g = grouped(f, { tab: 'chat-table', chats: (c) => c.filter((x) => x.id !== 'chat-table-copy') })
    return { ...g, ui: { ...g.ui!, modal: { name: 'confirm', kind: 'closeChats', workspaceId: ids.lead, chatIds: ['chat-table'] } } }
  }),
  GroupedCloseLastTabAfter: scene((f) => grouped(f, {
    running: [], chats: (c) => c.filter((x) => x.id !== 'chat-table-copy').map((x) => (x.id === 'chat-table' ? { ...x, closed: true } : x)),
    threads: (t) => t.map((x) => (x.id === GROUPED.table ? { ...x, closedAt: at(10, 50) } : x))
  })),
  // A room whose last chat was closed (KERNEL-365): the Lead's workspace opens on New chat with Rowan and the sidebar has no chat row (KERNEL-366).
  // The three workspaces the closed chat handed off stay as unowned rows.
  LeadNoChats: scene((f) => {
    const g = grouped(f, { running: [], chats: (c) => c.map((x) => ({ ...x, closed: true })), threads: (t) => t.map((x) => ({ ...x, closedAt: at(10, 50) })) })
    // Nothing is open, so no tab is stored and the closed chats keep no transcript.
    return { ...g, items: {}, ui: { ...g.ui!, tabs: {} } }
  }),
  // Shared files (KERNEL-305). The canvas draws them in Noor's invoice-pdf-renderer and in Rowan's chat. Which file a shot opens, and the
  // width, version menu or crash, is the shot's: WorkspaceSharedPhone, WorkspaceSharedVersions and WorkspaceSharedCrashed need a step (scripts/shots.ts).
  WorkspaceSharedCard: sharedTab(undefined, 2),
  WorkspaceSharedHtml: sharedTab('sh-html'),
  WorkspaceSharedPhone: sharedTab('sh-html'),
  WorkspaceSharedImage: sharedTab('sh-image'),
  WorkspaceSharedMarkdown: sharedTab('sh-md'),
  WorkspaceSharedPdf: sharedTab('sh-pdf'),
  WorkspaceSharedCrashed: sharedTab('sh-html'),
  WorkspaceSharedVersions: sharedTab('sh-html'),
  // Comment mode (KERNEL-311). The shots click Comment and the spot (scripts/shots.ts); the state they reach is not a fixture's to force.
  WorkspaceSharedComment: commentTab('sh-pricing'),
  WorkspaceSharedCommentImage: commentTab('sh-image'),
  WorkspaceSharedCommentSent: commentSent,
  WorkspaceSharedCommentArchived: scene((f) => commentArchived(f)),
  WorkspaceSharedCommentOlder: commentTab('sh-pricing', 3, 2),
  WorkspaceSharedPanel: scene((f) => sharedPanel(f)),
  WorkspaceSharedPanelEmpty: scene((f) => ({
    settings: { ...DEFAULT_SETTINGS('/Users/you'), experimental: { ...DEFAULT_SETTINGS('/Users/you').experimental, sharing: true } },
    ui: { ...open, workspace: { right: 'shared', bottom: 'run', checkpoints: false, toolsOpen: false } },
    shared: sharedFiles().filter((x) => x.workspaceId !== ids.table), sharedData: sharedStills
  })),
  TeamUpdateShared: scene((f) => teamUpdateShared(f)),
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
    prNote('c-note', 'playwright failed on the PR: the download test timed out in CI.', 'cifail')
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
    prNote('m-note', 'PR #42 was squashed into main.', 'merged')
  ], { prs: prInfo('merged') }),
  WorkspacePRClosed: prScene('closed', [prNote('x-note', 'PR #42 was closed without merging on GitHub.', 'closed')], { prs: prInfo('closed') }),
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
  WorkspaceTerminalPresets: terminalPresets(),
  WorkspacePreview: preview(),
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
  /** KERNEL-334: the ring from 75% is amber. Not on the canvas, see docs/decisions/KERNEL-334.md. */
  WorkspaceContextRingNear: scene((f) => ({ chats: contextChat(f, 132_000), ui: open })),
  /** KERNEL-334: from 90% the ring and the popover's top meter are red. */
  WorkspaceContextPopoverFull: scene((f) => ({ chats: contextChat(f, 160_000), ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false, contextOpen: true } } })),
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
  /** A brief Rowan handed off with wait_for, held until Noor's PR merges, with Send now to start it sooner (KERNEL-259, KERNEL-361). */
  WorkspaceQueuedMerge: scene((f) => {
    const queue = [{ id: 'q1', chatId: ids.tableChat, ts: at(10, 2), from: 'lead' as const, parts: [{ type: 'text' as const, text: 'Build the invoice table on top of the new schema' }] }]
    const schema = withWorkspace(f, ids.schema, { prNumber: 43, prUrl: 'https://github.com/samrivera/client-a/pull/43', prState: 'open' })
    return {
      workspaces: withWorkspace({ ...f, workspaces: schema }, ids.table, { stat: undefined, waitsFor: { on: [ids.schema], held: true } }),
      items: { [ids.tableChat]: [{ kind: 'note', id: 'n1', ts: at(10, 2), text: 'Waiting for PR #43 by Noor to merge. Kernel sends this brief then. Send now starts it sooner.', refs: [{ text: 'PR #43 by Noor', workspaceId: ids.schema }] }] },
      queue: { [ids.tableChat]: queue },
      // A held brief has no run script and no changes yet (KERNEL-259).
      changes: { ...f.changes, [ids.table]: [] },
      push: [...f.push.filter((e) => e.type !== 'script.output' || e.kind !== 'run'), { type: 'chat.queue', chatId: ids.tableChat, queue, why: 'merge' }],
      ui: open
    }
  }),
  /** Noor's PR #43 with Kai's T-14 brief held until it merges: the line above the box names Kai's workspace and opens it. */
  WorkspaceWaitedOn: scene((f) => {
    const schema = withWorkspace(f, ids.schema, { prNumber: 43, prUrl: 'https://github.com/samrivera/client-a/pull/43', prState: 'open', prTitle: 'feat(invoices): schema and migrations' })
    return {
      workspaces: withWorkspace({ ...f, workspaces: schema }, ids.table, { stat: undefined, source: { kind: 'issue', id: 'T-14', title: 'Invoice table' }, waitsFor: { on: [ids.schema], held: true } }),
      ui: { route: { name: 'workspace', workspaceId: ids.schema } }
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
