import type { ChatItem, FileEntry, Hunk, Skill } from '@shared/types'
import type { Fixture } from './types'
import { at, ids, scene, tableItems, withWorkspace } from './base'

// Workspace lane: the workspace screen (KERNEL-10), PR states (KERNEL-15), agent turns and requests (KERNEL-14).

const open = { route: { name: 'workspace', workspaceId: ids.table } } as const
const pr = { prNumber: 42, prUrl: 'https://github.com/cjjutba/client-a/pull/42' }
/** The transcript up to the last tool call, before Kai's summary. */
const midTurn = tableItems.filter((i) => i.kind !== 'text' && i.kind !== 'result')

const prScene = (prState: 'draft' | 'cifail' | 'changes' | 'merged' | 'closed') =>
  scene((f) => ({ workspaces: withWorkspace(f, ids.table, { ...pr, prState }), ui: open }))

const request = (kind: 'tool' | 'plan' | 'question', extra: object) => scene((f) => ({
  approvals: [{ id: `ap-${kind}`, kind, source: 'sdk' as const, roomId: ids.roomA, workspaceId: ids.table, agentId: 'kai', status: 'pending' as const, createdAt: at(10, 30), title: '', ...extra }, ...f.approvals],
  ui: open
}))

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
  WorkspacePerm: request('tool', { toolName: 'Bash', input: { command: 'pnpm add @tanstack/react-table' }, title: 'Run pnpm add @tanstack/react-table', detail: 'Adds a dependency to package.json.' }),
  WorkspacePlan: request('plan', { title: 'Plan for the invoice table', detail: '1. Build the table with sorting\n2. Add empty, loading and error states\n3. Cover each state with Playwright' }),
  WorkspaceQuestion: request('question', { title: 'Should the table remember the sort order?', options: ['Remember it per user', 'Reset on every visit'] }),
  WorkspaceInterrupted: scene(() => ({
    items: { [ids.tableChat]: [...midTurn.slice(0, 6), { kind: 'interrupted', id: 'i1', ts: at(10, 29) }] },
    ui: open
  })),
  WorkspaceError: scene(() => ({
    items: { [ids.tableChat]: [
      ...midTurn.slice(0, 7),
      { kind: 'tool', id: 't8', ts: at(10, 29), toolUseId: 'toolu_8', name: 'Bash', label: 'Ran', detail: 'pnpm playwright test invoices', status: 'failed', durationMs: 19_800, output: '2 failed\n  invoices.spec.ts:24 sorts by amount\n  invoices.spec.ts:41 shows the empty state' },
      { kind: 'result', id: 'r1', ts: at(10, 30), durationMs: 184_000, ok: false, error: 'Tests failed' }
    ] },
    ui: open
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
