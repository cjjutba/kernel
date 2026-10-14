import type { PushEvent } from '@shared/ipc'
import type { AgentReach, AgentScope, Approval, AskedQuestion, BranchCommit, QueuedMessage, ChangedFile, Chat, ChatItem, Checkpoint, Effort, FileEntry, Hunk, IssueSummary, PrCheck, PrInfo, ReviewKind, ReviewVerdict, ScriptTrust, SharedAnchor, SharedComment, SharedFile, SharedVersion, Skill, TeamEventKind, TeamUpdateRow, Thread, Workspace } from '@shared/types'
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

/**
 * KERNEL-413: the header. Noor's PR #147 for KERNEL-155 in the room Kernel, with the issue's title where
 * the workspace's name was, in one PR state. The right panel is hidden unless `panel`, which puts the PR cluster in the panel head.
 */
const HEADER_BRANCH = 'cjjutbaofficial/kernel-155-home-and-inbox-keep-asking-about-requests-and-prs'
const headerScene = (prState: Workspace['prState'], note: ChatItem[], opts: { panel?: boolean; title?: string } = {}) =>
  scene((f) => ({
    rooms: f.rooms.map((r) => (r.id === ids.roomA ? { ...r, name: 'Kernel' } : r)),
    workspaces: withWorkspace(f, ids.table, {
      name: 'kernel-155-home-and-inbox-keep-asking-about-requests-and-prs', branch: HEADER_BRANCH, agentId: 'noor', prState,
      title: opts.title ?? 'KERNEL-155 Home and Inbox keep asking about requests and the PRs',
      source: { kind: 'issue', id: 'KERNEL-155', title: 'Home and Inbox keep asking about requests and the PRs' },
      prNumber: 147, prUrl: 'https://github.com/samrivera/client-a/pull/147', prTitle: 'feat(home): ask about requests and PRs'
    }),
    chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: 'KERNEL-155 Home and Inbox' } : c)),
    items: { [ids.tableChat]: [...tableItems, ...note] },
    prs: prInfo(prState, { number: 147, url: 'https://github.com/samrivera/client-a/pull/147', title: 'feat(home): ask about requests and PRs' }),
    ui: { ...open, rightPanel: !!opts.panel, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
  }))

/**
 * KERNEL-478: a branch that merges on the Mac, as the PrLocal fixtures show it. Noor's discount code branch in the Shop room, a local
 * folder with no GitHub remote, 3 commits ahead of main. `behind`, `conflicts` and `dirty` are what git said about it. The room's merge
 * method is a squash, and `merged` is the commit it left on main.
 */
type LocalState = 'ready' | 'behind' | 'conflict' | 'merging' | 'merged' | 'dirty'
const SHOP = '/Users/you/Projects/shop'
const localFiles: ChangedFile[] = [
  { path: 'src/checkout/DiscountField.tsx', status: 'A', added: 58, removed: 0 },
  { path: 'src/checkout/CheckoutForm.tsx', status: 'M', added: 21, removed: 4 },
  { path: 'src/checkout/cart.ts', status: 'M', added: 34, removed: 6 },
  { path: 'src/db/discounts.ts', status: 'A', added: 41, removed: 0 },
  { path: 'src/db/schema.ts', status: 'M', added: 12, removed: 0 },
  { path: 'src/api/checkout.ts', status: 'M', added: 18, removed: 2 },
  { path: 'test/discounts.test.ts', status: 'A', added: 76, removed: 0 },
  { path: 'test/cart.test.ts', status: 'M', added: 44, removed: 3 }
]
const localScene = (state: LocalState) => scene((f) => {
  const behind = { ready: 0, merging: 0, merged: 0, dirty: 0, behind: 4, conflict: 2 }[state]
  const conflicts = state === 'conflict' ? ['src/checkout/cart.ts', 'src/db/schema.ts'] : []
  const dirty = state === 'dirty' ? [{ status: 'M', path: 'package.json' }, { status: 'M', path: 'src/app/layout.tsx' }, { status: '??', path: 'notes.md' }] : []
  const prState: Workspace['prState'] = state === 'behind' || state === 'dirty' ? 'ready' : state
  const merged = state === 'merged'
  return {
    rooms: f.rooms.map((r) => (r.id === ids.roomA ? { ...r, name: 'Shop', path: SHOP, repo: undefined, host: 'local' as const } : r)),
    workspaces: withWorkspace(f, ids.table, {
      name: 'add-discount-code-checkout', branch: 'feat/add-discount-code-to-checkout', baseRef: 'main', agentId: 'noor', title: 'Add a discount code to checkout', prState,
      stat: { files: 8, added: 304, removed: 15 }, ...(merged ? { mergedAt: at(10, 44), mergeCommit: '4e1b9c2f0a7d3b5c8e1a9d6f2b4c7e0a3d5f8b1c' } : {})
    }),
    chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: 'Discount code field' } : c)),
    items: { [ids.tableChat]: [
      userMsg('lm-u', 'Add a discount code field to checkout. It takes a code, checks it against a discounts table and shows the new total under the subtotal. Keep the cart tests passing, and add tests for a percent code, a fixed code and an unknown code.'),
      ...folded('lm', 14, 3),
      { kind: 'text', id: 'lm-x', ts: at(10, 42), text: 'Checkout has a discount code field now. A valid code shows the new total under the subtotal, and an unknown code says "Code not found".\n\nThe branch has 3 commits. This repo has no GitHub remote, so there is no pull request. Kernel merges the branch into `main` on this Mac.' },
      { kind: 'result', id: 'lm-r', ts: at(10, 43), durationMs: 72_000, ok: true },
      ...(merged ? [{ kind: 'note' as const, id: 'lm-note', ts: at(10, 44), text: 'Squashed into main as 4e1b9c2.', pr: 'merged' as const }] : [])
    ] },
    changes: { [ids.table]: localFiles },
    // The Run tab before the script has run, as the PNGs draw it (WorkspaceRunEmpty).
    roomSettings: { [ids.roomA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } },
    push: f.push.filter((e) => e.type !== 'script.output' || e.kind !== 'run'),
    prs: { [ids.table]: {
      workspaceId: ids.table, number: 0, url: '', title: '', state: state === 'conflict' ? 'conflict' : 'ready', baseRef: 'main', checks: [], comments: [], conflicts, head: 'a'.repeat(40),
      local: { ahead: 3, behind, stat: { files: 8, added: 304, removed: 15 }, method: 'squash', checkout: { path: SHOP, dirty } }
    } },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
  }
})

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
      ...frontend.map((line): PushEvent => ({ type: 'script.output', workspaceId: ids.table, kind: 'run', name: 'frontend', lines: [{ line, stream: 'stdout' }] })),
      scriptData(ids.table, 'run', `${dim(`$ ${frontend[0].slice(2)}`)}\r\n${green('▲')} ${bold('Next.js 15.3')}\r\n   - Local:   ${cyan('http://localhost:4312')}\r\n   - Studio:  ${cyan('http://localhost:4314')}\r\n\r\n ${green('✓')} Ready in 1.4s\r\n ${green('✓')} Compiled /invoices in 312ms\r\n ${dim('GET /invoices 200 in 84ms')}\r\n ${dim('GET /api/invoices 200 in 31ms')}\r\n`, 'frontend')
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

/** The invoice table's PR as one GitHub won't merge until someone approves it (KERNEL-388). */
const blocked = (f: Fixture): Fixture => ({ ...f, workspaces: f.workspaces.map((w) => (w.id === ids.table ? { ...w, prBlocked: 'review' as const } : w)) })

/** A workspace whose room has a run script that hasn't run, so the Run tab shows its empty state with the Run button under the icon, and a collapsed bar keeps its Run (KERNEL-512). */
const idleRun = (f: Fixture): Fixture => ({
  ...f,
  push: f.push.filter((e) => e.type !== 'script.output' || e.kind !== 'run'),
  roomSettings: { ...f.roomSettings, [ids.roomA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } }
})

/** The same fixture with the bottom pane folded to its tab bar, in Kernel's chats and in teammates' workspaces (KERNEL-513). */
const bottomFolded = (f: Fixture): Fixture => ({ ...f, ui: { ...f.ui, bottomCollapsed: { lead: true, teammate: true } } })

/** The invoice table's PR with two blockers from Theo on its latest commit, the only thing that holds the merge (KERNEL-501). */
const withBlockers = (f: Fixture): Fixture => ({
  ...f,
  workspaces: f.workspaces.map((w) => (w.id === ids.table ? {
    ...w, prHead: 'h147',
    reviews: [{ workspaceId: 'ws-review-147', agentId: 'theo', verdict: 'blockers' as const, summary: 'Two blockers.', blockers: [{ text: 'The download never retries.' }, { text: 'No test covers the failure toast.' }], sha: 'h147', prNumber: 147, ts: at(10, 38) }]
  } : w)),
  prs: Object.fromEntries(Object.entries(f.prs ?? {}).map(([id, info]) => [id, id === ids.table ? { ...info, head: 'h147' } : info]))
})

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

/** Codex's model list as `model/list` returns it, for a shot whose chat runs on Codex. */
const codexModels = ['GPT-6-Astra', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna'].map((label, i) => ({ provider: 'codex' as const, id: label.toLowerCase(), label, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as Effort[], defaultEffort: 'medium' as Effort, isDefault: i === 0 }))

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

/** A finished turn and a turn in progress that each read screenshots from .kernel/attachments, next to a Read of a source file (KERNEL-546). */
const readImageItems: ChatItem[] = [
  { kind: 'user', id: 'ri-u1', ts: at(10, 27), parts: [{ type: 'text', text: 'Match the empty state to this mock.' }, { type: 'image', name: 'image.png' }] },
  tool('ri-t1', 'Read image.png', '.kernel/attachments/image.png', { name: 'Read', durationMs: 90, input: { file_path: '.kernel/attachments/image.png' } }),
  tool('ri-t2', 'Read empty-state.tsx', 'src/app/invoices/empty-state.tsx', { name: 'Read', durationMs: 60, input: { file_path: 'src/app/invoices/empty-state.tsx' } }),
  { kind: 'text', id: 'ri-x1', ts: at(10, 28), text: 'The mock centres the message and puts the button under it. I will change the empty state to match.' },
  { kind: 'user', id: 'ri-u2', ts: at(10, 30), parts: [{ type: 'text', text: 'Now the loading state, with these two.' }, { type: 'image', name: 'image.png' }, { type: 'image', name: 'image-2.png' }] },
  tool('ri-t3', 'Read image.png', '/Users/you/kernel/worktrees/client-a/invoice-table/.kernel/attachments/image.png', { name: 'Read', durationMs: 90, input: { file_path: '/Users/you/kernel/worktrees/client-a/invoice-table/.kernel/attachments/image.png' } }),
  tool('ri-t4', 'Read image-2.png', '.kernel/attachments/image-2.png', { name: 'Read', durationMs: 80, input: { file_path: '.kernel/attachments/image-2.png' } }),
  tool('ri-t5', 'Read skeleton.tsx', 'src/app/invoices/skeleton.tsx', { name: 'Read', durationMs: 60, input: { file_path: 'src/app/invoices/skeleton.tsx' } })
]

/** The invoice table chat followed by six more rounds, so the transcript runs well past the window (WorkspaceScrolledUp, KERNEL-532). */
const longChat: ChatItem[] = [
  ...tableItems,
  ...[
    ['Add a sort to the client column too.', 'Done. The client column sorts A to Z, then Z to A, and keeps the order in the URL.'],
    ['Does the empty state show while the table loads?', 'No. Loading has its own skeleton, and the empty state only shows once the list comes back with no rows.'],
    ['Can the amount column right-align?', 'Yes. Amounts now right-align with tabular figures, so the digits line up from row to row.'],
    ['Check what happens with 10,000 rows.', 'It stays smooth. The table renders a window of rows, so scrolling costs the same at 10 rows and at 10,000.'],
    ['Add a test for the error state.', 'Added. It forces the request to fail and checks that the message and the Retry button show.'],
    ['Run everything once more before review.', 'Vitest, Playwright and the type check all pass, and the linter is clean.']
  ].flatMap(([ask, answer], i): ChatItem[] => [userMsg(`lc-u${i}`, ask), { kind: 'text', id: `lc-x${i}`, ts: at(10, 32 + i), text: answer }])
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

/** The messages in the setup wait shots (KERNEL-430): a pasted screenshot with a question, then a follow-up with a pasted log. */
const setupAsk: QueuedMessage = { id: 'q-setup', chatId: ids.tableChat, ts: at(10, 0), parts: [{ type: 'image' as const, name: 'image.png' }, { type: 'text' as const, text: 'In a setup script tab in the right sidebar panel, there is a redundancy in terms of Run. Can you fix that?' }] }
const setupFollow: QueuedMessage = { id: 'q-follow', chatId: ids.tableChat, ts: at(10, 0, 40), parts: [{ type: 'text' as const, text: 'Check the Terminal tab for the same problem. The console output is in' }, { type: 'file' as const, name: 'pasted_text_1.txt', text: 'Terminal\n  Run\n  Run', lines: 14 }] }

const E = '\x1b['
const dim = (t: string) => `${E}2m${t}${E}22m`
const bold = (t: string) => `${E}1m${t}${E}22m`
const green = (t: string) => `${E}32m${t}${E}39m`
const red = (t: string) => `${E}31m${t}${E}39m`
const cyan = (t: string) => `${E}36m${t}${E}39m`
const yellow = (t: string) => `${E}33m${t}${E}39m`

const boxed = (rows: string[]) => {
  const w = 36
  const line = (t: string) => `│ ${t}${' '.repeat(w - 2 - t.replace(/\x1b\[[0-9;]*m/g, '').length)} │`
  return [`╭${'─'.repeat(w)}╮`, ...rows.map(line), `╰${'─'.repeat(w)}╯`].join('\r\n')
}

/** pnpm install as a terminal prints it: dim command echo, colored counts, a progress line redrawn in place and the update notice in a box. */
export const SETUP_RAW = {
  head: `${dim('$ ./scripts/setup.sh')}\r\nCopying .env from the main checkout\r\nLinking node_modules cache\r\n${dim('$ pnpm install')}\r\n`,
  install: `Lockfile is up to date, resolution step is skipped\r\nPackages: ${green('+1204')}\r\n${green('++++++++++++++++++++++++++++++++')}\r\nProgress: resolved 1, reused 0, downloaded 0, added 0\r${E}2KProgress: resolved 640, reused 612, downloaded 2, added 310\r${E}2KProgress: resolved 1204, reused 1198, downloaded 6, added 940, ${green('done')}\r\n`,
  notice: `\r\n${boxed(['Update available! ' + red('9.15.0') + ' → ' + green('10.4.1'), cyan('Run pnpm add -g pnpm')])}\r\n`,
  done: `${green('└─')} ${bold('Done')} in 12.4s\r\n`,
  failed: `${red('gyp ERR!')} build error\r\n${red('ERR_PNPM_LIFECYCLE')}  better-sqlite3@11.8.1 install: exit status 1\r\n${red('└─')} ${bold('Failed')} in 26.1s\r\n`,
  frozen: `${dim('$ pnpm install --frozen-lockfile')}\r\n${red('ERR_PNPM_OUTDATED_LOCKFILE')}  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date\r\n${yellow('Setup failed with exit code 1')}\r\n`
}

const scriptData = (workspaceId: string, kind: 'setup' | 'run', data: string, name?: string): PushEvent => ({ type: 'script.data', workspaceId, kind, ...(name && { name }), data })
export const setupData = (workspaceId: string, data: string) => scriptData(workspaceId, 'setup', data)

/** Setup's log as main sends it: still running, failed with code 1, or stopped. */
function setupLog(end: 'running' | 'failed' | 'stopped'): PushEvent[] {
  const out = (line: string, stream: 'stdout' | 'stderr' = 'stdout'): PushEvent => ({ type: 'script.output', workspaceId: ids.table, kind: 'setup', lines: [{ line, stream }] })
  const lines = [out('$ pnpm install'), out('Lockfile is up to date, resolution step is skipped'), out('Packages: +1204'), out('Progress: resolved 1204, reused 1198, downloaded 6, added 940')]
  const raw = [setupData(ids.table, SETUP_RAW.head + SETUP_RAW.install)]
  if (end === 'failed') return [...lines, ...raw, setupData(ids.table, SETUP_RAW.failed), out('gyp ERR! build error', 'stderr'), out('ERR_PNPM_LIFECYCLE  better-sqlite3@11.8.1 install: exit status 1', 'stderr'), { type: 'script.exit', workspaceId: ids.table, kind: 'setup', code: 1 }]
  if (end === 'stopped') return [...lines, ...raw, { type: 'script.exit', workspaceId: ids.table, kind: 'setup', code: null }]
  return [...lines, ...raw, setupData(ids.table, SETUP_RAW.notice)]
}

/**
 * A new chat waiting for setup: `queue` waits for it, and `end` is how a failed setup ended (an exit code, or null when stopped).
 * `pending` is a worktree Kernel hasn't made yet (KERNEL-543), with git's reason once it failed: setup hasn't started, so it has no run or log.
 */
function setupWait(f: Fixture, status: 'setup' | 'failed', queue: QueuedMessage[], o: { end?: number | null; pending?: { error?: string }; panel?: boolean; right?: 'files'; collapsed?: boolean; composer?: { parts: import('@shared/types').ChatPart[]; draft: string } } = {}): Partial<Fixture> {
  const started = Date.now() - 42_000
  const setupRun = o.pending ? undefined : status === 'setup' ? { startedAt: started } : { startedAt: started - 26_000, endedAt: started + (o.end === null ? 5_000 : 42_000), end: o.end }
  return {
    workspaces: withWorkspace(f, ids.table, { status, setupRun, ...(o.pending ? { baseRef: 'origin/main', worktreePending: o.pending } : {}) }),
    items: { [ids.tableChat]: [] },
    queue: { [ids.tableChat]: queue },
    push: [...f.push, ...(o.pending ? [] : setupLog(status === 'setup' ? 'running' : o.end === null ? 'stopped' : 'failed')), ...(queue.length ? [{ type: 'chat.queue' as const, chatId: ids.tableChat, queue, why: 'setup' as const }] : [])],
    ui: { ...open, rightPanel: o.panel ?? true, ...(o.collapsed ? { bottomCollapsed: { lead: true, teammate: true } } : {}), workspace: { right: o.right ?? 'changes', bottom: 'setup', checkpoints: false, toolsOpen: false, ...(o.composer ? { composer: o.composer } : {}) } }
  }
}

/** Composer shots: the same screen, with the composer already holding something. */
const composing = (composer: { parts: import('@shared/types').ChatPart[]; draft: string }, extra: Partial<Fixture> = {}) =>
  scene(() => ({ ...extra, ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false, composer } } }))

/**
 * Kernel's chat picked Bypass permissions on the current branch while Only in worktrees is on, so it runs as Accept edits (KERNEL-456).
 * The label says Accept edits, and the menu keeps its check on Bypass permissions and says why.
 */
const bypassPicked = (f: Fixture, menu?: 'mode') => ({
  workspaces: withWorkspace(f, ids.lead, { mode: 'current' }),
  chats: f.chats.map((c) => (c.id === ids.leadChat ? { ...c, plan: false, effort: 'xhigh' as const, mode: 'bypassPermissions' as const } : c)),
  ui: { route: { name: 'workspace' as const, workspaceId: ids.lead }, ...(menu ? { menu } : {}) }
})

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
/** A deeper repo for the file trees (KERNEL-399): every git status, two compact folder chains (.github/workflows, lib/db) and many file types. */
const treeChanges: ChangedFile[] = [
  { path: 'docs/ARCHITECTURE.md', status: 'M', added: 12, removed: 3 },
  { path: 'src/app/invoices/empty-state.tsx', status: 'A', added: 64, removed: 0 },
  { path: 'src/app/invoices/legacy-table.tsx', status: 'D', added: 0, removed: 148 },
  { path: 'src/app/invoices/page.tsx', status: 'M', added: 18, removed: 9 },
  { path: 'src/app/invoices/sortable-header.tsx', status: '?', added: 41, removed: 0 },
  { path: 'src/app/invoices/table.tsx', status: 'M', added: 212, removed: 20 },
  { path: 'src/lib/db/schema.ts', status: 'R', added: 6, removed: 2 },
  { path: 'tests/invoices.spec.ts', status: 'A', added: 118, removed: 9 }
]
const treeStatus = new Map(treeChanges.map((c) => [c.path, c.status]))
const deepTree: FileEntry[] = [
  '.github/', '.github/workflows/', '.github/workflows/ci.yml', 'docs/', 'docs/ARCHITECTURE.md', 'docs/DECISIONS.md',
  'src/', 'src/app/', 'src/app/invoices/', 'src/app/invoices/empty-state.tsx', 'src/app/invoices/legacy-table.tsx', 'src/app/invoices/page.tsx',
  'src/app/invoices/sortable-header.tsx', 'src/app/invoices/table.tsx', 'src/app/layout.tsx', 'src/components/', 'src/lib/', 'src/lib/db/',
  'src/lib/db/client.ts', 'src/lib/db/schema.ts', 'src/styles.css', 'tests/', 'tests/invoices.spec.ts',
  '.env.example', '.gitignore', 'CLAUDE.md', 'package.json', 'pnpm-lock.yaml', 'README.md', 'tsconfig.json', 'vite.config.ts'
].map((p) => (p.endsWith('/') ? { path: p.slice(0, -1), dir: true } : { path: p, dir: false, ...(treeStatus.has(p) ? { status: treeStatus.get(p) } : {}) }))
const treeScene = (right: 'files' | 'changes', tab: string, changesView?: 'list' | 'tree') => scene((f) => ({
  tree: { ...f.tree, [ids.table]: deepTree },
  changes: { ...f.changes, [ids.table]: treeChanges },
  ui: { ...open, workspace: { right, bottom: 'run', checkpoints: false, toolsOpen: false, changesView }, tabs: { [ids.table]: { tab, files: tab.startsWith('file:') ? [tab.slice(5), 'package.json'] : [], diffs: tab.startsWith('diff:') ? [tab.slice(5)] : [] } } }
}))

const imageBefore = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAAA2klEQVR42u3coREAMAgEQapDpH+NSCXpIQIBO3MV/PqPqqvBhQkAC7AAC7AAC7AAAxZgARZgARZgAQYswAIswAIswAIswIAF+K/MsyrAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDlkt/ARZgARZgAQYswAIswAIswAIMWIAFWIAFWIAFGLAAC7AAq7cHvsLF6uuQAxcAAAAASUVORK5CYII='
const imageAfter = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABM0lEQVR42u3dsQ3DQAwEwatEgatUpIoVuATHzhQJz/sBtgIOFNlP5jwvFRcjACzAAizAAizA+gO+76+KAwxYgAVYgAVYgAUYsAALsAC/33F8APdYPg9wp2u9dLh2S4dut3HQdjMHbTdz6HYbh263ceh2G4dut3HodhuHbrcxYMB0JxsDBkx3snHodhsDBgwY8M66ixsDBgwY8Oa6KxsDBgwYMGDAgAEDBgy4BHic7rLGvmBfMGDAgAEDBgwYMGDAgP0e7PdgwIABA/avSsCAAQP2Nomu14VeFwIGzNgLf8CAbdkBvLzxoInZdGfTHWO7Kjcxnjgo+6Lti96eefR83Gxws2FX446xuJvkbtIe0q1DcLuwPNdHAQuwAAuwAAuwAAMWYAEWYAEWYAEGLMACLMB6tR96o4AjuY6UBwAAAABJRU5ErkJggg=='
const imageDiffScene = (status: 'A' | 'M') => scene((f) => ({
  changes: { ...f.changes, [ids.table]: [{ path: 'public/logo.png', status, added: 0, removed: 0 }, ...(f.changes[ids.table] ?? [])] },
  diffs: { ...f.diffs, [ids.table]: '' },
  images: { [ids.table]: { 'worktree:public/logo.png': { dataUrl: imageAfter }, ...(status === 'M' ? { 'base:public/logo.png': { dataUrl: imageBefore } } : {}) } },
  ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false }, tabs: { [ids.table]: { tab: 'diff:public/logo.png', files: [], diffs: ['public/logo.png'] } } }
}))

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
/** New chat with Kernel in a room with no open chat (KERNEL-366, KERNEL-405), with Todo issues for Up next and the remote's branches. */
function leadNoChats(f: Fixture): Partial<Fixture> {
  const g = grouped(f, { running: [], threads: (t) => t.map((x) => ({ ...x, closedAt: at(10, 50) })) })
  const issue = (id: string, title: string, priority: number): IssueSummary => ({ id, title, url: `https://linear.app/client-a/issue/${id}`, source: 'linear', priority })
  // Nothing is open, so no tab is stored and the archived chats keep no transcript here.
  return {
    ...g, items: {}, ui: { ...g.ui!, route: { name: 'leadNew', roomId: ids.roomA }, tabs: {} },
    issues: [issue('T-17', 'Email an invoice to the client from the row actions', 2), issue('T-19', 'Overdue badge on unpaid invoices past their due date', 3), issue('T-22', 'Remember the sort order on the invoices table', 0)],
    branches: ['origin/main', 'origin/invoice-pdf-renderer', 'origin/invoice-pdf-button', 'origin/invoice-table', 'origin/invoice-schema', 'origin/org-invites', 'origin/release/2.4', 'origin/hotfix/pdf-fonts']
  }
}

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

/** What Kernel sends with request_plan_approval (KERNEL-373): a write-up in `detail`, next to `steps`. */
const LEAD_PLAN = [
  '# Export invoices as PDF',
  '',
  'Invoices get a PDF renderer and a Download PDF action in each row. Four tasks, run in parallel, and Theo reviews each PR as it lands.',
  '',
  'T-15b needs the renderer from T-15a to merge first, since both change `row-actions.tsx`. Each PR runs `pnpm test`, `pnpm typecheck` and `pnpm shots`.'
].join('\n')

/** Kernel's plan for T-15 waiting on you in plan mode, in the Lead's chat: its write-up, then one row per task. */
const planWaiting = (f: Fixture): Partial<Fixture> => leadPlan(f, { agentId: 'kernel-lead' }, { detail: LEAD_PLAN })

/** The same plan once approved: it keeps its place with your Approved bubble under it, plan mode is off and each task has a workspace to open. */
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

/** Kernel's plan after you asked for changes: your notes are the bubble. The Kernel message that carried them after a restart names the approval and stays hidden. */
const planChanges = (f: Fixture): Partial<Fixture> => {
  const s = planWaiting(f)
  const notes = 'Split step 2 into its own PR, after step 1 merges.\nAnd have Theo review each PR as it lands.'
  const kernel: ChatItem = { kind: 'user', id: 'pl-kernel', ts: at(10, 30), from: 'kernel', approvalId: s.approvals?.[0].id, parts: [{ type: 'text', text: `The user asked for changes to the plan: ${notes}` }] }
  const reply: ChatItem = { kind: 'text', id: 'pl-rev', ts: at(10, 31), text: 'Understood. I will split step 2 out and bring the revised plan back.' }
  return {
    ...s,
    approvals: s.approvals?.map((a, i) => (i === 0 ? { ...a, status: 'denied' as const, answer: notes, images: [{ type: 'image' as const, name: 'invoice-table.png', dataUrl: imageAfter, path: '.kernel/images/invoice-table.png' }] } : a)),
    items: { [ids.leadChat]: [...(s.items?.[ids.leadChat] ?? []), kernel, reply] }
  }
}

/** A plan a newer plan replaced: it says why in place of an answer. */
const planReplaced = (f: Fixture): Partial<Fixture> => {
  const s = planWaiting(f)
  return {
    ...s,
    chats: s.chats?.map((c) => (c.id === ids.leadChat ? { ...c, plan: false } : c)),
    approvals: s.approvals?.map((a, i) => (i === 0 ? { ...a, status: 'expired' as const, expiredBy: 'replaced' as const } : a))
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

/** A scene that passes no approvals keeps the seed's: scene2 would otherwise set them to undefined. */
const noApprovals = ({ approvals: _none, ...patch }: Partial<Fixture>): Partial<Fixture> => patch

/** Kernel's own message in Kai's chat after a limit switch: one note line. */
const kernelNote = scene((f) => noApprovals(scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Download button', [
    userMsg('kn1', 'Build T-15b from the approved plan.', true),
    { kind: 'text', id: 'kn-tx', ts: at(10, 28), text: 'Starting with the row actions menu.' },
    { kind: 'result', id: 'kn-res', ts: at(10, 29), durationMs: 60_000, ok: true },
    { kind: 'user', id: 'kn-msg', ts: at(10, 30), from: 'kernel', parts: [{ type: 'text', text: 'You hit your usage limit and Kernel moved this chat to your other account. Carry on from where you stopped, and check git status first, since some edits may be unsaved.' }] }
  ], {})))

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

/** Two team updates in Kernel's chat after a hand-off: Kai's PR passed checks, then Theo approved it (KERNEL-127). */
const leadUpdate = (f: Fixture): Partial<Fixture> => {
  const header = 'Team update from Kernel, not from the user.'
  const kai: TeamUpdateRow = {
    workspaceId: ids.table, agentId: 'kai', name: 'Kai', task: 'Remove the Try section from the sidebar', prNumber: 108,
    events: [{ kind: 'pr.opened', text: 'Opened PR #108', actionable: false }, { kind: 'pr.ready', text: 'Ready to merge', actionable: true }, { kind: 'pr.review', text: 'Not reviewed', actionable: false }],
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
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Remove the Try section', [
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

/** The pieces a Team update fixture builds from (TeamUpdateMerge, TeamUpdateReview): a row, an event, the card with its text for the Lead, and the workspace, verdict and PR a row is about. */
const tuRow = (workspaceId: string, agentId: string, name: string, task: string, events: TeamUpdateRow['events']): TeamUpdateRow => ({ workspaceId, agentId, name, task, events })
const tuEv = (kind: TeamEventKind, text: string, actionable = false) => ({ kind, text, actionable })
const tuCard = (id: string, m: number, rows: TeamUpdateRow[], todo = 'Tell the user what is ready to merge.'): ChatItem => ({
  kind: 'user', id, ts: at(20, m), from: 'kernel', update: { rows },
  parts: [{ type: 'text', text: ['Team update from Kernel, not from the user.', '', ...rows.flatMap((r) => [`${r.name} (${r.agentId}) · ${r.task} · workspace ${r.workspaceId}`, ...r.events.map((e) => `- ${e.text}.`), '']), 'To do:', `- ${todo}`].join('\n') }]
})
const withOmitted = (item: ChatItem, omitted: number): ChatItem => (item.kind === 'user' && item.update ? { ...item, update: { ...item.update, omitted } } : item)
const tuWork = (id: string, agentId: string, name: string, n: number, over: Partial<Workspace>): Workspace =>
  ({ id, roomId: ids.roomA, name, branch: `feat/${name}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/client-a/${name}`, mode: 'worktree', agentId, port: 4330 + n % 50, status: 'ready', prState: 'ready', prNumber: n, prUrl: `https://github.com/samrivera/client-a/pull/${n}`, createdAt: at(19, 40), ...over })
const tuVerdict = (workspaceId: string, prNumber: number, sha: string): ReviewVerdict => ({ workspaceId, agentId: 'theo', verdict: 'approved', summary: 'No blockers.', sha, prNumber, ts: at(20, 12) })
const tuChecks: PrInfo['checks'] = [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'pass', meta: '48s' }]
const tuInfo = (workspaceId: string, number: number, head: string): PrInfo => ({ workspaceId, number, url: `https://github.com/samrivera/client-a/pull/${number}`, title: '', state: 'ready', baseRef: 'main', checks: tuChecks, comments: [], conflicts: [], head })

/**
 * Team updates with Merge (TeamUpdateMerge.png, KERNEL-351): an older card about PR #162 that no longer offers it, then a card where #162 and
 * a reviewer's row (#161) can merge, #158 waits for Theo's approval of its latest commit, #155 is merging and #150 merged and sits in History.
 */
const teamUpdateMerge = (f: Fixture): Partial<Fixture> => {
  const row = tuRow, ev = tuEv, work = tuWork, verdict = tuVerdict, info = tuInfo
  const card = (id: string, m: number, rows: TeamUpdateRow[]) => tuCard(id, m, rows)
  // Tasks come as the engine sends them, the workspace title with no key: the card reads the key from the issue the
  // workspace started on (KERNEL-411). A reviewer's workspace started on no issue, so Theo's task carries it.
  const rows = [
    { ...row('ws-182', 'kai', 'Kai', 'New chats focus the composer, and ⌘L focuses it', [ev('turn', 'Finished a turn'), ev('pr.opened', 'Pushed a fix'), ev('pr.ready', 'Ready to merge', true), ev('pr.review', 'Theo approved')]),
      reply: 'Fixed the focus race: `useLayoutEffect` now focuses the composer after the tab mounts. `pnpm test:changed` and `pnpm typecheck` pass.' },
    row('ws-review-161', 'theo', 'Theo', 'KERNEL-176 Kernel asks when a brief is unclear', [ev('turn', 'Reviewed PR #161'), ev('review', 'Approved', true)]),
    row('ws-172', 'noor', 'Noor', 'Duplicates show once in Issues', [ev('pr.opened', 'Opened PR #158'), ev('setup.passed', 'Checks passed')]),
    row('ws-160', 'kai', 'Kai', 'Issues screen with search', [ev('turn', 'Finished a turn'), ev('turn', 'Merging PR #155')]),
    row('ws-163', 'noor', 'Noor', "Linear service, contracts and Kernel's issue link", [ev('pr.merged', 'Merged PR #150')])
  ]
  const issue = (key: string, i: number): Partial<Workspace> => ({ title: rows[i].task, source: { kind: 'issue', id: key, title: rows[i].task } })
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Composer focus', [
    { kind: 'result', id: 'tum-res0', ts: at(20, 11), durationMs: 24 * 60_000 + 6_000, ok: true },
    // Workspaces past the 8th: the card says they didn't fit (KERNEL-654).
    withOmitted(card('tum-1', 11, [row('ws-182', 'kai', 'Kai', rows[0].task, [ev('turn', 'Finished a turn'), ev('pr.opened', 'Opened PR #162'), ev('pr.cifail', 'Checks failed', true)])]), 3),
    { kind: 'result', id: 'tum-res1', ts: at(20, 15), durationMs: 10_000, ok: true },
    card('tum-2', 15, rows),
    { kind: 'result', id: 'tum-res2', ts: at(20, 16), durationMs: 55_000, ok: true }
  ], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  return {
    ...rest,
    workspaces: [
      ...(s.workspaces ?? f.workspaces),
      work('ws-182', 'kai', 'kernel-182-new-chats-focus', 162, { prHead: 'h162', ...issue('KERNEL-182', 0) }),
      work('ws-176', 'kai', 'kernel-176-kernel-asks', 161, { prHead: 'h161', reviews: [verdict('ws-review-161', 161, 'h161')], title: 'Kernel asks when a brief is unclear', source: { kind: 'issue', id: 'KERNEL-176', title: 'Kernel asks when a brief is unclear' } }),
      work('ws-review-161', 'theo', 'review-pr-161-kernel-176', 0, { prState: 'none', prNumber: undefined, prUrl: undefined, reviewOf: 'ws-176' }),
      work('ws-172', 'noor', 'kernel-172-duplicates', 158, { prHead: 'h158b', reviews: [verdict('ws-review-158', 158, 'h158a')], ...issue('KERNEL-172', 2) }),
      // Kernel started this merge, and the row spins Merging all the same, as every place showing the PR does (KERNEL-417).
      work('ws-160', 'kai', 'kernel-160-issues-screen', 155, { prState: 'merging', ...issue('KERNEL-160', 3) }),
      work('ws-163', 'noor', 'kernel-163-linear-service', 150, { prState: 'merged', status: 'archived', mergedAt: at(20, 9), ...issue('KERNEL-163', 4) })
    ],
    prs: { 'ws-182': info('ws-182', 162, 'h162'), 'ws-176': info('ws-176', 161, 'h161'), 'ws-172': info('ws-172', 158, 'h158b') }
  }
}

/**
 * Team updates for the review pipeline (TeamUpdateReview.png, KERNEL-557): a PR Kernel merged by itself, one still blocked after 2 review
 * rounds with its two open blockers, and a ready one whose optional UX review was skipped to save usage. The replies are the teammate's
 * last words in the canvas. The engine sends the events, and the card adds "Needs you", the open list and the PR link.
 */
const teamUpdateReview = (f: Fixture): Partial<Fixture> => {
  const row = tuRow, ev = tuEv
  const rows = [
    { ...row('ws-182', 'kai', 'Kai', 'New chats focus the composer, and ⌘L focuses it', [ev('pr.opened', 'Opened PR #162'), ev('pr.merged', 'Merged automatically'), ev('pr.review', 'Reviews approved, checks passed, 84 lines')]), prNumber: 162,
      reply: 'Merged without asking you. Every review passed, checks were green and the change was 84 lines, under your 200 line limit.' },
    { ...row('ws-172', 'noor', 'Noor', 'Duplicates show once in Issues', [ev('pr.opened', 'Opened PR #158'), { ...ev('pr.ready', 'Checks passed'), held: true }, ev('pr.review', 'Still blocked after 2 review rounds')]), prNumber: 158 },
    { ...row('ws-176', 'ivy', 'Ivy', 'Kernel asks when a brief is unclear', [ev('pr.opened', 'Opened PR #161'), ev('pr.review', 'Code approved'), ev('pr.review', 'Skipped the UX review to save usage')]), prNumber: 161,
      reply: 'Your usage is at 91% of the 5-hour limit, so Kernel left out the optional UX review.' }
  ]
  const issue = (key: string, i: number): Partial<Workspace> => ({ title: rows[i].task, source: { kind: 'issue', id: key, title: rows[i].task } })
  const blocker = (kind: ReviewKind, workspaceId: string, text: string): ReviewVerdict => ({ ...tuVerdict(workspaceId, 158, 'h158'), verdict: 'blockers', lens: kind, blockers: [{ text }], summary: text })
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Composer focus', [
    { kind: 'result', id: 'tur-res0', ts: at(20, 31), durationMs: 8 * 60_000 + 41_000, ok: true },
    tuCard('tur-1', 31, rows, 'Tell the user what is ready to merge, and what still needs them.'),
    { kind: 'result', id: 'tur-res1', ts: at(20, 33), durationMs: 62_000, ok: true }
  ], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  return {
    ...rest,
    workspaces: [
      ...(s.workspaces ?? f.workspaces),
      tuWork('ws-182', 'kai', 'kernel-182-new-chats-focus', 162, { prState: 'merged', status: 'archived', mergedAt: at(20, 29), prHead: 'h162', ...issue('KERNEL-182', 0) }),
      tuWork('ws-172', 'noor', 'kernel-172-duplicates', 158, { prHead: 'h158', reviews: [blocker('security', 'ws-review-158-security', 'The new route reads the issue id without checking the room'), blocker('code', 'ws-review-158-code', 'The retry in dedupe() has no test')], ...issue('KERNEL-172', 1) }),
      tuWork('ws-176', 'ivy', 'kernel-176-kernel-asks', 161, { prHead: 'h161', reviews: [tuVerdict('ws-review-161', 161, 'h161')], ...issue('KERNEL-176', 2) })
    ],
    prs: { 'ws-172': tuInfo('ws-172', 158, 'h158'), 'ws-176': tuInfo('ws-176', 161, 'h161') }
  }
}

/** Kernel's plan waiting in the Lead's workspace. `ws` retitles that workspace. */
const leadPlan = (f: Fixture, ws: Partial<Workspace>, plan: Partial<Approval> = {}): Partial<Fixture> => ({
  ...scene2(f, { id: ids.lead, stat: { files: 1, added: 64, removed: 0 }, ...ws }, 'Export invoices as PDF', [
    userMsg('l1', 'Add PDF export to invoices. Spec first.'),
    { kind: 'thinking', id: 'l-th', ts: at(10, 28), text: 'Renderer, button, tests and review can run in parallel.' },
    tool('l-t1', 'Read the invoices module', 'cat src/app/invoices/page.tsx', { name: 'Read' }),
    tool('l-t2', 'Write the plan', 'cat > plans/t-15-invoice-pdf.md', { name: 'Write' }),
    { kind: 'text', id: 'l-tx', ts: at(10, 29), text: 'I split PDF export into four tasks that can run in parallel. Approve it and I will hand them out.' }
  ], {
    approvals: [pending('plan', 'kernel-lead', { workspaceId: ids.lead, title: 'Plan for T-15', steps: T15_STEPS, ...plan }), ...f.approvals]
  }, { plan: true, model: 'claude-opus-5-5' }),
  changes: { [ids.lead]: [{ path: 'plans/t-15-invoice-pdf.md', status: 'A', added: 64, removed: 0 }] }
})

/** What the Lead's PRs tab (KERNEL-354) reads for one open PR, in the words of LeadPrs.png. */
interface OpenPr {
  id: string; agentId: string; key: string; n: number; title: string; state: Workspace['prState']; stat: [number, number]
  /** Theo's review: `approved` of the head commit, `stale` an approval of an earlier one, `blockers` two blockers on the head commit. None is not reviewed. */
  review?: 'approved' | 'stale' | 'blockers'
}

/**
 * A PR title as agents write them: a Conventional Commits prefix and the issue key on the end, which the PRs tab strips
 * (KERNEL-411). "Kernel asks when a brief is unclear" becomes "feat(workspace): kernel asks when a brief is unclear (KERNEL-176)".
 */
const commitTitle = (title: string, key: string) => `feat(workspace): ${title.charAt(0).toLowerCase()}${title.slice(1)} (${key})`

/** The fields of a workspace that has `p` open: the PR, the issue it builds, its changes and Theo's review. */
const prFields = (p: OpenPr): Partial<Workspace> => {
  const verdict = (o: Partial<ReviewVerdict>): ReviewVerdict => ({ workspaceId: `${p.id}-review`, agentId: 'theo', verdict: 'approved', summary: 'No blockers.', sha: `h${p.n}`, prNumber: p.n, ts: at(20, 12), ...o })
  const reviews = p.review === 'approved' ? [verdict({})] : p.review === 'stale' ? [verdict({ sha: `h${p.n}-old` })] : p.review === 'blockers' ? [verdict({ verdict: 'blockers', blockers: [{ text: 'The download never retries.' }, { text: 'No test covers the failure toast.' }] })] : undefined
  return {
    title: p.title, prState: p.state, prNumber: p.n, prUrl: `https://github.com/samrivera/client-a/pull/${p.n}`, prTitle: commitTitle(p.title, p.key), prHead: `h${p.n}`, source: { kind: 'issue', id: p.key, title: p.title },
    stat: { files: 3, added: p.stat[0], removed: p.stat[1] }, reviews
  }
}

const openPrWorkspace = (p: OpenPr): Workspace => {
  const name = `${p.key.toLowerCase()}-${p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 18)}`
  return { id: p.id, roomId: ids.roomA, name, branch: `feat/${name}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/client-a/${name}`, mode: 'worktree', agentId: p.agentId, port: 4330 + p.n % 50, status: 'ready', createdAt: at(19, 40), prState: 'open', ...prFields(p) }
}

/** GitHub's read of each PR: its checks follow its state, and the head commit is the one the workspace saw. */
const openPrInfo = (p: OpenPr): PrInfo => ({
  workspaceId: p.id, number: p.n, url: `https://github.com/samrivera/client-a/pull/${p.n}`, title: commitTitle(p.title, p.key), state: p.state, baseRef: 'main', comments: [], conflicts: [], head: `h${p.n}`,
  checks: p.state === 'checks' ? [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'running' }] : p.state === 'cifail' ? [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'fail', meta: '48s' }] : [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'pass', meta: '48s' }]
})

/** The PRs the room has open, as workspaces and as GitHub reads them. Kai's org-invites workspace of the seed gives way to them. */
const openPrs = (f: Fixture, list: OpenPr[]): Pick<Fixture, 'workspaces' | 'prs'> => ({
  workspaces: [...withWorkspace(f, ids.invites, { prNumber: undefined, prUrl: undefined, prState: 'none' }), ...list.map(openPrWorkspace)],
  prs: Object.fromEntries(list.map((p) => [p.id, openPrInfo(p)]))
})

/**
 * The Lead's PRs tab (LeadPrs.png, LeadPrsEmpty.png, KERNEL-354) over a chat with Kernel: the two ready PRs first, then six that wait
 * on something. #158 holds an approval of an earlier commit, so the reviewer rule keeps it back.
 */
const leadPrsScene = (f: Fixture, list: OpenPr[], ask: string, reply: string, push: PushEvent[] = []): Partial<Fixture> => {
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Composer focus', [
    { ...userMsg('lp-u', ask), ts: at(20, 31) },
    { kind: 'text', id: 'lp-tx', ts: at(20, 31), text: reply },
    { kind: 'result', id: 'lp-res', ts: at(20, 31), durationMs: 12_000, ok: true }
  ], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  return {
    ...rest, ...openPrs(f, list),
    ...(push.length ? { push: [...(rest.push ?? f.push), ...push] } : {}),
    roomSettings: { [ids.roomA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } },
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', leadRight: 'prs', bottom: 'run', checkpoints: false, toolsOpen: false } }
  }
}

/** Kai's org invites PR, ready to merge. */
const INVITES_PR: OpenPr = { id: ids.invites, agentId: 'kai', key: 'T-09', n: 41, title: 'Org invites', state: 'ready', stat: [212, 34], review: 'approved' }

/** Kai's download button PR from the Export chat, ready to merge. */
const PDF_BUTTON_PR: OpenPr = { id: 'ws-pdf-button', agentId: 'kai', key: 'T-15b', n: 43, title: 'Download PDF in the row actions', state: 'ready', stat: [96, 12], review: 'approved' }

const LEAD_PRS: OpenPr[] = [
  { id: 'ws-182', agentId: 'kai', key: 'KERNEL-182', n: 162, title: 'New chats focus the composer, and ⌘L focuses it', state: 'ready', stat: [49, 5], review: 'approved' },
  { id: 'ws-176', agentId: 'noor', key: 'KERNEL-176', n: 161, title: 'Kernel asks when a brief is unclear', state: 'ready', stat: [117, 16], review: 'approved' },
  { id: 'ws-172', agentId: 'noor', key: 'KERNEL-172', n: 158, title: 'Duplicates show once in Issues', state: 'ready', stat: [28, 7], review: 'stale' },
  { id: 'ws-183', agentId: 'noor', key: 'KERNEL-183', n: 166, title: 'Stop idle chat sessions', state: 'checks', stat: [117, 16] },
  { id: 'ws-184', agentId: 'ivy', key: 'KERNEL-184', n: 165, title: 'Run the test suite from a chat', state: 'cifail', stat: [28, 7] },
  { id: 'ws-189', agentId: 'kai', key: 'KERNEL-189', n: 167, title: 'Download PDF in the row actions', state: 'changes', stat: [64, 9], review: 'blockers' },
  { id: 'ws-188', agentId: 'noor', key: 'KERNEL-188', n: 168, title: 'PDF renderer with embedded fonts', state: 'conflict', stat: [1050, 8] },
  { id: 'ws-173', agentId: 'ivy', key: 'KERNEL-173', n: 169, title: 'Screen list test', state: 'draft', stat: [4, 4] }
]

/** What Kernel says under the PRs tab: two PRs ready, one waiting on an approval and one running checks. */
const LEAD_PRS_REPLY = "Two PRs are ready. #162 from Kai and #161 from Noor both have Theo's approval. #158 is waiting for it, and #166 is still running checks. Merge them from the PRs tab, or tell me which one and I will."

/** Kai's download button PR with two blockers from Theo on its latest commit: GitHub calls it ready, and it still isn't (KERNEL-501). */
const BLOCKERS_PR: OpenPr = { ...LEAD_PRS[5], state: 'ready' }

/** What the Lead's run script has printed, under the Run tab (PanelTabsOverflow). */
const LEAD_RUN: PushEvent[] = ['$ pnpm dev --port 4303', 'VITE v6.3.5  ready in 412 ms', 'Local:   http://localhost:4303/', 'Compiled /inbox in 1.2s', 'GET /api/requests 200 in 84ms', 'GET /inbox 200 in 31ms']
  .map((line): PushEvent => ({ type: 'script.output', workspaceId: ids.lead, kind: 'run', lines: [{ line, stream: 'stdout' }] }))

/** Merge all's PRs (KERNEL-411): two ready, approved by Theo, and one still running checks. */
const MERGE_A: OpenPr = { id: 'ws-395', agentId: 'kai', key: 'KERNEL-395', n: 331, title: 'Home and Inbox count a workspace waiting for script trust', state: 'ready', stat: [99, 16], review: 'approved' }
const MERGE_B: OpenPr = { id: 'ws-398', agentId: 'noor', key: 'KERNEL-398', n: 330, title: 'Lead worktree tests call the features, not Kernel', state: 'ready', stat: [2, 2], review: 'approved' }
const MERGE_C: OpenPr = { id: 'ws-400', agentId: 'noor', key: 'KERNEL-400', n: 333, title: "New workspaces start from the room's default branch", state: 'checks', stat: [125, 4], review: 'stale' }

/**
 * KERNEL-515: the panel's strip for each tab, as the PanelToolbar* fixtures and PanelFilter show it. Noor's PR #147 for KERNEL-155 changed 16 files, which the Changes tab lists, the
 * All files tree marks and the Checks tab counts. Its run script is on port 4303.
 */
const PANEL_CHANGES: ChangedFile[] = [
  { path: '.changes/unreleased/inbox-stale-rows.md', status: 'A', added: 5, removed: 0 },
  { path: 'docs/decisions/KERNEL-155.md', status: 'A', added: 7, removed: 0 },
  { path: 'src/main/db.ts', status: 'M', added: 24, removed: 1 },
  { path: 'src/main/features/inbox.ts', status: 'M', added: 31, removed: 12 },
  { path: 'src/main/features/wiring.ts', status: 'M', added: 6, removed: 2 },
  { path: 'src/main/services/approvals.ts', status: 'M', added: 24, removed: 9 },
  { path: 'src/main/services/notifications.ts', status: 'M', added: 18, removed: 6 },
  { path: 'src/renderer/src/screens/home/Home.tsx', status: 'M', added: 9, removed: 11 },
  { path: 'src/renderer/src/screens/inbox/Inbox.tsx', status: 'M', added: 22, removed: 14 },
  { path: 'src/renderer/src/screens/inbox/InboxRow.tsx', status: 'M', added: 8, removed: 5 },
  { path: 'src/renderer/src/store.ts', status: 'M', added: 3, removed: 1 },
  { path: 'src/shared/inbox.ts', status: 'M', added: 4, removed: 0 },
  { path: 'src/shared/ipc.ts', status: 'M', added: 2, removed: 0 },
  { path: 'test/inbox.test.ts', status: 'M', added: 31, removed: 9 },
  { path: 'test/leadArchive.test.ts', status: 'M', added: 12, removed: 0 },
  { path: 'test/notifications.test.ts', status: 'M', added: 0, removed: 5 }
]

/** The repo's files: the changed ones above with their status, and the rest as the canvas lists them. */
const PANEL_TREE: FileEntry[] = [
  ...['.changes', '.changes/unreleased', '.github', 'design', 'docs', 'docs/decisions', 'fixtures', 'scripts', 'src', 'src/main', 'src/main/features', 'src/main/services', 'src/preload', 'src/renderer', 'src/renderer/src', 'src/renderer/src/screens', 'src/renderer/src/screens/home', 'src/renderer/src/screens/inbox', 'src/shared', 'test'].map((path) => ({ path, dir: true })),
  ...['docs/ARCHITECTURE.md', 'docs/PRODUCT.md', 'docs/ROADMAP.md', 'src/main/bus.ts', 'src/main/kernel.ts', '.gitignore', 'CLAUDE.md', 'DESIGN.md', 'package.json'].map((path) => ({ path, dir: false })),
  ...PANEL_CHANGES.map((c): FileEntry => ({ path: c.path, dir: false, status: c.status }))
]

/** What the table workspace's run script has printed, so its Run tab is running (PanelToolbarChecks). */
const PANEL_RUN: PushEvent[] = ['$ pnpm dev --port 4303', 'VITE v6.3.5  ready in 412 ms', 'Local:   http://localhost:4303/', 'Compiled /inbox in 1.2s', 'GET /api/requests 200 in 84ms', 'GET /inbox 200 in 31ms']
  .map((line): PushEvent => ({ type: 'script.output', workspaceId: ids.table, kind: 'run', lines: [{ line, stream: 'stdout' }] }))

const PANEL_CHECKS: PrCheck[] = [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'typecheck', state: 'pass', meta: '31s' }, { name: 'vitest', state: 'pass', meta: '48s' }, { name: 'playwright', state: 'pass', meta: '2m 4s' }]

/** The five commits PR #147 has on its branch, newest first, as the Changes ⋯ menu lists them (PanelCompare, KERNEL-517). Their ages are from now, so the shot always reads "12 min ago" and "Yesterday". */
const PANEL_COMMITS: BranchCommit[] = ([
  ['3e1f9a2', 'Count a workspace waiting on script trust in Inbox', 12 * 60_000],
  ['b07c4d8', 'Drop Inbox rows for archived chats', 41 * 60_000],
  ['9a2d6f1', 'Cover the stale-row sweep in tests', 60 * 60_000],
  ['f565c3d', 'Merge origin/main into the branch', 3 * 3600_000],
  ['7c2c03f', 'Add the stale-row sweep to the inbox feature', 30 * 3600_000]
] as const).map(([short, subject, age]) => ({ sha: short.padEnd(40, '0'), subject, author: 'Noor', time: Date.now() - age }))

/** PR #147 on `right`, the bottom folded to its tab bar unless `open`, and its run script idle unless `running`. */
const panelScene = (right: 'files' | 'changes' | 'checks', o: { tree?: boolean; open?: boolean; running?: boolean } = {}): Fixture => {
  const f = headerScene('ready', [], { panel: true })
  const idle = idleRun(f)
  return {
    ...(o.running ? f : idle),
    workspaces: f.workspaces.map((w) => (w.id === ids.table ? { ...w, port: 4303, prTitle: 'fix(inbox): keep asking about requests', stat: { files: 16, added: 206, removed: 75 } } : w)),
    changes: { ...f.changes, [ids.table]: PANEL_CHANGES },
    tree: { ...f.tree, [ids.table]: PANEL_TREE },
    prs: { ...f.prs, [ids.table]: { ...f.prs![ids.table], title: 'fix(inbox): keep asking about requests', checks: PANEL_CHECKS } },
    push: o.running ? [...f.push.filter((e) => e.type !== 'script.output' || e.kind !== 'run'), ...PANEL_RUN] : idle.push,
    ui: { ...f.ui, workspace: { ...f.ui!.workspace!, right, ...(o.tree ? { changesView: 'tree' as const } : {}) }, bottomCollapsed: { lead: !o.open, teammate: !o.open } }
  }
}

/** A ready PR, then one PR in each state the band, the PRs tab, a Team update row and the sidebar all say the same way (KERNEL-417). */
const PR_STATES: OpenPr[] = [
  LEAD_PRS[0],
  { id: 'ws-160', agentId: 'kai', key: 'KERNEL-160', n: 155, title: 'Issues screen with search', state: 'merging', stat: [212, 30], review: 'approved' },
  LEAD_PRS[3],
  { id: 'ws-190', agentId: 'noor', key: 'KERNEL-190', n: 170, title: 'Sidebar keeps its scroll on a new chat', state: 'resolving', stat: [40, 12] },
  LEAD_PRS[6],
  LEAD_PRS[4],
  LEAD_PRS[5],
  LEAD_PRS[7]
]

/**
 * A Team update about each PR of `PR_STATES`, with the PRs tab beside it (KERNEL-417). Both places say each PR's state the same
 * way: Merging, Checks running and Resolving spin, what failed is red, the draft reads Draft, and the ready PR keeps Merge.
 */
const teamUpdatePrStates = (f: Fixture): Partial<Fixture> => {
  const ev = (kind: TeamEventKind, text: string, actionable = false) => ({ kind, text, actionable })
  const events = (p: OpenPr): TeamUpdateRow['events'] => {
    switch (p.state) {
      case 'merging': return [ev('turn', 'Finished a turn'), ev('turn', `Merging PR #${p.n}`)]
      case 'checks': return [ev('pr.opened', `Opened PR #${p.n}`)]
      case 'resolving': case 'conflict': return [ev('pr.conflict', `Merge conflicts on PR #${p.n}`, true)]
      case 'cifail': return [ev('pr.cifail', `Checks failed on PR #${p.n}`, true)]
      case 'changes': return [ev('pr.changes', `Theo requested changes on PR #${p.n}`, true)]
      case 'draft': return [ev('pr.opened', `Opened draft PR #${p.n}`)]
      default: return [ev('pr.ready', 'Ready to merge', true), ev('pr.review', 'Theo approved')]
    }
  }
  const names: Record<string, string> = { kai: 'Kai', noor: 'Noor', ivy: 'Ivy' }
  const rows = PR_STATES.map((p): TeamUpdateRow => ({ workspaceId: p.id, agentId: p.agentId, name: names[p.agentId], task: p.title, events: events(p) }))
  const card: ChatItem = { kind: 'user', id: 'tus-1', ts: at(20, 30), from: 'kernel', update: { rows }, parts: [{ type: 'text', text: 'Team update from Kernel, not from the user.' }] }
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Composer focus', [card, { kind: 'result', id: 'tus-res', ts: at(20, 31), durationMs: 14_000, ok: true }], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  return {
    ...rest, ...openPrs(f, PR_STATES),
    roomSettings: { [ids.roomA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } },
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', leadRight: 'prs', bottom: 'run', checkpoints: false, toolsOpen: false } }
  }
}

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
  ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents' }, modal: { name: 'newWorkspace', roomId: ids.roomA }, menu: menu ?? null }
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

/** Kernel's workspace, with the page Noor shared from a workspace that has been archived since (WorkspaceSharedCommentArchived). */
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

/** Kernel's workspace with the room's five files, the HTML open in a tab. The Lead's panel lists every file shared in the room. */
const sharedPanel = (f: Fixture): Partial<Fixture> => {
  // scene2 sets approvals only when it is given some; an undefined one would hide the seed's.
  const { approvals: _none, ...lead } = scene2(f, { id: ids.lead, name: 'export-invoices-as-pdf', branch: 'feat/export-invoices-as-pdf', mode: 'worktree', lead: undefined, agentId: 'kernel-lead', stat: { files: 1, added: 64, removed: 0 } }, 'Export invoices as PDF', [
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

/** Kernel's Team update in Kernel's chat with a file under each of two teammates (TeamUpdateShared.png). */
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
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Composer focus', [
    update,
    { kind: 'text', id: 'tus-r', ts: at(14, 42), text: "Noor shared the invoice layouts and Kai shared a note on the download button. I'll look at both before I pass anything on." },
    { kind: 'result', id: 'tus-res', ts: at(14, 42), durationMs: 45_000, ok: true }
  ], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  return { ...rest, shared: sharedFiles(), sharedData: sharedStills }
}

/**
 * KERNEL-599: the chat rail. Noor's chat on PR #147 for KERNEL-155 holds 18 messages, each with a short turn,
 * and the 14th has the long reply. ChatRail and ChatRailOpen are read from the 14th message (the shot script scrolls it under the tab row), ChatRailNarrow is
 * at the bottom with the right panel open.
 */
type RailRound = [ask: string, reply: string, tools: number, thoughts: number, seconds: number, clock: [number, number]]
const RAIL_LONG_REPLY = [
  'PR #147 no longer conflicts with main. I merged origin/main into the branch and pushed it normally, with no force push.',
  '',
  '**What I did**',
  '',
  '- **Reset:** put the branch back on the pushed commit, 7c2c03f, and dropped the local rebase.',
  '- **Merge:** merged origin/main (f565c3d). The only conflict was `docs/DECISIONS.md`. Main\'s D-136 stays as it is, and my entry follows it as **D-137**.',
  '- **Renumber commit (1440439):** my code comments that cited D-136 now cite D-137, 12 lines across `ipc.ts`, `kernel.ts`, `db.ts` and `approvals.ts`.',
  '- **Checks:** `pnpm typecheck` passes, and `pnpm test` passes with 901 passed and 4 skipped.',
  '',
  '**PR state**',
  '',
  'GitHub reports the PR as mergeable, with merge state `BLOCKED`. When I checked once, Vercel had passed and the Release note check was still running. I didn\'t wait for it.',
  '',
  '**What\'s left**',
  '',
  '- **Release note check:** still running on Vercel\'s side. I\'ll look again before I stop.',
  '- **PR body:** updated to D-137 and D-138, and it lists the renumber commit.',
  '- **Review:** Theo hasn\'t been asked yet.',
  '',
  '**Next**',
  '',
  'I will check the Release note check again and tell you when it passes.'
].join('\n')
const railRounds: RailRound[] = [
  ['Home and Inbox keep asking about requests and the PRs, find out why', 'Inbox builds its rows from two lists that share one query, so a request and its PR land in the same row. That is why both keep asking.', 6, 2, 184, [12, 8]],
  ['Where does Inbox build its rows?', 'In `inbox.ts`, in `buildRows`. Home reads the same function through the store.', 2, 0, 21, [12, 11]],
  ['Keep requests and PRs in separate lists', 'Done. Requests and PRs now come from two queries, and each list sorts on its own.', 5, 1, 142, [12, 16]],
  ['Add a test for the stale PR row', 'Added `inbox.test.ts` cases for a PR that merged while its row was open. Both pass.', 4, 1, 96, [12, 21]],
  ['Run typecheck and the tests', 'Both pass. 887 tests passed and 4 were skipped.', 2, 0, 74, [12, 24]],
  ['Open the PR when it\'s green', 'Opened PR #147. Checks started.', 3, 0, 38, [12, 27]],
  ['Checks failed on #147, can you look?', 'One check failed, Vercel\'s build, with a rate limit error. Nothing in the code failed.', 3, 1, 52, [12, 31]],
  ['The Vercel build is rate limited, leave it alone', 'Understood, I left it. It will pass when the limit resets.', 1, 0, 9, [12, 33]],
  ['Rebase onto main', 'Rebased onto origin/main. One conflict in `docs/DECISIONS.md`, which I resolved.', 5, 2, 131, [12, 38]],
  ['Theo wants the empty state to say what\'s missing', 'The empty state now says "No requests yet" or "No PRs yet", whichever list is empty.', 4, 1, 88, [12, 44]],
  ['Reword that in plain words', 'Reworded. It reads "Nothing asked of you yet" for requests and "No open PRs" for PRs.', 2, 0, 27, [12, 47]],
  ['Squash the last two commits', 'Squashed them into one commit.', 2, 0, 18, [12, 51]],
  ['Why did the rebase drop my D-136 entry?', 'The rebase took main\'s version of `docs/DECISIONS.md`, which already had a D-136. Mine was in the conflict and lost.', 3, 1, 232, [13, 1]],
  ['Change of method for the conflict on PR #147. The repo\'s guard hook blocks force pushes, so don\'t rebase. Merge origin/main into your branch and push normally, since the repo squash-merges anyway. Everything else stays the same: your entry becomes D-137, check kernel.ts against #149, run typecheck and test, and update the PR body.', RAIL_LONG_REPLY, 9, 12, 232, [13, 1]],
  ['Show me the renumber commit', 'It\'s 1440439. It changes 12 comment lines across `ipc.ts`, `kernel.ts`, `db.ts` and `approvals.ts`, and no code.', 1, 1, 21, [13, 4]],
  ['Check the Release note check, then tell me', 'It\'s still running. Vercel passed on the last push.', 2, 0, 34, [13, 6]],
  ['Did Theo review it yet?', 'Not yet. I asked him in his chat 12 minutes ago, and he hasn\'t replied.', 0, 0, 8, [13, 7]],
  ['Ping him again if there\'s nothing by 13:30, and tell me when PR #147 is ready to merge so I can tell Kernel.', 'Will do. Right now PR #147 passes checks and has no conflicts, so only Theo\'s review is missing. I\'ll ask him again at 13:30 and write to you the moment he approves, with the PR number so you can merge from the panel.', 0, 0, 77, [13, 9]]
]
const railChat = (): ChatItem[] => railRounds.flatMap(([ask, reply, tools, thoughts, secs, clock], i): ChatItem[] => [
  { kind: 'user', id: `rc-u${i}`, ts: at(...clock) - secs * 1000, parts: [{ type: 'text', text: ask }] },
  ...folded(`rc${i}`, tools, thoughts),
  { kind: 'text', id: `rc-x${i}`, ts: at(...clock), text: reply },
  { kind: 'result', id: `rc-r${i}`, ts: at(...clock), durationMs: secs * 1000, ok: true }
]).concat({ kind: 'note', id: 'rc-note', ts: at(13, 9, 30), text: 'PR #147 passed checks and has no conflicts.' })
const railScene = (panel = false): Fixture => {
  const f = panel ? panelScene('changes', { open: true }) : headerScene('ready', [])
  return { ...f, items: { ...f.items, [ids.tableChat]: railChat() } }
}

/**
 * ChatRailLead: Kernel's chat with 11 things to list, 6 of them Team updates. The updates are the ones the PNG's rail names, and each row of each is the engine's own wording.
 * Noor's PR #161 and Kai's #162 can merge, so the newest card offers Merge for both, and #150 is in History.
 */
const railLead = (f: Fixture): Partial<Fixture> => {
  const row = tuRow, ev = tuEv
  const ask = (id: string, text: string, m: number): ChatItem => ({ kind: 'user', id, ts: at(20, m), parts: [{ type: 'text', text }] })
  const answer = (id: string, text: string, secs: number, m: number): ChatItem[] => [
    { kind: 'text', id: `${id}-x`, ts: at(20, m), text },
    { kind: 'result', id: `${id}-r`, ts: at(20, m), durationMs: secs * 1000, ok: true }
  ]
  const kai = (events: TeamUpdateRow['events']) => row('ws-182', 'kai', 'Kai', 'New chats focus the composer, and ⌘L focuses it', events)
  const noor = (events: TeamUpdateRow['events']) => row('ws-176', 'noor', 'Noor', 'Kernel asks when a brief is unclear', events)
  const items: ChatItem[] = [
    ask('rl-u1', 'Plan the week: what\'s ready, what\'s blocked?', 0),
    ...answer('rl-u1', 'Three tasks are in flight. Noor has the Linear service, Kai has the composer focus and Theo is free to review. Nothing is blocked yet.', 42, 0),
    ask('rl-u2', 'Who can take KERNEL-189?', 1),
    ...answer('rl-u2', 'Noor can, once KERNEL-163 merges.', 11, 1),
    tuCard('rl-t3', 2, [noor([ev('pr.opened', 'Opened PR #161')])]),
    ...answer('rl-t3', 'Noor opened PR #161. I will ask Theo to review it once checks pass.', 15, 2),
    ask('rl-u4', 'Ask Kai to fix the composer focus', 3),
    ...answer('rl-u4', 'Kai has it.', 9, 3),
    tuCard('rl-t5', 4, [kai([ev('turn', 'Finished a turn'), ev('pr.opened', 'Opened PR #162')])]),
    ...answer('rl-t5', 'Kai opened PR #162 for the composer focus.', 12, 4),
    ask('rl-u6', 'Ask Theo to review #161 and #162', 5),
    ...answer('rl-u6', 'Theo is reviewing both PRs.', 14, 5),
    tuCard('rl-t7', 6, [row('ws-review-161', 'theo', 'Theo', 'KERNEL-176 Kernel asks when a brief is unclear', [ev('review', 'Approved PR #161', true)]), kai([ev('turn', 'Finished a turn')])]),
    ...answer('rl-t7', 'Theo approved #161. #162 is still in review.', 18, 6),
    tuCard('rl-t8', 8, [row('ws-163', 'noor', 'Noor', "Linear service, contracts and Kernel's issue link", [ev('pr.merged', 'Merged PR #150')])]),
    { kind: 'result', id: 'rl-t8-r', ts: at(20, 9), durationMs: 4 * 60_000 + 9_000, ok: true },
    tuCard('rl-t9', 14, [kai([ev('turn', 'Finished a turn'), ev('pr.opened', 'Opened PR #162'), ev('pr.cifail', 'Checks failed', true)])]),
    ...answer('rl-t9', 'Nothing in Kai\'s code failed. Vercel\'s build rate limit is the only failure on PR #162.', 10, 15),
    tuCard('rl-t10', 15, [kai([ev('turn', 'Finished a turn'), ev('turn', 'Pushed a fix'), ev('pr.ready', 'Ready to merge', true)]), noor([ev('pr.opened', 'Opened PR #161'), ev('pr.ready', 'Ready to merge', true)])]),
    { kind: 'result', id: 'rl-t10-r', ts: at(20, 16), durationMs: 55_000, ok: true },
    ask('rl-u11', 'What can I merge?', 30),
    ...answer('rl-u11', 'Two PRs are ready to merge, #162 from Kai and #161 from Noor. #158 waits for Theo\'s review. Merge from the PRs tab, or tell me which one and I will.', 12, 31)
  ]
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Composer focus', items, {}, { model: 'claude-opus-5-5', effort: 'xhigh', plan: false })
  const { approvals: _none, ...rest } = s
  const issue = (key: string, title: string): Partial<Workspace> => ({ title, source: { kind: 'issue', id: key, title } })
  const tab = (id: string, title: string, m: number): Chat => ({ id, workspaceId: ids.lead, title, kind: 'chat', model: 'claude-opus-5-5', effort: 'xhigh', plan: false, threadId: 't-lead', createdAt: at(9, m) })
  return {
    ...rest,
    ui: { ...rest.ui!, rightPanel: false, tabs: { [ids.lead]: { tab: ids.leadChat, lastChat: ids.leadChat, files: [], diffs: [] } } },
    rooms: f.rooms.map((r) => (r.id === ids.roomA ? { ...r, name: 'Kernel' } : r)),
    chats: [tab('chat-lead-week', 'Plan the week', 1), tab('chat-lead-inbox', 'Inbox rows', 2), tab('chat-lead-linear', 'Linear setup', 3), ...(s.chats ?? f.chats)],
    workspaces: [
      ...(s.workspaces ?? f.workspaces),
      tuWork('ws-182', 'kai', 'kernel-182-new-chats-focus', 162, { prHead: 'h162', ...issue('KERNEL-182', 'New chats focus the composer, and ⌘L focuses it') }),
      tuWork('ws-176', 'noor', 'kernel-176-kernel-asks', 161, { prHead: 'h161', reviews: [tuVerdict('ws-review-161', 161, 'h161')], ...issue('KERNEL-176', 'Kernel asks when a brief is unclear') }),
      tuWork('ws-review-161', 'theo', 'review-pr-161-kernel-176', 0, { prState: 'none', prNumber: undefined, prUrl: undefined, reviewOf: 'ws-176' }),
      tuWork('ws-163', 'noor', 'kernel-163-linear-service', 150, { prState: 'merged', status: 'archived', mergedAt: at(20, 9), ...issue('KERNEL-163', "Linear service, contracts and Kernel's issue link") })
    ],
    prs: { 'ws-182': tuInfo('ws-182', 162, 'h162'), 'ws-176': tuInfo('ws-176', 161, 'h161') }
  }
}

// ---------- Lead chats that hold several tabs (KERNEL-338)

const GROUPED = { export: 't-export', table: 't-table', login: 't-login', demo: 't-demo', csv: 't-csv' } as const
const groupedThread = (id: string, title: string, m: number): Thread => ({ id, roomId: ids.roomA, title, createdAt: at(9, m) })
/** Each chat with Kernel's own workspace (KERNEL-405). The export chat's is the seed's Lead workspace. */
const CHAT_WS: Record<string, string> = { [GROUPED.export]: ids.lead, [GROUPED.table]: 'ws-chat-table', [GROUPED.login]: 'ws-chat-login', [GROUPED.demo]: 'ws-chat-demo', [GROUPED.csv]: 'ws-chat-csv' }
/** A tab of the Lead chat `threadId`, in that chat's workspace. */
const leadTab = (id: string, threadId: string, title: string, m: number, over: Partial<Chat> = {}): Chat =>
  ({ id, workspaceId: CHAT_WS[threadId] ?? ids.lead, title, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, threadId, createdAt: at(9, m), ...over })
const chatSlug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
/** A chat with Kernel's own worktree on `kernel/<a few words>` (KERNEL-405). Archived with its chat. */
const chatWorkspace = (t: Thread, port: number, over: Partial<Workspace> = {}): Workspace => ({
  id: CHAT_WS[t.id] ?? `ws-chat-${t.id}`, roomId: ids.roomA, name: chatSlug(t.title), branch: `kernel/${chatSlug(t.title)}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/client-a/kernel-${chatSlug(t.title)}`,
  mode: 'worktree', agentId: 'kernel-lead', lead: true, threadId: t.id, port, status: t.closedAt ? 'archived' : 'ready', prState: 'none', createdAt: t.createdAt, ...(t.closedAt ? { archivedAt: t.closedAt } : {}), ...over
})
/** A workspace the Lead's chat `threadId` handed off, from its first tab. */
const handedOff = (id: string, name: string, task: string, agentId: string, port: number, over: Partial<Workspace> = {}): Workspace =>
  ({ id, roomId: ids.roomA, name, branch: `feat/${task}-${name}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/client-a/${name}`, mode: 'worktree', agentId, port, status: 'ready', prState: 'none', createdAt: at(10, 2), threadId: GROUPED.export, leadChatId: ids.leadChat, ...over })

const T15_STEPS = [
  { title: 'T-15a PDF renderer with embedded fonts', taskId: 'T-15a', agentId: 'noor' }, { title: 'T-15b Download PDF in the row actions', taskId: 'T-15b', agentId: 'kai' },
  { title: 'T-15c Snapshot tests for three invoice types', taskId: 'T-15c', agentId: 'ivy' }, { title: 'T-15d Review each PR as it lands', taskId: 'T-15d', agentId: 'theo' }
]

/** The first tab of the Export chat: the plan Kernel wrote and you approved, then the hand-off. */
const exportItems = (): ChatItem[] => [
  userMsg('g1', 'Add PDF export to invoices. Spec first.'),
  { kind: 'thinking', id: 'g1-th', ts: at(10, 8), text: 'Renderer, button, tests and review can run in parallel.' },
  tool('g1-t1', 'Read the invoices module', 'cat src/app/invoices/page.tsx', { name: 'Read' }),
  tool('g1-t2', 'Write the plan', 'cat > plans/t-15-invoice-pdf.md', { name: 'Write' }),
  { kind: 'text', id: 'g1-tx', ts: at(10, 9), text: 'I split PDF export into four tasks that can run in parallel.' },
  { kind: 'approval', id: 'approval-ap-plan-kernel', ts: at(10, 12), approvalId: 'ap-plan-kernel' },
  { kind: 'text', id: 'g1-done', ts: at(10, 13), text: 'Handed off. Noor has the renderer, Kai has the button and Ivy has the tests. Theo reviews each PR as it lands.' }
]

/** The Lead's workspace on the sidebar the Grouped PNGs share: four Lead chats, two of them with several tabs, and their workspaces. Each shot picks what is open. */
export function grouped(f: Fixture, o: { tab?: string; files?: string[]; right?: 'prs' | 'changes' | 'files'; running?: string[]; items?: Record<string, ChatItem[]>; chats?: (c: Chat[]) => Chat[]; threads?: (t: Thread[]) => Thread[] } = {}): Partial<Fixture> {
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
  const plan: Approval = { ...pending('plan', 'kernel-lead', { workspaceId: ids.lead, chatId: ids.leadChat, title: 'Plan for T-15', steps: T15_STEPS }), status: 'allowed', createdAt: at(10, 12) }
  const tab = o.tab ?? ids.leadChat
  const handed: Workspace[] = [
    handedOff('ws-pdf-renderer', 'invoice-pdf-renderer', 't-15a', 'noor', 4320, { stat: { files: 3, added: 188, removed: 0 } }),
    handedOff('ws-pdf-button', 'invoice-pdf-button', 't-15b', 'kai', 4321, prFields(PDF_BUTTON_PR)),
    handedOff('ws-pdf-tests', 'invoice-pdf-tests', 't-15c', 'ivy', 4322, { stat: { files: 2, added: 138, removed: 9 } })
  ]
  const allThreads = (o.threads ?? ((t) => t))(threads)
  const allChats = (o.chats ?? ((c) => c))(chats)
  // Each chat has its own workspace, so the one on screen is the open tab's (KERNEL-405).
  const own = allThreads.map((t, i) => chatWorkspace(t, 4300 + i * 10))
  const shown = allChats.find((c) => c.id === tab)?.workspaceId ?? ids.lead
  const tree = (f.tree?.[ids.table] ?? []).map(({ status: _s, ...e }) => e)
  return {
    threads: allThreads,
    // The seed's single Lead chat gives way to the tabs above. The table and schema workspaces were handed off by the table chat.
    chats: [...allChats, ...f.chats.filter((c) => c.workspaceId !== ids.lead)],
    workspaces: [...own, ...handed, ...withWorkspace(f, ids.table, { threadId: T.table }).filter((w) => w.id !== ids.lead).map((w) => (w.id === ids.schema ? { ...w, threadId: T.table, stat: { files: 2, added: 54, removed: 6 } } : w.id === ids.invites ? { ...w, ...prFields(INVITES_PR) } : w))],
    // Kai's two PRs are ready and approved, which the tab and the header count (KERNEL-354).
    prs: { 'ws-pdf-button': openPrInfo(PDF_BUTTON_PR), [ids.invites]: openPrInfo(INVITES_PR) },
    items: { [ids.leadChat]: exportItems(), [ids.tableChat]: [], ...o.items },
    approvals: [plan, ...f.approvals],
    push: [...f.push, ...(o.running ?? ['chat-table']).map((chatId): PushEvent => ({ type: 'chat.running', chatId, running: true }))],
    // Each chat's worktree sits at the base, so no file differs from it.
    tree: { ...f.tree, ...Object.fromEntries(own.map((w) => [w.id, tree])) },
    fileText: { ...f.fileText, ...Object.fromEntries(own.map((w) => [w.id, f.fileText?.[ids.table] ?? {}])) },
    ui: {
      route: { name: 'workspace', workspaceId: shown }, workspace: { right: 'changes', leadRight: o.right ?? 'prs', bottom: 'run', checkpoints: false, toolsOpen: false },
      tabs: { [shown]: { tab, lastChat: tab.startsWith('file:') ? undefined : tab, files: o.files ?? [], diffs: [] } }
    }
  }
}

/**
 * SidebarUnread (no PNG, KERNEL-508): `grouped` with a bold title on each row that has a reply you haven't seen, and no dot anywhere. The table chat is on screen,
 * so its row stays regular although its second tab is unread, and that tab is bold. Under it, invoice-schema is unread and invoice-table is read. The login chat
 * is unread in one tab and running in the other, so its row is bold and keeps its spinner. The export chat is folded over three workspaces, one of them unread,
 * so its row is bold. org-invites needs you and is unread, with the amber icon and the bold title together. Client B is collapsed over an unread workspace,
 * and the demo chat, the other rooms and invoice-table are read.
 */
function sidebarUnread(f: Fixture): Partial<Fixture> {
  const unreadAt = at(10, 40)
  const unread = new Set(['chat-table-copy', 'chat-login-redirect', ids.schemaChat, ids.invitesChat, 'chat-pdf-button', 'chat-landing'])
  const owned = (id: string, workspaceId: string, title: string): Chat => ({ id, workspaceId, title, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: at(10, 5) })
  const g = grouped(f, { tab: 'chat-table', running: ['chat-login'] })
  const landing = handedOff('ws-landing-copy', 'landing-copy', 't-31', 'kai', 4330, { roomId: ids.roomB, threadId: undefined, leadChatId: undefined, branch: 'feat/t-31-landing-copy', path: '/Users/you/kernel/worktrees/client-b/landing-copy' })
  const question = pending('question', 'kai', { workspaceId: ids.invites, chatId: ids.invitesChat, title: 'Should invites expire after 7 days?', options: ['Yes, 7 days', 'No expiry'] })
  return {
    ...g,
    chats: [...g.chats!, owned('chat-pdf-button', 'ws-pdf-button', 'Download PDF button'), owned('chat-landing', landing.id, 'Landing page copy')].map((c) => (unread.has(c.id) ? { ...c, unreadAt } : c)),
    workspaces: [...g.workspaces!, landing],
    approvals: [...g.approvals!, question],
    items: { ...g.items, 'chat-table': groupedTurn('su', 38, 'Build the invoice table with sorting, plus the empty, loading and error states.', 'The table and the schema change are independent. Kai and Noor can start together.', [], 'Kai has the table and its states. Noor has the schema change the table needs.') },
    ui: { ...g.ui!, foldedChats: [GROUPED.export] }
  }
}

/** SidebarPlanChat (no PNG): `grouped` with the table chat and its copy tab planning, so their rows take the blue icon next to the ordinary ones. */
function sidebarPlanChat(f: Fixture): Partial<Fixture> {
  const g = grouped(f, { tab: 'chat-login', running: [] })
  return { ...g, chats: g.chats!.map((c) => (c.id === 'chat-table' || c.id === 'chat-login' ? { ...c, plan: true } : c)) }
}

/** WorkspaceLead.png: `grouped` with the export chat's plan still waiting, so it has one tab and nothing handed off, and no demo chat. */
function leadWaiting(f: Fixture): Partial<Fixture> {
  const plan = leadPlan(f, { agentId: 'kernel-lead' })
  const g = grouped(f, { chats: (c) => c.filter((x) => x.threadId !== GROUPED.export && x.threadId !== GROUPED.demo), threads: (t) => t.filter((x) => x.id !== GROUPED.demo) })
  const lead = plan.workspaces!.find((w) => w.id === ids.lead)!
  return {
    ...g,
    chats: [leadTab(ids.leadChat, GROUPED.export, 'Export invoices as PDF', 5, { plan: true }), ...g.chats!],
    // The schema workspace has no changes yet, as the PNG draws it. The export chat's own workspace keeps its branch (KERNEL-405).
    workspaces: g.workspaces!.filter((w) => w.threadId !== GROUPED.export || w.lead).map((w) => (w.id === ids.lead ? { ...lead, name: w.name, branch: w.branch, path: w.path, threadId: w.threadId } : w.id === ids.schema ? { ...w, stat: undefined } : w)),
    items: { ...g.items, ...plan.items },
    approvals: plan.approvals,
    changes: plan.changes
  }
}

/** Kernel, mid-turn `ago` seconds in, as the running tabs of the Grouped shots show it. */
const groupedTurn = (id: string, ago: number, ask: string, thought: string, tools: ChatItem[], reply?: string): ChatItem[] => [
  { ...userMsg(id, ask), ts: Date.now() - ago * 1000 }, { kind: 'thinking', id: `${id}-th`, ts: at(10, 28), text: thought }, ...tools, ...(reply ? [{ kind: 'text' as const, id: `${id}-tx`, ts: at(10, 29), text: reply }] : [])
]

/** What a freshly cloned repo's settings.toml and package.json ask the user to trust (KERNEL-209, KERNEL-218, KERNEL-260). */
export const scriptTrust: ScriptTrust = {
  roomId: ids.roomA, hash: 'a41f0c9e', workspaceIds: [ids.table],
  scripts: { setup: 'pnpm install --frozen-lockfile\ncp ../../.env.local .env.local', run: 'pnpm dev --port $KERNEL_PORT', archive: 'pnpm clean' },
  runScripts: [{ name: 'storybook', command: 'pnpm storybook --port $KERNEL_PORT' }],
  copy: ['.env.local', 'certs/*.pem'],
  installScripts: [{ name: 'postinstall', command: 'node scripts/postinstall.js' }, { name: 'prepare', command: 'husky install' }]
}

/** Wren's tools line, naming each MCP server in `servers` the way an agent file does (`mcp__figma__*`). */
const hireTools = (servers: string[]) => ['tools: Read, Grep, Glob, Bash(pnpm screenshot:*),', `  ${servers.map((n) => `mcp__${n}__*`).join(', ')}`]

/** Kernel's chat with the hire card for wren.md waiting (WorkspaceHire.png), with the servers its file reaches when `servers` is set (WorkspaceHireServers.png). */
const hireScene = (tools: string[], servers?: AgentReach, scope?: AgentScope) => scene((f) => ({
  ...scene2(f, { id: ids.lead, name: 'hire-a-designer', branch: 'main', baseRef: 'main', mode: 'current', agentId: 'kernel-lead', stat: { files: 1, added: 28, removed: 0 } }, 'Hire a designer', [
    userMsg('h0', 'We need a designer on the team who checks every screen against DESIGN.md before review.'),
    { kind: 'thinking', id: 'h-th', ts: at(10, 28), text: 'This fits as a subagent with read access and the screenshot skill.' },
    tool('h-t1', 'Read DESIGN.md', 'cat DESIGN.md', { name: 'Read' }),
    { kind: 'text', id: 'h-tx', ts: at(10, 29), text: 'Here is the agent file. Once you approve, I will save it and Wren joins the team.' }
  ], {
    approvals: [pending('agent', 'kernel-lead', { workspaceId: ids.lead, title: 'Add wren to the team', agentFile: { path: '.claude/agents/wren.md', ...(servers ? { servers } : {}), ...(scope ? { scope } : {}), text: [
      '---', 'name: wren', 'description: Designer. Checks every screen against DESIGN.md', '  before Theo reviews it. Flags spacing, type and color drift.', 'model: sonnet', ...tools, '---'
    ].join('\n') } }), ...f.approvals]
  }, { plan: false, model: 'claude-opus-5-5' }),
  changes: { [ids.lead]: [{ path: '.claude/agents/wren.md', status: 'A', added: 28, removed: 0 }] }
}))

/**
 * KERNEL-586: the turn files card, in Noor's chat for KERNEL-155. A first answer, then a turn that ends in `reply` (or in
 * its tool calls, with no reply) and the files it changed. The right panel lists everything PR #147 changed so far, which is `panel`.
 */
const tf = (path: string, status: ChangedFile['status'], added: number, removed: number): ChangedFile => ({ path, status, added, removed })
const TF_NOTES = tf('.changes/unreleased/inbox-stale-rows.md', 'A', 5, 0)
const TF_DECISION = tf('docs/decisions/KERNEL-155.md', 'A', 7, 0)
const TF_DB = tf('src/main/db.ts', 'M', 24, 1)
const TF_INBOX = tf('src/main/features/inbox.ts', 'M', 31, 12)
const TF_WIRING = tf('src/main/features/wiring.ts', 'M', 6, 2)
const TF_APPROVALS = tf('src/main/services/approvals.ts', 'M', 24, 9)
const TF_POLL = tf('src/main/services/inboxPoll.ts', 'D', 0, 54)
const TF_NOTIFY = tf('src/main/services/notifications.ts', 'M', 18, 6)
const TF_HOME = tf('src/renderer/src/screens/home/Home.tsx', 'M', 9, 11)
const TF_CSS = tf('src/renderer/src/screens/inbox/inbox.css', 'M', 4, 2)
const TF_PAGE = tf('src/renderer/src/screens/inbox/Inbox.tsx', 'M', 22, 14)
const TF_ROW = tf('src/renderer/src/screens/inbox/InboxRow.tsx', 'M', 8, 5)
const TF_HOOK = tf('src/renderer/src/screens/inbox/useInboxRows.ts', 'A', 74, 0)
const TF_STORE = tf('src/renderer/src/store.ts', 'M', 3, 41)
const TF_SHARED = tf('src/shared/inbox.ts', 'M', 4, 0)
const TF_IPC = tf('src/shared/ipc.ts', 'M', 2, 0)
const TF_STALE = tf('test/inboxStale.test.ts', 'A', 68, 0)
const TF_ROWS = tf('test/inboxRows.test.ts', 'A', 88, 0)
const TF_NOTIFY_TEST = tf('test/notifications.test.ts', 'M', 0, 5)

const turnFilesScene = (turn: ChatItem[], panel: ChangedFile[], earlier?: ChangedFile[]) => {
  const f = idleRun(headerScene('ready', [], { panel: true }))
  const total = (key: 'added' | 'removed') => panel.reduce((n, c) => n + c[key], 0)
  return {
    ...f,
    workspaces: f.workspaces.map((w) => (w.id === ids.table ? { ...w, port: 4303, stat: { files: panel.length, added: total('added'), removed: total('removed') } } : w)),
    items: { [ids.tableChat]: [
      userMsg('tf-u0', 'Does the Inbox drop a request once I have answered it?'),
      { kind: 'text', id: 'tf-x0', ts: at(10, 19), text: 'Not yet. A row stays until the next refresh, which is why you still see approvals you already handled.' },
      { kind: 'result', id: 'tf-r0', ts: at(10, 19), durationMs: 21_000, ok: true, ...(earlier && { files: earlier }) },
      ...turn
    ] },
    changes: { ...f.changes, [ids.table]: panel }
  } satisfies Fixture
}

const tfAsk = (text: string): ChatItem => ({ kind: 'user', id: 'tf-u1', ts: at(10, 27), parts: [{ type: 'text', text }] })
const tfReply = (text: string): ChatItem => ({ kind: 'text', id: 'tf-x1', ts: at(10, 31), text })
const tfEnd = (minutes: number, seconds: number, clock: [number, number], files: ChangedFile[]): ChatItem =>
  ({ kind: 'result', id: 'tf-r1', ts: at(...clock), durationMs: (minutes * 60 + seconds) * 1000, ok: true, files })

const TF_PANEL_SHORT = [TF_NOTES, TF_DECISION, TF_DB, TF_INBOX, TF_APPROVALS, TF_POLL, TF_NOTIFY, TF_STALE, TF_NOTIFY_TEST]
const TF_PANEL_LONG = [TF_NOTES, TF_DECISION, TF_DB, TF_INBOX, TF_WIRING, TF_APPROVALS, TF_POLL, TF_NOTIFY, TF_HOME, TF_CSS, TF_PAGE, TF_ROW, TF_HOOK, TF_STORE, TF_SHARED, TF_IPC, TF_ROWS, TF_NOTIFY_TEST]
const TF_LONG = [TF_INBOX, TF_WIRING, TF_POLL, TF_HOME, TF_PAGE, TF_CSS, TF_ROW, TF_HOOK, TF_STORE, TF_SHARED, TF_IPC, TF_ROWS]

const turnFilesLong = () => turnFilesScene([
  tfAsk('Split the inbox code out of the store so Home and the Inbox read the same rows, and move the tests along.'),
  ...folded('tf1', 31, 4),
  tfReply('Home and the Inbox now read their rows from one hook, and the store no longer holds any inbox code. I moved the polling helper out with it, since nothing calls it any more.\n\n`pnpm typecheck` and `pnpm test` both pass.'),
  tfEnd(7, 40, [11, 8], TF_LONG)
], TF_PANEL_LONG)

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
  // KERNEL-430: a new chat waiting for setup. The message waits as a bubble, one line says where setup stands, and its log is in the Setup tab.
  SetupRunning: scene((f) => setupWait(f, 'setup', [setupAsk])),
  SetupFollowUp: scene((f) => setupWait(f, 'setup', [setupAsk, setupFollow])),
  // Edit pulled the only queued message back into the box.
  SetupEditQueued: scene((f) => setupWait(f, 'setup', [], { composer: { parts: [...setupAsk.parts, ...setupFollow.parts], draft: '' } })),
  SetupPanelHidden: scene((f) => setupWait(f, 'setup', [setupAsk], { panel: false })),
  SetupFailed: scene((f) => setupWait(f, 'failed', [setupAsk], { end: 1 })),
  SetupStopped: scene((f) => setupWait(f, 'failed', [setupAsk], { end: null })),
  // KERNEL-543: the worktree isn't made yet. The message reads as sent, and one line says which base it is made from.
  SetupCreatingWorktree: scene((f) => setupWait(f, 'setup', [setupAsk], { pending: {} })),
  // Git wouldn't make it: the card says so with git's reason and Try again, and the message is Not sent yet.
  SetupWorktreeFailed: scene((f) => setupWait(f, 'failed', [setupAsk], { pending: { error: "fatal: '/Users/cj/Kernel/worktrees/kernel/in-setup-script-tab-in' already exists" } })),
  SetupSentAnyway: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { status: 'ready', title: 'Fix duplicate Run in the script panel', setupRun: { startedAt: at(10, 0), endedAt: at(10, 1, 8), end: 1 } }),
    items: { [ids.tableChat]: [{ kind: 'note', id: 'sw-note', ts: at(10, 2), text: 'Setup failed, sent anyway' }, { kind: 'user', id: 'sw-u', ts: Date.now() - 20_000, parts: [...setupAsk.parts, ...setupFollow.parts] }] },
    push: [...f.push, ...setupLog('failed'), { type: 'chat.running', chatId: ids.tableChat, running: true }],
    ui: { ...open, workspace: { right: 'changes', bottom: 'setup', checkpoints: false, toolsOpen: false } }
  })),
  SetupDone: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { status: 'ready', title: 'Fix duplicate Run in the script panel', setupRun: { startedAt: at(10, 0), endedAt: at(10, 1, 12), end: 0 } }),
    items: { [ids.tableChat]: [{ kind: 'user', id: 'sd-u', ts: Date.now() - 20_000, parts: [...setupAsk.parts, ...setupFollow.parts] }] },
    push: [...f.push, { type: 'chat.running', chatId: ids.tableChat, running: true }],
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
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
  /** Read rows on image files say "Read image" with the image chip, in the folded list and in the turn in progress (KERNEL-546). */
  WorkspaceReadImage: scene(() => ({
    items: { [ids.tableChat]: readImageItems },
    // image.png loads, so its row opens a tab. image-2.png was deleted, so its row opens to the path (KERNEL-671).
    images: { [ids.table]: { 'worktree:.kernel/attachments/image.png': { dataUrl: imageAfter } } },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: true } }
  })),
  /** The same transcript after a click on the Read image row whose file loads (an image tab opens, headed by its path) and on the one whose file is gone (the row opens to the path). scripts/shots.ts does the click (KERNEL-671). */
  WorkspaceReadImageTab: scene(() => ({
    items: { [ids.tableChat]: readImageItems },
    images: { [ids.table]: { 'worktree:.kernel/attachments/image.png': { dataUrl: imageAfter } } },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: true } }
  })),
  WorkspaceReadImageMissing: scene(() => ({
    items: { [ids.tableChat]: readImageItems },
    images: { [ids.table]: { 'worktree:.kernel/attachments/image.png': { dataUrl: imageAfter } } },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: true } }
  })),
  /** A long chat read from higher up, with the Scroll to bottom button over it (KERNEL-532). Scroll position is local to the transcript, so scripts/shots.ts scrolls it up before the shot. */
  WorkspaceScrolledUp: scene(() => ({
    items: { [ids.tableChat]: longChat },
    ui: open
  })),
  // KERNEL-599: the chat rail. A teammate's chat read from its 14th message with the right panel hidden, the same with the list open, Kernel's chat with Team updates listed, and the chat at its
  // end with the right panel open, where the rail takes the side padding. The scroll and the hover are local to the transcript and the rail, so scripts/shots.ts does them.
  ChatRail: railScene(),
  ChatRailOpen: railScene(),
  ChatRailLead: scene((f) => railLead(f)),
  ChatRailNarrow: railScene(true),
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
  // KERNEL-586: the card under a finished reply lists the files the turn created, edited or deleted, and each row opens that file's diff. The fold shows 5 of 12, the same chat without a reply
  // puts the card under the tool calls fold, and the last shot has one row hovered and one focused from the keyboard (the shot script presses Down to reach it).
  TurnFiles: turnFilesScene([
    tfAsk('Then drop it as soon as it resolves, and add a test for it.'),
    ...folded('tf1', 9, 2),
    tfReply('Answered requests now leave the Inbox right away. The row goes the moment the approval resolves, so nothing lingers until the next refresh.\n\nThe old polling helper had no callers left, so I deleted it. `pnpm typecheck` and `pnpm test` both pass.'),
    tfEnd(4, 12, [10, 31], [TF_INBOX, TF_POLL, TF_STALE])
  ], TF_PANEL_SHORT, [TF_NOTES, TF_DECISION]),
  TurnFilesLong: turnFilesLong(),
  TurnFilesNoReply: turnFilesScene([
    tfAsk('Drop answered rows as soon as the request resolves, and add a test for it.'),
    ...folded('tf1', 7, 0),
    tfEnd(4, 12, [10, 31], [TF_INBOX, TF_POLL, TF_SHARED, TF_STALE])
  ], [TF_NOTES, TF_DECISION, TF_DB, TF_INBOX, TF_APPROVALS, TF_POLL, TF_NOTIFY, TF_SHARED, TF_STALE, TF_NOTIFY_TEST]),
  TurnFilesHover: turnFilesLong(),
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
  // All files drawn like VS Code's explorer (KERNEL-399): Material icons, compact folders, indent guides, git colors, the open file selected.
  WorkspaceFilesTree: treeScene('files', 'file:src/app/invoices/table.tsx'),
  // The Changes tab as VS Code's Source Control draws it, as a list and as a tree (KERNEL-399).
  WorkspaceChangesList: treeScene('changes', 'diff:src/app/invoices/page.tsx', 'list'),
  WorkspaceChangesTree: treeScene('changes', 'diff:', 'tree'),
  // No PNG draws a diff tab (KERNEL-144). The diff opens in a tab of its own next to the chat, with the composer below it.
  WorkspaceDiffTab: scene(() => ({
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false }, tabs: { [ids.table]: { tab: 'diff:src/app/invoices/page.tsx', files: [], diffs: ['src/app/invoices/page.tsx'] } } }
  })),
  // No PNG draws an image in a diff tab (KERNEL-410). Git only says a binary file differs, so the tab shows the pictures: an added one as it is in the worktree, a changed one as Before and After.
  WorkspaceDiffImageAdded: imageDiffScene('A'),
  WorkspaceDiffImageModified: imageDiffScene('M'),
  // Focus mode hides both sides the way Conductor does (D-063), so this shot has no rail where the PNG draws one.
  WorkspaceFocus: scene(() => ({
    ui: { ...open, sidebar: false, rightPanel: false, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
  })),
  // No PNG draws Back and Forward (KERNEL-643). The sidebar is open with Back lit and Forward disabled, and the hidden twin shows the pair after Show sidebar.
  WorkspaceHistoryButtons: scene(() => ({
    ui: { ...open, nav: { canBack: true, canForward: false }, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
  })),
  WorkspaceHistoryButtonsNarrow: scene(() => ({
    ui: { ...open, nav: { canBack: true, canForward: true }, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
  })),
  WorkspaceHistoryButtonsHidden: scene(() => ({
    ui: { ...open, sidebar: false, nav: { canBack: true, canForward: true }, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
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
  // KERNEL-459: an approval says why it asked, on one line under the command: the classifier's reason on Claude in Auto, the sandbox's on Codex.
  WorkspacePermReason: scene((f) => scene2(f, { name: 'invoice-pdf-renderer', branch: 'feat/t-15a-pdf-renderer', agentId: 'noor' }, 'PDF renderer', [
    userMsg('p1', 'T-15a: PDF renderer with embedded fonts. Store generated files in the invoices bucket.', true),
    ...folded('p', 11, 2),
    { kind: 'text', id: 'p-reply', ts: at(10, 29), text: 'The renderer works and the fonts are embedded. I want to save a few sample PDFs where you can open them.' },
    { kind: 'result', id: 'p-res', ts: at(10, 29), durationMs: 90_000, ok: true }
  ], {
    approvals: [pending('tool', 'noor', { toolName: 'Bash', input: { command: 'pnpm pdf:export --out ~/Documents/invoices' }, title: 'Run pnpm pdf:export --out ~/Documents/invoices', detail: 'Saves three sample invoices as PDF.', reason: 'The classifier wants you to decide: writes outside the workspace' }), ...f.approvals]
  }, { mode: 'auto' })),
  WorkspacePermReasonCodex: scene((f) => ({
    ...scene2(f, { name: 'invoice-pdf-renderer', branch: 'feat/t-15a-pdf-renderer', agentId: 'noor' }, 'PDF renderer', [
      userMsg('p1', 'T-15a: PDF renderer with embedded fonts. Store generated files in the invoices bucket.', true),
      ...folded('p', 11, 2),
      { kind: 'text', id: 'p-reply', ts: at(10, 29), text: 'The renderer works. The embedded font comes from a package I have not installed yet.' },
      { kind: 'result', id: 'p-res', ts: at(10, 29), durationMs: 90_000, ok: true }
    ], {
      approvals: [pending('tool', 'noor', { toolName: 'Bash', input: { command: 'pnpm add @fontsource/inter' }, title: 'Run pnpm add @fontsource/inter', detail: 'Installs the font package the renderer embeds.', reason: 'Codex runs it outside its sandbox' }), ...f.approvals]
    }, { provider: 'codex', model: 'gpt-6-astra', effort: 'medium', mode: 'acceptEdits' }),
    models: { codex: codexModels }
  })),
  WorkspacePlan: scene(planWaiting),
  WorkspacePlanApproved: scene(planApproved),
  WorkspacePlanChanges: scene(planChanges),
  WorkspacePlanReplaced: scene(planReplaced),
  WorkspacePlanExit: scene(planExit),
  // The other plan mode states (KERNEL-322). The typing shots also focus the box (scripts/shots.ts).
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
  // One option picked, the next hovered and the one after focused from the keyboard: the pick is the strongest of the three (KERNEL-676, scripts/shots.ts).
  WorkspaceQuestionStates: scene((f) => scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Download button', [
    userMsg('qst1', 'Build T-15b from the approved plan.', true),
    ...folded('qst', 6, 0),
    { kind: 'result', id: 'qst-res', ts: at(10, 29), durationMs: 60_000, ok: true }
  ], {
    approvals: [pending('question', 'kai', { title: 'Should the download keep the invoice number in the file name?', options: ['Yes, invoice-009.pdf', 'Add the client name, acme-invoice-009.pdf', 'Use a random name'] }), ...f.approvals]
  })),
  // Long options read as an ink label with a muted description, and the recommended one carries a tag (KERNEL-414, KERNEL-416). Nothing is picked, so Send waits.
  WorkspaceQuestionLong: scene((f) => {
    const options = [
      { label: 'Use a token', recommended: true, description: 'MCPs, plugins, skills and history are shared exactly. Added accounts show the name you give them, and you pick their plan once when adding. Usage refreshes only while agents work.' },
      { label: 'Separate config folder per account', description: 'Full usage, plan and email, and the normal browser login. But Kernel has to keep MCP servers, plugins, skills and history in sync across folders, which is more code and can break when Claude Code updates.' }
    ]
    const question = 'Which way should extra Claude accounts work?'
    return scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Extra Claude accounts', [
      userMsg('ql1', 'Can I add a second Claude account to Kernel, for my team plan next to my Max one?'),
      { kind: 'thinking', id: 'ql-th', ts: at(10, 28), text: 'Two ways to do it. They differ in what Kernel can show and how much it has to keep in sync.' },
      tool('ql-t1', 'Read how sessions pick their account', 'rg -n "CLAUDE_CONFIG_DIR|oauthToken" src/main', { name: 'Read' })
    ], {
      approvals: [pending('question', 'kernel-lead', { workspaceId: ids.lead, title: question, options: options.map((o) => o.label), questions: [{ question, options }] }), ...f.approvals]
    }, { model: 'claude-opus-5-5' })
  }),
  // A sign-in link in the question and in an option's description wraps inside the card, and the AskUserQuestion call has no row of its own above it (KERNEL-591).
  WorkspaceQuestionUrl: scene((f) => {
    const url = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=Zk3n0r1a8Xw5pQ2sT7vB9cD4eF6gH1jK3lM5nP7qR9s&code_challenge_method=S256&state=Yb2cD4eF6gH8iJ0kL2mN4oP6qR8sT0uV'
    const question = `Please sign in to Claude to continue. Open this link in your browser and paste the code it shows: ${url}`
    const options = [
      { label: 'I have signed in', description: `The code came from ${url}` },
      { label: 'Use an API key instead' }
    ]
    return scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'noor' }, 'Download button', [
      userMsg('qu1', 'Build T-15b from the approved plan.', true),
      tool('qu-t1', 'Read the PDF renderer', 'cat src/pdf/render.ts', { name: 'Read' }),
      tool('qu-ask', 'AskUserQuestion', JSON.stringify({ questions: [{ question, options }] }), { name: 'AskUserQuestion', status: 'running', input: { questions: [{ question, options }] } })
    ], {
      approvals: [pending('question', 'noor', { title: question, options: options.map((o) => o.label), questions: [{ question, options }] }), ...f.approvals]
    })
  }),
  // set_room_scripts' card: every script in full, as Save writes it, multi-line setup included (KERNEL-683).
  WorkspaceQuestionScripts: scene((f) => {
    const question = 'Save these scripts to .kernel/settings.local.toml?'
    const options = [{ label: 'Save', description: 'Write them to .kernel/settings.local.toml, on this Mac only' }, { label: 'Cancel', description: 'Write nothing' }]
    const detail = 'Setup script\npnpm install\ncp "$KERNEL_ROOT_PATH/.env" .env\n\nRun script\npnpm dev --port $KERNEL_PORT\n\nRun script "storybook"\npnpm storybook -p $((KERNEL_PORT + 1))\n\nRun mode\nOne at a time'
    return scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Room scripts', [
      userMsg('qs1', 'Here is our conductor.json, set this room up the same way.'),
      tool('qs-t1', 'Read package.json', 'cat package.json', { name: 'Read' })
    ], {
      approvals: [pending('question', 'kernel-lead', { workspaceId: ids.lead, title: question, detail, options: options.map((o) => o.label), questions: [{ question, options }] }), ...f.approvals]
    }, { model: 'claude-opus-5-5' })
  }),
  WorkspaceQuestionSteps:scene((f) => scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Download button', [
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
  // One question, answered: the card keeps the question and your answer is the bubble under it.
  WorkspaceQuestionAnswered: scene((f) => scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Download button', [
    userMsg('q1a', 'Build T-15b from the approved plan.', true),
    ...folded('q1', 6, 0),
    { kind: 'result', id: 'q1-res', ts: at(10, 29), durationMs: 60_000, ok: true }
  ], {
    approvals: [{ ...pending('question', 'kai', { title: DOWNLOAD_QUESTIONS[0].question, options: DOWNLOAD_QUESTIONS[0].options.map((o) => o.label), questions: [DOWNLOAD_QUESTIONS[0]] }), status: 'answered', answer: 'Yes, invoice-009.pdf' }, ...f.approvals]
  })),
  // Kernel's own message is one note line that opens to its full text with Copy, and after a quit it folds into the quit note's line.
  WorkspaceKernelNote: kernelNote,
  WorkspaceKernelNoteOpen: kernelNote, // the same, opened by scripts/shots.ts
  WorkspaceRelaunch: scene((f) => noApprovals(scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'kai' }, 'Download button', [
    userMsg('rl1', 'Build T-15b from the approved plan.', true),
    tool('rl-t1', 'Read the row actions', 'cat src/app/invoices/row-actions.tsx', { name: 'Read' }),
    { kind: 'note', id: 'rl-note', ts: at(10, 29), text: 'Kernel quit while this agent was working.' },
    { kind: 'user', id: 'rl-msg', ts: at(10, 31), from: 'kernel', parts: [{ type: 'text', text: 'Kernel restarted while you were working on this chat. Check git status for edits that were not saved, then carry on from where you stopped.' }] },
    { kind: 'text', id: 'rl-tx', ts: at(10, 32), text: 'Checking git status, then back to the row actions.' },
    { kind: 'result', id: 'rl-res', ts: at(10, 32), durationMs: 20_000, ok: true }
  ], {}))),
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
  // Kernel's plan for T-15 waits in the Lead's own worktree, on the Grouped sidebar, before the export chat hands anything off (KERNEL-355).
  WorkspaceLead: scene((f) => leadWaiting(f)),
  WorkspaceLeadPlan: scene((f) => leadPlan(f, { agentId: 'kernel-lead' })),
  // The Lead's PRs tab: two ready PRs with Merge, six that wait, and the same panel with nothing open (KERNEL-354).
  LeadPrs: scene((f) => leadPrsScene(f, LEAD_PRS, 'What can I merge?', LEAD_PRS_REPLY)),
  // The right panel's two panes (KERNEL-513): 2/3 over 1/3 in a teammate's workspace, which starts with the bottom open, and Kernel's chat, which starts with it
  // folded to its tab bar. A teammate's can fold too, and its handle lights like the sidebar's edge. A new chat waiting on setup opens the bottom on Setup even when it was folded.
  PanelSplit: idleRun(headerScene('ready', [], { panel: true })),
  PanelSplitLead: scene((f) => leadPrsScene(f, LEAD_PRS, 'What can I merge?', LEAD_PRS_REPLY)),
  PanelCollapsed: bottomFolded(idleRun(headerScene('ready', [], { panel: true }))),
  // Folded while the run script runs: the bar says Running, so you can tell the app is up without opening it (KERNEL-529).
  PanelCollapsedRunning: bottomFolded(headerScene('ready', [], { panel: true })),
  PanelResize: idleRun(headerScene('ready', [], { panel: true })),
  // The panel at its narrowest, 320px, where the strips scroll sideways (KERNEL-514). The top strip sits beside the PRs toolbar, Merge all and refresh, which takes the room the tabs need.
  // The bottom's two terminals past Run are stand-ins the shot adds.
  PanelTabsOverflow: scene((f) => {
    const s = leadPrsScene(f, [MERGE_A, MERGE_B], 'What can I merge?', LEAD_PRS_REPLY, LEAD_RUN)
    return { ...s, ui: { ...s.ui, bottomCollapsed: { lead: false, teammate: false } } }
  }),
  PanelSetup: scene((f) => setupWait(f, 'setup', [setupAsk], { right: 'files', collapsed: true })),
  // The right panel's strip carries the tab on show's own actions (KERNEL-515): PRs has Merge all and refresh, All files a filter and collapse, Changes Review all, a filter and the tree toggle, Checks refresh and
  // open on GitHub. The filter's field opens under the strip from the search button, the way PanelFilter draws it with "inbox" typed.
  PanelToolbarPrs: scene((f) => {
    const s = leadPrsScene(f, [MERGE_A, MERGE_B, MERGE_C], 'What can I merge?', LEAD_PRS_REPLY)
    return { ...s, workspaces: s.workspaces!.map((w) => (w.id === ids.lead ? { ...w, port: 4303 } : w)), ui: { ...s.ui, bottomCollapsed: { lead: false, teammate: false } } }
  }),
  PanelToolbarFiles: panelScene('files'),
  PanelToolbarChanges: panelScene('changes', { tree: true }),
  PanelToolbarChecks: panelScene('checks', { open: true, running: true }),
  PanelFilter: panelScene('changes', { open: true }),
  // The Changes ⋯ menu lists the target branch, All changes, Uncommitted changes and the branch's commits. The shot presses the ⋯ to open it (PanelCompare.png, KERNEL-517).
  PanelCompare: (() => {
    const f = panelScene('changes', { open: true })
    return { ...f, commits: { [ids.table]: PANEL_COMMITS }, branches: ['origin/main', 'origin/develop', 'origin/kernel-154-inbox-rows'] }
  })(),
  LeadPrsEmpty: scene((f) => leadPrsScene(f, [], 'What can I merge?', 'Nothing is open right now. Every PR your agents opened has merged.')),
  // A PR with blockers on its latest commit isn't ready: it sits under Still open, says Blockers found and offers Merge anyway (KERNEL-501).
  LeadPrsBlockers: scene((f) => leadPrsScene(f, [LEAD_PRS[0], LEAD_PRS[1], BLOCKERS_PR, LEAD_PRS[2], LEAD_PRS[3]], 'What can I merge?', "Two PRs are ready. #162 from Kai and #161 from Noor both have Theo's approval. Theo found 2 blockers on #167, so it isn't ready. #158 is waiting for his approval, and #166 is still running checks.")),
  // A PR merging keeps its row in Ready to merge and spins there, though this tab didn't start it (KERNEL-411, KERNEL-417).
  LeadPrsMerging: scene((f) => leadPrsScene(f, [{ ...MERGE_A, state: 'merging' }, MERGE_B, MERGE_C], 'Merge #331.', 'Merging #331 now. #330 is ready too, and #333 is still running checks.')),
  // Open PRs, none of them ready: the band counts them instead of saying there are none (KERNEL-411).
  LeadPrsNoneReady: scene((f) => leadPrsScene(f, [{ ...MERGE_B, state: 'cifail' }, MERGE_C], 'What can I merge?', 'Nothing yet. #330 failed its checks and #333 is still running them.')),
  // Merge all on the Ready to merge heading, its run one PR at a time, and a run that stopped at a conflict (KERNEL-411).
  LeadPrsMergeAll: scene((f) => leadPrsScene(f, [MERGE_A, MERGE_B, MERGE_C], 'What can I merge?', 'Two PRs are ready. #331 from Kai and #330 from Noor both have Theo\'s approval, and #333 is still running checks. Merge them from the PRs tab, or tell me which one and I will.')),
  LeadPrsMergeAllRunning: scene((f) => leadPrsScene(f, [{ ...MERGE_A, state: 'merging' }, MERGE_B, MERGE_C], 'What can I merge?', 'Two PRs are ready. Merge them from the PRs tab, or tell me which one and I will.',
    [{ type: 'pr.queue', roomId: ids.roomA, queue: { ids: [MERGE_A.id, MERGE_B.id], current: MERGE_A.id } }])),
  LeadPrsMergeAllStopped: scene((f) => leadPrsScene(f, [{ ...MERGE_B, state: 'conflict' }, MERGE_C], 'What can I merge?', 'Two PRs are ready. Merge them from the PRs tab, or tell me which one and I will.',
    [{ type: 'pr.queue', roomId: ids.roomA, result: { merged: [331], stopped: { workspaceId: MERGE_B.id, prNumber: 330, reason: 'It has merge conflicts.' } } }])),
  // Kernel's team updates in Kernel's chat (KERNEL-127). No PNG: the card follows the canvas card and note values.
  WorkspaceLeadUpdate: scene((f) => leadUpdate(f)),
  TeamUpdateMerge: scene((f) => teamUpdateMerge(f)),
  // KERNEL-557: a merge Kernel made by itself, a PR still blocked after its review rounds, and a skipped review.
  TeamUpdateReview: scene((f) => teamUpdateReview(f)),
  TeamUpdatePrStates: scene((f) => teamUpdatePrStates(f)),
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
  // Hovering the login row shows its card, which names that tab and the question (KERNEL-339), four minutes into the wait.
  GroupedRowStatus: scene((f) => {
    const g = grouped(f)
    const ask: Approval = { ...pending('question', 'kernel-lead', { workspaceId: CHAT_WS[GROUPED.login], chatId: 'chat-login-redirect', title: 'Should we keep Google sign in?', options: ['Keep it', 'Drop it'] }), createdAt: Date.now() - 4.5 * 60_000 }
    return { ...g, approvals: [ask, ...(g.approvals ?? [])] }
  }),
  // The last tab of a chat that is still running asks first, since closing it archives the chat and its two workspaces (KERNEL-405).
  GroupedCloseLastTab: scene((f) => {
    const g = grouped(f, { tab: 'chat-table', chats: (c) => c.filter((x) => x.id !== 'chat-table-copy') })
    return { ...g, ui: { ...g.ui!, modal: { name: 'confirm', kind: 'archiveChat', threadId: GROUPED.table } } }
  }),
  // Hovering a chat row shows Archive, like a workspace row's (KERNEL-405). The shot hovers the table chat (scripts/shots.ts).
  GroupedChatArchive: scene((f) => grouped(f, { running: [] })),
  SidebarUnread: scene(sidebarUnread),
  SidebarPlanChat: scene(sidebarPlanChat),
  // Archiving the export chat would stop Kai's open PR and drop the renderer's uncommitted changes, so it asks first (KERNEL-405).
  ConfirmArchiveChat: scene((f) => {
    const g = grouped(f, { running: [] })
    return { ...g, ui: { ...g.ui!, modal: { name: 'confirm', kind: 'archiveChat', threadId: GROUPED.export } } }
  }),
  // The chat is archived with the two workspaces it handed off, which leave the sidebar for History (KERNEL-405).
  GroupedCloseLastTabAfter: scene((f) => {
    const g = grouped(f, {
      running: [], chats: (c) => c.filter((x) => x.id !== 'chat-table-copy'),
      threads: (t) => t.map((x) => (x.id === GROUPED.table ? { ...x, closedAt: at(10, 50) } : x))
    })
    return { ...g, workspaces: g.workspaces!.map((w) => (w.threadId === GROUPED.table ? { ...w, status: 'archived' as const, archivedAt: at(10, 50) } : w)) }
  }),
  // A room with no open chat (KERNEL-365): New chat with Kernel, with no workspace before the first message, and no chat row (KERNEL-366, KERNEL-405).
  // The workspaces the archived chats handed off stay as unowned rows when Archive a chat's workspaces is off.
  // The line under the title says what the room is doing, and Up next lists the tracker's Todo issues, urgent first.
  LeadNoChats: scene(leadNoChats),
  // New branch from main opened: the remote's branches with the default checked. The menu is the composer's own, so the shot opens it (scripts/shots.ts).
  LeadNoChatsBranch: scene(leadNoChats),
  // Shared files (KERNEL-305). The canvas draws them in Noor's invoice-pdf-renderer and in Kernel's chat. Which file a shot opens, and the
  // width, version menu or crash, is the shot's: WorkspaceSharedPhone, WorkspaceSharedVersions and WorkspaceSharedCrashed need a step (scripts/shots.ts).
  WorkspaceSharedCard: sharedTab(undefined, 2),
  WorkspaceSharedHtml: sharedTab('sh-html'),
  WorkspaceSharedPhone: sharedTab('sh-html'),
  WorkspaceSharedImage: sharedTab('sh-image'),
  WorkspaceSharedImageZoom: sharedTab('sh-image'), // the same image at 200%, with the zoom control in the toolbar; the shot presses Zoom in twice (KERNEL-598)
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
  WorkspaceHire: hireScene(['tools: Read, Grep, Glob, Bash(pnpm screenshot:*)']),
  // KERNEL-502: the hire card says where the agent goes. No scope on the approval means just the user, so WorkspaceHire shows that line.
  WorkspaceHireTeam: hireScene(['tools: Read, Grep, Glob, Bash(pnpm screenshot:*)'], undefined, 'team'),
  // The servers row on the hire card (KERNEL-484). The PNG draws Wren with Figma reached and Linear needing sign-in. The other states are
  // the ones the engine reports (`AgentReach.blocked`), one fixture each, for screenshots only.
  WorkspaceHireServers: hireScene(hireTools(['figma', 'linear']), { reach: ['figma'], blocked: [{ name: 'linear', why: 'needs-auth' }] }),
  WorkspaceHireServersReached: hireScene(hireTools(['figma', 'linear']), { reach: ['figma', 'linear'], blocked: [] }),
  WorkspaceHireServersFailed: hireScene(hireTools(['figma', 'neon']), { reach: ['figma'], blocked: [{ name: 'neon', why: 'failed' }] }),
  WorkspaceHireServersOff: hireScene(hireTools(['figma', 'playwright']), { reach: ['figma'], blocked: [{ name: 'playwright', why: 'off' }] }),
  WorkspaceHireServersDisabled: hireScene(hireTools(['figma', 'sentry']), { reach: ['figma'], blocked: [{ name: 'sentry', why: 'disabled' }] }),
  WorkspaceHireServersMissing: hireScene(hireTools(['linear', 'figma']), { reach: ['linear'], blocked: [{ name: 'figma', why: 'missing', suggestion: 'figma-dev' }] }),
  WorkspaceHireServersMany: hireScene(hireTools(['figma', 'claude_ai_Linear', 'neon', 'playwright']), {
    reach: ['figma', 'github', 'notion', 'sentry', 'claude_ai_Slack'],
    blocked: [{ name: 'claude_ai_Linear', why: 'needs-auth' }, { name: 'neon', why: 'failed' }, { name: 'playwright', why: 'off' }]
  }),
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
  // The PR header in the states the fixtures above don't cover (KERNEL-274).
  WorkspacePRNoChanges: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { prState: 'none', stat: { files: 0, added: 0, removed: 0 } }),
    changes: { [ids.table]: [] },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
  })),
  WorkspacePRNone: prScene('none', []),
  WorkspacePRCreating: prScene('creating', []),
  WorkspacePROpen: prScene('open', [], { prs: prInfo('open') }),
  WorkspaceRunScripts: runScripts(),
  // The Run tab before the script has run: the empty state's Run is the only button, and the strip's steps aside (KERNEL-423, KERNEL-512).
  WorkspaceRunEmpty: scene((f) => ({
    roomSettings: { [ids.roomA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } },
    push: f.push.filter((e) => e.type !== 'script.output' || e.kind !== 'run'),
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', checkpoints: false, toolsOpen: false } }
  })),
  // KERNEL-685: a room with no setup script. The Setup tab offers Kernel's suggestion, Ask Kernel and Add manually.
  WorkspaceSetupAddConductor: scene((f) => ({
    roomSettings: { [ids.roomA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } },
    scriptSuggestions: { [ids.roomA]: [{ source: 'conductor', file: '.conductor/settings.toml', patch: { scripts: { setup: 'pnpm install\ncp ../../.env.local .env.local' } }, notes: ['The archive script was left out because this room already has one.'] }] },
    push: f.push.filter((e) => e.type !== 'script.output' || e.kind !== 'setup'),
    ui: { ...open, workspace: { right: 'changes', bottom: 'setup', checkpoints: false, toolsOpen: false } }
  })),
  WorkspaceSetupAddDetected: scene((f) => ({
    roomSettings: { [ids.roomA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } },
    scriptSuggestions: { [ids.roomA]: [{ source: 'detected', file: 'pnpm-lock.yaml', patch: { scripts: { setup: 'pnpm install' } }, notes: [] }] },
    push: f.push.filter((e) => e.type !== 'script.output' || e.kind !== 'setup'),
    ui: { ...open, workspace: { right: 'changes', bottom: 'setup', checkpoints: false, toolsOpen: false } }
  })),
  WorkspaceSetupAdd: scene((f) => ({
    roomSettings: { [ids.roomA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } },
    push: f.push.filter((e) => e.type !== 'script.output' || e.kind !== 'setup'),
    ui: { ...open, workspace: { right: 'changes', bottom: 'setup', checkpoints: false, toolsOpen: false } }
  })),
  WorkspaceTerminalPresets: terminalPresets(),
  WorkspacePreview: preview(),
  WorkspacePRChecks: prScene('checks', [], { prs: prInfo('checks') }),
  // A ready PR whose repo requires only Release note: Test failed and Vercel still runs, both optional (KERNEL-388).
  WorkspacePRChecksOptional: prScene('ready', [], {
    prs: prInfo('ready', { checks: [{ name: 'Release note', state: 'pass', meta: '28s' }, { name: 'Test', state: 'fail', optional: true }, { name: 'Vercel', state: 'running', optional: true }] })
  }, 'checks'),
  WorkspacePRConflict: prScene('conflict', [], { prs: prInfo('conflict') }),
  WorkspacePRResolving: prScene('resolving', [], { prs: prInfo('resolving') }),
  WorkspacePRReady: prScene('ready', [], { prs: prInfo('ready') }),
  // A ready PR GitHub won't merge until someone approves it: the header reads Open, as PrOpen.png draws it (KERNEL-388).
  WorkspacePRBlocked: blocked(prScene('ready', [], { prs: prInfo('ready', { blocked: 'review' }) })),
  WorkspacePRMerging: prScene('merging', [], { prs: prInfo('merging') }),
  // A branch that merges on the Mac, in a room with no GitHub (KERNEL-478).
  PrLocalReady: localScene('ready'),
  PrLocalBehind: localScene('behind'),
  PrLocalConflict: localScene('conflict'),
  PrLocalMerging: localScene('merging'),
  PrLocalMerged: localScene('merged'),
  PrLocalDirty: localScene('dirty'),
  // The header and the PR capsule (KERNEL-413): the toggle ends the chat header in both states (KERNEL-425).
  PrMergedOpen: headerScene('merged', [prNote('h-note', 'PR #147 was merged on GitHub.', 'merged')], { panel: true }),
  PrMergedHidden: headerScene('merged', [prNote('h-note', 'PR #147 was merged on GitHub.', 'merged')]),
  PrReadyHidden: headerScene('ready', []),
  // Blockers on the latest commit: the band reads Blockers found in red, with a soft Merge anyway (KERNEL-501).
  PrBlockers: withBlockers(headerScene('ready', [], { panel: true })),
  PrCiFailHidden: headerScene('cifail', [prNote('h-note', 'Checks failed on PR #147.', 'cifail')]),
  // The capsule on a neutral band: soft Create PR with its icon and its own menu square, and a closed PR's Reopen (KERNEL-528).
  PrNoPrHidden: headerScene('none', []),
  PrClosedHidden: headerScene('closed', [prNote('h-note', 'PR #147 was closed without merging.', 'closed')]),
  PrMergedHiddenLong: headerScene('merged', [prNote('h-note', 'PR #147 was merged on GitHub.', 'merged')], { title: 'KERNEL-155 Home and Inbox keep asking about requests and the PRs, and show the team when a merge is waiting' }),
  HeaderBranchTooltip: headerScene('merged', [prNote('h-note', 'PR #147 was merged on GitHub.', 'merged')]),
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
  /** KERNEL-531: Claude's guess at the next message stands in for the placeholder of an empty box. Not on the canvas, see docs/decisions/KERNEL-530.md. */
  WorkspaceSuggestion: scene((f) => ({ chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, suggestion: 'Run the tests and fix anything that fails' } : c)), ui: open })),
  // KERNEL-406: a role runs on Codex, so the picker groups models by provider. This chat has started on Claude, so Codex's open a new chat.
  WorkspaceModelPicker: scene((f) => {
    const d = DEFAULT_SETTINGS('/Users/you')
    return {
      settings: { ...d, models: { ...d.models, roles: { ...d.models.roles, qa: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' } } } },
      chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, sessionId: 'session-kai' } : c)),
      models: { codex: codexModels },
      ui: { ...open, menu: 'model' }
    }
  }),
  ComposerModes: scene((f) => bypassPicked(f)),
  ComposerModeMenu: scene((f) => bypassPicked(f, 'mode')),
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
  /** A brief Kernel handed off with wait_for, held until Noor's PR merges, with Send now to start it sooner (KERNEL-259, KERNEL-361). */
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
