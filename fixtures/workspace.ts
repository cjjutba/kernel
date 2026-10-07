import type { ChatItem } from '@shared/types'
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
  WorkspacePRClosed: prScene('closed')
}
