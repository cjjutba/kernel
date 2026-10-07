import type { Approval, Chat, ChatItem, FileEntry, Hunk, Skill, Workspace } from '@shared/types'
import type { Fixture } from './types'
import { at, ids, scene, tableItems, withWorkspace } from './base'

// Workspace lane: the workspace screen (KERNEL-10), PR states (KERNEL-15), agent turns and requests (KERNEL-14).

const open = { route: { name: 'workspace', workspaceId: ids.table } } as const
const pr = { prNumber: 42, prUrl: 'https://github.com/cjjutba/client-a/pull/42' }
/** The transcript up to the last tool call, before Kai's summary. */
const midTurn = tableItems.filter((i) => i.kind !== 'text' && i.kind !== 'result')

const prScene = (prState: 'draft' | 'cifail' | 'changes' | 'merged' | 'closed') =>
  scene((f) => ({ workspaces: withWorkspace(f, ids.table, { ...pr, prState }), ui: open }))

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
  scene(() => ({ ...extra, ui: { ...open, workspace: { right: 'changes', bottom: 'run', focus: false, checkpoints: false, toolsOpen: false, composer } } }))

const file = (path: string): FileEntry => ({ path, dir: false })
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
    items: { [chatId]: items },
    approvals: extra.approvals,
    ui: { route: { name: 'workspace', workspaceId: id } }
  }
}

export const workspaceFixtures: Record<string, Fixture> = {
  Workspace: scene(() => ({ ui: open })),
  WorkspaceLoading: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { status: 'setup' }),
    items: { [ids.tableChat]: [] },
    ui: open
  })),
  WorkspaceToolCalls: scene(() => ({
    items: { [ids.tableChat]: toolCalls },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', focus: false, checkpoints: false, toolsOpen: true } }
  })),
  WorkspaceFile: scene(() => ({
    ui: { ...open, workspace: { right: 'files', bottom: 'run', focus: false, checkpoints: false, toolsOpen: false, tab: 'file:src/app/invoices/table.tsx' } }
  })),
  WorkspaceFocus: scene(() => ({
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', focus: true, checkpoints: false, toolsOpen: false } }
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
    ui: { ...open, workspace: { right: 'files', bottom: 'run', focus: false, checkpoints: false, toolsOpen: false } }
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
    approvals: [pending('plan', 'kai', { title: 'Plan for T-15b', steps: [
      'Add "Download PDF" to the row actions menu', 'Call /api/invoices/:id/pdf and stream the file', 'Show progress on the item while it downloads', 'Toast on failure with a retry action', 'Playwright test for the download'
    ].map((title) => ({ title })) }), ...f.approvals]
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
  WorkspaceLead: scene((f) => ({
    ...scene2(f, { id: ids.lead, name: 'export-invoices-as-pdf', branch: 'feat/export-invoices-as-pdf', agentId: 'rowan', mode: 'worktree' }, 'Export invoices as PDF', [
      userMsg('l1', 'Add PDF export to invoices. Spec first.'),
      { kind: 'note', id: 'l-note', ts: at(10, 28), text: 'Rowan is at the task wall on the floor.', link: { label: 'View floor', href: `kernel://floor/${ids.roomA}` } },
      { kind: 'thinking', id: 'l-th', ts: at(10, 28), text: 'Renderer, button, tests and review can run in parallel.' },
      tool('l-t1', 'Read the invoices module', 'cat src/app/invoices/page.tsx', { name: 'Read' }),
      tool('l-t2', 'Write the plan', 'cat > plans/t-15-invoice-pdf.md', { name: 'Write' }),
      { kind: 'text', id: 'l-tx', ts: at(10, 29), text: 'I split PDF export into four tasks that can run in parallel. Approve it and I will walk the floor and hand them out.' }
    ], {
      approvals: [pending('plan', 'rowan', { workspaceId: ids.lead, title: 'Plan for T-15', steps: [
        { title: 'T-15a PDF renderer with embedded fonts', taskId: 'T-15a', agentId: 'noor' }, { title: 'T-15b Download PDF in the row actions', taskId: 'T-15b', agentId: 'kai' },
        { title: 'T-15c Snapshot tests for three invoice types', taskId: 'T-15c', agentId: 'ivy' }, { title: 'T-15d Review each PR as it lands', taskId: 'T-15d', agentId: 'theo' }
      ] }), ...f.approvals]
    }, { plan: true, model: 'claude-opus-5-5' }),
    changes: { [ids.lead]: [{ path: 'plans/t-15-invoice-pdf.md', status: 'A', added: 64, removed: 0 }] }
  })),
  WorkspaceHire: scene((f) => ({
    ...scene2(f, { id: ids.lead, name: 'hire-a-designer', branch: 'main', baseRef: 'main', mode: 'current', agentId: 'rowan' }, 'Hire a designer', [
      userMsg('h0', 'We need a designer on the team who checks every screen against DESIGN.md before review.'),
      { kind: 'thinking', id: 'h-th', ts: at(10, 28), text: 'This fits as a subagent with read access and the screenshot skill.' },
      tool('h-t1', 'Read DESIGN.md', 'cat DESIGN.md', { name: 'Read' }),
      { kind: 'text', id: 'h-tx', ts: at(10, 29), text: 'Here is the agent file. Once you approve, I will save it and Lumi will take the open desk on the floor.' }
    ], {
      approvals: [pending('agent', 'rowan', { workspaceId: ids.lead, title: 'Add lumi to the team', agentFile: { path: '.claude/agents/lumi.md', text: [
        '---', 'name: lumi', 'description: Designer. Checks every screen against DESIGN.md', '  before Theo reviews it. Flags spacing, type and color drift.', 'model: sonnet', 'tools: Read, Grep, Glob, Bash(pnpm screenshot:*)', '---'
      ].join('\n') } }), ...f.approvals]
    }, { plan: false, model: 'claude-opus-5-5' }),
    changes: { [ids.lead]: [{ path: '.claude/agents/lumi.md', status: 'A', added: 28, removed: 0 }] }
  })),
  WorkspaceDraftPR: prScene('draft'),
  WorkspaceCIFailed: prScene('cifail'),
  WorkspaceChangesRequested: prScene('changes'),
  WorkspaceMerged: prScene('merged'),
  WorkspacePRClosed: prScene('closed'),
  WorkspacePaste: composing({
    parts: [
      { type: 'text', text: 'Staging breaks on the invoices page. Here is the log ' },
      { type: 'file', name: 'pasted_text_1.txt', lines: 212, text: 'log' },
      { type: 'text', text: ' and what I see ' },
      { type: 'image', name: 'image.png', width: 1280, height: 800 }
    ],
    draft: ''
  }),
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
