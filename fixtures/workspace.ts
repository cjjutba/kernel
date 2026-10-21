import type { PushEvent } from '@shared/ipc'
import type { PanelTab, WorkspaceView, CriterionEvidence, EvidenceLink, PrEvidence, ChatPart, Notification, AccountProfile, MoveNotice, AgentReach, AgentScope, Approval, AskedQuestion, BranchCommit, QueuedMessage, ChangedFile, Chat, ChatItem, Effort, FileEntry, Hunk, IssueSummary, Overrule, PrCheck, PrInfo, PrPending, ReviewKind, ReviewVerdict, SharedAnchor, SharedComment, SharedFile, SharedVersion, TeamEventKind, TeamUpdateRow, Thread, Workspace } from '@shared/types'
import type { Fixture } from './types'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { describeTool } from '../src/main/services/approvals'
import { agent, at, ids, scene, tableItems, team, withWorkspace } from './base'
import { downloadFlowMarkdown, fontsCheckImage, invoiceLayoutStill, invoicePdfStill, pdfNotesMarkdown, pricingStill } from './sharedStills'

// Workspace lane: the workspace screen (KERNEL-10), PR states (KERNEL-15), agent turns and requests (KERNEL-14).

const open = { route: { name: 'workspace', workspaceId: ids.table } } as const
const pr = { prNumber: 42, prUrl: 'https://github.com/cjjutba/client-a/pull/42' }
/** The transcript up to the last tool call, before Christian's summary. */
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
const prScene = (prState: Workspace['prState'], items: ChatItem[], extra: Partial<Fixture> = {}, right: 'changes' | 'pr' = 'changes') =>
  scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { ...pr, prTitle, prState }),
    items: { [ids.tableChat]: [...tableItems, ...items] },
    ...extra,
    ui: { ...open, workspace: { right, bottom: 'run' }, ...extra.ui }
  }))

/**
 * KERNEL-413: the header. Sean's PR #147 for KERNEL-155 in the project Kernel, with the issue's title where
 * the workspace's name was, in one PR state. The right panel is hidden unless `panel`, which puts the PR cluster in the panel head.
 */
const HEADER_BRANCH = 'cjjutbaofficial/kernel-155-home-and-inbox-keep-asking-about-requests-and-prs'
const headerScene = (prState: Workspace['prState'], note: ChatItem[], opts: { panel?: boolean; title?: string } = {}) =>
  scene((f) => ({
    projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, name: 'Kernel' } : r)),
    workspaces: withWorkspace(f, ids.table, {
      name: 'kernel-155-home-and-inbox-keep-asking-about-requests-and-prs', branch: HEADER_BRANCH, agentId: 'sean', prState,
      title: opts.title ?? 'KERNEL-155 Home and Inbox keep asking about requests and the PRs',
      source: { kind: 'issue', id: 'KERNEL-155', title: 'Home and Inbox keep asking about requests and the PRs' },
      prNumber: 147, prUrl: 'https://github.com/cjjutba/client-a/pull/147', prTitle: 'feat(home): ask about requests and PRs'
    }),
    chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: 'KERNEL-155 Home and Inbox' } : c)),
    items: { [ids.tableChat]: [...tableItems, ...note] },
    prs: prInfo(prState, { number: 147, url: 'https://github.com/cjjutba/client-a/pull/147', title: 'feat(home): ask about requests and PRs' }),
    ui: { ...open, rightPanel: !!opts.panel, workspace: { right: 'changes', bottom: 'run' } }
  }))

/** A workspace whose project has a run script that hasn't run, so the Run tab shows its empty state with the Run button under the icon, and a collapsed bar keeps its Run (KERNEL-512). */
const idleRun = (f: Fixture): Fixture => ({
  ...f,
  push: f.push.filter((e) => e.type !== 'script.output' || e.kind !== 'run'),
  projectSettings: { ...f.projectSettings, [ids.projectA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } }
})

const withSetup = { [ids.projectA]: { scripts: { setup: 'pnpm install', run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' as const }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } }

/** The same fixture with the bottom pane folded to its tab bar, in Kernel's chats and in teammates' workspaces (KERNEL-513). */
const bottomFolded = (f: Fixture): Fixture => ({ ...f, ui: { ...f.ui, bottomCollapsed: { lead: true, teammate: true } } })

const prInfo = (prState: Workspace['prState'], o: Partial<PrInfo> = {}): Record<string, PrInfo> => ({
  [ids.table]: { workspaceId: ids.table, number: 42, url: pr.prUrl, title: prTitle, state: prState, baseRef: 'main', checks: [], comments: [], conflicts: [], ...o }
})

const EXIT_PLAN = [
  'Add "Download PDF" to the row actions menu', 'Call /api/invoices/:id/pdf and stream the file', 'Show progress on the item while it downloads', 'Toast on failure with a retry action', 'Playwright test for the download'
].map((t, i) => `${i + 1}. ${t}`).join('\n')

const pending = (kind: 'tool' | 'plan' | 'question' | 'agent', agentId: string, extra: object): Approval =>
  ({ id: `ap-${kind}-${agentId}`, kind, source: 'sdk', projectId: ids.projectA, workspaceId: ids.table, agentId, status: 'pending', createdAt: at(10, 30), title: '', ...extra })

/** Codex's model list as `model/list` returns it, for a shot whose chat runs on Codex. */
export const codexModels = [...['GPT-6-Astra', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna'].map((label) => ({ label, legacy: false })), ...['GPT-5.5', 'GPT-5.4', 'GPT-5.3-Codex', 'GPT-5.2'].map((label) => ({ label, legacy: true }))].map(({ label, legacy }, i) => ({ provider: 'codex' as const, id: label.toLowerCase(), label, legacy, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as Effort[], defaultEffort: 'medium' as Effort, isDefault: i === 0 }))

/** Settings with a role on Codex, so the picker offers both providers. */
export const codexRoleSettings = () => {
  const d = DEFAULT_SETTINGS('/Users/you')
  return { ...d, models: { ...d.models, roles: { ...d.models.roles, qa: { ...d.models.roles.qa, prefer: 'codex' as const, codex: { model: 'gpt-6-astra', effort: 'medium' as Effort } } } } }
}

const userMsg = (id: string, text: string, plan = false): ChatItem =>
  ({ kind: 'user', id, ts: at(10, 27), parts: [{ type: 'text', text }, ...(plan ? [{ type: 'file' as const, name: 'plan.md', path: 'docs/plan.md', lines: 42 }] : [])] })

/** `tools` tool calls and `messages` thinking rows, which a finished turn folds into one "N tool calls" row. */
const folded = (prefix: string, tools: number, messages: number): ChatItem[] => [
  ...Array.from({ length: tools }, (_, i) => tool(`${prefix}-f${i}`, `Step ${i + 1}`, 'rg -n "invoice" src')),
  ...Array.from({ length: messages }, (_, i): ChatItem => ({ kind: 'thinking', id: `${prefix}-fm${i}`, ts: at(10, 28), text: 'Checking the next step.' }))
]

export const tool = (id: string, label: string, detail: string, extra: Partial<Extract<ChatItem, { kind: 'tool' }>> = {}): ChatItem =>
  ({ kind: 'tool', id, ts: at(10, 28), toolUseId: `toolu_${id}`, name: 'Bash', label, detail, status: 'done', durationMs: 100, ...extra })

/** Teng's snapshot-test turn, still going (WorkspaceRunning.png). Times count back from now so the clock reads 2m 14s. */
const runningItems = (): ChatItem[] => {
  const now = Date.now()
  const t = (secs: number) => now - secs * 1000
  return [
    { kind: 'user', id: 'ru1', ts: t(134), parts: [{ type: 'text', text: 'T-15c: snapshot tests for three invoice types. Use stable fixture dates.' }, { type: 'file', name: 'plan.md', path: 'docs/plan.md', lines: 42 }] },
    { kind: 'thinking', id: 'rth1', ts: t(130), text: 'I should check how invoices render before writing fixtures.' },
    tool('rt1', 'Read the PDF renderer', 'src/pdf/render.ts', { name: 'Read', ts: t(125), input: { file_path: 'src/pdf/render.ts' } }),
    tool('rt1b', 'Read the invoice types', 'src/pdf/types.ts', { name: 'Read', ts: t(120), input: { file_path: 'src/pdf/types.ts' } }),
    { kind: 'thinking', id: 'rth2', ts: t(110), text: 'Three types: standard, credit note, and multi-currency.' },
    tool('rt2', 'Find the existing snapshot setup', 'rg -n "toMatchSnapshot" tests', { ts: t(100) }),
    { kind: 'text', id: 'rx1', ts: t(90), text: 'Vitest already snapshots the invoice table, so I will reuse that setup and add fixtures with frozen dates.' },
    tool('rt3', 'Create the test file', 'tests/invoice-pdf.spec.ts', { name: 'Write', ts: t(60), input: { file_path: 'tests/invoice-pdf.spec.ts', content: 'import { test } from "vitest"' } }),
    tool('rt3b', 'Create the fixtures', 'tests/fixtures/invoices.ts', { name: 'Write', ts: t(50), input: { file_path: 'tests/fixtures/invoices.ts', content: 'export const invoices = []' } }),
    { kind: 'thinking', id: 'rth3', ts: t(40), text: 'Freezing time at 2026-10-01 keeps every snapshot stable.' },
    tool('rt4', 'Run the new tests', 'pnpm vitest run tests/invoice-pdf.spec.ts', { ts: t(20), status: 'running', durationMs: undefined, input: { command: 'pnpm vitest run tests/invoice-pdf.spec.ts' } })
  ]
}

/** Teng's turn after its tests ran: the same steps, a reply and a result that took 2m 14s (WorkspaceFoldDone). */
const finishedFoldItems = (): ChatItem[] => {
  const items = runningItems()
  const last = items[items.length - 1]
  const now = Date.now()
  return [
    ...items.slice(0, -1),
    last.kind === 'tool' ? { ...last, status: 'done', durationMs: 4100 } : last,
    { kind: 'text', id: 'rx2', ts: now - 8000, text: 'All three invoice types now have snapshot tests with frozen dates.' },
    { kind: 'result', id: 'rres', ts: now - 5000, durationMs: 134_000, ok: true }
  ]
}

/** A running turn whose commands are longer than the 760px column (WorkspaceFoldLongCommands): each row ends in an ellipsis at the column edge. */
const longCommandItems = (): ChatItem[] => {
  const now = Date.now()
  const cmd = (id: string, command: string, ago: number, status: 'done' | 'running' = 'done') =>
    tool(id, 'Run a command', command, { ts: now - ago * 1000, status, durationMs: status === 'done' ? 900 : undefined, input: { command } })
  return [
    { kind: 'user', id: 'lcu1', ts: now - 60_000, parts: [{ type: 'text', text: 'Find where the hash-style file names come from.' }] },
    cmd('lc1', 'grep -rn "attachments" src --include=*.ts --include=*.tsx -l | head -30; grep -rn "\\[Image " src | head -20; grep -rn "createHash" src/main src/renderer | head -40', 50),
    cmd('lc2', 'sed -n 80,170p src/main/services/plans.ts; grep -rn "kernel/attachments\\|createHash\\|sha256" src/main | grep -i attach | head -20; grep -rln "imageMarker" src', 40),
    cmd('lc3', 'grep -rn "name:" src/renderer/src/screens/workspace/composer/*.ts | grep -i "image\\|file\\|hash\\|png" | head; grep -rn "sha\\|digest\\|hash" src/renderer/src/screens/workspace/composer', 30),
    cmd('lc4', 'find src -name "*.ts" -newer package.json -not -path "*/node_modules/*" | xargs wc -l | sort -rn | head -50 && git log --oneline -20 -- src/main/services/plans.ts', 15, 'running')
  ]
}

/** A turn 20 steps in (WorkspaceFoldWorkingLong): reads, edits and checks, with the last command in flight. */
const longRunningItems = (): ChatItem[] => {
  const now = Date.now()
  const steps: ChatItem[] = Array.from({ length: 19 }, (_, i) => i % 3 === 0
    ? tool(`lr${i}`, `Read file ${i + 1}`, `src/pdf/part${i + 1}.ts`, { name: 'Read', ts: now - (260 - i * 10) * 1000, input: { file_path: `src/pdf/part${i + 1}.ts` } })
    : tool(`lr${i}`, `Check step ${i + 1}`, `pnpm vitest run part${i + 1}`, { ts: now - (260 - i * 10) * 1000, input: { command: `pnpm vitest run part${i + 1}` } }))
  return [
    { kind: 'user', id: 'lru1', ts: now - 270_000, parts: [{ type: 'text', text: 'T-15c: snapshot tests for three invoice types. Use stable fixture dates.' }] },
    ...steps,
    tool('lr19', 'Run the full suite', 'pnpm test', { ts: now - 20_000, status: 'running', durationMs: undefined, input: { command: 'pnpm test' } })
  ]
}

/** Teng's turn with a long shell command in flight (WorkspaceRunningLongCommand). */
const runningLongCommandItems = (): ChatItem[] => {
  const command = "printf -- 'type: internal. A test of shared MCP sign-ins no longer leaking between projects and the chats that open them' > .changes/unreleased/shared-mcp-sign-ins.md && git add -A && git commit -m 'test(mcp): shared sign-ins stay inside their project'"
  return [
    ...runningItems().slice(0, -1),
    tool('rt4', 'Run a command', command, { ts: Date.now() - 20_000, status: 'running', durationMs: undefined, input: { command } })
  ]
}

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

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/** An MCP tool call the way the engine writes it: the stored label and detail are the raw `server · tool` and the arguments as JSON, which rows no longer show. */
const mcpCall = (id: string, server: string, name: string, input: Record<string, unknown>, extra: Partial<ToolItem> = {}): ChatItem =>
  tool(id, `${server} · ${name}`, JSON.stringify(input).slice(0, 120), { name: `mcp__${server}__${name}`, input, ...extra })

const DENIED_OUTPUT = "The user doesn't want to proceed with this tool use. The tool use was rejected."

/** KERNEL-1025: a chat with a denied group, a one-call group, three turns and a run of three grey notes. Only the last turn keeps its time and actions in view. */
const quietChat: ChatItem[] = [
  userMsg('qt-u1', 'Run the live test again.'),
  tool('qt-t1', 'Run the live test', 'pnpm test test/terminalLead.live.test.ts', { status: 'failed', output: DENIED_OUTPUT, input: { command: 'pnpm test test/terminalLead.live.test.ts' } }),
  tool('qt-t2', 'Run the live test without tail', 'pnpm test test/terminalLead.live.test.ts', { status: 'failed', output: DENIED_OUTPUT, input: { command: 'pnpm test test/terminalLead.live.test.ts' } }),
  { kind: 'text', id: 'qt-x1', ts: at(10, 29), text: 'I still can not run the live test. Both attempts were denied, so I need an allow rule or a run from your terminal.' },
  { kind: 'result', id: 'qt-r1', ts: at(10, 29), durationMs: 10_000, ok: true },
  userMsg('qt-u2', 'Check the empty state file.'),
  tool('qt-t3', 'Read empty-state.tsx', 'src/app/invoices/empty-state.tsx', { name: 'Read', input: { file_path: 'src/app/invoices/empty-state.tsx' } }),
  { kind: 'text', id: 'qt-x2', ts: at(10, 31), text: 'The empty state centres its message and puts the button under it.' },
  { kind: 'result', id: 'qt-r2', ts: at(10, 31), durationMs: 14_000, ok: true },
  { kind: 'note', id: 'qt-n1', ts: at(10, 32), text: 'Kernel is summarizing this chat as it moves to the 3rd account.' },
  { kind: 'note', id: 'qt-n2', ts: at(10, 32), text: 'Compacted the conversation, 139k to 8k tokens.' },
  { kind: 'note', id: 'qt-n3', ts: at(10, 33), text: 'Moved to the 3rd account and re-read 0 tokens.' },
  userMsg('qt-u3', 'Thanks. Now the loading state.'),
  tool('qt-t4', 'Read skeleton.tsx', 'src/app/invoices/skeleton.tsx', { name: 'Read', input: { file_path: 'src/app/invoices/skeleton.tsx' } }),
  tool('qt-t5', 'Edit skeleton.tsx', 'src/app/invoices/skeleton.tsx', { name: 'Edit', input: { file_path: 'src/app/invoices/skeleton.tsx' } }),
  { kind: 'text', id: 'qt-x3', ts: at(10, 35), text: 'The loading state now shows six skeleton rows.' },
  { kind: 'result', id: 'qt-r3', ts: at(10, 35), durationMs: 32_000, ok: true }
]

const leadSteps: ChatItem[] = [
  { kind: 'user', id: 'ls-u', ts: at(10, 20), parts: [{ type: 'text', text: 'Approved' }] },
  { kind: 'thinking', id: 'ls-th1', ts: at(10, 21), text: 'I should file the Linear issues first, so I need to check team and project names along with labels, then create the sub-issues.' },
  tool('ls-t1', 'ToolSearch', '{"query":"select:mcp__linear__save_issue,mcp__linear__list_issue_labels","max_results":2}', { name: 'ToolSearch', input: { query: 'select:mcp__linear__save_issue,mcp__linear__list_issue_labels', max_results: 2 }, output: 'Loaded 2 tools' }),
  mcpCall('ls-t2', 'linear', 'list_issue_labels', { team: 'Kernel' }, { output: 'Bug\nImprovement\nFeature\nWorkspace\nEngine\nPlatform\nTeam' }),
  mcpCall('ls-t3', 'linear', 'list_issues', { team: 'Kernel', query: 'Settings', updatedAt: '-P30D' }, { output: 'KERNEL-716 Project settings title misaligned and long Always allow commands overflow' }),
  { kind: 'thinking', id: 'ls-th2', ts: at(10, 22), text: 'KERNEL-716 is already in review covering the project title misalignment and command overflow, which overlaps with the layout issue.' },
  { kind: 'text', id: 'ls-x1', ts: at(10, 22), text: 'KERNEL-716, now in review, already fixes the project title alignment and the overflowing command tags, so I will leave both out of the layout issue. Filing the issues now.' },
  mcpCall('ls-t4', 'linear', 'save_issue', { team: 'Kernel', project: 'Kernel v1', title: 'Settings: clear saving, scope and layout' }, { output: 'KERNEL-720' }),
  { kind: 'text', id: 'ls-x2', ts: at(10, 23), text: 'Now the sub-issues.' },
  ...['Settings say Saving and Saved next to the control', 'Settings pages line up', 'Project settings update when the TOML changes', 'Record when each setting takes effect', 'Settings rows say Applies to new chats'].map((title, i) =>
    mcpCall(`ls-s${i}`, 'linear', 'save_issue', { team: 'Kernel', project: 'Kernel v1', parentId: 'KERNEL-720', title }, { output: `KERNEL-72${i + 1}` })),
  { kind: 'thinking', id: 'ls-th3', ts: at(10, 24), text: 'Now I need to check list_workspaces for the limit and the KERNEL-716 workspace, then plan the new ones.' },
  mcpCall('ls-t5', 'kernel', 'list_workspaces', {}, { output: 'ws-716 Project settings title misaligned (in review)\nws-714 Replace the ring spinner (ready to merge)' }),
  { kind: 'thinking', id: 'ls-th4', ts: at(10, 25), text: 'KERNEL-721 and KERNEL-716 both touch kit.tsx and settings.css, since the title alignment logic lives in Page.' },
  ...[['christian', 'KERNEL-721', 'Settings say Saving and Saved next to the control'], ['sean', 'KERNEL-723', 'Project settings update when the TOML changes'], ['sean', 'KERNEL-724', 'Record when each setting takes effect'], ['christian', 'KERNEL-722', 'Settings pages line up']].map(([agent, issue, title], i) =>
    mcpCall(`ls-w${i}`, 'kernel', 'create_workspace', { agent, issue, title, brief: `Build ${issue}.` }, { output: `Created a workspace for ${agent}.` }))
]

/** A Lead turn in progress (WorkspaceStepRuns): a run of seven Linear issues with one failure, a run of five handoffs and the step in flight. Times count back from now so the clock reads 10m 49s. */
const stepRunItems = (done: boolean): ChatItem[] => {
  const t = (secs: number) => Date.now() - secs * 1000
  const titles = ['Settings say Saving and Saved next to the control', 'Settings pages line up', 'Project settings update when the TOML changes', 'Record when each setting takes effect', 'Settings rows say Applies to new chats', 'Settings tabs keep their scroll position', 'Settings search finds a row by its hint']
  const issues = titles.map((title, i) => mcpCall(`sr-s${i}`, 'linear', 'save_issue', { team: 'Kernel', project: 'Kernel v1', parentId: 'KERNEL-720', title }, i === 5
    ? { status: 'failed', output: 'Validation failed: title is a duplicate of KERNEL-731' } : { output: `KERNEL-72${i + 1}` }))
  const hands = [['christian', 'KERNEL-721'], ['sean', 'KERNEL-723'], ['sean', 'KERNEL-724'], ['christian', 'KERNEL-722'], ['christian', 'KERNEL-725']].map(([agent, issue], i) =>
    mcpCall(`sr-w${i}`, 'kernel', 'create_workspace', { agent, issue, title: titles[i], brief: `Build ${issue}.` }, { output: `Created a workspace for ${agent}.` }))
  return [
    { kind: 'user', id: 'sr-u', ts: t(649), parts: [{ type: 'text', text: 'Approved' }] },
    { kind: 'thinking', id: 'sr-th1', ts: t(640), text: 'I should file the Linear issues first, so I need to check team and project names along with labels, then create the sub-issues.' },
    tool('sr-t1', 'ToolSearch', '{}', { name: 'ToolSearch', input: { query: 'select:mcp__linear__save_issue' }, output: 'Loaded 1 tool' }),
    mcpCall('sr-t2', 'linear', 'list_issue_labels', { team: 'Kernel' }, { output: 'Bug\nImprovement\nFeature' }),
    mcpCall('sr-t3', 'linear', 'list_issues', { team: 'Kernel', query: 'Settings' }, { output: 'KERNEL-716 Project settings title misaligned' }),
    { kind: 'thinking', id: 'sr-th2', ts: t(600), text: 'KERNEL-716 is already in review covering the project title misalignment, so I will leave it out.' },
    { kind: 'text', id: 'sr-x1', ts: t(590), text: 'KERNEL-716, now in review, already fixes the project title alignment, so I will leave it out of the layout issue. Filing the issues now.' },
    mcpCall('sr-t4', 'linear', 'save_issue', { team: 'Kernel', project: 'Kernel v1', title: 'Settings: clear saving, scope and layout' }, { output: 'KERNEL-720' }),
    { kind: 'text', id: 'sr-x2', ts: t(560), text: 'Now the sub-issues.' },
    ...issues.slice(0, 3),
    { kind: 'thinking', id: 'sr-th3', ts: t(540), text: 'Next the rest of the sub-issues.' },
    ...issues.slice(3),
    { kind: 'thinking', id: 'sr-th4', ts: t(500), text: 'Now I need to check list_workspaces for the limit, then plan the new ones.' },
    mcpCall('sr-t5', 'kernel', 'list_workspaces', {}, { output: 'ws-716 Project settings title misaligned (in review)' }),
    ...hands,
    ...(done
      ? [{ kind: 'text' as const, id: 'sr-x3', ts: t(20), text: 'Filed KERNEL-720 with six sub-issues, and handed five tasks to Christian and Sean. One issue was a duplicate of KERNEL-731, so I left it out.' }, { kind: 'result' as const, id: 'sr-res', ts: t(10), durationMs: 640_000, ok: true }]
      : [mcpCall('sr-t6', 'kernel', 'wait_for_merge', { on: 'KERNEL-721' }, { status: 'running', durationMs: undefined })])
  ]
}

/** A running turn of 500 steps: reads, commands, edits and thinking, then the step in flight (WorkspaceStepsLong). */
const longSteps = (): ChatItem[] => [
  { kind: 'user', id: 'sl-u', ts: Date.now() - 1_800_000, parts: [{ type: 'text', text: 'Sweep every screen for hard-coded colours and move them to tokens.' }] },
  ...Array.from({ length: 500 }, (_, i): ChatItem => {
    const file = `src/renderer/src/screens/screen${Math.floor(i / 5)}.tsx`
    switch (i % 5) {
      case 0: return tool(`sl${i}`, 'Read', file, { name: 'Read', input: { file_path: file } })
      case 1: return { kind: 'thinking', id: `sl${i}`, ts: at(10, 28), text: 'This screen has two hex values, both in the header.' }
      case 2: return tool(`sl${i}`, 'Run', 'rg -n "#[0-9a-f]{6}" src', { input: { command: `rg -n "#[0-9a-f]{6}" ${file}` } })
      case 3: return tool(`sl${i}`, 'Edit', file, { name: 'Edit', input: { file_path: file, old_string: '#fff', new_string: 'var(--ink-2)' } })
      default: return tool(`sl${i}`, 'Run', 'pnpm typecheck', { input: { command: 'pnpm typecheck' } })
    }
  }),
  tool('sl-live', 'Run the shots', 'pnpm shots --all', { status: 'running', durationMs: undefined, input: { command: 'pnpm shots --all' } })
]

const invoiceFiles: ChangedFile[] = [{ path: 'src/app/invoices/table.tsx', status: 'M', added: 212, removed: 20 }, { path: 'src/app/invoices/empty-state.tsx', status: 'A', added: 64, removed: 0 }]
/** A finished turn with two in-between messages and real thinking between its calls (KERNEL-840): one fold, then the reply. */
const foldedMessages: ChatItem[] = [
  tableItems[0],
  { kind: 'thinking', id: 'fm-th1', ts: at(10, 28), text: 'The table needs sorting by date and amount. The empty state can wait until the rows render.' },
  tool('fm-t1', 'Read the plan', 'cat plans/t-14-invoice-table.md', { name: 'Read', ts: at(10, 28) }),
  { kind: 'text', id: 'fm-x1', ts: at(10, 28), text: '**I will build the table first**, then the empty state and the tests.\n\nThe plan lists three states:\n\n- loading\n- empty\n- error' },
  tool('fm-t2', 'Edit table.tsx', 'src/app/invoices/table.tsx', { name: 'Edit', ts: at(10, 29) }),
  { kind: 'thinking', id: 'fm-th2', ts: at(10, 29), text: 'Sorting works on the client. The empty state needs its own component.' },
  { kind: 'text', id: 'fm-x2', ts: at(10, 29), text: 'The table sorts now. Moving on to the empty state.' },
  tool('fm-t3', 'Run unit tests', 'pnpm vitest run invoices', { ts: at(10, 30), input: { command: 'pnpm vitest run invoices' } }),
  { kind: 'text', id: 'fm-x3', ts: at(10, 31), text: 'Done. The table sorts and each state has its own component.' },
  { kind: 'result', id: 'fm-r', ts: at(10, 31), durationMs: 252_000, ok: true, files: invoiceFiles }
]
/** The Lead's chat with `items`, and the turn running unless it is told otherwise. */
const leadRunning = (f: Fixture, items: ChatItem[], running = true): Partial<Fixture> => {
  // scene2 sets approvals only when it is given some; an undefined one would hide the seed's.
  const { approvals: _none, ...rest } = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Settings save feedback', items, {}, { model: 'claude-opus-5-5' })
  return { ...rest, push: running ? [...f.push, { type: 'chat.running', chatId: ids.leadChat, running: true }] : f.push }
}

const codexPatch = (path: string, old: string[], next: string[], context = ['export function InvoiceTable() {']) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -10,${old.length + 1} +10,${next.length + 1} @@`, ` ${context[0]}`, ...old.map((l) => `-${l}`), ...next.map((l) => `+${l}`)].join('\n')

/** The brief and the follow-up in the setup shots (KERNEL-430, KERNEL-1093): a teammate's task from the Lead's plan. */
export const JOURNEY = 'Run every step of KERNEL-31 on a fresh Mac account. File each failure as its own issue, then post one comment on KERNEL-232 with the results and shots.'
export const JOURNEY_TITLE = 'Clean-account journey on a fresh Mac user'
const setupAsk: QueuedMessage = { id: 'q-setup', chatId: ids.tableChat, ts: at(10, 0), parts: [{ type: 'text' as const, text: JOURNEY }] }
const setupFollow: QueuedMessage = { id: 'q-follow', chatId: ids.tableChat, ts: at(10, 0, 40), parts: [{ type: 'text' as const, text: 'Also attach the screenshots to the issue.' }] }

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
function setupLog(end: 'running' | 'done' | 'failed' | 'stopped'): PushEvent[] {
  const out = (line: string, stream: 'stdout' | 'stderr' = 'stdout'): PushEvent => ({ type: 'script.output', workspaceId: ids.table, kind: 'setup', lines: [{ line, stream }] })
  const lines = [out('$ pnpm install'), out('Lockfile is up to date, resolution step is skipped'), out('Packages: +1204'), out('Progress: resolved 1204, reused 1198, downloaded 6, added 940')]
  const raw = [setupData(ids.table, SETUP_RAW.head + SETUP_RAW.install)]
  if (end === 'failed') return [...lines, ...raw, setupData(ids.table, SETUP_RAW.failed), out('gyp ERR! build error', 'stderr'), out('ERR_PNPM_LIFECYCLE  better-sqlite3@11.8.1 install: exit status 1', 'stderr'), { type: 'script.exit', workspaceId: ids.table, kind: 'setup', code: 1 }]
  if (end === 'stopped') return [...lines, ...raw, { type: 'script.exit', workspaceId: ids.table, kind: 'setup', code: null }]
  if (end === 'done') return [...lines, ...raw, setupData(ids.table, SETUP_RAW.done), { type: 'script.exit', workspaceId: ids.table, kind: 'setup', code: 0 }]
  return [...lines, ...raw, setupData(ids.table, SETUP_RAW.notice)]
}

/**
 * A new chat waiting for setup: `queue` waits for it, and `end` is how a failed setup ended (an exit code, or null when stopped).
 * `pending` is a worktree Kernel hasn't made yet (KERNEL-543), with git's reason once it failed: setup hasn't started, so it has no run or log.
 */
function setupWait(f: Fixture, status: 'setup' | 'failed', queue: QueuedMessage[], o: { later?: boolean; end?: number | null; pending?: { error?: string }; panel?: boolean; right?: 'files'; collapsed?: boolean; composer?: { parts: import('@shared/types').ChatPart[]; draft: string } } = {}): Partial<Fixture> {
  const started = Date.now() - 42_000
  const setupRun = o.pending ? undefined : status === 'setup' ? { startedAt: started } : { startedAt: started - 26_000, endedAt: started + (o.end === null ? 5_000 : 42_000), end: o.end }
  // A worktree still being made was asked for a moment ago, and the Working line counts from then.
  if (o.pending && !o.pending.error) queue = queue.map((q) => ({ ...q, ts: Date.now() - 2_000 }))
  return {
    workspaces: withWorkspace(f, ids.table, { status, title: JOURNEY_TITLE, setupRun, copied: 2, ...(o.later ? { firstInProject: false } : {}), ...(o.pending ? { baseRef: 'origin/main', worktreePending: o.pending } : {}) }),
    chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: JOURNEY_TITLE } : c)),
    items: { [ids.tableChat]: [] },
    queue: { [ids.tableChat]: queue },
    push: [...f.push, ...(o.pending ? [] : setupLog(status === 'setup' ? 'running' : o.end === null ? 'stopped' : 'failed')), ...(queue.length ? [{ type: 'chat.queue' as const, chatId: ids.tableChat, queue, why: 'worktree' as const }] : [])],
    ui: { ...open, rightPanel: o.panel ?? true, ...(o.collapsed ? { bottomCollapsed: { lead: true, teammate: true } } : {}), workspace: { right: o.right ?? 'changes', bottom: 'setup', ...(o.composer ? { composer: o.composer } : {}) } }
  }
}

/**
 * KERNEL-1086, KERNEL-1093: a teammate's brief went out at once and setup runs, passed or didn't alongside it. `setup` is where the run stands, and a run that
 * didn't pass pushes the `setup.failed` main does, so the toast comes through the app's own handler. `steps` is how far the turn has got, `later` marks a chat
 * that isn't the project's first, and `pane` opens the right panel on its Setup tab.
 */
export function along(f: Fixture, o: { quiet?: boolean; setup?: 'running' | 'done' | 'failed' | 'stopped' | 'timeout'; steps?: 0 | 1 | 3; later?: boolean; pane?: boolean; right?: 'files'; collapsed?: boolean; followUp?: boolean; secs?: number } = {}): Partial<Fixture> {
  const now = Date.now()
  const t = (secs: number) => now - secs * 1000
  const secs = o.secs ?? 14
  const run = { running: { startedAt: t(42) }, done: { startedAt: t(100), endedAt: t(28), end: 0 }, failed: { startedAt: t(68), endedAt: t(26), end: 1 }, stopped: { startedAt: t(70), endedAt: t(39), end: null }, timeout: { startedAt: t(330), endedAt: t(30), end: 'timeout' as const } }
  const setupRun = o.setup ? run[o.setup] : undefined
  const steps = [
    tool('al-1', 'Read', 'docs/qa/kernel-31.md', { name: 'Read', ts: t(secs - 4), input: { file_path: 'docs/qa/kernel-31.md' } }),
    tool('al-2', 'Read issue', 'KERNEL-232', { name: 'Read', ts: t(secs - 8), input: { file_path: 'KERNEL-232' } }),
    tool('al-3', 'Run steps 1 to 5', 'pnpm test:journey --steps 1-5', { ts: t(6), status: 'running', durationMs: undefined, input: { command: 'pnpm test:journey --steps 1-5' } })
  ]
  const end = !o.quiet && (o.setup === 'failed' || o.setup === 'timeout' || o.setup === 'stopped')
  return {
    workspaces: withWorkspace(f, ids.table, { status: 'ready', title: JOURNEY_TITLE, copied: 2, ...(o.later ? { firstInProject: false } : {}), setupRun }),
    chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: JOURNEY_TITLE } : c)),
    items: { [ids.tableChat]: [
      { kind: 'user', id: 'al-u', ts: t(secs), parts: [{ type: 'text', text: JOURNEY }] },
      ...(o.followUp ? [{ kind: 'user' as const, id: 'al-u2', ts: t(secs - 2), parts: setupFollow.parts }] : []),
      ...(o.steps === 0 ? [] : steps.slice(0, o.steps === 1 ? 1 : 3))
    ] },
    push: [
      ...f.push,
      ...(o.setup ? setupLog(o.setup === 'timeout' ? 'failed' : o.setup) : []),
      { type: 'chat.running', chatId: ids.tableChat, running: true },
      ...(end ? [{ type: 'setup.failed' as const, workspaceId: ids.table, chatId: ids.tableChat, kind: o.setup === 'stopped' ? 'stopped' as const : o.setup === 'timeout' ? 'timeout' as const : 'failed' as const, ...(o.setup === 'failed' ? { code: 1 } : {}) }] : [])
    ],
    ui: { ...open, rightPanel: o.pane ?? false, ...(o.collapsed ? { bottomCollapsed: { lead: true, teammate: true } } : {}), workspace: { right: o.right ?? 'changes', bottom: 'setup' } }
  }
}

/** The Lead's chat sets up the same way, silently (Pen 6.11): its message goes out at once and Kernel works while the script runs, or after it failed. */
export function leadAlong(f: Fixture, failed: boolean): Partial<Fixture> {
  const now = Date.now()
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead', status: 'ready', copied: 2, setupRun: failed ? { startedAt: now - 68_000, endedAt: now - 26_000, end: 1 } : { startedAt: now - 12_000 } }, 'Refund rounding', [
    { kind: 'user', id: 'la-u', ts: now - (failed ? 40_000 : 12_000), parts: [{ type: 'text', text: 'The invoice total is off by a cent on refunds. Can you fix it?' }] },
    tool('la-1', 'Read', 'src/lib/money.ts', { name: 'Read', ts: now - 5_000, status: 'running', durationMs: undefined, input: { file_path: 'src/lib/money.ts' } })
  ], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  return { ...rest, push: [...f.push, { type: 'chat.running', chatId: ids.leadChat, running: true }, ...(failed ? [{ type: 'setup.failed' as const, workspaceId: ids.lead, chatId: ids.leadChat, kind: 'failed' as const, code: 1 }] : [])] }
}

/**
 * A project's first chat, made when the project was added, before anything is sent: one setup block at the top, the box below. `script` is the project's
 * setup script, which runs (`running`) or has finished; without one the block offers to add it.
 */
/** The first message, as it reads once sent: the block of setup rows is gone and the agent's turn follows (Pen 6.3). */
const sentFirst = (): ChatItem[] => {
  const now = Date.now()
  return [
    { kind: 'user', id: 'fc-u', ts: now - 14_000, parts: [{ type: 'text', text: 'Add a dark mode toggle to Settings, Appearance. Keep the current theme as the default.' }] },
    tool('fc-1', 'Read', 'src/renderer/src/tokens.css', { name: 'Read', ts: now - 10_000, input: { file_path: 'src/renderer/src/tokens.css' } }),
    tool('fc-2', 'Searched', 'theme in src/renderer', { name: 'Grep', ts: now - 6_000, input: { pattern: 'theme', path: 'src/renderer' } }),
    tool('fc-3', 'Checking the team', 'Which teammate owns Settings', { ts: now - 2_000, status: 'running', durationMs: undefined })
  ]
}

function firstChat(f: Fixture, o: { script?: boolean; running?: boolean; sent?: boolean; pane?: boolean } = {}): Partial<Fixture> {
  const started = Date.now() - 18_000
  const setupRun = !o.script ? undefined : o.running ? { startedAt: started } : { startedAt: started - 40_000, endedAt: started - 28_000, end: 0 }
  return {
    projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, name: 'aurahire', firstChatId: ids.tableChat } : r)),
    workspaces: withWorkspace(f, ids.table, { status: o.running ? 'setup' : 'ready', firstInProject: true, branch: 'cjjutba/yx6r7', baseRef: 'origin/main', copied: 1028, setupRun }),
    chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: o.sent ? 'Dark mode toggle' : 'New tab', autoTitle: { turns: 0 } } : c)),
    items: { [ids.tableChat]: o.sent ? sentFirst() : [] },
    projectSettings: { [ids.projectA]: { scripts: o.script ? { setup: 'pnpm install' } : {}, runScripts: [], files: { copy: [] }, workspace: {} } },
    push: [...f.push, ...(o.script ? setupLog(o.running ? 'running' : 'done') : []), ...(o.sent ? [{ type: 'chat.running' as const, chatId: ids.tableChat, running: true }] : [])],
    ui: { ...open, rightPanel: o.pane ?? false, workspace: { right: 'files', bottom: 'setup' } }
  }
}

/** A project whose setup script runs on create, with Wait for setup left at its default, off. */
const handoverSettings: NonNullable<Fixture['projectSettings']> = { [ids.projectA]: { scripts: { setup: 'pnpm install' }, runScripts: [], files: { copy: [] }, workspace: {} } }
/** The updates after a New chat message whose worktree was pending, in main's order: `worktreePending` clears alone, the setup script starts, then setup ends and the workspace is ready, and the row, the running state and the empty tray follow it. The ready update and what it releases draw as one frame. */
function handoverSteps(): { label: string; events: PushEvent[] }[] {
  const made = scene((f) => setupWait(f, 'setup', [], { pending: {} })).workspaces.find((w) => w.id === ids.table)!
  const cleared = { ...made, worktreePending: undefined }
  return [
    { label: 'worktree made', events: [{ type: 'workspace', workspace: cleared }] },
    { label: 'setup script started', events: [{ type: 'workspace', workspace: { ...cleared, setupRun: { startedAt: Date.now() } } }] },
    { label: 'ready + row + running + tray empty', events: [{ type: 'workspace', workspace: { ...cleared, status: 'ready', setupRun: { startedAt: Date.now() - 1_000, endedAt: Date.now() } } }, { type: 'chat.item', chatId: ids.tableChat, item: { kind: 'user', id: setupAsk.id, ts: Date.now(), parts: setupAsk.parts } }, runningEvent(ids.tableChat, true), { type: 'chat.queue', chatId: ids.tableChat, queue: [] }] }
  ]
}


/**
 * Kernel's chat picked Bypass permissions on the current branch while Only in worktrees is on, so it runs as Accept edits (KERNEL-456).
 * The label says Accept edits, and the menu keeps its check on Bypass permissions and says why.
 */
const bypassPicked = (f: Fixture, menu?: 'mode') => ({
  workspaces: withWorkspace(f, ids.lead, { mode: 'current' }),
  chats: f.chats.map((c) => (c.id === ids.leadChat ? { ...c, plan: false, effort: 'medium' as const, mode: 'bypassPermissions' as const } : c)),
  ui: { route: { name: 'workspace' as const, workspaceId: ids.lead }, ...(menu ? { menu } : {}) }
})


const file = (path: string): FileEntry => ({ path, dir: false })
/** A stand-in for a pasted screenshot, so hovering the image chip in WorkspacePaste shows a preview. */
export const pastedLog = Array.from({ length: 212 }, (_, i) => `2025-03-11T10:${String(i % 60).padStart(2, '0')}:07Z ${i % 9 === 4 ? 'ERROR invoices.list: relation "invoice_lines" does not exist' : `INFO  request ${1000 + i} GET /api/invoices 200 ${12 + (i % 7)}ms`}`).join('\n')
export const screenshot = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#141518"/><rect width="240" height="800" fill="#1b1c20"/><rect x="300" y="60" width="520" height="22" rx="4" fill="#3a3c42"/><rect x="300" y="120" width="920" height="420" rx="10" fill="#1f2024" stroke="#2c2e33"/><rect x="330" y="160" width="400" height="14" rx="3" fill="#5a2a2a"/><rect x="330" y="196" width="760" height="12" rx="3" fill="#2f3136"/><rect x="330" y="224" width="680" height="12" rx="3" fill="#2f3136"/></svg>')}`
const imageBefore = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAAA2klEQVR42u3coREAMAgEQapDpH+NSCXpIQIBO3MV/PqPqqvBhQkAC7AAC7AAC7AAAxZgARZgARZgAQYswAIswAIswAIswIAF+K/MsyrAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDlkt/ARZgARZgAQYswAIswAIswAIMWIAFWIAFWIAFGLAAC7AAq7cHvsLF6uuQAxcAAAAASUVORK5CYII='
const imageAfter = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABM0lEQVR42u3dsQ3DQAwEwatEgatUpIoVuATHzhQJz/sBtgIOFNlP5jwvFRcjACzAAizAAizA+gO+76+KAwxYgAVYgAVYgAUYsAALsAC/33F8APdYPg9wp2u9dLh2S4dut3HQdjMHbTdz6HYbh263ceh2G4dut3HodhuHbrcxYMB0JxsDBkx3snHodhsDBgwY8M66ixsDBgwY8Oa6KxsDBgwYMGDAgAEDBgy4BHic7rLGvmBfMGDAgAEDBgwYMGDAgP0e7PdgwIABA/avSsCAAQP2Nomu14VeFwIGzNgLf8CAbdkBvLzxoInZdGfTHWO7Kjcxnjgo+6Lti96eefR83Gxws2FX446xuJvkbtIe0q1DcLuwPNdHAQuwAAuwAAuwAAMWYAEWYAEWYAEGLMACLMB6tR96o4AjuY6UBwAAAABJRU5ErkJggg=='



const mentionAgentTree: FileEntry[] = ['src/lib/money.ts', 'docs/journeys/clean-account.md'].map(file)



const hunk = (owner: Hunk['owner'], lines: string, added: number, removed: number): Hunk => ({ id: `src/lib/checkout.ts#${owner}#0`, path: 'src/lib/checkout.ts', owner, lines, added, removed, patch: '' })

/** WorkspaceQueued.png: Christian is mid-turn with two follow-ups waiting. */
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
/** New chat with Kernel in a project with no open chat (KERNEL-366, KERNEL-405), with Todo issues for Up next and the remote's branches. */
function leadNoChats(f: Fixture, open = 0): Partial<Fixture> {
  // `open` chats stay open, the newest first, so New chat has worktrees to offer as Previous worktree.
  const g = grouped(f, { running: [], threads: (t) => t.map((x, i) => (i >= t.length - open ? x : { ...x, closedAt: at(10, 50) })) })
  const issue = (id: string, title: string, priority: number, project?: string): IssueSummary => ({ id, title, url: `https://linear.app/client-a/issue/${id}`, source: 'linear', priority, ...(project ? { project } : {}) })
  // Nothing is open, so no tab is stored and the archived chats keep no transcript here.
  return {
    ...g, items: {}, ui: { ...g.ui!, route: { name: 'leadNew', projectId: ids.projectA }, tabs: {} },
    issues: [issue('T-17', 'Email an invoice to the client from the row actions', 2, 'Invoicing'), issue('T-19', 'Overdue badge on unpaid invoices past their due date', 3, 'Invoicing'), issue('T-22', 'Remember the sort order on the invoices table', 0)],
    branches: ['origin/main', 'origin/invoice-pdf-renderer', 'origin/invoice-pdf-button', 'origin/invoice-table', 'origin/invoice-schema', 'origin/org-invites', 'origin/release/2.4', 'origin/hotfix/pdf-fonts']
  }
}

/** New chat with the Lead's plan mode off, as a fresh install has it, so the box shows its permission mode. */
const noPlan = (p: Partial<Fixture>): Partial<Fixture> => ({ ...p, settings: { ...DEFAULT_SETTINGS('/Users/you'), models: { ...DEFAULT_SETTINGS('/Users/you').models, leadPlanMode: false } } })
const newChatBranches = (f: Fixture): Partial<Fixture> => ({
  ...noPlan(leadNoChats(f)),
  branches: ['origin/main', 'origin/feat/t-14-invoice-table', 'origin/feat/t-12-invoice-schema', 'origin/feat/t-09-org-invites', 'origin/fix/t-17-pdf-fonts', 'origin/feat/t-21-saving-saved', 'origin/feat/t-23-project-settings', 'spike/pdf-fonts']
})

/** Teng's reply with paths in it (clickable file mentions), and what the workspace resolves them to. */
function fileLinks(f: Fixture, click?: { click: string }): Partial<Fixture> {
  const text = [
    'The sort lives in `src/app/invoices/table.tsx:12-14`, and the empty state is in empty-state.tsx.',
    '',
    '- Layout rules are in DESIGN.md, and the folder is `src/app/invoices/`.',
    '- Two `page.tsx` files use it, so check both before you change the props.',
    '- I removed `src/gone.ts` and bumped the PDF library to 1.2.3 in `package.json`.'
  ].join('\n')
  const file = (path: string, more: object = {}) => ({ kind: 'file' as const, path, ...more })
  return {
    items: { [ids.tableChat]: [{ kind: 'text', id: 'fl0', ts: at(10, 31), text }] },
    mentions: { [ids.table]: {
      'src/app/invoices/table.tsx:12-14': file('src/app/invoices/table.tsx', { line: 12, endLine: 14 }),
      'empty-state.tsx': file('src/app/invoices/empty-state.tsx'),
      'DESIGN.md': file('DESIGN.md'),
      'src/app/invoices/': { kind: 'dir', path: 'src/app/invoices' },
      'page.tsx': { matches: ['src/app/invoices/page.tsx', 'src/app/page.tsx'] },
      // Picking the root match asks for it as `./package.json`, so the engine doesn't list the matches again.
      'package.json': { matches: ['package.json', 'packages/pdf/package.json'] },
      './package.json': file('package.json', { sensitive: true })
    } },
    ui: { ...open, workspace: { right: 'files', bottom: 'run' } },
    ...(click && { motion: { action: click, ms: 800, area: '.ws-main' } })
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
  'Invoices get a PDF renderer and a Download PDF action in each row. Four tasks, run in parallel, and Artkin reviews each PR as it lands.',
  '',
  'T-15b needs the renderer from T-15a to merge first, since both change `row-actions.tsx`. Each PR runs `pnpm test`, `pnpm typecheck` and `pnpm shots`.'
].join('\n')

/** Kernel's plan for T-15 waiting on you in plan mode, in the Lead's chat: its write-up, then one row per task. */
const planWaiting = (f: Fixture): Partial<Fixture> => leadPlan(f, { agentId: 'kernel-lead' }, { detail: LEAD_PLAN })

/** The same plan once approved: it keeps its place with your Approved bubble under it, plan mode is off and each task has a workspace to open. */
const planApproved = (f: Fixture): Partial<Fixture> => {
  const s = planWaiting(f)
  const reply: ChatItem = { kind: 'text', id: 'pl-go', ts: at(10, 31), text: 'Handed off. Sean has the renderer, Christian has the button and Teng has the tests. Artkin reviews each PR as it lands.' }
  return {
    ...s,
    chats: s.chats?.map((c) => (c.id === ids.leadChat ? { ...c, plan: false } : c)),
    approvals: s.approvals?.map((a, i) => (i === 0 ? { ...a, status: 'allowed' as const, steps: a.steps?.map((st, j) => ({ ...st, workspaceId: `ws-t15-${j}` })) } : a)),
    items: { [ids.leadChat]: [...(s.items?.[ids.leadChat] ?? []), reply] }
  }
}

/** The approved plan once every task has merged: a line under the card counts the PRs and how often it needed you (KERNEL-1063). */
const planFinished = (f: Fixture): Partial<Fixture> => {
  const s = planApproved(f)
  const id = s.approvals?.[0]?.id ?? ''
  const base = f.workspaces[0]
  const merged = [0, 1, 2, 3].map((j) => ({ ...base, id: `ws-t15-${j}`, name: `t-15${'abcd'[j]}`, branch: `t-15${'abcd'[j]}`, prState: 'merged' as const, prNumber: 160 + j }))
  return { ...s, workspaces: [...(s.workspaces ?? f.workspaces), ...merged], attention: { [id]: { prsMerged: 4, needed: 5, byKind: { plan: 1, tool: 2, question: 1, blocker: 0, merge: 1 }, finished: true } } }
}

/** The approved plan of a chat that has your answer as a message (KERNEL-838): Approved is the chat's own user row, so the plan card draws no bubble of its own. */
const planApprovedItem = (f: Fixture): Partial<Fixture> => {
  const s = planApproved(f)
  const id = s.approvals?.[0]?.id ?? ''
  const answer: ChatItem = { kind: 'user', id: `answer-${id}`, ts: at(10, 30), parts: [{ type: 'text', text: 'Approved' }], approvalId: id }
  const list = s.items?.[ids.leadChat] ?? []
  const at1 = list.findIndex((i) => i.id === 'pl-go')
  return { ...s, items: { [ids.leadChat]: at1 < 0 ? [...list, answer] : [...list.slice(0, at1), answer, ...list.slice(at1)] } }
}

/** Kernel's plan after you asked for changes: your notes are the bubble. The Kernel message that carried them after a restart names the approval and stays hidden. */
const planChanges = (f: Fixture): Partial<Fixture> => {
  const s = planWaiting(f)
  const notes = 'Split step 2 into its own PR, after step 1 merges.\nAnd have Artkin review each PR as it lands.'
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

/** Question and answer rows ahead of a chat's own rows, so the chat is taller than the view and has somewhere to scroll up to. */
const scrollHistory = (prefix: string, pairs = 12): ChatItem[] => Array.from({ length: pairs }, (_, i): ChatItem[] => [
  userMsg(`${prefix}q${i}`, `Question ${i + 1} about how the invoice export should behave.`),
  { kind: 'text', id: `${prefix}a${i}`, ts: at(10, 20), text: `Answer ${i + 1}. The export reads the invoice, renders it with the embedded fonts and hands the file to the download action, so the row never waits on the renderer.\n\nIt keeps the page margins from the invoice settings and falls back to A4 when none are set.` }
]).flat()

/** The Lead's chat with history above its pending plan, so the plan sits at the end of a long thread. */
const planAfterHistory = (s: Partial<Fixture>): Partial<Fixture> => ({ ...s, items: { ...s.items, [ids.leadChat]: [...scrollHistory('sh'), ...(s.items?.[ids.leadChat] ?? [])] } })

/** A write-up with many sections, so the pending plan is taller than the view and its task list sits below the fold of it. */
const TALL_PLAN = [LEAD_PLAN, ...Array.from({ length: 8 }, (_, i) => `\n## Section ${i + 1}\n\nThis section covers one part of the PDF export and what each task must leave behind it: the files it touches, the checks it runs and the reviewer it waits on. A reader scrolls past it to reach the tasks.`)].join('\n')

/** The plan of `planAfterHistory`, with a second chat to switch to and back. */
const planWithOtherChat = (f: Fixture, detail = LEAD_PLAN): Partial<Fixture> => {
  const s = planAfterHistory(planWaiting({ ...f }))
  const plan = s.approvals?.[0]
  return {
    ...s,
    approvals: s.approvals?.map((a) => (a === plan ? { ...a, detail } : a)),
    chats: [...(s.chats ?? f.chats), { ...extraChat('chat-other', 'Empty state copy'), workspaceId: ids.lead, threadId: 't-lead' }],
    items: { ...s.items, 'chat-other': [userMsg('o1', 'Shorten the empty state copy.')] },
    ui: { ...s.ui, workspace: { right: 'changes', bottom: 'run' }, tabs: { [ids.lead]: { tab: ids.leadChat, files: [], diffs: [] } } }
  }
}

/** `planWithOtherChat` with the other chat open, so the first open of the plan's chat is the motion. */
const startOnOtherChat = (s: Partial<Fixture>): Partial<Fixture> => ({ ...s, ui: { ...s.ui, tabs: { [ids.lead]: { tab: 'chat-other', files: [], diffs: [] } } } })

/** A long plan arriving live in a Lead chat that is open at its end: the plan's approval and its row are pushed, not in the chat yet. */
const livePlan = (f: Fixture, detail: string): { start: Partial<Fixture>; push: PushEvent[] } => {
  const s = planAfterHistory(planWaiting({ ...f }))
  const plan = { ...s.approvals![0], detail }
  return {
    start: { ...s, approvals: s.approvals!.slice(1), chats: s.chats?.map((c) => (c.id === ids.leadChat ? { ...c, plan: false } : c)), items: { ...s.items, [ids.leadChat]: s.items![ids.leadChat].filter((i) => i.id !== `approval-${plan.id}`) } },
    push: [
      { type: 'approval', approval: plan },
      { type: 'chat.item', chatId: ids.leadChat, item: { kind: 'approval', id: `approval-${plan.id}`, ts: Date.now(), approvalId: plan.id } }
    ]
  }
}

/** A plan with a new approval id, as Kernel sends it after changes were asked for: the old one expires and the new one takes its place in the chat. */
const revisedPlan = (f: Fixture): PushEvent[] => {
  const old = planWaiting(f).approvals?.[0]
  const next = { ...old!, id: 'ap-plan-kernel-lead-2', detail: `${LEAD_PLAN}\n\nRevised: step 2 is its own PR, after step 1 merges.`, createdAt: at(10, 32) }
  return [
    { type: 'approval', approval: { ...old!, status: 'expired', expiredBy: 'replaced' } },
    { type: 'approval', approval: next },
    { type: 'chat.item', chatId: ids.leadChat, item: { kind: 'approval', id: `approval-${next.id}`, ts: Date.now(), approvalId: next.id } }
  ]
}

/** Christian's plan for T-15b from ExitPlanMode, waiting on you in plan mode: markdown in `detail` and `input`, no `steps` (KERNEL-374). */
const planExit = (f: Fixture): Partial<Fixture> => scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'christian' }, 'Plan T-15b', [
  userMsg('pl1', 'Plan T-15b: a Download PDF button on each invoice row. Do not edit anything yet.'),
  { kind: 'thinking', id: 'pl-th', ts: at(10, 28), text: 'Row actions already live in a menu. A second button would crowd the row.' },
  tool('pl-t1', 'Read the row actions', 'cat src/app/invoices/row-actions.tsx', { name: 'Read' }),
  tool('pl-t2', 'Check the PDF endpoint', 'rg -n "renderInvoicePdf" src')
], {
  approvals: [pending('plan', 'christian', { toolName: 'ExitPlanMode', input: { plan: EXIT_PLAN }, title: 'Plan for invoice-pdf-button', detail: EXIT_PLAN }), ...f.approvals]
}, { plan: true, model: 'claude-opus-5-5' })

/** A scene that passes no approvals keeps the seed's: scene2 would otherwise set them to undefined. */
const noApprovals = ({ approvals: _none, ...patch }: Partial<Fixture>): Partial<Fixture> => patch

/** The same chat in plan mode with nothing waiting: Christian answered and the box waits for the next message. */
const planMode = (f: Fixture): Partial<Fixture> => {
  // scene2 sets approvals from the ones a scene passes. This one passes none and keeps the seed's.
  const { approvals: _none, ...patch } = scene2(f, { name: 'invoice-pdf-button', branch: 'feat/t-15b-invoice-pdf-button', agentId: 'christian' }, 'Invoice row actions', [
    userMsg('pm1', 'Look at how the invoice rows show their actions.'),
    tool('pm-t1', 'Read the row actions', 'cat src/app/invoices/row-actions.tsx', { name: 'Read' }),
    { kind: 'text', id: 'pm-reply', ts: at(10, 28), text: 'Each row ends in a menu with Duplicate, Send and Void. A new action fits there without crowding the row.' },
    { kind: 'result', id: 'pm-res', ts: at(10, 28), durationMs: 24_000, ok: true }
  ], {}, { plan: true, model: 'claude-opus-5-5' })
  return patch
}

/** A fixture with a draft in the box. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const runningEvent = (chatId: string, running: boolean): PushEvent => ({ type: 'chat.running', chatId, running })
/** The engine's row for a message the window drew: `$id`, `$now` and `$parts` are filled from the call (src/main/fixtures.ts). */
const sentRow = (chatId: string, o: { id?: string; parts?: ChatPart[] } = {}): PushEvent =>
  ({ type: 'chat.item', chatId, item: { kind: 'user', id: o.id ?? '$id', ts: '$now' as unknown as number, parts: o.parts ?? ('$parts' as unknown as ChatPart[]) } })
/** What main pushes once it takes a message: the row under the window's id, then the running turn. */
const sentAfter = (chatId: string, parts?: ChatPart[]): { afterMs: number; events: PushEvent[] }[] => [{ afterMs: 0, events: [sentRow(chatId, { parts }), runningEvent(chatId, true)] }]
const errorItems: ChatItem[] = [
  userMsg('e0', 'Run the full test suite before I open the PR.'),
  tool('e-t1', 'Run unit tests', 'pnpm vitest run', { status: 'failed', durationMs: 19_800, output: 'FAIL tests/invoices.spec.ts > sorts by date\n  Expected: 2026-10-01  Received: 01/10/2026\nFAIL tests/invoices.spec.ts > empty state\n  Snapshot mismatch: 1 line changed' }),
  { kind: 'result', id: 'e-res', ts: at(10, 30), durationMs: 184_000, ok: false, error: '2 tests failed' }
]

const withDraft = (p: Partial<Fixture>, draft: string): Partial<Fixture> =>
  ({ ...p, ui: { ...p.ui, workspace: { right: 'changes', bottom: 'run', composer: { parts: [], draft } } } })

/** Two team updates in Kernel's chat after a hand-off: Christian's PR passed checks, then Artkin approved it (KERNEL-127). */
const leadUpdate = (f: Fixture): Partial<Fixture> => {
  const header = 'Team update from Kernel, not from the user.'
  const teng: TeamUpdateRow = {
    workspaceId: ids.table, agentId: 'teng', name: 'Teng', task: 'KERNEL-232 Clean-account journey on a fresh Mac user', prNumber: 1153,
    events: [{ kind: 'pr.opened', text: 'Opened PR #1153', actionable: false }, { kind: 'pr.ready', text: 'Checks passed', actionable: true }, { kind: 'pr.review', text: 'Not reviewed', actionable: false }],
    reply: 'All six steps pass on a clean account. I opened PR #1153 with the journey test and its fixture, and posted the results on KERNEL-232.'
  }
  const artkin: TeamUpdateRow = {
    workspaceId: 'ws-review-1153', agentId: 'artkin', name: 'Artkin', task: 'KERNEL-232 Review PR #1153',
    events: [{ kind: 'review', text: 'Approved PR #1153', actionable: true }, { kind: 'pr.review', text: 'No blockers', actionable: false }],
    reply: "Every step passes on a fresh account, and the one failure has its own issue, KERNEL-1084. The fixture covers the release candidate's review screen."
  }
  const update = (id: string, m: number, row: TeamUpdateRow, todo: string): ChatItem => ({
    kind: 'user', id, ts: J(m), from: 'kernel', update: { rows: [row] },
    parts: [{ type: 'text', text: [header, '', `${row.name} (${row.agentId}) · ${row.task} · workspace ${row.workspaceId}`, ...row.events.map((e) => `- ${e.text}.`), '', 'To do:', `- ${todo}`].join('\n') }]
  })
  const done = (id: string, m: number): ChatItem => ({ kind: 'result', id, ts: J(m), durationMs: 9_000, ok: true })
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Clean-account journey and soak', [
    userMsg('lu1', 'Run the clean-account journey, then have Artkin review the PR before I merge.'),
    { kind: 'text', id: 'lu1-r', ts: J(58), text: 'Teng has it. Once its checks pass, Artkin reviews the PR.' },
    done('lu1-res', 58),
    update('lu2', 59, teng, 'PR #1153 needs a review. Artkin (artkin) reviews on this team: call create_workspace with agent "artkin" and review_of "ws-invoice-table".'),
    { kind: 'text', id: 'lu2-r', ts: J(59, 9), text: "Teng's PR #1153 passed its checks. Artkin is reviewing it now." },
    done('lu2-res', 59),
    update('lu3', 62, artkin, 'PR #1153 passed checks, has no conflicts and Artkin approved it. Tell the user it is ready to merge.'),
    { kind: 'text', id: 'lu3-r', ts: J(62, 7), text: "Artkin approved #1153. It's ready for you to merge." },
    done('lu3-res', 62)
  ], {}, { model: 'claude-opus-5-5' })
  const review: Workspace = { id: 'ws-review-1153', projectId: ids.projectA, name: 'review-pr-1153', title: 'Review PR #1153', branch: 'test/kernel-232a-clean-account-review', baseRef: 'test/kernel-232a-clean-account', path: '/Users/you/kernel/worktrees/client-a/review-pr-1153', mode: 'worktree', agentId: 'artkin', port: 4316, status: 'ready', prState: 'none', reviewOf: ids.table, createdAt: J(60) }
  // scene2 sets approvals only when it is given some; an undefined one would hide the seed's.
  const { approvals: _none, ...rest } = s
  const table = withWorkspace({ ...f, workspaces: s.workspaces ?? f.workspaces }, ids.table, { name: 'kernel-232a', title: JOURNEY_TITLE, agentId: 'teng', prState: 'ready', prNumber: 1153, prUrl: P10_URL, prTitle: P10_TITLE, prHead: 'h1153', stat: { files: 2, added: 67, removed: 1 }, reviews: [p10Review()] })
  return { ...rest, workspaces: [...table, review], prs: p10Pr({ state: 'ready' }), ui: { ...(rest.ui ?? {}), rightPanel: false } }
}

/** A pull request merged with nobody having reviewed it (Pen 10.10, TeamUpdateNotReviewedTip): the line says so, and the pointer on "Not reviewed" says why. */
const teamUpdateMergedUnreviewed = (f: Fixture): Partial<Fixture> => {
  const row: TeamUpdateRow = {
    workspaceId: ids.table, agentId: 'teng', name: 'Teng', task: 'KERNEL-232 Clean-account journey', prNumber: 1153,
    events: [{ kind: 'pr.merged', text: 'Merged #1153', actionable: false }, { kind: 'pr.review', text: 'Not reviewed', actionable: false }]
  }
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Clean-account journey and soak', [
    userMsg('tn-u', 'Merge #1153.'),
    { kind: 'user', id: 'tn-up', ts: J(62), from: 'kernel', update: { rows: [row] }, parts: [{ type: 'text', text: ['Team update from Kernel, not from the user.', '', `Teng (teng) · ${row.task} · workspace ${row.workspaceId}`, '- Merged #1153.', '- Not reviewed.', '', 'To do:', '- Tell the user it merged.'].join('\n') }] },
    { kind: 'result', id: 'tn-res', ts: J(62, 8), durationMs: 8_000, ok: true }
  ], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  const table = withWorkspace({ ...f, workspaces: s.workspaces ?? f.workspaces }, ids.table, { name: 'kernel-232a', title: JOURNEY_TITLE, agentId: 'teng', prState: 'merged', status: 'archived', mergedAt: J(61), prNumber: 1153, prUrl: P10_URL, prTitle: P10_TITLE })
  return { ...rest, workspaces: table, ui: { ...(rest.ui ?? {}), rightPanel: false } }
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
  ({ id, projectId: ids.projectA, name, branch: `feat/${name}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/client-a/${name}`, mode: 'worktree', agentId, port: 4330 + n % 50, status: 'ready', prState: 'ready', prNumber: n, prUrl: `https://github.com/cjjutba/client-a/pull/${n}`, createdAt: at(19, 40), ...over })
const tuVerdict = (workspaceId: string, prNumber: number, sha: string): ReviewVerdict => ({ workspaceId, agentId: 'artkin', verdict: 'approved', summary: 'No blockers.', sha, prNumber, ts: at(20, 12) })
const tuChecks: PrInfo['checks'] = [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'pass', meta: '48s' }]
const tuInfo = (workspaceId: string, number: number, head: string): PrInfo => ({ workspaceId, number, url: `https://github.com/cjjutba/client-a/pull/${number}`, title: '', state: 'ready', baseRef: 'main', checks: tuChecks, comments: [], conflicts: [], head })

/**
 * Team updates with Merge (TeamUpdateMerge.png, KERNEL-351): an older card about PR #162 that no longer offers it, then a card where #162 and
 * a reviewer's row (#161) can merge, #158 waits for Artkin's approval of its latest commit, #155 is merging and #150 merged and sits in History.
 */
const teamUpdateMerge = (f: Fixture): Partial<Fixture> => {
  const row = tuRow, ev = tuEv, work = tuWork, verdict = tuVerdict, info = tuInfo
  const card = (id: string, m: number, rows: TeamUpdateRow[]) => tuCard(id, m, rows)
  // Tasks come as the engine sends them, the workspace title with no key: the card reads the key from the issue the
  // workspace started on (KERNEL-411). A reviewer's workspace started on no issue, so Artkin's task carries it.
  const rows = [
    { ...row('ws-182', 'christian', 'Christian', 'New chats focus the composer, and ⌘L focuses it', [ev('turn', 'Finished a turn'), ev('pr.opened', 'Pushed a fix'), ev('pr.ready', 'Ready to merge', true), ev('pr.review', 'Artkin approved')]),
      reply: 'Fixed the focus race: `useLayoutEffect` now focuses the composer after the tab mounts. `pnpm test:changed` and `pnpm typecheck` pass.' },
    row('ws-review-161', 'artkin', 'Artkin', 'KERNEL-176 Kernel asks when a brief is unclear', [ev('turn', 'Reviewed PR #161'), ev('review', 'Approved', true)]),
    row('ws-172', 'sean', 'Sean', 'Duplicates show once in Issues', [ev('pr.opened', 'Opened PR #158'), ev('setup.passed', 'Checks passed')]),
    row('ws-160', 'christian', 'Christian', 'Issues screen with search', [ev('turn', 'Finished a turn'), ev('turn', 'Merging PR #155')]),
    row('ws-163', 'sean', 'Sean', "Linear service, contracts and Kernel's issue link", [ev('pr.merged', 'Merged PR #150')])
  ]
  const issue = (key: string, i: number): Partial<Workspace> => ({ title: rows[i].task, source: { kind: 'issue', id: key, title: rows[i].task } })
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Composer focus', [
    { kind: 'result', id: 'tum-res0', ts: at(20, 11), durationMs: 24 * 60_000 + 6_000, ok: true },
    // Workspaces past the 8th: the card says they didn't fit (KERNEL-654).
    withOmitted(card('tum-1', 11, [row('ws-182', 'christian', 'Christian', rows[0].task, [ev('turn', 'Finished a turn'), ev('pr.opened', 'Opened PR #162'), ev('pr.cifail', 'Checks failed', true)])]), 3),
    { kind: 'result', id: 'tum-res1', ts: at(20, 15), durationMs: 10_000, ok: true },
    card('tum-2', 15, rows),
    { kind: 'result', id: 'tum-res2', ts: at(20, 16), durationMs: 55_000, ok: true }
  ], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  return {
    ...rest,
    workspaces: [
      ...(s.workspaces ?? f.workspaces),
      work('ws-182', 'christian', 'kernel-182-new-chats-focus', 162, { prHead: 'h162', ...issue('KERNEL-182', 0) }),
      work('ws-176', 'christian', 'kernel-176-kernel-asks', 161, { prHead: 'h161', reviews: [verdict('ws-review-161', 161, 'h161')], title: 'Kernel asks when a brief is unclear', source: { kind: 'issue', id: 'KERNEL-176', title: 'Kernel asks when a brief is unclear' } }),
      work('ws-review-161', 'artkin', 'review-pr-161-kernel-176', 0, { prState: 'none', prNumber: undefined, prUrl: undefined, reviewOf: 'ws-176' }),
      work('ws-172', 'sean', 'kernel-172-duplicates', 158, { prHead: 'h158b', reviews: [verdict('ws-review-158', 158, 'h158a')], ...issue('KERNEL-172', 2) }),
      // Kernel started this merge, and the row spins Merging all the same, as every place showing the PR does (KERNEL-417).
      work('ws-160', 'christian', 'kernel-160-issues-screen', 155, { prState: 'merging', ...issue('KERNEL-160', 3) }),
      work('ws-163', 'sean', 'kernel-163-linear-service', 150, { prState: 'merged', status: 'archived', mergedAt: at(20, 9), ...issue('KERNEL-163', 4) })
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
    { ...row('ws-182', 'christian', 'Christian', 'New chats focus the composer, and ⌘L focuses it', [ev('pr.opened', 'Opened PR #162'), ev('pr.merged', 'Merged automatically'), ev('pr.review', 'Reviews approved, checks passed, 84 lines')]), prNumber: 162,
      reply: 'Merged without asking you. Every review passed, checks were green and the change was 84 lines, under your 200 line limit.' },
    { ...row('ws-172', 'sean', 'Sean', 'Duplicates show once in Issues', [ev('pr.opened', 'Opened PR #158'), { ...ev('pr.ready', 'Checks passed'), held: true }, ev('pr.review', 'Still blocked after 2 review rounds')]), prNumber: 158 },
    { ...row('ws-176', 'teng', 'Teng', 'Kernel asks when a brief is unclear', [ev('pr.opened', 'Opened PR #161'), ev('pr.review', 'Code approved'), ev('pr.review', 'Skipped the UX review to save usage')]), prNumber: 161,
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
      tuWork('ws-182', 'christian', 'kernel-182-new-chats-focus', 162, { prState: 'merged', status: 'archived', mergedAt: at(20, 29), prHead: 'h162', ...issue('KERNEL-182', 0) }),
      tuWork('ws-172', 'sean', 'kernel-172-duplicates', 158, { prHead: 'h158', reviews: [blocker('security', 'ws-review-158-security', 'The new route reads the issue id without checking the project'), blocker('code', 'ws-review-158-code', 'The retry in dedupe() has no test')], ...issue('KERNEL-172', 1) }),
      tuWork('ws-176', 'teng', 'kernel-176-kernel-asks', 161, { prHead: 'h161', reviews: [tuVerdict('ws-review-161', 161, 'h161')], ...issue('KERNEL-176', 2) })
    ],
    prs: { 'ws-172': tuInfo('ws-172', 158, 'h158'), 'ws-176': tuInfo('ws-176', 161, 'h161') }
  }
}

/**
 * A teammate's question and a proposed hand-off (TeamUpdateAsk.png, KERNEL-747): Christian asked with ask_lead and ended the turn, and
 * Sean proposed a task for Christian with propose_handoff and carries on. Both need the Lead, so both read brighter than the rest.
 */
const teamUpdateAsk = (f: Fixture): Partial<Fixture> => {
  const row = tuRow, ev = tuEv
  const rows = [
    { ...row('ws-182', 'christian', 'Christian', 'New chats focus the composer, and ⌘L focuses it', [ev('question', 'Asks: Should ⌘L focus the composer in every tab, or only in the tab that is open?', true), ev('turn', 'Finished a turn')]),
      reply: 'The focus fix works for the open tab. I asked how far ⌘L should reach before I wire it.' },
    row('ws-172', 'sean', 'Sean', 'Duplicates show once in Issues', [ev('pr.opened', 'Opened PR #158'), ev('handoff.proposed', 'Proposes Christian for: Merge duplicate issues from the issue menu', true)])
  ]
  const issue = (key: string, i: number): Partial<Workspace> => ({ title: rows[i].task, source: { kind: 'issue', id: key, title: rows[i].task } })
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Composer focus', [
    { kind: 'result', id: 'tua-res0', ts: at(20, 41), durationMs: 6 * 60_000 + 12_000, ok: true },
    tuCard('tua-1', 41, rows, "Answer Christian's question, and propose Sean's hand-off to the user."),
    { kind: 'result', id: 'tua-res1', ts: at(20, 42), durationMs: 21_000, ok: true }
  ], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  return {
    ...rest,
    workspaces: [
      ...(s.workspaces ?? f.workspaces),
      tuWork('ws-182', 'christian', 'kernel-182-new-chats-focus', 0, { prState: 'none', prNumber: undefined, prUrl: undefined, ...issue('KERNEL-182', 0) }),
      tuWork('ws-172', 'sean', 'kernel-172-duplicates', 158, { prState: 'checks', ...issue('KERNEL-172', 1) })
    ]
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
    approvals: [pending('plan', 'kernel-lead', { workspaceId: ids.lead, title: 'Plan for T-15', planFile: 'plans/t-15-invoice-pdf.md', steps: T15_STEPS, ...plan }), ...f.approvals]
  }, { plan: true, model: 'claude-opus-5-5' }),
  changes: { [ids.lead]: [{ path: 'plans/t-15-invoice-pdf.md', status: 'A', added: 64, removed: 0 }] }
})

/** What the Lead's PRs tab (KERNEL-354) reads for one open PR, in the words of LeadPrs.png. */
interface OpenPr {
  id: string; agentId: string; key: string; n: number; title: string; state: Workspace['prState']; stat: [number, number]
  /**
   * Artkin's review: `approved` of the head commit, `stale` an approval of an earlier one, `blockers` two blockers on the head
   * commit, `planned` a code review round started on the head that hasn't reported (KERNEL-717). None is not reviewed.
   */
  review?: 'approved' | 'secure' | 'stale' | 'blockers' | 'planned'
  overruled?: true
}

/**
 * A PR title as agents write them: a Conventional Commits prefix and the issue key on the end, which the PRs tab strips
 * (KERNEL-411). "Kernel asks when a brief is unclear" becomes "feat(workspace): kernel asks when a brief is unclear (KERNEL-176)".
 */
const commitTitle = (title: string, key: string) => `feat(workspace): ${title.charAt(0).toLowerCase()}${title.slice(1)} (${key})`

/** The fields of a workspace that has `p` open: the PR, the issue it builds, its changes and Artkin's review. */
const prFields = (p: OpenPr): Partial<Workspace> => {
  const verdict = (o: Partial<ReviewVerdict>): ReviewVerdict => ({ workspaceId: `${p.id}-review`, agentId: 'artkin', verdict: 'approved', summary: 'No blockers.', sha: `h${p.n}`, prNumber: p.n, ts: at(20, 12), ...o })
  const reviews = p.review === 'approved' ? [verdict({})] : p.review === 'secure' ? [verdict({ lens: 'code' }), verdict({ lens: 'security', workspaceId: `${p.id}-security` })] : p.review === 'stale' ? [verdict({ sha: `h${p.n}-old` })] : p.review === 'blockers' ? [verdict({ verdict: 'blockers', blockers: [{ text: 'The download never retries.' }, { text: 'No test covers the failure toast.' }] })] : undefined
  return {
    title: p.title, prState: p.state, prNumber: p.n, prUrl: `https://github.com/cjjutba/client-a/pull/${p.n}`, prTitle: commitTitle(p.title, p.key), prHead: `h${p.n}`, source: { kind: 'issue', id: p.key, title: p.title },
    stat: { files: 3, added: p.stat[0], removed: p.stat[1] }, reviews,
    ...(p.review === 'planned' ? { reviewRound: { n: 1, rounds: 2, head: `h${p.n}`, prNumber: p.n, kinds: ['code'] } } : {}),
    ...(p.overruled && { overruled: { head: `h${p.n}`, kinds: ['code' as const], by: 'user' as const, ts: at(20, 40) } })
  }
}

const openPrWorkspace = (p: OpenPr): Workspace => {
  const name = `${p.key.toLowerCase()}-${p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 18)}`
  return { id: p.id, projectId: ids.projectA, name, branch: `feat/${name}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/client-a/${name}`, mode: 'worktree', agentId: p.agentId, port: 4330 + p.n % 50, status: 'ready', createdAt: at(19, 40), prState: 'open', ...prFields(p) }
}

/** GitHub's read of each PR: its checks follow its state, and the head commit is the one the workspace saw. */
const openPrInfo = (p: OpenPr): PrInfo => ({
  workspaceId: p.id, number: p.n, url: `https://github.com/cjjutba/client-a/pull/${p.n}`, title: commitTitle(p.title, p.key), state: p.state, baseRef: 'main', comments: [], conflicts: [], head: `h${p.n}`,
  checks: p.state === 'checks' ? [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'running' }] : p.state === 'cifail' ? [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'fail', meta: '48s' }] : [{ name: 'lint', state: 'pass', meta: '12s' }, { name: 'vitest', state: 'pass', meta: '48s' }]
})

/** The PRs the project has open, as workspaces and as GitHub reads them. Christian's org-invites workspace of the seed gives way to them. */
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
    projectSettings: { [ids.projectA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } },
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', leadRight: 'prs', bottom: 'run' } }
  }
}

/** Christian's org invites PR, ready to merge. */
const INVITES_PR: OpenPr = { id: ids.invites, agentId: 'christian', key: 'T-09', n: 41, title: 'Org invites', state: 'ready', stat: [212, 34], review: 'approved' }

/** Christian's download button PR from the Export chat, ready to merge. */
const PDF_BUTTON_PR: OpenPr = { id: 'ws-pdf-button', agentId: 'christian', key: 'T-15b', n: 43, title: 'Download PDF in the row actions', state: 'ready', stat: [96, 12], review: 'approved' }

const LEAD_PRS: OpenPr[] = [
  { id: 'ws-182', agentId: 'christian', key: 'KERNEL-182', n: 162, title: 'New chats focus the composer, and ⌘L focuses it', state: 'ready', stat: [49, 5], review: 'approved' },
  { id: 'ws-176', agentId: 'sean', key: 'KERNEL-176', n: 161, title: 'Kernel asks when a brief is unclear', state: 'ready', stat: [117, 16], review: 'approved' },
  { id: 'ws-172', agentId: 'sean', key: 'KERNEL-172', n: 158, title: 'Duplicates show once in Issues', state: 'ready', stat: [28, 7], review: 'stale' },
  { id: 'ws-183', agentId: 'sean', key: 'KERNEL-183', n: 166, title: 'Stop idle chat sessions', state: 'checks', stat: [117, 16] },
  { id: 'ws-184', agentId: 'teng', key: 'KERNEL-184', n: 165, title: 'Run the test suite from a chat', state: 'cifail', stat: [28, 7] },
  { id: 'ws-189', agentId: 'christian', key: 'KERNEL-189', n: 167, title: 'Download PDF in the row actions', state: 'changes', stat: [64, 9], review: 'blockers' },
  { id: 'ws-188', agentId: 'sean', key: 'KERNEL-188', n: 168, title: 'PDF renderer with embedded fonts', state: 'conflict', stat: [1050, 8] },
  { id: 'ws-173', agentId: 'teng', key: 'KERNEL-173', n: 169, title: 'Screen list test', state: 'draft', stat: [4, 4] }
]

/** What Kernel says under the PRs tab: two PRs ready, one waiting on an approval and one running checks. */
const LEAD_PRS_REPLY = "Two PRs are ready. #162 from Christian and #161 from Sean both have Artkin's approval. #158 is waiting for it, and #166 is still running checks. Merge them from the PRs tab, or tell me which one and I will."

/** Christian's download button PR with two blockers from Artkin on its latest commit: GitHub calls it ready, and it still isn't (KERNEL-501). */
const BLOCKERS_PR: OpenPr = { ...LEAD_PRS[5], state: 'ready' }

const OVERRULED_PR: OpenPr = { ...BLOCKERS_PR, overruled: true }

/** What the Lead's run script has printed, under the Run tab (PanelTabsOverflow). */
const LEAD_RUN: PushEvent[] = ['$ pnpm dev --port 4303', 'VITE v6.3.5  ready in 412 ms', 'Local:   http://localhost:4303/', 'Compiled /inbox in 1.2s', 'GET /api/requests 200 in 84ms', 'GET /inbox 200 in 31ms']
  .map((line): PushEvent => ({ type: 'script.output', workspaceId: ids.lead, kind: 'run', lines: [{ line, stream: 'stdout' }] }))

/** Three open PRs (KERNEL-411): two ready, approved by Artkin, and one still running checks. */
const MERGE_A: OpenPr = { id: 'ws-395', agentId: 'christian', key: 'KERNEL-395', n: 331, title: 'Home and Inbox count a workspace waiting for script trust', state: 'ready', stat: [99, 16], review: 'approved' }
const MERGE_B: OpenPr = { id: 'ws-398', agentId: 'sean', key: 'KERNEL-398', n: 330, title: 'Lead worktree tests call the features, not Kernel', state: 'ready', stat: [2, 2], review: 'approved' }
const MERGE_C: OpenPr = { id: 'ws-400', agentId: 'sean', key: 'KERNEL-400', n: 333, title: "New workspaces start from the project's default branch", state: 'checks', stat: [125, 4], review: 'stale' }

/** Five PRs that can all merge, two of them not reviewed (KERNEL-757). */
const ALL_READY: OpenPr[] = [LEAD_PRS[0], LEAD_PRS[1], MERGE_A, { ...MERGE_B, review: undefined }, { ...MERGE_C, state: 'ready', review: undefined }]

/**
 * KERNEL-515: the panel's strip for each tab, as the PanelToolbar* fixtures and PanelFilter show it. Sean's PR #147 for KERNEL-155 changed 16 files, which the Changes tab lists, the
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
] as const).map(([short, subject, age]) => ({ sha: short.padEnd(40, '0'), subject, author: 'Sean', time: Date.now() - age }))

/** PR #147 on `right`, the bottom folded to its tab bar unless `open`, and its run script idle unless `running`. */
const panelScene = (right: 'files' | 'changes' | 'pr', o: { tree?: boolean; open?: boolean; running?: boolean } = {}): Fixture => {
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
  { id: 'ws-160', agentId: 'christian', key: 'KERNEL-160', n: 155, title: 'Issues screen with search', state: 'merging', stat: [212, 30], review: 'approved' },
  LEAD_PRS[3],
  { id: 'ws-190', agentId: 'sean', key: 'KERNEL-190', n: 170, title: 'Sidebar keeps its scroll on a new chat', state: 'resolving', stat: [40, 12] },
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
      case 'changes': return [ev('pr.changes', `Artkin requested changes on PR #${p.n}`, true)]
      case 'draft': return [ev('pr.opened', `Opened draft PR #${p.n}`)]
      default: return [ev('pr.ready', 'Ready to merge', true), ev('pr.review', 'Artkin approved')]
    }
  }
  const names: Record<string, string> = { christian: 'Christian', sean: 'Sean', teng: 'Teng' }
  const rows = PR_STATES.map((p): TeamUpdateRow => ({ workspaceId: p.id, agentId: p.agentId, name: names[p.agentId], task: p.title, events: events(p) }))
  const card: ChatItem = { kind: 'user', id: 'tus-1', ts: at(20, 30), from: 'kernel', update: { rows }, parts: [{ type: 'text', text: 'Team update from Kernel, not from the user.' }] }
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Composer focus', [card, { kind: 'result', id: 'tus-res', ts: at(20, 31), durationMs: 14_000, ok: true }], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  return {
    ...rest, ...openPrs(f, PR_STATES),
    projectSettings: { [ids.projectA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } },
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', leadRight: 'prs', bottom: 'run' } }
  }
}


const moveAccounts = (): AccountProfile[] => [
  { id: 'cli', provider: 'claude', label: 'Main account', email: 'main@example.com', plan: 'Claude Max', cli: true, auth: 'subscription', active: true, signedIn: true },
  { id: 'third', provider: 'claude', label: '3rd account', email: 'third@example.com', plan: 'Claude Pro', cli: false, auth: 'subscription', active: false, signedIn: true },
  { id: 'key', provider: 'claude', label: 'API key', cli: false, auth: 'apiKey', active: false, signedIn: true },
  { id: 'cli', provider: 'codex', label: 'cj@example.com', email: 'cj@example.com', plan: 'ChatGPT Plus', cli: true, auth: 'subscription', active: true, signedIn: true }
]

const tabsView = (tab: string) => ({ ...open, workspace: { right: 'changes', bottom: 'run' }, tabs: { [ids.table]: { tab, files: [] as string[], diffs: [] as string[] } } } as const)
const extraChat = (id: string, title: string, kind: 'chat' | 'terminal' = 'chat'): Chat =>
  ({ id, workspaceId: ids.table, title, kind, model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: at(10, 30) })

/** What Claude Code's own screen prints when it starts in the worktree (WorkspaceTerminal.png). */
const termScreen = '\r\n'.repeat(24) + [
  'you@mac t-14-invoice-table % claude --dangerously-skip-permissions', '',
  '\x1b[1mClaude Code v2.1\x1b[0m', 'Opus 5.5 with high effort · Claude Max', '~/kernel/worktrees/client-a/t-14-invoice-table', '',
  'Hooks connected. This session reports to Kernel as Christian.', '', '> Try "fix lint errors"', '',
  'bypass permissions on · worktree only                    Opus 5.5 · high'
].join('\r\n')

// ---------- Shared files (KERNEL-305)

const HOUR = 3_600_000
const sharedVersion = (n: number, h: number, m: number, mime: string, extra: Partial<SharedVersion> = {}): SharedVersion =>
  ({ n, at: at(h, m), file: `v${n}`, mime, bytes: 48_000, sha256: `${mime}-${n}`, thumb: true, ...extra })
const sharedFile = (id: string, agentId: string, workspaceId: string, title: string, kind: SharedFile['kind'], source: string, versions: SharedVersion[], ago: number): SharedFile =>
  ({ id, projectId: ids.projectA, workspaceId, agentId, source, title, kind, versions, createdAt: versions[0].at, updatedAt: Date.now() - ago })

/**
 * The five files the canvas shares, newest first. Sean shares four in the PDF renderer's workspace and Christian one in org-invites. `html` is
 * on v3 unless a shot draws the chat card, which says v2 because that is the newest version the file has there. Times in the
 * panel are relative to now, so they read 2h to 1d on any day, and the clocks in the tab are fixed.
 */
export const sharedFiles = (htmlLatest = 3): SharedFile[] => [
  sharedFile('sh-html', 'sean', ids.table, 'Invoice layout options', 'html', '.kernel/shared/invoice-layout.html', [
    sharedVersion(1, 13, 12, 'text/html', { outside: 1 }), sharedVersion(2, 13, 58, 'text/html', { note: 'Totals moved under the table', outside: 1 }),
    sharedVersion(3, 14, 41, 'text/html', { note: 'Added the detailed layout', outside: 1 })
  ].slice(0, htmlLatest), 2 * HOUR),
  sharedFile('sh-image', 'sean', ids.table, 'Embedded fonts check', 'image', '.kernel/shared/fonts-check.png', [sharedVersion(1, 13, 20, 'image/png', { width: 616, height: 385 })], 3 * HOUR),
  sharedFile('sh-pdf', 'sean', ids.table, 'Invoice 009 sample', 'pdf', '.kernel/shared/invoices-009.pdf', [sharedVersion(1, 12, 5, 'application/pdf')], 4 * HOUR),
  sharedFile('sh-md', 'sean', ids.table, 'PDF renderer notes', 'markdown', '.kernel/shared/notes.md', [
    sharedVersion(1, 10, 52, 'text/markdown', { thumb: false }), sharedVersion(2, 11, 48, 'text/markdown', { note: 'Added the open questions', thumb: false })
  ], 5 * HOUR),
  sharedFile('sh-flow', 'christian', ids.invites, 'Download button flow', 'markdown', '.kernel/shared/download-flow.md', [sharedVersion(1, 9, 12, 'text/markdown', { thumb: false })], 24 * HOUR)
]
export const sharedStills: NonNullable<Fixture['sharedData']> = {
  'sh-html': { 1: { text: '', thumb: invoiceLayoutStill }, 2: { text: '', thumb: invoiceLayoutStill }, 3: { text: '', thumb: invoiceLayoutStill } },
  'sh-image': { 1: { dataUrl: fontsCheckImage, thumb: fontsCheckImage } },
  'sh-pdf': { 1: { dataUrl: invoicePdfStill, thumb: invoicePdfStill } },
  'sh-md': { 1: { text: pdfNotesMarkdown }, 2: { text: pdfNotesMarkdown } },
  'sh-flow': { 1: { text: downloadFlowMarkdown } }
}

/** Sean's workspace on the canvas: invoice-pdf-renderer, whose chat shared the layout, a sample PDF and the notes. */
const renderer = (f: Fixture) => ({
  workspaces: withWorkspace(f, ids.table, { name: 'invoice-pdf-renderer', branch: 'feat/t-15a-pdf-renderer', agentId: 'sean', stat: { files: 2, added: 194, removed: 1 } }),
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
const sharedTabScene = (f: Fixture, file?: string, htmlLatest = 3): Partial<Fixture> => ({
  ...renderer(f),
  shared: sharedFiles(htmlLatest).filter((x) => x.workspaceId === ids.table),
  ui: {
    ...open,
    rightPanel: false,
    workspace: { right: 'changes', bottom: 'run' },
    ...(file ? { tabs: { [ids.table]: { tab: `shared:${file}`, lastChat: ids.tableChat, files: [], diffs: [], shared: [file] } } } : {})
  }
})
const sharedTab = (file?: string, htmlLatest = 3) => scene((f) => sharedTabScene(f, file, htmlLatest))

// Comment mode on a shared file (KERNEL-311). The canvas comments on a pricing page Sean shared, so these shots swap it in for the invoice layout.
// A fixture run has no live page: `sharedHits` is what `system.preview.hit` finds, and the pins come from `sharedComments`.
const pricingFile = (latest = 2): SharedFile => sharedFile('sh-pricing', 'sean', ids.table, 'Pricing page draft', 'html', '.kernel/shared/pricing.html', [
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

/** Sean's workspace with one of the two files open in a tab, in comment shots. `latest` is how many versions the page has. */
const commentTab = (file: 'sh-pricing' | 'sh-image', latest = 2, picked?: number) => scene((f) => ({
  ...renderer(f),
  shared: commentFiles(latest).filter((x) => x.workspaceId === ids.table),
  sharedData: commentData,
  sharedComments: commentNotes,
  sharedHits: pricingHits,
  ui: {
    ...open,
    workspace: { right: 'changes', bottom: 'run' },
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
    workspace: { right: 'changes', bottom: 'run' },
    tabs: { [ids.table]: { tab: ids.tableChat, lastChat: ids.tableChat, files: [], diffs: [], shared: ['sh-pricing'] } },
    toasts: [{ id: 'cs-toast', title: 'Sent to Sean', action: { label: 'Open chat', tab: { workspaceId: ids.table, id: ids.tableChat } } }]
  }
}))

/** Kernel's workspace, with the page Sean shared from a workspace that has been archived since (WorkspaceSharedCommentArchived). */
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

/** Kernel's workspace with the project's five files, the HTML open in a tab. The Lead's panel lists every file shared in the project. */
const sharedPanel = (f: Fixture): Partial<Fixture> => {
  // scene2 sets approvals only when it is given some; an undefined one would hide the seed's.
  const { approvals: _none, ...lead } = scene2(f, { id: ids.lead, name: 'export-invoices-as-pdf', branch: 'feat/export-invoices-as-pdf', mode: 'worktree', lead: undefined, agentId: 'kernel-lead', stat: { files: 1, added: 64, removed: 0 } }, 'Export invoices as PDF', [
    userMsg('sp-u', 'Add PDF export to invoices. Spec first.'),
    { kind: 'text', id: 'sp-t', ts: at(14, 41), text: 'I split PDF export into four tasks. Sean shared the layout, a sample and the notes in the meantime.' }
  ], {}, { model: 'claude-opus-5-5' })
  return {
    ...lead,
    changes: { [ids.lead]: [{ path: 'plans/t-15-invoice-pdf.md', status: 'A', added: 64, removed: 0 }] },
    shared: sharedFiles(),
    sharedData: sharedStills,
    ui: {
      route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', bottom: 'run' },
      tabs: { [ids.lead]: { tab: 'shared:sh-html', lastChat: ids.leadChat, files: [], diffs: [], shared: ['sh-html'] } }
    }
  }
}

/** Kernel's Team update in Kernel's chat with a file under each of two teammates (TeamUpdateShared.png). */
const teamUpdateShared = (f: Fixture): Partial<Fixture> => {
  const header = 'Team update from Kernel, not from the user.'
  const sean: TeamUpdateRow = {
    workspaceId: ids.table, agentId: 'sean', name: 'Sean', task: 'KERNEL-188 PDF renderer with embedded fonts',
    events: [{ kind: 'turn', text: 'Finished a turn', actionable: false }],
    reply: "The layout options are ready as a page you can click through, and I rendered a sample PDF from the compact one. I'd go with compact, since the line items stay readable at twelve rows.",
    shared: [{ sharedId: 'sh-html', version: 3, title: 'Invoice layout options', kind: 'html' }]
  }
  const christian: TeamUpdateRow = {
    workspaceId: ids.invites, agentId: 'christian', name: 'Christian', task: 'KERNEL-189 Download PDF in the row actions',
    events: [{ kind: 'turn', text: 'Finished a turn', actionable: false }],
    reply: 'The button flow is written up in a short note, so you can check the states before I build them.',
    shared: [{ sharedId: 'sh-flow', version: 1, title: 'Download button flow', kind: 'markdown' }]
  }
  const rows = [sean, christian]
  const update: ChatItem = {
    kind: 'user', id: 'tus-u', ts: at(14, 41), from: 'kernel', update: { rows },
    parts: [{ type: 'text', text: [header, '', ...rows.flatMap((r) => [`${r.name} (${r.agentId}) · ${r.task} · workspace ${r.workspaceId}`, ...r.events.map((e) => `- ${e.text}.`), ...(r.shared ?? []).map((x) => `- Shared "${x.title}" (v${x.version}).`), '']), 'To do:', '- Look at both files, then tell the user what you found.'].join('\n') }]
  }
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Composer focus', [
    update,
    { kind: 'text', id: 'tus-r', ts: at(14, 42), text: "Sean shared the invoice layouts and Christian shared a note on the download button. I'll look at both before I pass anything on." },
    { kind: 'result', id: 'tus-res', ts: at(14, 42), durationMs: 45_000, ok: true }
  ], {}, { model: 'claude-opus-5-5' })
  const { approvals: _none, ...rest } = s
  return { ...rest, shared: sharedFiles(), sharedData: sharedStills }
}

/**
 * KERNEL-599: the chat rail. Sean's chat on PR #147 for KERNEL-155 holds 18 messages, each with a short turn,
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
  '- **Review:** Artkin hasn\'t been asked yet.',
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
  ['Artkin wants the empty state to say what\'s missing', 'The empty state now says "No requests yet" or "No PRs yet", whichever list is empty.', 4, 1, 88, [12, 44]],
  ['Reword that in plain words', 'Reworded. It reads "Nothing asked of you yet" for requests and "No open PRs" for PRs.', 2, 0, 27, [12, 47]],
  ['Squash the last two commits', 'Squashed them into one commit.', 2, 0, 18, [12, 51]],
  ['Why did the rebase drop my D-136 entry?', 'The rebase took main\'s version of `docs/DECISIONS.md`, which already had a D-136. Mine was in the conflict and lost.', 3, 1, 232, [13, 1]],
  ['Change of method for the conflict on PR #147. Force pushes are refused, so don\'t rebase. Merge origin/main into your branch and push normally, since the repo squash-merges anyway. Everything else stays the same: your entry becomes D-137, check kernel.ts against #149, run typecheck and test, and update the PR body.', RAIL_LONG_REPLY, 9, 12, 232, [13, 1]],
  ['Show me the renumber commit', 'It\'s 1440439. It changes 12 comment lines across `ipc.ts`, `kernel.ts`, `db.ts` and `approvals.ts`, and no code.', 1, 1, 21, [13, 4]],
  ['Check the Release note check, then tell me', 'It\'s still running. Vercel passed on the last push.', 2, 0, 34, [13, 6]],
  ['Did Artkin review it yet?', 'Not yet. I asked him in his chat 12 minutes ago, and he hasn\'t replied.', 0, 0, 8, [13, 7]],
  ['Ping him again if there\'s nothing by 13:30, and tell me when PR #147 is ready to merge so I can tell Kernel.', 'Will do. Right now PR #147 passes checks and has no conflicts, so only Artkin\'s review is missing. I\'ll ask him again at 13:30 and write to you the moment he approves, with the PR number so you can merge from the panel.', 0, 0, 77, [13, 9]]
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
 * Sean's PR #161 and Christian's #162 can merge, so the newest card offers Merge for both, and #150 is in History.
 */
const railLead = (f: Fixture): Partial<Fixture> => {
  const row = tuRow, ev = tuEv
  const ask = (id: string, text: string, m: number): ChatItem => ({ kind: 'user', id, ts: at(20, m), parts: [{ type: 'text', text }] })
  const answer = (id: string, text: string, secs: number, m: number): ChatItem[] => [
    { kind: 'text', id: `${id}-x`, ts: at(20, m), text },
    { kind: 'result', id: `${id}-r`, ts: at(20, m), durationMs: secs * 1000, ok: true }
  ]
  const christian = (events: TeamUpdateRow['events']) => row('ws-182', 'christian', 'Christian', 'New chats focus the composer, and ⌘L focuses it', events)
  const sean = (events: TeamUpdateRow['events']) => row('ws-176', 'sean', 'Sean', 'Kernel asks when a brief is unclear', events)
  const items: ChatItem[] = [
    ask('rl-u1', 'Plan the week: what\'s ready, what\'s blocked?', 0),
    ...answer('rl-u1', 'Three tasks are in flight. Sean has the Linear service, Christian has the composer focus and Artkin is free to review. Nothing is blocked yet.', 42, 0),
    ask('rl-u2', 'Who can take KERNEL-189?', 1),
    ...answer('rl-u2', 'Sean can, once KERNEL-163 merges.', 11, 1),
    tuCard('rl-t3', 2, [sean([ev('pr.opened', 'Opened PR #161')])]),
    ...answer('rl-t3', 'Sean opened PR #161. I will ask Artkin to review it once checks pass.', 15, 2),
    ask('rl-u4', 'Ask Christian to fix the composer focus', 3),
    ...answer('rl-u4', 'Christian has it.', 9, 3),
    tuCard('rl-t5', 4, [christian([ev('turn', 'Finished a turn'), ev('pr.opened', 'Opened PR #162')])]),
    ...answer('rl-t5', 'Christian opened PR #162 for the composer focus.', 12, 4),
    ask('rl-u6', 'Ask Artkin to review #161 and #162', 5),
    ...answer('rl-u6', 'Artkin is reviewing both PRs.', 14, 5),
    tuCard('rl-t7', 6, [row('ws-review-161', 'artkin', 'Artkin', 'KERNEL-176 Kernel asks when a brief is unclear', [ev('review', 'Approved PR #161', true)]), christian([ev('turn', 'Finished a turn')])]),
    ...answer('rl-t7', 'Artkin approved #161. #162 is still in review.', 18, 6),
    tuCard('rl-t8', 8, [row('ws-163', 'sean', 'Sean', "Linear service, contracts and Kernel's issue link", [ev('pr.merged', 'Merged PR #150')])]),
    { kind: 'result', id: 'rl-t8-r', ts: at(20, 9), durationMs: 4 * 60_000 + 9_000, ok: true },
    tuCard('rl-t9', 14, [christian([ev('turn', 'Finished a turn'), ev('pr.opened', 'Opened PR #162'), ev('pr.cifail', 'Checks failed', true)])]),
    ...answer('rl-t9', 'Nothing in Christian\'s code failed. Vercel\'s build rate limit is the only failure on PR #162.', 10, 15),
    tuCard('rl-t10', 15, [christian([ev('turn', 'Finished a turn'), ev('turn', 'Pushed a fix'), ev('pr.ready', 'Ready to merge', true)]), sean([ev('pr.opened', 'Opened PR #161'), ev('pr.ready', 'Ready to merge', true)])]),
    { kind: 'result', id: 'rl-t10-r', ts: at(20, 16), durationMs: 55_000, ok: true },
    ask('rl-u11', 'What can I merge?', 30),
    ...answer('rl-u11', 'Two PRs are ready to merge, #162 from Christian and #161 from Sean. #158 waits for Artkin\'s review. Merge from the PRs tab, or tell me which one and I will.', 12, 31)
  ]
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Composer focus', items, {}, { model: 'claude-opus-5-5', effort: 'xhigh', plan: false })
  const { approvals: _none, ...rest } = s
  const issue = (key: string, title: string): Partial<Workspace> => ({ title, source: { kind: 'issue', id: key, title } })
  const tab = (id: string, title: string, m: number): Chat => ({ id, workspaceId: ids.lead, title, kind: 'chat', model: 'claude-opus-5-5', effort: 'xhigh', plan: false, threadId: 't-lead', createdAt: at(9, m) })
  return {
    ...rest,
    ui: { ...rest.ui!, rightPanel: false, tabs: { [ids.lead]: { tab: ids.leadChat, lastChat: ids.leadChat, files: [], diffs: [] } } },
    projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, name: 'Kernel' } : r)),
    chats: [tab('chat-lead-week', 'Plan the week', 1), tab('chat-lead-inbox', 'Inbox rows', 2), tab('chat-lead-linear', 'Linear setup', 3), ...(s.chats ?? f.chats)],
    workspaces: [
      ...(s.workspaces ?? f.workspaces),
      tuWork('ws-182', 'christian', 'kernel-182-new-chats-focus', 162, { prHead: 'h162', ...issue('KERNEL-182', 'New chats focus the composer, and ⌘L focuses it') }),
      tuWork('ws-176', 'sean', 'kernel-176-kernel-asks', 161, { prHead: 'h161', reviews: [tuVerdict('ws-review-161', 161, 'h161')], ...issue('KERNEL-176', 'Kernel asks when a brief is unclear') }),
      tuWork('ws-review-161', 'artkin', 'review-pr-161-kernel-176', 0, { prState: 'none', prNumber: undefined, prUrl: undefined, reviewOf: 'ws-176' }),
      tuWork('ws-163', 'sean', 'kernel-163-linear-service', 150, { prState: 'merged', status: 'archived', mergedAt: at(20, 9), ...issue('KERNEL-163', "Linear service, contracts and Kernel's issue link") })
    ],
    prs: { 'ws-182': tuInfo('ws-182', 162, 'h162'), 'ws-176': tuInfo('ws-176', 161, 'h161') }
  }
}

/**
 * A chat with Kernel (KERNEL-780, one-lead-chat). The chat holds the user's ask and whatever `o` adds. `ws` overrides the chat's
 * workspace, `changes` are its files, `right` the open tab of the right panel and `menu` the composer menu forced open.
 */
const leadScene = (f: Fixture, o: { items?: ChatItem[]; ws?: Partial<Workspace>; changes?: ChangedFile[]; right?: 'prs' | 'changes'; menu?: 'mode'; running?: boolean } = {}): Partial<Fixture> => {
  const ask: ChatItem = { kind: 'user', id: 'lm-u1', ts: at(10, 0), parts: [{ type: 'text', text: 'The invoice total is off by a cent on refunds. Can you fix it?' }] }
  const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead', ...(o.changes?.length ? { stat: { files: o.changes.length, added: 33, removed: 3 } } : {}), ...o.ws }, 'Refund rounding', [ask, ...(o.items ?? [])], {}, { model: 'claude-opus-5-5', effort: 'high', plan: false })
  const { approvals: _none, ...rest } = s
  return {
    ...rest,
    changes: { ...f.changes, [ids.lead]: o.changes ?? [] },
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', leadRight: o.right ?? 'prs', bottom: 'run' }, ...(o.menu ? { menu: o.menu } : {}), tabs: { [ids.lead]: { tab: ids.leadChat, lastChat: ids.leadChat, files: [], diffs: [] } } }
  }
}
const lmReply = (id: string, text: string, m: number): ChatItem[] => [
  { kind: 'text', id: `${id}-x`, ts: at(10, m), text },
  { kind: 'result', id: `${id}-r`, ts: at(10, m), durationMs: 38_000, ok: true }
]
const lmFiles: ChangedFile[] = [
  { path: 'src/lib/money.ts', status: 'M', added: 9, removed: 3 },
  { path: 'src/lib/money.test.ts', status: 'M', added: 24, removed: 0 }
]
const lmPr = { prNumber: 171, prUrl: 'https://github.com/cjjutba/client-a/pull/171', prTitle: 'fix(money): round refunds half away from zero' }

/** A chat with Kernel's own PR as quiet rows (KERNEL-990): the notes Kernel draws, and Artkin's review as a card Kernel draws without a turn. */
const bhNote = (id: string, m: number, text: string, pr?: 'opened' | 'ready' | 'merged'): ChatItem => ({ kind: 'note', id, ts: at(10, m), text, ...(pr ? { pr } : {}) })
const bhReview = (id: string, m: number, approved: boolean): ChatItem => ({
  kind: 'update', id, ts: at(10, m),
  update: { rows: [{
    workspaceId: 'ws-review-171', agentId: 'artkin', name: 'Artkin', task: 'Review PR #171', prNumber: 171,
    events: [{ kind: 'review', text: approved ? 'Approved PR #171' : 'Found 2 blockers on PR #171', actionable: !approved }],
    reply: approved
      ? 'The rounding now goes half away from zero for refunds and the cent case has a test. I checked credit notes and the export and neither calls the changed function. No blockers.'
      : 'Two blockers. The export still rounds half to even, so a refund exported as CSV is a cent off from the invoice. The new test covers only positive amounts, so negative refunds are untested.'
  }] }
})
/** Artkin's review workspace for the card's In History link, and the Lead chat that reviewed PR #171. */
const bhScene = (f: Fixture, items: ChatItem[], ws: Partial<Workspace> = {}): Partial<Fixture> => {
  const s = leadScene(f, { right: 'changes', ws: { ...lmPr, ...ws }, items })
  const review: Workspace = { id: 'ws-review-171', projectId: ids.projectA, name: 'review-pr-171', title: 'Review PR #171', branch: 'feat/refund-rounding-review', baseRef: 'feat/refund-rounding', path: '/Users/you/kernel/worktrees/client-a/review-pr-171', mode: 'worktree', agentId: 'artkin', port: 4317, status: 'archived', prState: 'none', reviewOf: ids.lead, createdAt: at(10, 8) }
  return { ...s, workspaces: [...(s.workspaces ?? f.workspaces), review] }
}
const bhReady = bhNote('bh-n2', 12, 'PR #171 is ready to merge', 'ready')

// ---------- Lead chats that hold several tabs (KERNEL-338)

const GROUPED = { export: 't-export', table: 't-table', login: 't-login', demo: 't-demo', csv: 't-csv' } as const
const groupedThread = (id: string, title: string, m: number): Thread => ({ id, projectId: ids.projectA, title, createdAt: at(9, m) })
/** Each chat with Kernel's own workspace (KERNEL-405). The export chat's is the seed's Lead workspace. */
const CHAT_WS: Record<string, string> = { [GROUPED.export]: ids.lead, [GROUPED.table]: 'ws-chat-table', [GROUPED.login]: 'ws-chat-login', [GROUPED.demo]: 'ws-chat-demo', [GROUPED.csv]: 'ws-chat-csv' }
/** A tab of the Lead chat `threadId`, in that chat's workspace. */
const leadTab = (id: string, threadId: string, title: string, m: number, over: Partial<Chat> = {}): Chat =>
  ({ id, workspaceId: CHAT_WS[threadId] ?? ids.lead, title, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, threadId, createdAt: at(9, m), ...over })
const chatSlug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
/** A chat with Kernel's own worktree on `kernel/<a few words>` (KERNEL-405). Archived with its chat. */
const chatWorkspace = (t: Thread, port: number, over: Partial<Workspace> = {}): Workspace => ({
  id: CHAT_WS[t.id] ?? `ws-chat-${t.id}`, projectId: ids.projectA, name: chatSlug(t.title), branch: `kernel/${chatSlug(t.title)}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/client-a/kernel-${chatSlug(t.title)}`,
  mode: 'worktree', agentId: 'kernel-lead', lead: true, threadId: t.id, port, status: t.closedAt ? 'archived' : 'ready', prState: 'none', createdAt: t.createdAt, ...(t.closedAt ? { archivedAt: t.closedAt } : {}), ...over
})
/** A workspace the Lead's chat `threadId` handed off, from its first tab. */
const handedOff = (id: string, name: string, task: string, agentId: string, port: number, over: Partial<Workspace> = {}): Workspace =>
  ({ id, projectId: ids.projectA, name, branch: `feat/${task}-${name}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/client-a/${name}`, mode: 'worktree', agentId, port, status: 'ready', prState: 'none', createdAt: at(10, 2), threadId: GROUPED.export, leadChatId: ids.leadChat, ...over })

const T15_STEPS = [
  { title: 'T-15a PDF renderer with embedded fonts', taskId: 'T-15a', agentId: 'sean' }, { title: 'T-15b Download PDF in the row actions', taskId: 'T-15b', agentId: 'christian' },
  { title: 'T-15c Snapshot tests for three invoice types', taskId: 'T-15c', agentId: 'teng' }, { title: 'T-15d Review each PR as it lands', taskId: 'T-15d', agentId: 'artkin' }
]

/** The same four tasks with the Lead's acceptance criteria (KERNEL-1061), as the plan card lists them under each title (KERNEL-1064). */
const T15_CRITERIA_STEPS = [
  { ...T15_STEPS[0], criteria: ['The PDF embeds the invoice font', 'A 200 line invoice fits on three pages or fewer'] },
  { ...T15_STEPS[1], criteria: ['Each invoice row has a Download PDF action', 'The action is disabled while the PDF is rendering'] },
  { ...T15_STEPS[2] },
  { ...T15_STEPS[3], criteria: ['Every PR gets a code review before it merges', 'Blockers go back to the builder'] }
]

/** The first tab of the Export chat: the plan Kernel wrote and you approved, then the hand-off. */
const exportItems = (): ChatItem[] => [
  userMsg('g1', 'Add PDF export to invoices. Spec first.'),
  { kind: 'thinking', id: 'g1-th', ts: at(10, 8), text: 'Renderer, button, tests and review can run in parallel.' },
  tool('g1-t1', 'Read the invoices module', 'cat src/app/invoices/page.tsx', { name: 'Read' }),
  tool('g1-t2', 'Write the plan', 'cat > plans/t-15-invoice-pdf.md', { name: 'Write' }),
  { kind: 'text', id: 'g1-tx', ts: at(10, 9), text: 'I split PDF export into four tasks that can run in parallel.' },
  { kind: 'approval', id: 'approval-ap-plan-kernel', ts: at(10, 12), approvalId: 'ap-plan-kernel' },
  { kind: 'text', id: 'g1-done', ts: at(10, 13), text: 'Handed off. Sean has the renderer, Christian has the button and Teng has the tests. Artkin reviews each PR as it lands.' }
]

/** The Lead's workspace on the sidebar the Grouped PNGs share: four Lead chats, two of them with several tabs, and their workspaces. Each shot picks what is open. */
export function grouped(f: Fixture, o: { tab?: string; files?: string[]; right?: 'prs' | 'changes' | 'files'; running?: string[]; items?: Record<string, ChatItem[]>; chats?: (c: Chat[]) => Chat[]; threads?: (t: Thread[]) => Thread[] } = {}): Partial<Fixture> {
  const T = GROUPED
  const chats = [
    leadTab(ids.leadChat, T.export, 'Export invoices as PDF', 5),
    leadTab('chat-christian-pr', T.export, "How is Christian's PR going?", 6),
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
    handedOff('ws-pdf-renderer', 'invoice-pdf-renderer', 't-15a', 'sean', 4320, { stat: { files: 3, added: 188, removed: 0 } }),
    handedOff('ws-pdf-button', 'invoice-pdf-button', 't-15b', 'christian', 4321, prFields(PDF_BUTTON_PR)),
    handedOff('ws-pdf-tests', 'invoice-pdf-tests', 't-15c', 'teng', 4322, { stat: { files: 2, added: 138, removed: 9 } })
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
    // Christian's two PRs are ready and approved, which the tab and the header count (KERNEL-354).
    prs: { 'ws-pdf-button': openPrInfo(PDF_BUTTON_PR), [ids.invites]: openPrInfo(INVITES_PR) },
    items: { [ids.leadChat]: exportItems(), [ids.tableChat]: [], ...o.items },
    approvals: [plan, ...f.approvals],
    push: [...f.push, ...(o.running ?? ['chat-table']).map((chatId): PushEvent => ({ type: 'chat.running', chatId, running: true }))],
    // Each chat's worktree sits at the base, so no file differs from it.
    tree: { ...f.tree, ...Object.fromEntries(own.map((w) => [w.id, tree])) },
    fileText: { ...f.fileText, ...Object.fromEntries(own.map((w) => [w.id, f.fileText?.[ids.table] ?? {}])) },
    ui: {
      route: { name: 'workspace', workspaceId: shown }, workspace: { right: 'changes', leadRight: o.right ?? 'prs', bottom: 'run' },
      tabs: { [shown]: { tab, lastChat: tab.startsWith('file:') ? undefined : tab, files: o.files ?? [], diffs: [] } }
    }
  }
}

/**
 * SidebarUnread (no PNG, KERNEL-508): `grouped` with a bold title on each row that has a reply you haven't seen, and no dot anywhere. The table chat is on screen,
 * so its row stays regular although its second tab is unread, and that tab is bold. Under it, invoice-schema is unread and invoice-table is read. The login chat
 * is unread in one tab and running in the other, so its row is bold and keeps its spinner. The export chat is folded over three workspaces, one of them unread,
 * so its row is bold. org-invites needs you and is unread, with the amber icon and the bold title together. Client B is collapsed over an unread workspace,
 * and the demo chat, the other projects and invoice-table are read.
 */
function sidebarUnread(f: Fixture): Partial<Fixture> {
  const unreadAt = at(10, 40)
  const unread = new Set(['chat-table-copy', 'chat-login-redirect', ids.schemaChat, ids.invitesChat, 'chat-pdf-button', 'chat-landing'])
  const owned = (id: string, workspaceId: string, title: string): Chat => ({ id, workspaceId, title, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: at(10, 5) })
  const g = grouped(f, { tab: 'chat-table', running: ['chat-login'] })
  const landing = handedOff('ws-landing-copy', 'landing-copy', 't-31', 'christian', 4330, { projectId: ids.projectB, threadId: undefined, leadChatId: undefined, branch: 'feat/t-31-landing-copy', path: '/Users/you/kernel/worktrees/client-b/landing-copy' })
  const question = pending('question', 'christian', { workspaceId: ids.invites, chatId: ids.invitesChat, title: 'Should invites expire after 7 days?', options: ['Yes, 7 days', 'No expiry'] })
  return {
    ...g,
    chats: [...g.chats!, owned('chat-pdf-button', 'ws-pdf-button', 'Download PDF button'), owned('chat-landing', landing.id, 'Landing page copy')].map((c) => (unread.has(c.id) ? { ...c, unreadAt } : c)),
    workspaces: [...g.workspaces!, landing],
    approvals: [...g.approvals!, question],
    items: { ...g.items, 'chat-table': groupedTurn('su', 38, 'Build the invoice table with sorting, plus the empty, loading and error states.', 'The table and the schema change are independent. Christian and Sean can start together.', [], 'Christian has the table and its states. Sean has the schema change the table needs.') },
    ui: { ...g.ui!, foldedChats: [GROUPED.export] }
  }
}

/**
 * SidebarChatPrs (no PNG, KERNEL-993): `grouped` where a chat's own PR shows on its row. The table chat has a ready PR, the login chat has checks running, and the
 * demo chat's PR is merged. The export chat is folded over a teammate with a red PR and keeps its chat icon.
 */
function sidebarChatPrs(f: Fixture): Partial<Fixture> {
  const g = grouped(f, { tab: 'chat-table', running: [] })
  const own = (id: string, over: Partial<Workspace>) => (w: Workspace) => (w.id === id ? { ...w, ...over } : w)
  const edits = [
    own('ws-chat-table', { prState: 'ready', prNumber: 31, prUrl: 'https://github.com/cjjutba/client-a/pull/31' }),
    own('ws-chat-login', { prState: 'checks', prNumber: 32, prUrl: 'https://github.com/cjjutba/client-a/pull/32' }),
    own('ws-chat-demo', { prState: 'merged', prNumber: 33, prUrl: 'https://github.com/cjjutba/client-a/pull/33' }),
    own('ws-pdf-renderer', { prState: 'cifail', prNumber: 34, prUrl: 'https://github.com/cjjutba/client-a/pull/34' })
  ]
  return { ...g, workspaces: g.workspaces!.map((w) => edits.reduce((t, e) => e(t), w)), ui: { ...g.ui!, foldedChats: [GROUPED.export] } }
}

/** SidebarChatPrPlan (no PNG, KERNEL-993): the table chat plans while its PR's CI failed, so its icon stays red. The login chat has a plain chat icon, and so does the Hand off chat. */
function sidebarChatPrPlan(f: Fixture): Partial<Fixture> {
  const g = grouped(f, { tab: 'chat-table', running: [] })
  return {
    ...g,
    chats: g.chats!.map((c) => (c.id === 'chat-table' ? { ...c, plan: true } : c)),
    workspaces: g.workspaces!.map((w) => (w.id === 'ws-chat-table' ? { ...w, prState: 'cifail', prNumber: 31, prUrl: 'https://github.com/cjjutba/client-a/pull/31' } : w))
  }
}

/** SidebarPlanChat (no PNG): `grouped` with the table chat and its copy tab planning, so their rows take the blue icon next to the ordinary ones. */
function sidebarPlanChat(f: Fixture): Partial<Fixture> {
  const g = grouped(f, { tab: 'chat-login', running: [] })
  return { ...g, chats: g.chats!.map((c) => (c.id === 'chat-table' || c.id === 'chat-login' ? { ...c, plan: true } : c)) }
}

/** WorkspaceLead with three open items on the Export chat: Sean's question, blockers in Christian's work and Teng's proposed hand-off. */
function leadOpenItems(f: Fixture): Partial<Fixture> {
  const base = { projectId: ids.projectA, threadId: GROUPED.export, chatId: ids.leadChat, createdAt: at(10, 20) }
  return {
    ...leadWaiting(f),
    openItems: [
      { ...base, id: 'oi-q', kind: 'question', workspaceId: 'ws-176', agentId: 'sean', name: 'Sean', text: 'Should the PDF include the VAT breakdown?' },
      { ...base, id: 'oi-b', kind: 'blockers', workspaceId: 'ws-182', agentId: 'christian', name: 'Christian', blockers: 2 },
      { ...base, id: 'oi-h', kind: 'handoff.proposed', workspaceId: 'ws-176', agentId: 'sean', name: 'Sean', text: 'Snapshot tests for three invoice types', proposed: { agentId: 'teng', name: 'Teng' } }
    ]
  }
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
      '---', 'name: wren', 'description: Designer. Checks every screen against DESIGN.md', '  before Artkin reviews it. Flags spacing, type and color drift.', 'model: sonnet', ...tools, '---'
    ].join('\n') } }), ...f.approvals]
  }, { plan: false, model: 'claude-opus-5-5' }),
  changes: { [ids.lead]: [{ path: '.claude/agents/wren.md', status: 'A', added: 28, removed: 0 }] }
}))

/**
 * KERNEL-586: the turn files card, in Sean's chat for KERNEL-155. A first answer, then a turn that ends in `reply` (or in
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

/**
 * KERNEL-788: the chat New chat started, right after the send. Its right panel is held closed whatever `rightPanel` says (`panelHeld`), so the shot has the
 * panel setting on and still no panel. `opened` is the same chat once the toggle was pressed in it, which clears the hold and shows the panel on PRs.
 */
function startedFromNewChat(f: Fixture, opened: boolean): Partial<Fixture> {
  const title = 'Settings search plan'
  const ask: ChatItem = { kind: 'user', id: 'ns-u1', ts: Date.now() - 4000, parts: [{ type: 'issue', name: 'KERNEL-731', title: 'Settings search opens the page and lands on the setting', source: 'linear' }, { type: 'text', text: ' Plan this one. Enter should open the first match too.' }] }
  // The chat has the one tab it started with. Its title is the chat's, in the breadcrumb and the tab.
  const g = grouped(f, {
    running: opened ? [] : [ids.leadChat], right: 'prs',
    chats: (c) => c.filter((x) => x.threadId !== GROUPED.export || x.id === ids.leadChat).map((x) => (x.id === ids.leadChat ? { ...x, title } : x)),
    threads: (t) => t.map((x) => (x.id === GROUPED.export ? { ...x, title } : x)),
    ...(opened ? {} : { items: { [ids.leadChat]: [ask, tool('ns-t1', 'Reading the settings search code', 'rg search src/renderer/src/screens/settings', { name: 'Read', status: 'running', ts: Date.now() - 4000, durationMs: undefined })] } })
  })
  // Just started, it has handed nothing off, so the project shows no PR yet. Opened, it has Christian's PRs the frame lists.
  const own = g.workspaces!.map((w) => (w.id === ids.lead ? { ...w, title } : w)).filter((w) => opened || (!w.leadChatId && !w.prNumber))
  const kept = new Set(own.map((w) => w.id))
  return { ...g, workspaces: own, chats: g.chats!.filter((c) => kept.has(c.workspaceId)), ...(opened ? {} : { prs: {} }), ui: { ...g.ui!, rightPanel: true, panelHeld: opened ? [] : [ids.lead] } }
}

/** scene2 puts the chat and workspace on its first approval only. A queue needs them on every one, as real approvals have. */
const queued = (s: Partial<Fixture>): Partial<Fixture> => {
  const [first, ...rest] = s.approvals ?? []
  return { ...s, approvals: first && [first, ...rest.map((a) => (a.status === 'pending' && a.toolName === 'Bash' ? { ...a, workspaceId: first.workspaceId, chatId: first.chatId } : a))] }
}

// ---- KERNEL-1094, The agent works (Pen Part 7): Teng's clean-account journey in each moment of a turn. ----

/** A time on the journey's day, 13:41 to 13:52 (the clocks the canvas shows). */
export const J = (m: number, s = 0) => at(13, m, s)
/** A time counted back from now, for a turn that is still running, so its clock reads what the shot says. */
export const ago = (secs: number) => Date.now() - secs * 1000

/** The workspace Teng works in: made at 13:41, set up in 1:12, a task of the Lead's plan, with the rail's stages to read. */
const JOURNEY_WS: Partial<Workspace> = {
  name: 'kernel-232a', branch: 'test/kernel-232a-clean-account', agentId: 'teng', title: JOURNEY_TITLE, taskId: 'T-31', status: 'ready', port: 4312, createdAt: J(41),
  setupRun: { startedAt: J(41, 20), endedAt: J(42, 32), end: 0 }, stat: { files: 2, added: 67, removed: 1 }
}
const JOURNEY_PROJECT: NonNullable<Fixture['projectSettings']> = { [ids.projectA]: { scripts: { setup: 'pnpm install' }, runScripts: [], files: { copy: [] }, workspace: {} } }

export const jBrief = (ts = J(43)): ChatItem => ({ kind: 'user', id: 'j-u', ts, parts: [{ type: 'text', text: JOURNEY }] })
export const jTool = (id: string, ts: number, command: string, description: string, extra: Partial<ToolItem> = {}): ChatItem =>
  tool(id, description, command, { ts, input: { command, description }, ...extra })
export const jRead = (ts = J(43, 5)): ChatItem => tool('j-read', 'Read', 'docs/qa/kernel-31.md', { name: 'Read', ts, durationMs: 80, input: { file_path: 'docs/qa/kernel-31.md' } })
export const jIssue = (ts = J(43, 12)): ChatItem => mcpCall('j-issue', 'linear', 'get_issue', { id: 'KERNEL-232' }, { ts, durationMs: 900, output: 'KERNEL-232  Clean-account journey on a fresh Mac user' })
const JOURNEY_PASS = ['✓ 1  installs from the DMG', '✓ 2  opens on New chat', '✓ 3  adds a project from GitHub', '✓ 4  sends the first brief', '✓ 5  approves the plan']
export const jRun15 = (ts = J(43, 20), extra: Partial<ToolItem> = {}): ChatItem => jTool('j-run15', ts, 'pnpm test:journey --steps 1-5', 'Run steps 1 to 5', { durationMs: 42_000, output: JOURNEY_PASS.join('\n'), ...extra })
export const jShots = (ts = J(44, 10), extra: Partial<ToolItem> = {}): ChatItem => jTool('j-shots', ts, 'pnpm shots --all', 'Capture every screen', { durationMs: 38_000, output: 'Captured 214 screens', ...extra })
const jEdit = (ts = J(46)): ChatItem => tool('j-edit', 'Edit journey.test.ts', 'test/journey.test.ts', {
  name: 'Edit', ts, durationMs: 120,
  input: { file_path: 'test/journey.test.ts', old_string: "  await shots(['Review'])", new_string: "  await shots(['Review', 'ReviewRc'])\n  expect(diff('Review', 'ReviewRc')).toBeLessThan(0.01)\n  expect(missing()).toEqual([])" }
})
const jWrite = (ts = J(46, 30)): ChatItem => tool('j-write', 'Create journey.ts', 'fixtures/journey.ts', {
  name: 'Write', ts, durationMs: 90,
  input: { file_path: 'fixtures/journey.ts', content: ['export const ReviewRc: Fixture = {', "  screen: 'Review',", "  build: 'release-candidate',", '  account: freshAccount(),', '  chats: [cleanAccountChat],', ...Array.from({ length: 58 }, (_, i) => `  // frame ${i + 1} of the release candidate`), '}'].join('\n') }
})
const jTypes = (ts = J(47, 10)): ChatItem => jTool('j-types', ts, 'pnpm typecheck', 'Check types', { status: 'failed', durationMs: 6100, output: "Exit code 2\ntest/journey.test.ts(41,7): error TS2322: Type 'string' is not assignable to type 'number'." })
const jRun6 = (ts = J(48), extra: Partial<ToolItem> = {}): ChatItem => jTool('j-run6', ts, 'pnpm test:journey --steps 6', 'Run step 6', { durationMs: 21_000, output: '✓ 6  compares the review screen', ...extra })
export const jSay = (id: string, ts: number, text: string): ChatItem => ({ kind: 'text', id, ts, text })
const jThink = (id: string, ts: number, text: string): ChatItem => ({ kind: 'thinking', id, ts, text })
export const jResult = (ts: number, ms: number, extra: Partial<Extract<ChatItem, { kind: 'result' }>> = {}): ChatItem => ({ kind: 'result', id: 'j-res', ts, durationMs: ms, ok: true, ...extra })
const jFiles: ChangedFile[] = [{ path: 'test/journey.test.ts', status: 'M', added: 3, removed: 1 }, { path: 'fixtures/journey.ts', status: 'A', added: 64, removed: 0 }]
export const jReply = 'All six steps pass on a clean account. Step 6 needed a fixture for the release candidate\'s review screen, so I added one and a test that compares the two.'

/** The turn at rest: Teng read the checklist and the issue, ran steps 1 to 5 and told you where it stands (7.1). */
export const jRest = (): ChatItem[] => [
  jBrief(), jRead(), jIssue(), jRun15(),
  jSay('j-reply', J(49, 10), 'Steps 1 to 5 pass on a clean account. Step 6 compares the review screen with the release candidate, so it needs the full screenshot run before I can call it.'),
  jResult(J(49, 12), 372_000)
]

/** The whole turn, finished: every kind of step, a failed one, thinking and the messages between (7.3 and 7.4). */
export const jDay = (): ChatItem[] => [
  jBrief(), jThink('j-th1', J(43, 2), "Step 6 needs the release candidate's review screen, and the fixtures don't have one yet."), jRead(), jIssue(), jRun15(),
  jSay('j-s1', J(44, 5), 'Steps 1 to 5 pass. Capturing every screen next.'), jShots(), jEdit(), jWrite(),
  jThink('j-th2', J(47), 'The typecheck failure is in my own test. The threshold takes a number.'), jTypes(),
  jSay('j-s2', J(47, 40), 'Fixed the threshold type in journey.test.ts. Running step 6 again against the release candidate, then I\'ll post the results on KERNEL-232.'), jRun6(),
  jSay('j-reply', J(49, 10), jReply), jResult(J(49, 12), 372_000, { files: jFiles })
]

export interface Works { running?: boolean; approvals?: Approval[]; placed?: Approval[]; ws?: Partial<Workspace>; chat?: Partial<Chat>; view?: Record<string, unknown>; panel?: boolean; toasts?: import('@shared/types').Toast[] }

/**
 * Teng's chat on the journey, with the Session rail beside it (the panel closed). `approvals` wait in the chat after `items`, `placed` are ones the items already hold,
 * and `running` is a turn still going.
 */
export function works(f: Fixture, items: ChatItem[], o: Works = {}): Partial<Fixture> {
  const s = scene2(f, { ...JOURNEY_WS, ...o.ws }, JOURNEY_TITLE, items, o.approvals ? { approvals: o.approvals } : {}, o.chat)
  const base = o.approvals ? s : noApprovals(s)
  return {
    ...base,
    ...(o.placed ? { approvals: [...o.placed.map((a) => ({ ...a, workspaceId: ids.table, chatId: ids.tableChat })), ...f.approvals] } : {}),
    projectSettings: JOURNEY_PROJECT,
    push: o.running ? [...f.push, { type: 'chat.running', chatId: ids.tableChat, running: true }] : f.push,
    ui: { ...open, rightPanel: o.panel ?? false, ...(o.toasts ? { toasts: o.toasts } : {}), workspace: { right: 'changes', bottom: 'run', ...o.view } }
  }
}

/** A tool approval Teng waits on, the way Kernel words it: what it wants to do, and why it asked. */
const jPerm = (extra: object = {}): Approval => pending('tool', 'teng', {
  toolName: 'Bash', input: { command: 'rm -rf ~/Library/Application\\ Support/Kernel-qa' }, title: 'Run rm -rf ~/Library/Application\\ Support/Kernel-qa',
  detail: "Clears the test account's Kernel data, so step 1 starts from a fresh install.", reason: 'Accept edits asks before commands no rule allows.', createdAt: Date.now() - 4_000, ...extra
})

/** The turn up to the question or approval, running, with the clock stopped where the agent asked. */
const jAsked = (secs = 90, say = "Step 1 needs a fresh install, so the test account's Kernel data has to go first."): ChatItem[] => [
  jBrief(ago(secs)), jRead(ago(secs - 5)), jIssue(ago(secs - 12)), jSay('j-asked', ago(secs - 30), say)
]

const JOURNEY_QUESTIONS: AskedQuestion[] = [
  {
    question: "The review screen on a clean account is 2px taller than the release candidate's, from the banner's top margin. Should I file it?", header: 'The 2px difference',
    options: [{ label: 'File it as its own issue' }, { label: "Leave it, it's under the 4px threshold" }]
  },
  {
    question: 'Which build should step 6 use?', header: 'Build',
    options: [{ label: 'The release candidate from Friday', recommended: true, description: 'Matches what ships on Monday. The review screen shot is already in shots/rc.' }, { label: "Today's main", description: "Newer, but it includes the banner change that isn't in the release yet." }]
  },
  {
    question: 'Should the comment on KERNEL-232 include every shot, or only the ones that moved?', header: 'The comment',
    options: [{ label: 'Every shot' }, { label: 'Only the ones that moved' }]
  }
]
const jQuestion = (qs: AskedQuestion[] = [JOURNEY_QUESTIONS[0]], extra: object = {}): Approval =>
  pending('question', 'teng', { title: qs[0].question, options: qs[0].options.map((o) => o.label), questions: qs, createdAt: Date.now() - 4_000, ...extra })
const jAnswered = (qs: AskedQuestion[], answers: string[]): Approval => ({
  ...jQuestion(qs, { createdAt: J(47, 40) }), status: 'answered', answer: answers.join(' · '), answers: Object.fromEntries(qs.map((q, i) => [q.question, answers[i]]))
})
/** The turn once its question has an answer: the card, then the reply that follows. */
const jAfterAnswer = (a: Approval, withItem = false): Partial<Fixture> => {
  const f = scene(() => ({}))
  const placed: ChatItem = { kind: 'approval', id: `approval-${a.id}`, ts: J(47, 40), approvalId: a.id }
  const answer: ChatItem = { kind: 'user', id: `answer-${a.id}`, ts: J(47, 50), parts: [{ type: 'text', text: a.answer ?? '' }], approvalId: a.id }
  return works(f, [jBrief(J(43)), jRead(), jIssue(), jRun15(), jSay('j-asked', J(47, 30), 'Steps 1 to 5 pass on a clean account. Step 6 found one difference from the release candidate.'), placed, ...(withItem ? [answer] : []), jSay('j-after', J(48), 'Filed KERNEL-1090 for the 2px difference and posted the moved shots on KERNEL-232.'), jResult(J(48, 10), 310_000)], { placed: [a] })
}

const jPermScene = (f: Fixture, o: { approvals?: Approval[]; reason?: string; mode?: Chat['mode']; ws?: Partial<Workspace>; chat?: Partial<Chat>; say?: string; models?: boolean } = {}): Partial<Fixture> => ({
  ...works(f, jAsked(90, o.say), { running: true, approvals: o.approvals ?? [jPerm({ reason: o.reason ?? 'Accept edits asks before commands no rule allows.' })], ws: o.ws, chat: { mode: o.mode ?? 'acceptEdits', ...o.chat } }),
  ...(o.models ? { models: { codex: codexModels } } : {})
})

/** Two turns with Kernel's own message between them (7.8): one line, with what Kernel told Teng a click away. */
const jKernelNote = (): ChatItem[] => [
  jBrief(), jRead(), jIssue(), jRun15(), jSay('j-n1', J(47), 'Steps 1 to 5 pass on a clean account. Capturing every screen next.'), jResult(J(47, 50), 230_000),
  { kind: 'user', id: 'j-kn', ts: J(48), from: 'kernel', parts: [{ type: 'text', text: 'You hit your usage limit, so Kernel moved this chat to Work account. You are continuing on a different account. Carry on from where you stopped: you were capturing every screen for step 6. Check git status first. Nothing should be lost.' }] },
  jShots(J(49)), jSay('j-n2', J(51, 10), 'Picked up from the screenshot run. git status was clean, so nothing was lost. All six steps pass on a clean account.'), jResult(J(51, 12), 125_000)
]

// ---- KERNEL-1096, Review the work (Pen Part 9): Teng's clean-account journey in the right panel, its files, changes, review and pull request, and the pane under them. ----

const R9_BRANCH = 'test/kernel-232a-clean-account'
const R9_TREE: FileEntry[] = [
  { path: '.changes', dir: true }, { path: '.changes/unreleased', dir: true }, { path: 'docs', dir: true },
  { path: 'fixtures', dir: true }, { path: 'fixtures/journey.ts', dir: false, status: 'A' }, { path: 'fixtures/team.ts', dir: false }, { path: 'fixtures/workspace.ts', dir: false },
  { path: 'scripts', dir: true }, { path: 'shots', dir: true }, { path: 'src', dir: true },
  { path: 'test', dir: true }, { path: 'test/support', dir: true }, { path: 'test/helpers.ts', dir: false }, { path: 'test/journey.test.ts', dir: false, status: 'M' },
  { path: 'test/kernel.test.ts', dir: false }, { path: 'test/merge.test.ts', dir: false },
  { path: 'AGENTS.md', dir: false }, { path: 'DESIGN.md', dir: false }, { path: 'electron-builder.yml', dir: false }, { path: 'package.json', dir: false }, { path: 'README.md', dir: false }
]
const R9_TEST = [
  "import { describe, expect, it } from 'vitest'", "import { diff, missing, shots } from './support/shots'", "import { journey } from '../fixtures/journey'", '',
  "describe('clean-account journey', () => {", "  it('steps 1 to 5 pass on a new account', async () => {", '    for (const step of journey.slice(0, 5)) {',
  "      await expect(step.run()).resolves.toBe('passed')", '    }', '  })', '', "  it('step 6 compares the review screen', async () => {",
  "    await shots(['Review', 'ReviewRc'])", "    expect(diff('Review', 'ReviewRc')).toBeLessThan(0.01)", '    expect(missing()).toEqual([])', '  })', '',
  "  it('files each failure as its own issue', async () => {", '    const failed = journey.filter((s) => s.failed)', '    expect(failed.map((s) => s.issue)).toHaveLength(failed.length)', '  })', '})'
].join('\n') + '\n'
const R9_JOURNEY = ["import type { Fixture } from './types'", '', "export const ReviewRc: Fixture = {", "  screen: 'Review',", "  build: 'release-candidate',", '  account: freshAccount(),', '  chats: [cleanAccountChat],', '}'].join('\n') + '\n'
const R9_DIFF = [
  'diff --git a/test/journey.test.ts b/test/journey.test.ts', '--- a/test/journey.test.ts', '+++ b/test/journey.test.ts', "@@ -9,9 +9,11 @@ describe('clean-account journey', () => {",
  '     }', '   })', ' ', "   it('step 6 compares the review screen', async () => {", "-    await shots(['Review'])", "+    await shots(['Review', 'ReviewRc'])",
  "+    expect(diff('Review', 'ReviewRc')).toBeLessThan(0.01)", '+    expect(missing()).toEqual([])', '   })', ' ', "   it('files each failure as its own issue', async () => {"
].join('\n') + '\n'
const R9_FILE_DIFF = [
  'diff --git a/fixtures/journey.ts b/fixtures/journey.ts', 'new file mode 100644', '--- /dev/null', '+++ b/fixtures/journey.ts', '@@ -0,0 +1,8 @@',
  ...R9_JOURNEY.trimEnd().split('\n').map((l) => `+${l}`)
].join('\n') + '\n'
/** A moment before now, so the review reads "12 min ago" on any day. */
const MIN = 60_000

/** Theo's review of PR #1157, as Kernel's reviewer found it: two blockers on the head commit, and the GitHub thread that was fixed already. */
const R9_REVIEW: NonNullable<Workspace['reviews']> = [{
  workspaceId: 'ws-review-1157', agentId: 'artkin', verdict: 'blockers', sha: 'h1157', prNumber: 1157, ts: Date.now() - 12 * MIN,
  summary: "The journey change looks right. Two things before it merges: step 6's threshold is a bare number, and the fixture hard-codes the build it compares against.",
  blockers: [
    { text: '0.01 is a bare number. Name it, so step 6 says what the threshold means.', file: 'test/journey.test.ts', line: 14 },
    { text: 'The build name is hard-coded. Read it from the release manifest so the fixture follows the next candidate.', file: 'fixtures/journey.ts', line: 3 }
  ]
}]
const R9_CHECKS: PrCheck[] = [
  { name: 'Test', state: 'pass', meta: 'Ubuntu' }, { name: 'Build', state: 'pass', meta: 'Ubuntu' }, { name: 'Other apps', state: 'pass', meta: 'names check' }, { name: 'Test on macOS', state: 'running' }
]
const r9Pr = (o: Partial<PrInfo> = {}): Record<string, PrInfo> => ({ [ids.table]: {
  workspaceId: ids.table, number: 1157, url: 'https://github.com/cjjutba/kernel/pull/1157', title: 'Clean-account journey: all six steps pass', state: 'open', baseRef: 'main', head: 'h1157',
  checks: R9_CHECKS, conflicts: [], comments: [{ id: 'c-typo', author: 'artkin', path: 'docs/qa/kernel-31.md', line: 22, body: 'Typo in step 4', resolved: true, association: 'trusted' }], ...o
} })
const R9_SCRIPTS: NonNullable<Fixture['projectSettings']> = { [ids.projectA]: {
  scripts: { setup: 'pnpm install', run: 'pnpm dev', runMode: 'concurrent' },
  runScripts: [{ name: 'app', command: 'pnpm dev --port $KERNEL_PORT' }, { name: 'shots', command: 'pnpm shots --all --no-build' }, { name: 'tests', command: 'pnpm test' }], files: { copy: [] }, workspace: {}
} }

interface R9 {
  /** The right panel's tab. */ right?: PanelTab
  /** The bottom pane's tab, and whether it is open or folded to its bar. Folded unless `pane`. */ bottom?: 'setup' | 'run' | 'terminal'; pane?: boolean
  /** The panel is closed, so the Session rail shows. */ rail?: boolean
  /** Setup is still running, instead of done. */ setting?: boolean
  /** The tab in front, and the file and diff tabs open. */ tab?: string; files?: string[]; diffs?: string[]
  /** A pull request in `state`, with its checks and reviews, or none. */ pr?: Workspace['prState']; reviewed?: boolean
  ws?: Partial<Workspace>; view?: Partial<WorkspaceView>; ui?: Partial<Fixture['ui']>
}

/** Teng's journey with the panel open (or the rail, when `rail`), the worktree's files, the changes and a pull request to read. */
function review9(f: Fixture, o: R9 = {}): Partial<Fixture> {
  const state = o.pr ?? 'open'
  const w = works(f, jRest(), {
    panel: !o.rail,
    ws: { baseRef: 'main', ...(state === 'none' ? {} : { prNumber: 1157, prUrl: 'https://github.com/cjjutba/kernel/pull/1157', prTitle: 'Clean-account journey: all six steps pass', prHead: 'h1157' }), prState: state, ...(o.reviewed ? { reviews: R9_REVIEW } : {}), ...o.ws },
    view: { right: o.right ?? 'changes', bottom: o.bottom ?? 'run', ...o.view }
  })
  const tab = o.tab ?? ids.tableChat
  return {
    ...w,
    changes: { [ids.table]: jFiles },
    tree: { [ids.table]: R9_TREE },
    fileText: { [ids.table]: { 'test/journey.test.ts': R9_TEST, 'fixtures/journey.ts': R9_JOURNEY } },
    diffs: { [ids.table]: R9_DIFF, [`${ids.table}:fixtures/journey.ts`]: R9_FILE_DIFF },
    prs: state === 'none' ? {} : r9Pr(),
    projectSettings: R9_SCRIPTS,
    commits: { [ids.table]: [{ sha: 'e4f5a6b'.padEnd(40, '0'), subject: 'Compare the review screen', author: 'Teng', time: Date.now() - 50 * MIN }, { sha: 'a1b2c3d'.padEnd(40, '0'), subject: 'Add the ReviewRc fixture', author: 'Teng', time: Date.now() - 80 * MIN }] },
    branches: ['main', 'release/0.43', 'feat/kernel-1075-auto-review'],
    push: [...(w.push ?? f.push).filter((e) => e.type !== 'script.output'), { type: 'script.output', workspaceId: ids.table, kind: 'setup', lines: [{ line: '$ pnpm install', stream: 'stdout' }, { line: 'Lockfile is up to date, resolution step is skipped', stream: 'stdout' }, { line: 'Packages: +1214', stream: 'stdout' }] }, ...(o.setting ? [] : [{ type: 'script.exit' as const, workspaceId: ids.table, kind: 'setup' as const, code: 0 }])],
    ui: {
      ...w.ui!, ...o.ui,
      workspace: { ...w.ui!.workspace!, ...o.view, right: o.right ?? 'changes', bottom: o.bottom ?? 'run' },
      bottomCollapsed: { lead: true, teammate: !o.pane },
      tabs: { [ids.table]: { tab, lastChat: ids.tableChat, files: o.files ?? [], diffs: o.diffs ?? [] } }
    }
  }
}

/** The chats a busy workspace has beside the one on screen: one waiting on an answer, one working, and a terminal (Pen 9.1). `w` is the scene they are added to. */
const r9Tabs = (f: Fixture, w: Partial<Fixture>): Partial<Fixture> => ({
  chats: [...(w.chats ?? f.chats), extraChat('chat-ask', 'Should a 2px margin count as a failure'), extraChat('chat-run', 'Snapshot tests for the review screen'), extraChat('chat-term', 'Terminal (claude)', 'terminal')],
  approvals: [{ ...pending('question', 'teng', { title: 'Should a 2px margin count as a failure?', options: ['Yes', 'No'] }), chatId: 'chat-ask' }, ...(w.approvals ?? f.approvals)],
  push: [...(w.push ?? f.push), { type: 'chat.running', chatId: 'chat-run', running: true }],
  settings: DEFAULT_SETTINGS('/Users/you')
})

/** `n` images Teng shared in one turn, each its own file with its own title, as Pen 9.19 lays them out by count. */
const R9_IMAGES = [
  ['Clean account', invoiceLayoutStill], ['Release candidate', pricingStill], ['Phone width', fontsCheckImage], ['Tablet width', invoiceLayoutStill],
  ['Dark theme', pricingStill], ['Light theme', fontsCheckImage], ['High contrast', invoiceLayoutStill]
] as const
const r9Images = (f: Fixture, n: number, title?: string, version = 1): Partial<Fixture> => {
  const files = R9_IMAGES.slice(0, n).map(([name, data], i) => sharedFile(`sh-img-${i}`, 'teng', ids.table, name, 'image', `shots/${name.toLowerCase().replace(/ /g, '-')}.png`, [sharedVersion(version, 14, 2, 'image/png', { width: 616, height: 385 })], 5 * MIN))
  const w = review9(f, { rail: true, ws: { name: 'kernel-232a' } })
  return {
    ...w,
    shared: files,
    sharedData: Object.fromEntries(files.map((file, i) => [file.id, { [version]: { dataUrl: R9_IMAGES[i][1], thumb: R9_IMAGES[i][1] } }])),
    items: { [ids.tableChat]: [
      jBrief(J(43)),
      jSay('j-sh', J(49, 10), n === 1 ? 'Here is the review screen on a clean account.' : 'Here are the review screens side by side. The banner’s top margin is the only difference, 2px at 1280 wide.'),
      ...files.map((file, i): ChatItem => ({ kind: 'shared', id: `sh-i${i}`, ts: J(50, i), sharedId: file.id, version })),
      jResult(J(50, 10), 150_000)
    ] },
    settings: { ...DEFAULT_SETTINGS('/Users/you'), experimental: { ...DEFAULT_SETTINGS('/Users/you').experimental, sharing: true } },
    ...(title ? {} : {})
  }
}


const r9SetupDone: PushEvent[] = [
  { type: 'script.output', workspaceId: ids.table, kind: 'setup', lines: [{ line: '$ pnpm rebuild better-sqlite3', stream: 'stdout' }, { line: 'Rebuilt dependencies successfully', stream: 'stdout' }, { line: '✓ Setup script finished in 1:12', stream: 'stdout' }] },
  { type: 'script.exit', workspaceId: ids.table, kind: 'setup', code: 0 }
]
/** The diff tab of a picture: an added one as it is, a changed one as Before and After (Pen 9.17). */
const r9ImageDiff = (f: Fixture, status: 'A' | 'M'): Partial<Fixture> => {
  const name = status === 'A' ? 'shots/ReviewRc.png' : 'shots/Review.png'
  const w = review9(f, { rail: true, tab: `diff:${name}`, diffs: [name] })
  return {
    ...w,
    changes: { [ids.table]: [{ path: name, status, added: 0, removed: 0 }, ...jFiles] },
    diffs: { [ids.table]: '' },
    images: { [ids.table]: { [`worktree:${name}`]: { dataUrl: fontsCheckImage }, ...(status === 'M' ? { [`base:${name}`]: { dataUrl: invoiceLayoutStill } } : {}) } }
  }
}

/** One shared file in the chat, with its picture or text, for the cards of a page, a note and a PDF (Pen 9.19). */
const r9Shared = (f: Fixture, file: SharedFile, data: { text?: string; dataUrl?: string; thumb?: string }): Partial<Fixture> => ({
  ...review9(f, { rail: true }),
  shared: [file],
  sharedData: { [file.id]: { 1: data } },
  items: { [ids.tableChat]: [jBrief(J(43)), jSay('j-sh', J(49, 10), 'Here is what I shared.'), { kind: 'shared', id: 'sh-i0', ts: J(50), sharedId: file.id, version: 1 }, jResult(J(50, 10), 150_000)] },
  settings: { ...DEFAULT_SETTINGS('/Users/you'), experimental: { ...DEFAULT_SETTINGS('/Users/you').experimental, sharing: true } }
})
const R9_NOTE = ['# Clean-account journey, KERNEL-31', '', 'All six steps pass on a fresh Mac account. Step 6 needed a fixture for the release candidate’s review screen.', '', 'One issue filed: KERNEL-1084, the review screen is 2px taller at 1280 wide.'].join('\n')
/** The files the rail lists: a page, three images, a note and a PDF, shared by Teng. */
const r9Files = (): SharedFile[] => [
  sharedFile('sh-page', 'teng', ids.table, 'review-compare.html', 'html', 'shots/review-compare.html', [sharedVersion(3, 14, 10, 'text/html', { outside: 1 })], 2 * MIN),
  sharedFile('sh-imgs', 'teng', ids.table, 'Review screen, clean account and release candidate', 'image', 'shots/review.png', [sharedVersion(2, 14, 2, 'image/png', { width: 616, height: 385 })], 8 * MIN),
  sharedFile('sh-note', 'teng', ids.table, 'Clean-account journey results', 'markdown', 'docs/qa/results.md', [sharedVersion(1, 13, 58, 'text/markdown', { thumb: false })], 12 * MIN),
  sharedFile('sh-list', 'teng', ids.table, 'Release checklist', 'pdf', 'docs/release/checklist.pdf', [sharedVersion(1, 13, 41, 'application/pdf')], 30 * MIN)
]
/** Files and Changes states of Pen 9.21. */
const r9Changed: ChangedFile[] = [{ path: 'src/renderer/src/screens/workspace/Transcript.tsx', status: 'M', added: 6, removed: 2 }, { path: 'test/setup.test.ts', status: 'A', added: 24, removed: 0 }, { path: 'src/legacy.ts', status: 'D', added: 0, removed: 31 }]
/** A chat message that links to `path`, so the workspace screen can show what the link does (Pen 9.22). */
const r9Link = (f: Fixture, text: string, mentions: Record<string, unknown>): Partial<Fixture> => ({
  ...review9(f, { rail: true }),
  items: { [ids.tableChat]: [jBrief(J(43)), { kind: 'text', id: 'fl-r', ts: J(49), text }, jResult(J(49, 12), 372_000)] },
  mentions: { [ids.table]: mentions as NonNullable<Fixture['mentions']>[string] }
})

// ---- KERNEL-1097, Redesign 10, Pull request and merge (Pen Part 10): Teng's journey from no pull request to merged, in the Session rail, the title bar and the panel. ----

const SHOP = '/Users/you/Projects/shop'
const P10_URL = 'https://github.com/cjjutba/kernel/pull/1153'
const P10_TITLE = 'Clean-account journey test'
const crit = (index: number, text: string, status: CriterionEvidence['status'], links: EvidenceLink[], stale = links.some((l) => l.stale)): CriterionEvidence => ({ index, text, status, stale, links })
const P10_CHECKS: PrCheck[] = [{ name: 'Test', state: 'pass' }, { name: 'Build', state: 'pass' }, { name: 'Release note', state: 'pass' }, { name: 'Other apps', state: 'pass' }]
const p10Review = (o: Partial<ReviewVerdict> = {}): ReviewVerdict => ({ workspaceId: 'ws-review-1153', agentId: 'artkin', verdict: 'approved', summary: 'Every step passes on a fresh account, and the one failure has its own issue.', sha: 'h1153', prNumber: 1153, ts: J(55), ...o })
const P10_BLOCKERS = [{ text: "Step 6's threshold is a bare number", file: 'test/journey.test.ts', line: 14 }, { text: 'The fixture hard-codes the build it compares against', file: 'fixtures/journey.ts', line: 3 }]
const p10Blockers = (): ReviewVerdict => p10Review({ verdict: 'blockers', summary: 'Two blockers.', blockers: P10_BLOCKERS })
const p10Pr = (o: Partial<PrInfo> = {}): Record<string, PrInfo> => ({ [ids.table]: { workspaceId: ids.table, number: 1153, url: P10_URL, title: P10_TITLE, state: 'open', baseRef: 'main', head: 'h1153', checks: P10_CHECKS, conflicts: [], comments: [], ...o } })

/** The pull requests of the Lead's PRs tab as Pen 10.6 draws them: the journey test ready with Artkin's approval, the banner margin failing its checks and the soak harness still running them. */
const P10_LEAD: Record<'journey' | 'banner' | 'soak', OpenPr> = {
  journey: { id: 'ws-1153', agentId: 'teng', key: 'KERNEL-232', n: 1153, title: 'Clean-account journey test', state: 'ready', stat: [67, 1], review: 'approved' },
  banner: { id: 'ws-1155', agentId: 'christian', key: 'KERNEL-234', n: 1155, title: 'Banner margin at 1280 wide', state: 'cifail', stat: [4, 2] },
  soak: { id: 'ws-1154', agentId: 'sean', key: 'KERNEL-233', n: 1154, title: 'Soak harness that runs agents for 24 hours', state: 'checks', stat: [318, 12] }
}
const P10_LEAD_REPLY = "One PR is ready. Teng's #1153 has Artkin's approval and its checks passed. Sean's #1154 is still running checks, and #1155 failed its Test check, so Christian is fixing it. Merge #1153 from the PRs tab, or tell me to and I will."

interface P10 {
  state: Workspace['prState']
  pr?: Partial<PrInfo>
  ws?: Partial<Workspace>
  /** The workspace has no changes at all. */
  noChanges?: boolean
  /** An action main runs on the pull request now. */
  pending?: PrPending
  /** The right panel is open on its Pull request tab, so the Session rail is hidden. */
  panel?: boolean
  right?: PanelTab
  /** Neither the rail nor the panel shows, so the title bar carries the state. */
  hidden?: boolean
  ui?: Partial<Fixture['ui']>
  title?: string
}

/** The Pull request tab of the journey with the criteria at `at` (and the model that reviewed it), the panel open so the rail is hidden. */
function p10Criteria(f: Fixture, at: number[], provider?: 'claude' | 'codex'): Partial<Fixture> {
  const w = pr10(f, { state: 'open', panel: true, right: 'pr', ws: { reviews: [p10Review({ ...(provider ? { provider } : {}) })] } })
  return { ...w, evidence: { [ids.table]: { ...P10_EVIDENCE, criteria: at.map((i, n) => ({ ...P10_EVIDENCE.criteria[i], index: n })) } } }
}

/** The journey workspace with its pull request #1153 in one state, the Session rail beside the chat (or the panel, or neither). */
function pr10(f: Fixture, o: P10): Partial<Fixture> {
  const none = (o.state === 'none' || o.state === 'creating') && !o.ws?.prNumber
  const w = works(f, jRest(), {
    panel: !!o.panel,
    ws: { baseRef: 'main', prState: o.state, ...(none ? {} : { prNumber: 1153, prUrl: P10_URL, prTitle: P10_TITLE, prHead: 'h1153' }), ...(o.noChanges ? { stat: { files: 0, added: 0, removed: 0 } } : {}), ...o.ws },
    view: { right: o.right ?? 'pr', bottom: 'run' }
  })
  return {
    ...w,
    changes: { [ids.table]: o.noChanges ? [] : jFiles },
    ...(none ? { prs: {} } : { prs: p10Pr({ state: o.state, ...o.pr }) }),
    push: [...(w.push ?? f.push), ...(o.pending ? [{ type: 'pr.pending' as const, workspaceId: ids.table, action: o.pending }] : [])],
    ui: { ...w.ui!, ...(o.hidden ? { rail: false, rightPanel: false } : {}), bottomCollapsed: { lead: true, teammate: true }, ...o.ui }
  }
}

/** A project that merges on this Mac, with Kai's branch for the offline visit list (Pen 10.4): a local folder with no GitHub, 2 files changed and a review that approved. */
type P10Stand = 'ready' | 'behind' | 'dirty' | 'conflict' | 'resolving' | 'merging' | 'merged'
function p10Local(f: Fixture, stand: P10Stand): Partial<Fixture> {
  const behind = stand === 'behind' ? 3 : 0
  const conflicts = stand === 'conflict' || stand === 'resolving' ? ['src/visits/cache.ts'] : []
  const dirty = stand === 'dirty' ? [{ status: 'M', path: 'package.json' }, { status: '??', path: 'notes.md' }] : []
  const prState: Workspace['prState'] = stand === 'behind' || stand === 'dirty' ? 'ready' : stand
  const w = works(f, jRest(), {
    ws: { name: 'EVF-12', branch: 'feat/visit-cache', baseRef: 'main', prState, stat: { files: 2, added: 67, removed: 1 }, agentId: 'sean', ...(stand === 'merged' ? { mergedAt: J(59), mergeCommit: '4e1b9c2f0a7d3b5c8e1a9d6f2b4c7e0a3d5f8b1c' } : {}), reviews: [p10Review({ summary: 'The cache keeps the last 50 visits.', sha: 'a'.repeat(40), prNumber: undefined, ts: J(55) })] },
    view: { right: 'pr', bottom: 'run' }
  })
  return {
    ...w,
    projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, name: 'evenfar', path: SHOP, repo: undefined, host: 'local' as const } : r)),
    changes: { [ids.table]: jFiles },
    prs: { [ids.table]: { workspaceId: ids.table, number: 0, url: '', title: '', state: stand === 'conflict' ? 'conflict' : 'ready', baseRef: 'main', checks: [], comments: [], conflicts, head: 'a'.repeat(40), local: { ahead: 3, behind, stat: { files: 2, added: 67, removed: 1 }, method: 'squash', checkout: { path: SHOP, dirty } } } },
    ...(stand === 'resolving' ? { push: [...(w.push ?? f.push), { type: 'pr.pending' as const, workspaceId: ids.table, action: 'resolve' as const }] } : {})
  }
}

/** The acceptance criteria of the journey step, as Pen 10.5 words them: one in each state, the reviewer's judgment labeled, and "Reviewed by Codex" over them. */
const p10Link = (id: string, o: Partial<EvidenceLink> & Pick<EvidenceLink, 'source' | 'label' | 'effect'>): EvidenceLink => ({ id, stale: false, commit: 'h1153', ts: J(56), ...o })
const P10_EVIDENCE: PrEvidence = {
  workspaceId: ids.table, prNumber: 1153, head: 'h1153', stepTitle: P10_TITLE,
  criteria: [
    crit(0, 'Every step of KERNEL-31 passes on a new account', 'passed', [p10Link('c-test', { source: 'check', label: 'Test check passed on 4f2a1c0', effect: 'supports', url: `${P10_URL}/checks` }), p10Link('c-run', { source: 'check', label: 'Journey run, 6 of 6 steps', effect: 'supports', url: `${P10_URL}/checks` })]),
    crit(1, 'Each failure is filed as its own issue', 'reviewer-met', [p10Link('c-rev', { source: 'review', judgedBy: 'reviewer', label: "Theo's review of #1153", effect: 'supports', url: P10_URL })]),
    crit(2, 'The review screen matches the release candidate', 'failed', [p10Link('c-fail', { source: 'check', label: 'KERNEL-1084, banner margin 2px off at 1280 wide', effect: 'contradicts', url: 'https://linear.app/kernel/issue/KERNEL-1084' })]),
    crit(3, 'One comment on KERNEL-232 has the results and shots', 'unverified', []),
    crit(4, 'Shots cover every step of the journey', 'unverified', [p10Link('c-shots', { source: 'files', label: 'Shots from 3a9e2b1', effect: 'context', stale: true, commit: 'h1152', url: P10_URL })], true)
  ],
  run: { approvals: [], files: ['test/journey.test.ts'], images: [] }, commentUrl: `${P10_URL}#issuecomment-1`
}

export const workspaceFixtures: Record<string, Fixture> = {
  /** 7.1: the workspace at rest. Teng finished a turn and its fold is closed, with the Session rail beside the chat while the panel is shut (KERNEL-1094). */
  Workspace: scene((f) => works(f, jRest())),
  // Chat header mocks: today's two rows on a new Lead chat, then the one-row header with one tab and with three.
  // The one-row header (Lead chats and New chat): New chat with its one tab, three tabs, and a tab's hover card naming what the chat follows.
  NewChatOneRow: scene((f) => ({ ...noPlan(leadNoChats(f)), projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, name: 'Kernel' } : r)) })),
  LeadChatTabs: scene((f) => {
    const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Export invoices as PDF', [], {}, { model: 'claude-opus-5-5', effort: 'xhigh', plan: false })
    const { approvals: _none, ...rest } = s
    const tab = (id: string, title: string, m: number): Chat => ({ id, workspaceId: ids.lead, title, kind: 'chat', model: 'claude-opus-5-5', effort: 'xhigh', plan: false, threadId: 't-lead', createdAt: at(9, m) })
    return {
      ...rest,
      ui: { ...rest.ui!, rightPanel: false, tabs: { [ids.lead]: { tab: ids.leadChat, lastChat: ids.leadChat, files: [], diffs: [] } } },
      projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, name: 'Kernel' } : r)),
      chats: [tab('chat-hdr-long', 'Split the invoice export into one PDF per client and email each client their own copy', 1), tab('chat-hdr-inbox', 'Inbox rows', 2), ...(rest.chats ?? f.chats)]
    }
  }),
  LeadChatTabBranch: scene((f) => {
    const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead', mode: 'worktree', branch: 'cjjutba/refund-rounding' }, 'Refund rounding', [], {}, { model: 'claude-opus-5-5', effort: 'xhigh', plan: false })
    const { approvals: _none, ...rest } = s
    const tab = (id: string, title: string, m: number): Chat => ({ id, workspaceId: ids.lead, title, kind: 'chat', model: 'claude-opus-5-5', effort: 'xhigh', plan: false, threadId: 't-lead', createdAt: at(9, m) })
    return {
      ...rest,
      ui: { ...rest.ui!, rightPanel: false, tabs: { [ids.lead]: { tab: ids.leadChat, lastChat: ids.leadChat, files: [], diffs: [] } } },
      projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, name: 'kernel' } : r)),
      chats: [...(rest.chats ?? f.chats), tab('chat-hdr-usage', 'Usage meter after a reset', 2)]
    }
  }),
  // Three chat tabs and two file tabs with the right panel open: the tabs shrink and truncate, and the project, + and editor button keep their size. KERNEL-760 is the linked issue.
  LeadChatTabsFull: scene((f) => {
    const s = scene2(f, { id: ids.lead, agentId: 'kernel-lead', source: { kind: 'issue', id: 'KERNEL-760', title: 'Export invoices as PDF' } }, 'Clean-account journey', [], {}, { model: 'claude-opus-5-5', effort: 'xhigh', plan: false })
    const { approvals: _none, ...rest } = s
    const tab = (id: string, title: string, m: number): Chat => ({ id, workspaceId: ids.lead, title, kind: 'chat', model: 'claude-opus-5-5', effort: 'xhigh', plan: false, threadId: 't-lead', createdAt: at(9, m) })
    return {
      ...rest,
      ui: { ...rest.ui!, workspace: { right: 'changes', bottom: 'run' }, tabs: { [ids.lead]: { tab: ids.leadChat, lastChat: ids.leadChat, files: ['journey.test.ts', 'kernel-232-clean-account.md'], diffs: [] } } },
      projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, name: 'kernel' } : r)),
      chats: [tab('chat-hdr-long', 'How long should a journey run before it times out', 1), tab('chat-hdr-inbox', 'Export retries', 2), ...(rest.chats ?? f.chats)]
    }
  }),
  // KERNEL-161: the workspace started on a Linear issue shows its key after the branch.
  WorkspaceIssue: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { branch: 'feat/kernel-24-invoice-table', source: { kind: 'issue', id: 'KERNEL-24', title: 'Invoice table', url: 'https://linear.app/cj-jutba/issue/KERNEL-24' } }),
    ui: open
  })),
  // 6.12: the chat's messages are still on their way, so the skeleton stands in and no spinner shows.
  WorkspaceLoading: { ...scene(() => ({ ui: open })), lag: { 'chats.items': 600_000 } },
  // Redesign 06, An agent's workspace starts (KERNEL-1093). Setup is optional and never holds a message: a brief goes out at once, the agent works while the script runs,
  // and a run that doesn't pass is a toast. Frames 6.1 to 6.3: a project's first chat, its block of plain rows, and the block gone once the first message is sent.
  FirstChatNoScript: scene((f) => firstChat(f)),
  WorkspaceSetupAdd: scene((f) => firstChat(f, { pane: true })),
  FirstChatAfterSend: scene((f) => firstChat(f, { sent: true })),
  // 6.4 to 6.7: setup runs beside the working agent, a run that fails or stops is a toast and the agent goes on, and git can't make the worktree: the message stays as Not sent.
  SetupRunning: scene((f) => along(f, { setup: 'running', pane: true })),
  SetupFailed: scene((f) => along(f, { setup: 'failed' })),
  SetupWorktreeFailed: scene((f) => {
    const error = "fatal: '/Users/cj/Kernel/worktrees/kernel/in-setup-script-tab-in' already exists"
    const w = setupWait(f, 'failed', [setupAsk], { pending: { error }, panel: false })
    return { ...w, push: [...(w.push ?? []), { type: 'worktree.failed', workspaceId: ids.table, chatId: ids.tableChat, error }] }
  }),
  // 6.10: setup never holds a message. The first chat's block while the script runs and once it finished, a worktree still being made, the brief going out at once, a follow-up, and a restored chat.
  FirstChatSetupRunning: scene((f) => firstChat(f, { script: true, running: true })),
  FirstChatSetupDone: scene((f) => firstChat(f, { script: true })),
  SetupCreatingWorktree: scene((f) => setupWait(f, 'setup', [{ ...setupAsk, clientId: setupAsk.id }], { pending: {}, panel: false })),
  SetupWorkingAlongside: scene((f) => along(f, { setup: 'running', steps: 3, secs: 18 })),
  // Wait for setup is gone, so a chat that used to hold its message now just works. Kept as its own state: the brief, one step and the clock.
  SetupHeldWaitOn: scene((f) => along(f, { setup: 'running', steps: 1, secs: 4 })),
  SetupSentHeldWaitOn: scene((f) => along(f, { setup: 'running', steps: 0, secs: 2 })),
  SetupFollowUp: scene((f) => along(f, { setup: 'running', steps: 3, followUp: true, secs: 31 })),
  // KERNEL-1018: a restored chat with history. It keeps its transcript, and what you send goes out at once.
  SetupRestoredChat: scene((f) => {
    const now = Date.now()
    const w = along(f, { setup: 'running', steps: 0, secs: 3 })
    return { ...w, items: { [ids.tableChat]: [
      { kind: 'user', id: 'rc-u1', ts: now - 600_000, parts: [{ type: 'text', text: 'Where did we leave off with the soak harness?' }] },
      { kind: 'text', id: 'rc-t1', ts: now - 590_000, text: 'The harness runs for 24 hours. Memory stayed flat in the last run.' },
      { kind: 'result', id: 'rc-r1', ts: now - 589_000, durationMs: 11_000, ok: true },
      { kind: 'user', id: 'rc-u2', ts: now - 3_000, parts: [{ type: 'text', text: 'Run it again on the fresh account.' }] }
    ] } }
  }),
  // 6.11: setup ends and the chat carries on. A pass says so in the Setup tab and nothing in the chat, a stop or a failure is a toast with its action, and a later chat or the Lead's does the same.
  SetupDone: scene((f) => along(f, { setup: 'done', steps: 3, pane: true, secs: 120 })),
  SetupStopped: scene((f) => along(f, { setup: 'stopped', steps: 1, secs: 40 })),
  SetupSentAnyway: scene((f) => along(f, { setup: 'running', steps: 1, secs: 9 })),
  SetupFailedKeepsWorking: scene((f) => along(f, { setup: 'failed', steps: 3, secs: 130 })),
  SetupLaterChatCreatingWorktree: scene((f) => setupWait(f, 'setup', [{ ...setupAsk, clientId: setupAsk.id }], { pending: {}, later: true, panel: false })),
  SetupLaterChatFailed: scene((f) => along(f, { setup: 'failed', steps: 1, later: true, secs: 51 })),
  // The first chat after its message went out: the block is gone and the agent's turn follows.
  SetupLaterChat: scene((f) => along(f, { setup: 'done', steps: 3, later: true })),
  // A setup run that ran past its limit is a toast too.
  SetupTimedOut: scene((f) => along(f, { setup: 'timeout', steps: 3, secs: 330 })),
  // 6.12: the chat loading, one started from an issue, an edit pulled back into the box, and the Setup tab offering a script it found.
  SetupEditQueued: scene((f) => setupWait(f, 'setup', [], { pending: {}, panel: false, composer: { parts: [...setupAsk.parts], draft: '' } })),
  // The worktree is made while the first message goes out: one step per frame as main sends it. The bubble and the Working line stay in one place, and no setup text or queue strip shows.
  NewChatSendWorktreeMotion: { ...scene((f) => ({ ...setupWait(f, 'setup', [{ ...setupAsk, clientId: setupAsk.id }], { pending: {} }), projectSettings: handoverSettings })), motion: { action: { steps: handoverSteps() }, ms: 0, area: '.ws-main' } },
  /** Every row of a Lead turn reads as a sentence with its service's mark (KERNEL-782). The turn has no result, so nothing folds and every step shows. */
  WorkspaceLeadSteps: scene((f) => {
    // scene2 sets approvals only when it is given some; an undefined one would hide the seed's.
    const { approvals: _none, ...rest } = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Settings save feedback', leadSteps, {}, { model: 'claude-opus-5-5' })
    return rest
  }),
  /** Running, done, failed and denied steps of Bash with and without a description, Edit, Read and an MCP tool the app has no mark for, and a command with tokens in it (KERNEL-782). */
  WorkspaceLeadStepOpen: scene((f) => { const { approvals: _none, ...rest } = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Settings save feedback', leadSteps, {}, { model: 'claude-opus-5-5' }); return rest }),
  WorkspaceLeadStepsOpen: scene((f) => { const { approvals: _none, ...rest } = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Settings save feedback', leadSteps, {}, { model: 'claude-opus-5-5' }); return rest }),
  /** 11.1: running, done, failed and denied. The failed step's title and icon are red, a denied one says Denied, and the one in flight has the loader. */
  WorkspaceStepStates: scene((f) => works(f, [
    jBrief(ago(60)), jRun6(ago(50)), jTypes(ago(40)),
    tool('j-denied', 'Run', 'rm -rf ~/Library/Application\\ Support/Kernel-qa', { name: 'Bash', ts: ago(30), status: 'failed', durationMs: 100, output: DENIED_OUTPUT, input: { command: 'rm -rf ~/Library/Application\\ Support/Kernel-qa' } }),
    jShots(ago(12), { status: 'running', durationMs: undefined, output: undefined })
  ], { running: true, view: { toolCalls: 'open' } })),
  /** 7.2: a turn running. The Working header with the loader and the clock, the steps under it with the finished ones in place, and the step in flight with its own loader. The shot opens the command's result. */
  WorkspaceTurnRunning: scene((f) => works(f, [
    jBrief(ago(74)), jRead(ago(70)), jIssue(ago(64)), jRun15(ago(60)),
    jSay('j-s1', ago(16), 'Steps 1 to 5 pass on a clean account. Capturing every screen now, so step 6 can compare the review screen with the release candidate.'),
    jShots(ago(12), { status: 'running', durationMs: undefined, output: undefined })
  ], { running: true })),
  /** 7.4: a turn ends. The fold open on its steps with Teng's thinking in italics and what it said between them, then the reply, the files card and the time line. */
  WorkspaceTurnFolded: scene((f) => works(f, jDay(), { view: { toolCalls: 'open' } })),
  WorkspaceTurnFoldedOpen: scene((f) => works(f, jDay(), { view: { toolCalls: 'open' } })),
  /** 12.1: a turn that ends on text: the closed fold, the reply and the time line. */
  WorkspaceTurnEndsOnText: scene((f) => works(f, [jBrief(J(42, 50)), jRun15(J(43)), jSay('j-e', J(43, 50), 'Step 3 passes on the fresh account too. The flaky wait was the Dock bouncing, not Kernel.'), jResult(J(43, 52), 62_000)])),
  /** 12.2: a turn that ends on a tool call: the last step stays in view under the closed fold. */
  WorkspaceTurnEndsOnTool: scene((f) => works(f, [
    jBrief(J(51, 40)), mcpCall('j-cmt', 'linear', 'save_comment', { id: 'KERNEL-232', body: 'All six steps pass on a clean account.' }, { ts: J(52, 10), durationMs: 900, output: 'Comment posted' }), jResult(J(52, 24), 44_000)
  ])),
  /** 12.7: you stopped the turn: its fold, one quiet line, and the time with the actions. */
  WorkspaceTurnStopped: scene((f) => works(f, [jBrief(J(29, 28)), jRead(J(29, 33)), jRun15(J(29, 40)), { kind: 'interrupted', id: 'j-stop', ts: J(30, 30) }, jResult(J(30, 30), 62_000, { ok: false, error: 'Interrupted' })])),
  /** 12.8: a failed turn is a quiet line and a toast with Retry. */
  WorkspaceTurnFailed: scene((f) => works(f, [jBrief(J(32, 45)), jRead(J(32, 50)), jRun15(J(32, 56)), jResult(J(33, 33), 48_000, { ok: false, error: "Anthropic's API is overloaded (529)." })], {
    toasts: [{ id: 'turn-failed', title: "Teng's turn failed", sub: "Anthropic's API is overloaded (529).", detail: JOURNEY_TITLE, glyph: 'error', action: { label: 'Retry', retryNow: ids.tableChat, primary: true } }]
  })),
  /** 12.9: the turn was cut off when Kernel quit: its last step stays in view, and Continue picks it up. */
  WorkspaceTurnOrphaned: scene((f) => works(f, [jBrief(J(43)), jRead(), jRun15(), jShots(J(45, 40), { status: 'failed', durationMs: undefined, output: 'Stopped when Kernel quit' })])),
  /** 7.3: steps and tool calls. A finished turn with its fold open: reads, commands, an edit and a new file, a failed check in red, and the reply with the files it changed. The shot opens the edit and the failure. */
  WorkspaceToolCalls: scene((f) => works(f, jDay(), { view: { toolCalls: 'open' } })),
  /** 11.2: an opened command: what it exited with and after how long, then its output. The shot opens the row. */
  WorkspaceStepCardBash: scene((f) => works(f, [jBrief(), jRun15(), jSay('j-b', J(44), 'Steps 1 to 5 pass on a clean account.'), jResult(J(44, 5), 66_000)], { view: { toolCalls: 'open' } })),
  /** 11.4: an opened MCP call reads as what it did: its fields, then what came back, with the link it made. */
  WorkspaceStepCardMcp: scene((f) => works(f, [
    jBrief(), mcpCall('j-mcp', 'linear', 'save_issue', { team: 'Kernel', title: 'Review screen is 2px taller on a clean account', labels: ['Bug', 'Workspace'] }, { ts: J(44), durationMs: 1200, output: 'Created KERNEL-1090 https://linear.app/cj-jutba/issue/KERNEL-1090' }),
    jSay('j-m', J(44, 10), 'Filed the difference as KERNEL-1090.'), jResult(J(44, 12), 70_000)
  ], { view: { toolCalls: 'open' } })),
  /** 11.5: Codex's patch opens per file, each with its counts and its lines. */
  WorkspaceStepCardCodexDiff: scene((f) => works(f, [
    jBrief(),
    tool('j-patch', 'Apply patch', '', { name: 'Edit', ts: J(44), durationMs: 150, input: {}, output: [
      codexPatch('test/journey.test.ts', ["  await shots(['Review'])"], ["  await shots(['Review', 'ReviewRc'])", "  expect(diff('Review', 'ReviewRc')).toBeLessThan(0.01)"], ["import { shots, diff } from './support'"]),
      codexPatch('fixtures/index.ts', [], ["export { ReviewRc } from './journey'"], ["export { Review } from './review'"])
    ].join('\n') }),
    jSay('j-p', J(44, 10), 'Added the release candidate fixture.'), jResult(J(44, 12), 70_000)
  ], { view: { toolCalls: 'open' } })),
  /** 11.3: an opened new file shows its first lines, all added, and how many more there are. The shot opens the row. */
  WorkspaceStepCardWrite: scene((f) => works(f, [jBrief(), jWrite(J(44)), jSay('j-w', J(44, 10), 'Added the release candidate fixture.'), jResult(J(44, 12), 70_000)], { view: { toolCalls: 'open' } })),
  /** 11.6: several steps opened at once, a passing one and a failing one with its output in red. The shot opens both. */
  WorkspaceRowsOpen: scene((f) => works(f, [jBrief(), jRun6(J(44)), jTypes(J(44, 30)), jSay('j-ro', J(45), 'Step 6 passes, and the typecheck has one error in my test.'), jResult(J(45, 5), 120_000)], { view: { toolCalls: 'open' } })),
  /** 11.7: every step folded, one line each. */
  WorkspaceRowsFolded: scene((f) => works(f, [jBrief(), jRead(), jIssue(), jRun15(), jShots(), jEdit(), jSay('j-rf', J(47), jReply), jResult(J(47, 5), 240_000)], { view: { toolCalls: 'open' } })),
  /** 11.8: reading an image. The step says Read and the path, like any other file. */
  WorkspaceReadImage: scene((f) => ({
    ...works(f, [
      jBrief(), tool('j-img1', 'Read', 'shots/ReviewRc.png', { name: 'Read', ts: J(44), durationMs: 90, input: { file_path: 'shots/ReviewRc.png' } }), jRead(J(44, 20)),
      jSay('j-ri', J(44, 40), 'The release candidate shot matches the checklist.'), jResult(J(44, 45), 90_000)
    ], { view: { toolCalls: 'open' } }),
    images: { [ids.table]: { 'worktree:shots/ReviewRc.png': { dataUrl: imageAfter } } }
  })),
  /** 11.9: the image opened in a file tab: the step's Open in a tab link opens it, headed by its path (KERNEL-671). scripts/shots.ts does the clicks. */
  WorkspaceReadImageTab: scene((f) => ({
    ...works(f, [jBrief(), tool('j-img1', 'Read', 'shots/ReviewRc.png', { name: 'Read', ts: J(44), durationMs: 90, input: { file_path: 'shots/ReviewRc.png' } }), jSay('j-ri', J(44, 40), 'The release candidate shot matches the checklist.'), jResult(J(44, 45), 90_000)], { view: { toolCalls: 'open' } }),
    images: { [ids.table]: { 'worktree:shots/ReviewRc.png': { dataUrl: imageAfter } } }
  })),
  /** 11.10: the image previews under its step, with its size and a link that opens it in a tab. */
  WorkspaceReadImagePreview: scene((f) => ({
    ...works(f, [jBrief(), tool('j-img1', 'Read', 'shots/ReviewRc.png', { name: 'Read', ts: J(44), durationMs: 90, input: { file_path: 'shots/ReviewRc.png' } }), jSay('j-ri', J(44, 40), 'The release candidate shot matches the checklist.'), jResult(J(44, 45), 90_000)], { view: { toolCalls: 'open' } }),
    images: { [ids.table]: { 'worktree:shots/ReviewRc.png': { dataUrl: imageAfter } } }
  })),
  /** 11.11: the file is gone, so the step says so. */
  WorkspaceReadImageMissing: scene((f) => works(f, [jBrief(), tool('j-img1', 'Read', 'shots/ReviewRc.png', { name: 'Read', ts: J(44), durationMs: 90, input: { file_path: 'shots/ReviewRc.png' } }), jSay('j-ri', J(44, 40), 'The release candidate shot is gone, so I ran the comparison from the saved copy.'), jResult(J(44, 45), 90_000)], { view: { toolCalls: 'open' } })),
  /** KERNEL-1025: a denied group that says it once, a one-call group with no parent row, footers only on the last turn, and a run of three notes folded to one line. */
  WorkspaceQuietTranscript: scene(() => ({
    items: { [ids.tableChat]: quietChat },
    ui: open
  })),
  /** 15.1: quiet turns with Kernel's notes between them, each one line that opens to what Kernel told the agent. */
  WorkspaceQuietTranscriptNotes: scene((f) => works(f, [
    { kind: 'user', id: 'qn-u1', ts: J(1, 0), parts: [{ type: 'text', text: 'Rerun step 3 on the fresh account.' }] }, jTool('qn-t1', J(1, 5), 'pnpm test:journey --steps 3', 'Run step 3', { durationMs: 30_000 }), jSay('qn-x1', J(1, 30), 'Step 3 passes on the fresh account too.'), { kind: 'result', id: 'qn-r1', ts: J(1, 38), durationMs: 38_000, ok: true },
    { kind: 'user', id: 'qn-m1', ts: J(2), from: 'kernel', parts: [{ type: 'text', text: 'The Mac slept for 40 minutes, so Kernel resumed this chat when it woke. Carry on from where you stopped.' }] },
    { kind: 'user', id: 'qn-u2', ts: J(3, 0), parts: [{ type: 'text', text: 'And step 4.' }] }, jTool('qn-t2', J(3, 5), 'pnpm test:journey --steps 4', 'Run step 4', { durationMs: 40_000 }), jSay('qn-x2', J(3, 40), 'Step 4 passes as well.'), { kind: 'result', id: 'qn-r2', ts: J(3, 51), durationMs: 51_000, ok: true },
    { kind: 'user', id: 'qn-m2', ts: J(4), from: 'kernel', parts: [{ type: 'text', text: 'Kernel moved this chat to Work account after Main hit its limit. You are continuing on a different account, so check git status first.' }] }
  ])),
  /** A long chat right after a send (KERNEL-891): the message is the last row at the end of the thread with the Working line under it. scripts/shots.ts delivers the send after the chat opens at its end. */
  WorkspaceJustSentLong: scene((f) => ({
    items: { [ids.tableChat]: longChat },
    push: [...f.push, { type: 'chat.running', chatId: ids.tableChat, running: true }],
    ui: open
  })),
  /** A short reply that has finished (KERNEL-891): the message and its reply are the last rows, and the end of the turn moved nothing. scripts/shots.ts delivers the send, the reply and the end of the turn after the chat opens. */
  WorkspaceJustSentDone: scene((f) => ({
    items: { [ids.tableChat]: tableItems.slice(0, 1) },
    push: f.push,
    ui: open
  })),
  /** The first message sent from New chat (KERNEL-891): the chat opens with it at the top of the short, top-aligned thread and the Working line under it. The fixture starts on New chat, and scripts/shots.ts types the message and sends it. */
  WorkspaceNewChatJustSent: scene((f) => {
    const base = noPlan(leadNoChats(f))
    return {
      ...base,
      leadStart: ids.leadChat,
      items: { [ids.leadChat]: [{ kind: 'user' as const, id: 'nc-u1', ts: Date.now() - 2000, parts: [{ type: 'text' as const, text: 'Add a CSV export for the filtered invoice rows.' }] }] },
      push: [...f.push, { type: 'chat.running', chatId: ids.leadChat, running: true }]
    }
  }),
  /**
   * One-frame sends (KERNEL-895), each a user action as motion. Main answers late (`lag`) and then pushes what the engine does, with the window's id on the row (`$id`), so the sheet shows
   * the frame after the action already in its final layout and the engine's confirmation arriving in place. Frame 0 is 150ms after the action, before main has answered.
   * The first message sent from New chat: the chat opens with the message and the Working line already drawn.
   */
  WorkspaceNewChatSendMotion: { ...scene((f) => {
    const base = noPlan(leadNoChats(f))
    return {
      ...base,
      leadStart: ids.leadChat,
      items: { [ids.leadChat]: [] },
      lag: { 'lead.start': 500 },
      after: { 'lead.start': sentAfter(ids.leadChat) },
      ui: { ...base.ui!, workspace: { right: 'changes', bottom: 'run', composer: { parts: [], draft: 'hi this is a test prompt' } } }
    }
  }), motion: { action: { click: 'Send' }, ms: 1500, area: '.ws-main' } },
  /** A send from New chat that fails: the message and the Working line show at once, then the page comes back with the text still in the box and a toast says why. */
  NewChatSendFailedMotion: { ...scene((f) => {
    const base = noPlan(leadNoChats(f))
    return {
      ...base,
      lag: { 'lead.start': 500 },
      fails: { 'lead.start': 'Kernel could not reach the remote.' },
      ui: { ...base.ui!, workspace: { right: 'changes', bottom: 'run', composer: { parts: [], draft: 'hi this is a test prompt' } } }
    }
  }), motion: { action: { click: 'Send' }, ms: 1000, area: '.ws-main' } },
  /** A typed send in a short chat: the message appears at the end at once and nothing moves besides the new row. */
  WorkspaceSendShortMotion: { ...scene(() => ({
    ...withDraft({ items: { [ids.tableChat]: tableItems.slice(0, 1) }, ui: open }, 'Now add a CSV export for the filtered rows.'),
    lag: { 'chats.send': 500 }, after: { 'chats.send': sentAfter(ids.tableChat) }
  })), motion: { action: { click: 'Send' }, ms: 1500, area: '.ws-main' } },
  /** A typed send in a long chat: the view is at its end, and the message appears there at once with no scroll. */
  WorkspaceSendLongMotion: { ...scene(() => ({
    ...withDraft({ items: { [ids.tableChat]: longChat }, ui: open }, 'Now add a CSV export for the filtered rows.'),
    lag: { 'chats.send': 500 }, after: { 'chats.send': sentAfter(ids.tableChat) }
  })), motion: { action: { click: 'Send' }, ms: 1500, area: '.ws-main' } },
  /** Composer send in an empty tab (the maintainer's GIF): three lines in the box. The welcome gives way to the thread, the box clears and the placeholder, Send and the Working line change in the frame of the click. */
  WorkspaceSendEmptyMotion: { ...scene((f) => ({
    chats: [...f.chats, extraChat('chat-new', 'New chat')],
    items: { 'chat-new': [] },
    lag: { 'chats.send': 500 }, after: { 'chats.send': sentAfter('chat-new') },
    ui: { ...tabsView('chat-new'), workspace: { right: 'changes', bottom: 'run', composer: { parts: [], draft: 'Add a CSV export for the filtered invoice rows.\nKeep the current column order.\nName the file invoices.csv.' } } }
  })), motion: { action: { click: 'Send' }, ms: 1500, area: '.ws-main' } },
  /** A starter suggestion in an empty tab: the welcome switches straight to the thread with the message. */
  WorkspaceSuggestionMotion: { ...scene((f) => ({
    chats: [...f.chats, extraChat('chat-new', 'New chat')],
    items: { 'chat-new': [] },
    lag: { 'chats.send': 500 }, after: { 'chats.send': sentAfter('chat-new') },
    ui: tabsView('chat-new')
  })), motion: { action: { click: 'Explain this branch' }, ms: 1500, area: '.ws-main' } },
  /** Ask to fix on a failed turn: the message and the Working line appear together under the error. */
  WorkspaceAskFixMotion: { ...scene(() => ({
    items: { [ids.tableChat]: errorItems },
    lag: { 'chats.send': 500 }, after: { 'chats.send': sentAfter(ids.tableChat) },
    ui: open
  })), motion: { action: { click: 'Ask Christian to fix' }, ms: 1500, area: '.ws-main' } },
  /** Retry on a failed turn: the copy of the message and the Working line appear together. */
  WorkspaceRetryMotion: { ...scene(() => ({
    items: { [ids.tableChat]: errorItems },
    lag: { 'chats.retry': 500 }, after: { 'chats.retry': sentAfter(ids.tableChat, [{ type: 'text', text: 'Run the full test suite before I open the PR.' }]) },
    ui: open
  })), motion: { action: { click: 'Retry' }, ms: 1500, area: '.ws-main' } },
  /** A send whose call fails: the bubble and Working line are drawn at once, then everything goes and the text is back in the box. */
  WorkspaceSendFailsMotion: { ...scene(() => ({
    ...withDraft({ items: { [ids.tableChat]: tableItems.slice(0, 1) }, ui: open }, 'Now add a CSV export for the filtered rows.'),
    lag: { 'chats.send': 500 }, fails: { 'chats.send': 'Kernel did not answer.' }
  })), motion: { action: { click: 'Send' }, ms: 1500, area: '.ws-main' } },
  /** Send now on a queued message: the row leaves the tray and the bubble appears in the same frame. */
  WorkspaceSendNowMotion: { ...scene((f) => ({
    items: { [ids.tableChat]: queuedItems() },
    queue: { [ids.tableChat]: [{ id: 'q1', chatId: ids.tableChat, ts: at(10, 30), clientId: 'q1', parts: [{ type: 'text', text: 'Also add a loading skeleton to the table' }] }] },
    lag: { 'chats.sendNow': 500 },
    after: { 'chats.sendNow': [{ afterMs: 0, events: [runningEvent(ids.tableChat, false), { type: 'chat.queue', chatId: ids.tableChat, queue: [] }, sentRow(ids.tableChat), runningEvent(ids.tableChat, true)] }] },
    push: [...f.push, runningEvent(ids.tableChat, true)],
    ui: open
  })), motion: { action: { click: 'Send now' }, ms: 1500, area: '.ws-main' } },
  /** A queued message posting when the turn ends: the row leaves the tray and the bubble and the Working line arrive in one frame. Nothing was pressed, main pushes the three events. */
  WorkspaceQueuePostsMotion: { ...scene((f) => ({
    items: { [ids.tableChat]: queuedItems() },
    queue: { [ids.tableChat]: [{ id: 'q1', chatId: ids.tableChat, ts: at(10, 30), clientId: 'q1', parts: [{ type: 'text', text: 'Also add a loading skeleton to the table' }] }] },
    push: [...f.push, runningEvent(ids.tableChat, true)],
    ui: open
  })), motion: { action: { push: [runningEvent(ids.tableChat, false), { type: 'chat.queue', chatId: ids.tableChat, queue: [] }, sentRow(ids.tableChat, { id: 'q1', parts: [{ type: 'text', text: 'Also add a loading skeleton to the table' }] }), runningEvent(ids.tableChat, true)] }, ms: 1000, area: '.ws-main' } },
  /** A plan's change request with an image: the answer row, image included, is drawn in the frame of the click, and the strip leaves with it. */
  WorkspacePlanChangesImageMotion: { ...scene((f) => {
    const s = planWaiting(f)
    const id = s.approvals?.[0]?.id ?? ''
    const image = { type: 'image' as const, name: 'sketch.png', dataUrl: PIXEL, width: 160, height: 100 }
    return {
      ...withDraft(s, 'Split step 2 into its own PR, after step 1 merges.'),
      ui: { ...s.ui, workspace: { right: 'changes', bottom: 'run', composer: { parts: [image], draft: 'Split step 2 into its own PR, after step 1 merges.' } } },
      lag: { 'approvals.decide': 500 },
      after: { 'approvals.decide': [{ afterMs: 0, events: [{ type: 'chat.item', chatId: ids.leadChat, item: { kind: 'user', id: `answer-${id}`, ts: Date.now(), approvalId: id, parts: [{ type: 'text', text: 'Split step 2 into its own PR, after step 1 merges.' }, image] } }] }] }
    }
  }), motion: { action: { click: 'Send plan adjustments' }, ms: 1500, area: '.ws-main' } },
  /**
   * After a plan strip has closed, typing a letter and deleting it shows the normal placeholder on every frame (KERNEL-895). The plan placeholder never shows over it.
   */
  WorkspacePlaceholderMotion: { ...scene(planWaiting), motion: { action: { press: ['click:Approve', 'a', 'Backspace'] }, ms: 900, area: '.cmp' } },
  /** A chat left and come back to after its turn ended (KERNEL-765): it opens at its end, where it was left. scripts/shots.ts sends, finishes the turn, opens another tab and returns. */
  WorkspaceLeaveAndReturn: scene((f) => ({
    chats: [...f.chats, extraChat('chat-other', 'Empty state copy')],
    items: { [ids.tableChat]: tableItems.slice(0, 1), 'chat-other': [userMsg('o1', 'Shorten the empty state copy.')] },
    push: f.push,
    ui: tabsView(ids.tableChat)
  })),
  /** A long chat with shared image cards, read from higher up and shown again after leaving it, with the Scroll to bottom button over it (KERNEL-765). The scroll is the transcript's own, so scripts/shots.ts scrolls it up before the shot. */
  ChatRestoredSpot: scene(() => ({
    items: { [ids.tableChat]: [
      ...longChat.slice(0, 6),
      { kind: 'shared' as const, id: 'rs-i1', ts: at(10, 30), sharedId: 'sh-image', version: 1 },
      { kind: 'shared' as const, id: 'rs-i2', ts: at(10, 31), sharedId: 'sh-image', version: 1 },
      { kind: 'shared' as const, id: 'rs-i3', ts: at(10, 31), sharedId: 'sh-image', version: 1 },
      ...longChat.slice(6)
    ] },
    shared: sharedFiles().filter((x) => x.workspaceId === ids.table),
    sharedData: sharedStills,
    ui: open
  })),
  ChatRailLead: scene((f) => railLead(f)),
  // one-lead-chat: a chat with Kernel that changed the refund rounding itself and handed the export to Sean, in one thread. Its changes are open, its PR is up, and Sean's workspace is the team's.
  WorkspaceLeadDidAndHandedOff: scene((f) => {
    const s = leadScene(f, {
      right: 'prs', ws: { ...lmPr, prState: 'ready', stat: { files: 2, added: 33, removed: 3 } },
      items: [
        { kind: 'text', id: 'lm-b-x', ts: at(10, 3), text: 'I rounded refunds half away from zero in money.ts and added a test for the cent case. The export has its own rounding, which is a separate lane, so Sean has it.' },
        mcpCall('lm-b-t1', 'kernel', 'create_workspace', { agent: 'sean', title: 'Round refunds in the CSV export', brief: 'The export rounds half to even. Match money.ts.' }, { output: 'Created ws-export on feat/refund-export for sean.' }),
        ...lmReply('lm-b', 'I opened PR #171 and started Sean on the export. I will tell you when it is ready.', 6)
      ]
    })
    return s
  }),
  WorkspaceLeadOwnPrReview: scene((f) => leadScene(f, {
    right: 'changes', changes: lmFiles, ws: { ...lmPr, prState: 'ready' },
    items: lmReply('lm-b', 'I opened PR #171. Checks passed and it has no conflicts.', 6)
  })),
  WorkspaceLeadOwnPrMerged: scene((f) => leadScene(f, {
    right: 'changes', ws: { ...lmPr, prState: 'merged', mergedAt: at(10, 20) },
    items: lmReply('lm-b', 'PR #171 merged.', 21)
  })),
  WorkspaceLeadOwnPrReadyToMerge: scene((f) => bhScene(f, [...lmReply('lm-b', 'I committed, pushed and opened PR #171. Checks are running.', 6), bhReview('bh-u1', 10, true)], { prState: 'ready' })),
  WorkspaceLeadOwnPrReadyNoReview: scene((f) => bhScene(f, [...lmReply('lm-b', 'I committed, pushed and opened PR #171.', 6), bhReady], { prState: 'ready' })),
  WorkspaceLeadOwnPrMergedRows: scene((f) => bhScene(f, [...lmReply('lm-b', 'I committed, pushed and opened PR #171.', 6), bhReview('bh-u1', 10, true), bhNote('bh-n3', 20, 'PR #171 was squashed into main. Next changes start on a new branch', 'merged')], { prState: 'merged', mergedAt: at(10, 20) })),
  WorkspaceLeadOwnPrKept: scene((f) => bhScene(f, [...lmReply('lm-b', 'I opened PR #171.', 6), bhReview('bh-u1', 10, true), bhNote('bh-n3', 20, 'PR #171 was squashed into main.', 'merged'), bhNote('bh-n4', 20, 'Kernel kept this branch because it has uncommitted changes. A new branch starts once nothing here is left out of the merge.')], { prState: 'merged', mergedAt: at(10, 20) })),
  WorkspaceLeadOwnPrBlockers: scene((f) => bhScene(f, [...lmReply('lm-b', 'I committed, pushed and opened PR #171.', 6), bhReview('bh-u1', 10, false), ...lmReply('lm-c', 'Artkin found two blockers in PR #171. I am fixing the export rounding and adding a test for negative refunds.', 11)], { prState: 'open' })),
  WorkspaceLeadOldSelfCard: scene((f) => bhScene(f, [
    ...lmReply('lm-b', 'I committed, pushed and opened PR #171.', 6),
    tuCard('bh-old1', 7, [{ ...tuRow(ids.lead, 'kernel-lead', 'Kernel', 'Refund rounding', [tuEv('pr.opened', 'Opened PR #171'), tuEv('pr.ready', 'Ready to merge', true), tuEv('pr.review', 'Code approved')]), prNumber: 171 }]),
    ...lmReply('lm-c', 'PR #171 is ready to merge. Artkin approved it.', 12),
    tuCard('bh-old2', 13, [{ ...tuRow(ids.lead, 'kernel-lead', 'Kernel', 'Refund rounding', [tuEv('pr.cifail', 'Checks failed', true)]), prNumber: 171 }]),
    ...lmReply('lm-d', 'A check failed on PR #171. I am looking at it.', 14)
  ], { prState: 'cifail' })),
  // An old chat that was switched between Hand off and Build here: the dividers and Kernel's suggestions read as plain notes, with no Switch button.
  WorkspaceLeadOldSuggestions: scene((f) => leadScene(f, {
    right: 'changes', changes: lmFiles,
    items: [
      { kind: 'leadMode', id: 'lm-d1', ts: at(10, 2), mode: 'build' },
      ...lmReply('lm-b', 'Rounding is shared by invoices, credit notes and the export. That touches 14 files across three modules.', 4),
      { kind: 'modeSuggestion', id: 'lm-s1', ts: at(10, 5), mode: 'handoff', why: 'This change touches 14 files across three modules.' },
      { kind: 'leadMode', id: 'lm-d2', ts: at(10, 8), mode: 'handoff' },
      { kind: 'leadMode', id: 'lm-d3', ts: at(10, 9), mode: 'build' },
      ...lmReply('lm-c', 'The export also needs the same rounding, which is another 6 files.', 11),
      { kind: 'modeSuggestion', id: 'lm-s2', ts: at(10, 12), mode: 'handoff', why: 'The export adds 6 more files. Splitting it between teammates keeps each PR small.' }
    ]
  })),
  // A chat with edits of its own that is handing work to Sean: the note under the message box says teammates start from main and won't see them.
  WorkspaceLeadUncommitted: scene((f) => leadScene(f, {
    changes: lmFiles,
    items: lmReply('lm-a', 'Sean has it. Your edits in this chat stay where they are.', 3)
  })),
  // KERNEL-1052: a chat from before every chat got a folder of its own, still on the project's shared main folder and not the project's first. Changes and Run say there is nothing of its own until its next message, Create PR is off with the reason, and no setup rows show (KERNEL-1053).
  WorkspaceLeadSharedFolder: scene((f) => leadScene(f, {
    right: 'changes', ws: { shared: true, branch: 'HEAD', firstInProject: false },
    items: lmReply('lm-a', 'Sean has it. I read the latest main, so I do not have a worktree of my own.', 1)
  })),
  // KERNEL-1053: the first chat of a newly added project is on the shared folder, so its one-time block has a banner for a chat with no branch and the setup script line, but no worktree rows.
  WorkspaceLeadFirstChat: scene((f) => {
    const s = leadScene(f, { right: 'changes', ws: { shared: true, branch: 'HEAD', firstInProject: true }, items: [] })
    return {
      ...s,
      projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, firstChatId: ids.leadChat } : r)),
      projectSettings: { [ids.projectA]: { scripts: {}, runScripts: [], files: { copy: [] }, workspace: {} } },
      items: { [ids.leadChat]: [] }
    }
  }),
  // KERNEL-1053: a chat from the shared folder holds its message because its working copy failed. One line under the message, with Try again.
  WorkspaceLeadCopyFailed: scene((f) => {
    const q: QueuedMessage[] = [{ id: 'lm-q1', chatId: ids.leadChat, ts: at(10, 3), parts: [{ type: 'text', text: 'The invoice total is off by a cent on refunds. Can you fix it?' }] }]
    const s = leadScene(f, { right: 'changes', ws: { status: 'failed', shared: true, branch: 'HEAD', firstInProject: false, worktreePending: { fromShared: true, error: "fatal: a branch named 'cjjutba/refund-rounding' already exists" } }, items: [] })
    return {
      ...s,
      items: { [ids.leadChat]: [] },
      queue: { [ids.leadChat]: q },
      push: [...(s.push ?? f.push), { type: 'chat.queue' as const, chatId: ids.leadChat, queue: q, why: 'worktree' as const }]
    }
  }),
  ChatRailNarrow: railScene(true),
  WorkspaceNewChat: scene((f) => ({
    chats: [...f.chats, extraChat('chat-new', 'New chat')],
    items: { 'chat-new': [] },
    ui: { ...tabsView('chat-new'), menu: 'newTab' }
  })),
  // KERNEL-841: the choice of a chat that waits to move, before its next turn re-reads 310k tokens on another account. A card in the chat with numbered rows (KERNEL-1094). The key variant adds the price.
  ChatMoveNotice: scene((f) => ({ ...works(f, jRest(), { chat: { ranOn: 'cli' } }), accounts: moveAccounts(), moveNotices: { [ids.tableChat]: { kind: 'move', reason: 'account', from: 'cli', to: 'third', tokens: 310_000, keep: true } } })),
  ChatMoveNoticeApiKey: scene((f) => ({ ...works(f, jRest(), { chat: { ranOn: 'cli' } }), accounts: moveAccounts(), moveNotices: { [ids.tableChat]: { kind: 'move', reason: 'account', from: 'cli', to: 'key', tokens: 310_000, price: 4.7, keep: true } } })),
  SettingsAccountsMoves: scene(() => ({ accounts: moveAccounts(), ui: { route: { name: 'settings', page: 'accounts' } } })),
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
  // ---- Redesign 09, Review the work (KERNEL-1096). 9.1 to 9.14 follow the flow, and the sheets 9.15 to 9.22 hold the smaller states, each next to the frame it belongs to.
  // 9.1: the title bar's tabs and view toggles. One chat waits on an answer, one works and one is a terminal.
  WorkspaceTabStates: scene((f) => { const w = works(f, jRest()); return { ...w, ...r9Tabs(f, w) } }),
  // 9.2: Focus mode. The sidebar, the rail and the panel are hidden and the title bar says how to come back.
  WorkspaceFocus: scene((f) => { const w = works(f, jRest()); return { ...w, ...r9Tabs(f, w), ui: { ...open, sidebar: false, rail: false, rightPanel: false, workspace: { right: 'changes', bottom: 'run' } } } }),
  // Focus mode with an update ready: the Update pill takes the title bar's right end, and the view toggles stay clear of it (Redesign 17 noted it could cover them).
  WorkspaceFocusUpdate: scene((f) => { const w = works(f, jRest()); return { ...w, ...r9Tabs(f, w), update: { status: 'ready', current: '0.42.0', version: '0.43.0', notes: [{ title: 'Improved', body: 'The right panel has Files, Changes, Review and Pull request tabs.' }] }, ui: { ...open, sidebar: false, rail: false, rightPanel: true, workspace: { right: 'changes', bottom: 'run' } } } }),
  // 9.3 to 9.6: Files and Changes in the panel, then the same file and diff in a tab of their own, with the Session rail beside them.
  WorkspaceFilesTree: scene((f) => review9(f, { right: 'files' })),
  WorkspaceFile: scene((f) => review9(f, { rail: true, tab: 'file:test/journey.test.ts', files: ['test/journey.test.ts'] })),
  WorkspaceChangesList: scene((f) => review9(f, { right: 'changes' })),
  WorkspaceDiffTab: scene((f) => review9(f, { rail: true, tab: 'diff:test/journey.test.ts', diffs: ['test/journey.test.ts'] })),
  // 9.7 and 9.8: Review and Pull request, each a screen of the panel.
  WorkspaceReview: scene((f) => review9(f, { right: 'review', reviewed: true })),
  WorkspacePullRequest: scene((f) => review9(f, { right: 'pr', reviewed: true, ws: { reviews: [{ ...R9_REVIEW[0], verdict: 'approved', summary: 'Looks right.', blockers: undefined, ts: Date.now() - 4 * MIN }] } })),
  // 9.9 and 9.10: the panel over its bottom pane, on the Terminal tab and on the Run tab with `shots` running.
  PanelSplit: scene((f) => { const s = review9(f, { right: 'changes', bottom: 'run', pane: true }); return { ...s, push: [...s.push!, ...['$ git status --short', ' M test/journey.test.ts', '?? fixtures/journey.ts', '$ pnpm test test/journey.test.ts', '✓ test/journey.test.ts (3 tests) 9.8s', '  Tests  3 passed (3)'].map((line): PushEvent => ({ type: 'script.output', workspaceId: ids.table, kind: 'run', name: 'app', lines: [{ line, stream: 'stdout' }] }))] } }),
  WorkspaceRunScripts: scene((f) => {
    const run = review9(f, { right: 'changes', bottom: 'run', pane: true })
    const lines = ['$ pnpm shots --all --no-build', 'Reusing the last build from 13:46', 'Rendering 782 fixtures at 1440x900', '✓ Workspace  0.4s', '✓ WorkspaceTurnRunning  0.5s', '✓ WorkspaceToolCalls  0.6s', '✓ Review  0.5s', '✓ ReviewRc  0.5s', '… WorkspaceQuestion', '214 of 782 saved to shots/']
    return { ...run, push: [...run.push!, ...lines.map((line): PushEvent => ({ type: 'script.output', workspaceId: ids.table, kind: 'run', name: 'shots', lines: [{ line, stream: 'stdout' }] }))] }
  }),
  // 9.12: shared files. A file an agent shares is a plain card in the chat, its images laid out by count: one fills the card, two sit side by side, three put one large beside two, four make a grid and more show +N.
  WorkspaceSharedCard: scene((f) => r9Images(f, 2)),
  // 9.15: tabs and the title bar.
  WorkspaceTabMenu: scene((f) => { const w = works(f, jRest()); return { ...w, ...r9Tabs(f, w), ui: { ...open, rightPanel: false, menu: 'tab', workspace: { right: 'changes', bottom: 'run' } } } }),
  NewTabMenu: scene((f) => { const w = works(f, jRest()); return { ...w, ...r9Tabs(f, w), ui: { ...open, rightPanel: false, menu: 'newTab', workspace: { right: 'changes', bottom: 'run' } } } }),
  HeaderBranchTooltip: scene((f) => works(f, jRest())),
  WorkspaceHistoryButtons: scene((f) => ({ ...works(f, jRest()), ui: { ...open, rightPanel: false, nav: { canBack: true, canForward: false }, workspace: { right: 'changes', bottom: 'run' } } })),
  WorkspaceHistoryButtonsHidden: scene((f) => { const w = works(f, jRest()); return { ...w, ...r9Tabs(f, w), ui: { ...open, rightPanel: false, sidebar: false, nav: { canBack: true, canForward: true }, workspace: { right: 'changes', bottom: 'run' } } } }),
  // 9.16 and 9.17: the Files and Changes toolbars, the file tree while it loads, the changes as a tree, the filter and the compare menu, and an image in a diff.
  WorkspaceFilesLoading: { ...scene((f) => review9(f, { right: 'files' })), lag: { 'workspaces.tree': 600_000 } },
  PanelToolbarFiles: scene((f) => review9(f, { right: 'files' })),
  WorkspaceChangesTree: scene((f) => review9(f, { right: 'changes', view: { changesView: 'tree' } })),
  PanelToolbarChanges: scene((f) => review9(f, { right: 'changes', view: { changesView: 'list' } })),
  PanelFilter: scene((f) => review9(f, { right: 'changes' })),
  PanelCompare: scene((f) => review9(f, { right: 'changes' })),
  WorkspaceDiffImageAdded: scene((f) => r9ImageDiff(f, 'A')),
  WorkspaceDiffImageModified: scene((f) => r9ImageDiff(f, 'M')),
  PanelToolbarChecks: scene((f) => review9(f, { right: 'pr', reviewed: true })),
  // 9.18: the panel over its bottom pane. It starts folded in Kernel's chat, folds to its tab bar and still says when something runs, and Setup, Run and Terminal each have their states.
  PanelSplitLead: scene((f) => {
    const { approvals: _none, ...lead } = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'Round half away from zero', [userMsg('pl-u', 'Make the total round half away from zero, like money.ts does.')], {}, { model: 'claude-opus-5-5', plan: false })
    return { ...lead, changes: { [ids.lead]: [{ path: 'src/lib/money.ts', status: 'M' as const, added: 12, removed: 3 }, { path: 'src/lib/money.test.ts', status: 'M' as const, added: 9, removed: 0 }] }, ui: { ...lead.ui!, rightPanel: true, workspace: { right: 'changes', bottom: 'run' }, bottomCollapsed: { lead: true, teammate: false } } }
  }),
  PanelCollapsed: scene((f) => review9(f, { right: 'changes' })),
  PanelCollapsedRunning: scene((f) => {
    const s = review9(f, { right: 'changes' })
    return { ...s, push: [...s.push!, { type: 'script.output', workspaceId: ids.table, kind: 'run', name: 'app', lines: [{ line: '$ pnpm dev', stream: 'stdout' }] }] }
  }),
  PanelSetup: scene((f) => { const s = review9(f, { right: 'changes', bottom: 'setup', pane: true }); return { ...s, push: [...s.push!, ...r9SetupDone] } }),
  BottomPanelSetupRunning: scene((f) => review9(f, { right: 'changes', bottom: 'setup', pane: true, setting: true })),
  BottomPanelSetupDone: scene((f) => { const s = review9(f, { right: 'changes', bottom: 'setup', pane: true }); return { ...s, push: [...s.push!, ...r9SetupDone] } }),
  BottomPanelNoRun: scene((f) => { const s = review9(f, { right: 'changes', bottom: 'run', pane: true }); return { ...s, projectSettings: { [ids.projectA]: { scripts: { setup: 'pnpm install' }, runScripts: [], files: { copy: [] }, workspace: {} } } } }),
  WorkspaceRunEmpty: scene((f) => { const s = review9(f, { right: 'changes', bottom: 'run', pane: true }); return { ...s, projectSettings: { [ids.projectA]: { scripts: { run: 'pnpm dev', runMode: 'concurrent' }, runScripts: [{ name: 'frontend', command: 'pnpm dev' }], files: { copy: [] }, workspace: {} } } } }),
  BottomPanelRunSplit: scene((f) => { const s = review9(f, { right: 'changes', bottom: 'run', pane: true }); return { ...s, projectSettings: { [ids.projectA]: { scripts: { run: 'pnpm dev', runMode: 'concurrent' }, runScripts: [{ name: 'frontend', command: 'pnpm dev' }, { name: 'shots', command: 'pnpm shots --all' }, { name: 'tests', command: 'pnpm test' }], files: { copy: [] }, workspace: {} } }, push: [...s.push!, ...['$ pnpm dev', 'VITE v6.2.0  ready in 412 ms', '➜  Local:   http://localhost:5173/', '➜  press h + enter to show help'].map((line): PushEvent => ({ type: 'script.output', workspaceId: ids.table, kind: 'run', name: 'frontend', lines: [{ line, stream: 'stdout' }] }))] } }),
  BottomPanelRunMenu: scene((f) => { const s = review9(f, { right: 'changes', bottom: 'run', pane: true }); return { ...s, push: [...s.push!, { type: 'script.output', workspaceId: ids.table, kind: 'run', name: 'app', lines: [{ line: '$ pnpm dev', stream: 'stdout' }] }] } }),
  SharedCardOne: scene((f) => r9Images(f, 1)),
  SharedCardTwo: scene((f) => r9Images(f, 2)),
  SharedCardThree: scene((f) => r9Images(f, 3)),
  SharedCardFour: scene((f) => r9Images(f, 4)),
  SharedCardMore: scene((f) => r9Images(f, 7)),
  SharedCardPage: scene((f) => r9Shared(f, r9Files()[0], { thumb: pricingStill, still: pricingStill } as { thumb: string })),
  SharedCardNote: scene((f) => r9Shared(f, r9Files()[2], { text: R9_NOTE })),
  SharedCardPdf: scene((f) => r9Shared(f, r9Files()[3], { dataUrl: invoicePdfStill, thumb: invoicePdfStill })),
  WorkspaceSharedPanel: scene((f) => ({ ...review9(f, { rail: true }), shared: r9Files(), sharedData: { 'sh-page': { 3: { thumb: pricingStill } }, 'sh-imgs': { 2: { dataUrl: fontsCheckImage, thumb: fontsCheckImage } }, 'sh-note': { 1: { text: R9_NOTE } }, 'sh-list': { 1: { dataUrl: invoicePdfStill, thumb: invoicePdfStill } } }, settings: { ...DEFAULT_SETTINGS('/Users/you'), experimental: { ...DEFAULT_SETTINGS('/Users/you').experimental, sharing: true } } })),
  WorkspaceSharedPanelEmpty: scene((f) => ({ ...review9(f, { rail: true }), shared: [], settings: { ...DEFAULT_SETTINGS('/Users/you'), experimental: { ...DEFAULT_SETTINGS('/Users/you').experimental, sharing: true } } })),
  // 9.21: the panel's toolbars and the states they lead to. The filters, compare menu and picks are local to the tab, so scripts/shots.ts opens them as a person would.
  FilesToolbar: scene((f) => review9(f, { right: 'files' })),
  FilesFilterNoMatch: scene((f) => review9(f, { right: 'files' })),
  ChangesBaselineHidden: scene((f) => ({ ...review9(f, { right: 'changes', ws: { mode: 'current', prState: 'none' }, pr: 'none' }), changes: { [ids.table]: r9Changed } })),
  ChangesFilterNoMatch: scene((f) => review9(f, { right: 'changes' })),
  ChecksNone: scene((f) => ({ ...review9(f, { right: 'pr' }), prs: r9Pr({ checks: [], comments: [] }) })),
  ChecksBeforePr: scene((f) => review9(f, { right: 'pr', pr: 'none' })),
  SetupNoScript: scene((f) => { const s = review9(f, { right: 'changes', bottom: 'setup', pane: true }); return { ...s, push: s.push!.filter((e) => e.type !== 'script.output' && e.type !== 'script.exit'), projectSettings: { [ids.projectA]: { scripts: { run: 'pnpm dev', runMode: 'concurrent' }, runScripts: [{ name: 'app', command: 'pnpm dev' }], files: { copy: [] }, workspace: {} } }, scriptSuggestions: { [ids.projectA]: [{ source: 'detected', file: 'package.json', patch: { scripts: { setup: 'pnpm install' } }, notes: [] }] } } }),
  SetupOutputEmpty: scene((f) => { const s = review9(f, { right: 'changes', bottom: 'setup', pane: true, ws: { setupRun: undefined } }); return { ...s, push: s.push!.filter((e) => e.type !== 'script.output' && e.type !== 'script.exit') } }),
  RunAllConfigure: scene((f) => { const s = review9(f, { right: 'changes', bottom: 'run', pane: true }); return { ...s, projectSettings: { [ids.projectA]: { scripts: { run: 'pnpm dev', runMode: 'concurrent' }, runScripts: [{ name: 'app', command: 'pnpm dev --port 4400' }, { name: 'storybook', command: 'pnpm storybook' }], files: { copy: [] }, workspace: {} } }, push: [...s.push!, ...['$ pnpm dev --port 4400', 'VITE ready in 412 ms', 'Local: http://localhost:4400/'].map((line): PushEvent => ({ type: 'script.output', workspaceId: ids.table, kind: 'run', name: 'app', lines: [{ line, stream: 'stdout' }] }))] } }),
  CompareMenu: scene((f) => review9(f, { right: 'changes' })),
  CompareBranches: scene((f) => review9(f, { right: 'changes' })),
  CompareCommits: scene((f) => review9(f, { right: 'changes' })),
  CompareNothingUncommitted: scene((f) => ({ ...review9(f, { right: 'changes' }), changesAgainst: { [ids.table]: { uncommitted: [] } } })),
  CompareCommitNoFiles: scene((f) => ({ ...review9(f, { right: 'changes' }), changesAgainst: { [ids.table]: { commit: [] } } })),
  DiffNoChanges: scene((f) => ({ ...review9(f, { rail: true, tab: 'diff:test/journey.test.ts', diffs: ['test/journey.test.ts'] }), diffs: { [ids.table]: '' } })),
  // 9.22: a file Kernel can't show, lines sent to the agent, links to a secret and to a file that is gone, renaming a tab, a new tab's welcome, the big terminal's notice and the viewer's toolbar.
  FileViewCantShow: scene((f) => { const s = review9(f, { rail: true, tab: 'file:fixtures/big.sqlite', files: ['fixtures/big.sqlite'] }); return { ...s, fileErrors: { [ids.table]: { 'fixtures/big.sqlite': 'It is binary or too large to show here.' } } } }),
  FileViewSendToAgent: scene((f) => { const path = 'src/renderer/src/screens/workspace/Transcript.tsx'; const s = review9(f, { rail: true, tab: `file:${path}`, files: [path] }); return { ...s, fileText: { [ids.table]: { [path]: `${'\n'.repeat(1099)}<ChatWelcome\n  title={\`New tab with \${agentName}\`}\n  suggestions={isLead ? LEAD : SUGGESTIONS}\n/>\n` } } } }),
  FileLinkSecret: scene((f) => r9Link(f, 'The token is read from `.env.local`, so I left it out of the commit.', { '.env.local': { kind: 'file', path: '.env.local', sensitive: true } })),
  FileLinkMissing: scene((f) => ({ ...r9Link(f, 'I moved the fixtures out of `src/fixtures.ts`.', { 'src/fixtures.ts': { kind: 'file', path: 'src/fixtures.ts' } }), mentionsGone: { [ids.table]: ['src/fixtures.ts'] } })),
  TabRename: scene((f) => { const w = works(f, jRest()); return { ...w, ...r9Tabs(f, w), ui: { ...open, rightPanel: false, workspace: { right: 'changes', bottom: 'run' } } } }),
  ChatWelcomeAgent: scene((f) => ({ ...works(f, []), ui: { ...open, rightPanel: false, workspace: { right: 'changes', bottom: 'run' } } })),
  ChatWelcomeLead: scene((f) => { const { approvals: _none, ...lead } = scene2(f, { id: ids.lead, agentId: 'kernel-lead' }, 'New tab', [], {}, { model: 'claude-opus-5-5', plan: false }); return { ...lead, ui: { ...lead.ui!, rightPanel: false, workspace: { right: 'prs', bottom: 'run' } } } }),
  BigTerminalSkipNotice: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { mode: 'current', branch: 'main' }),
    chats: [...f.chats, { ...extraChat('chat-term', 'Terminal (claude)', 'terminal'), terminal: { preset: 'claude-skip', command: 'claude' } }],
    push: [...f.push, { type: 'terminal.data', chatId: 'chat-term', data: termScreen }],
    settings: DEFAULT_SETTINGS('/Users/you'),
    ui: { ...tabsView('chat-term'), rightPanel: false }
  })),
  SharedViewerToolbar: scene((f) => { const s = sharedTabScene(f, 'sh-html'); return { ...s, ui: { ...s.ui!, rightPanel: false } } }),
  // 9.11: the app's preview. The rail's Preview row opens the app in the browser and lists the project's URLs.
  WorkspacePreview: scene((f) => {
    const s = review9(f, { rail: true })
    return { ...s, projectSettings: { [ids.projectA]: { ...R9_SCRIPTS[ids.projectA], preview: { urls: [{ name: 'Web app', url: 'http://localhost:$KERNEL_PORT/review' }, { name: 'API docs', url: 'http://localhost:$((KERNEL_PORT + 1))/docs' }] } } }, ui: { ...s.ui!, menu: 'preview' } }
  }),
  WorkspaceTerminal: scene((f) => ({
    chats: [...f.chats, extraChat('chat-term', 'Terminal (claude)', 'terminal')],
    push: [...f.push, { type: 'terminal.data', chatId: 'chat-term', data: termScreen }],
    ui: tabsView('chat-term')
  })),
  // KERNEL-739: an image in the All changes diff opens in its own tab, like a chat chip. scripts/shots.ts clicks the picture.
  WorkspaceDiffImageInlineOpen: scene((f) => ({
    changes: { ...f.changes, [ids.table]: [{ path: 'public/logo.png', status: 'A', added: 0, removed: 0 }] },
    diffs: { ...f.diffs, [ids.table]: 'diff --git a/public/logo.png b/public/logo.png\nnew file mode 100644\nBinary files /dev/null and b/public/logo.png differ\n' },
    images: { [ids.table]: { 'worktree:public/logo.png': { dataUrl: imageAfter } } },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run' }, tabs: { [ids.table]: { tab: 'diff:', files: [], diffs: [''] } } }
  })),
  // The sidebar toggle as motion: one element at one spot while the sidebar hides, so the frames show the icon staying put.
  WorkspaceSidebarToggle: { ...scene(() => ({
    ui: { ...open, nav: { canBack: true, canForward: true }, workspace: { right: 'changes', bottom: 'run' } }
  })), motion: { action: { click: 'Hide sidebar' }, ms: 600, area: '.app' } },
  WorkspaceHistoryButtonsNarrow: scene(() => ({
    ui: { ...open, nav: { canBack: true, canForward: true }, workspace: { right: 'changes', bottom: 'run' } }
  })),
  // Clickable file mentions: paths in the reply link when the workspace has them. `src/gone.ts` and `1.2.3` stay plain text. The motion clicks a link with a range, so the file tab opens on it.
  WorkspaceFileLinks: scene((f) => fileLinks(f, { click: 'Open src/app/invoices/table.tsx at line 12' })),
  WorkspaceFileLinksText: scene((f) => fileLinks(f)),
  // A bare name that two files have: the link opens a menu of the paths instead of guessing.
  WorkspaceFileLinksMenu: { ...scene((f) => fileLinks(f)), motion: { action: { click: 'Choose a file named page.tsx' }, ms: 600, area: '.ws-main' } },
  WorkspaceRunning: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { name: 'invoice-pdf-tests', branch: 'feat/t-15c-invoice-pdf-tests', agentId: 'teng' }),
    chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: 'Snapshot tests' } : c)),
    items: { [ids.tableChat]: runningItems() },
    changes: { [ids.table]: [
      { path: 'tests/invoice-pdf.spec.ts', status: 'A', added: 96, removed: 0 },
      { path: 'tests/fixtures/invoices.ts', status: 'A', added: 42, removed: 0 }
    ] },
    push: [...f.push, { type: 'chat.running', chatId: ids.tableChat, running: true }],
    ui: { ...open, workspace: { right: 'files', bottom: 'run' } }
  })),
  /** 10.4: folded while it runs. Only the step in flight shows under the closed header. */
  WorkspaceRunningFold: scene((f) => works(f, [jBrief(ago(74)), jRead(ago(70)), jIssue(ago(64)), jRun15(ago(60)), jShots(ago(12), { status: 'running', durationMs: undefined, output: undefined })], { running: true, view: { toolCalls: 'closed' } })),
  /** The same turn stepped through two more calls after Send: the summary grows, the command text never shows. */
  WorkspaceRunningFoldSteps: { ...scene((f) => ({
    ...withDraft({
      workspaces: withWorkspace(f, ids.table, { name: 'invoice-pdf-tests', branch: 'feat/t-15c-invoice-pdf-tests', agentId: 'teng' }),
      chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: 'Snapshot tests' } : c)),
      items: { [ids.tableChat]: runningItems() },
      push: [...f.push, { type: 'chat.running', chatId: ids.tableChat, running: true }],
      ui: { ...open, workspace: { right: 'files', bottom: 'run' } }
    }, 'Keep going.'),
    afterSend: [
      { afterMs: 250, events: [{ type: 'chat.item', chatId: ids.tableChat, item: tool('rt4', 'Run the new tests', 'pnpm vitest run tests/invoice-pdf.spec.ts', { status: 'done', durationMs: 4100, input: { command: 'pnpm vitest run tests/invoice-pdf.spec.ts' } }) }, { type: 'chat.item', chatId: ids.tableChat, item: tool('rt5', 'Lint the tests', 'pnpm lint tests', { status: 'running', durationMs: undefined, input: { command: 'pnpm lint tests' } }) }] },
      { afterMs: 500, events: [{ type: 'chat.item', chatId: ids.tableChat, item: tool('rt5', 'Lint the tests', 'pnpm lint tests', { status: 'done', durationMs: 900, input: { command: 'pnpm lint tests' } }) }, { type: 'chat.item', chatId: ids.tableChat, item: tool('rt6', 'Typecheck', 'pnpm typecheck', { status: 'running', durationMs: undefined, input: { command: 'pnpm typecheck' } }) }] }
    ]
  })), motion: { action: { click: 'Queue message' }, ms: 900, area: '.ws-main' } },
  /** 10.6: just started. The first step is running, and the header counts the seconds. */
  WorkspaceFoldWorking: scene((f) => works(f, [jBrief(ago(3)), tool('j-first', 'Read', 'test/journey.test.ts', { name: 'Read', ts: ago(2), status: 'running', durationMs: undefined, input: { file_path: 'test/journey.test.ts' } })], { running: true })),
  /** 10.7: after a long run the time counts hours. */
  WorkspaceFoldWorkingLong: scene((f) => works(f, [
    jBrief(ago(4320)), jTool('j-soak0', ago(4300), 'pnpm soak:prepare', 'Run the soak setup', { durationMs: 60_000 }),
    jTool('j-soak', ago(3600), 'pnpm soak --hours 24', 'Soak for 24 hours', { status: 'running', durationMs: undefined })
  ], { running: true })),
  /** KERNEL-912: back to a working chat from another tab. The chat is long, its turn has a live steps list, and the motion clicks its tab. The view must be at the end from the first frame. */
  WorkspaceChatSwitchWorkingMotion: { ...scene((f) => ({
    chats: [...f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: 'Snapshot tests' } : c)), extraChat('chat-other', 'Empty state copy')],
    items: { [ids.tableChat]: [...longChat, ...longRunningItems()], 'chat-other': [userMsg('o1', 'Shorten the empty state copy.')] },
    push: [...f.push, { type: 'chat.running', chatId: ids.tableChat, running: true }],
    ui: tabsView('chat-other')
  })), motion: { action: { click: 'Snapshot tests' }, ms: 1000, area: '.ws-main' } },
  /** A working chat that has settled at its end gets a new step. Its open steps list must not play its open motion again, which slid the chat down under a reader at the end. */
  WorkspaceChatWorkingNewStepMotion: { ...scene((f) => ({
    items: { [ids.tableChat]: [...longChat, ...longRunningItems()] },
    push: [...f.push, { type: 'chat.running', chatId: ids.tableChat, running: true }],
    ui: open
  })), motion: { action: { push: [{ type: 'chat.item', chatId: ids.tableChat, item: tool('lr20', 'Check the snapshots', 'pnpm vitest run invoices', { ts: Date.now(), status: 'running', durationMs: undefined, input: { command: 'pnpm vitest run invoices' } }) }] }, ms: 600, area: '.ws-main' } },
  /** KERNEL-912: back to a chat left scrolled up in the middle of its thread. scripts/shots.ts scrolls it up and leaves it first, and the motion clicks its tab. The view must be on the same lines from the first frame. */
  WorkspaceChatSwitchSavedSpotMotion: { ...scene((f) => ({
    chats: [...f.chats, extraChat('chat-other', 'Empty state copy')],
    items: { [ids.tableChat]: longChat, 'chat-other': [userMsg('o1', 'Shorten the empty state copy.')] },
    push: f.push,
    ui: tabsView(ids.tableChat)
  })), motion: { action: { click: 'Invoice table' }, ms: 1000, area: '.ws-main' } },
  /** 10.8: long commands inside the fold end in an ellipsis. */
  WorkspaceFoldLongCommands: scene((f) => works(f, [
    jBrief(J(43)),
    jTool('j-lc1', J(43, 10), "pnpm exec vitest run test/journey.test.ts --reporter=verbose --bail=1 -t 'clean-account journey on a fresh Mac user'", 'Run the journey', { durationMs: 190_000 }),
    jTool('j-lc2', J(46, 20), 'pnpm shots Review ReviewRc --motion --no-build --out shots/rc/review-motion --theme dark', 'Capture the review screen', { durationMs: 120_000 }),
    jTool('j-lc3', J(48, 30), 'node scripts/diff-shots.mjs shots/Review.png shots/rc/Review.png --threshold 0.01 --report shots/rc/diff.json', 'Compare the shots', { durationMs: 9_000 }),
    jSay('j-lc-r', J(52, 40), 'The review screen matches the release candidate.'), jResult(J(52, 42), 580_000)
  ], { view: { toolCalls: 'open' } })),
  /** 10.9: waiting on you. The hourglass is the only amber, and the question Teng asked is the last step. */
  WorkspaceFoldWaiting: scene((f) => {
    const question = 'File the 2px difference?'
    const options = [{ label: 'File it as its own issue' }, { label: "Leave it, it's under the 4px threshold" }]
    return works(f, [
      jBrief(ago(280)), jRead(ago(275)), jIssue(ago(268)), jRun15(ago(260)),
      tool('j-ask', 'AskUserQuestion', '', { name: 'AskUserQuestion', ts: ago(5), status: 'running', durationMs: undefined, input: { questions: [{ question, options }] } })
    ], { running: true, view: { toolCalls: 'open' }, approvals: [jQuestion([{ question, options }], { createdAt: ago(0) })] })
  }),
  /** The same turn finished: one folded line with only its summary, and the reply right under it. */
  WorkspaceFoldDone: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { name: 'invoice-pdf-tests', branch: 'feat/t-15c-invoice-pdf-tests', agentId: 'teng' }),
    chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: 'Snapshot tests' } : c)),
    items: { [ids.tableChat]: finishedFoldItems() },
    ui: { ...open, workspace: { right: 'files', bottom: 'run' } }
  })),
  /** A turn ending: Queue message steps it from running to done, and the open fold closes to its "Worked for" line with the reply under it. */
  WorkspaceFoldEnding: { ...scene((f) => ({
    ...withDraft({
      workspaces: withWorkspace(f, ids.table, { name: 'invoice-pdf-tests', branch: 'feat/t-15c-invoice-pdf-tests', agentId: 'teng' }),
      chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, title: 'Snapshot tests' } : c)),
      items: { [ids.tableChat]: runningItems() },
      push: [...f.push, { type: 'chat.running', chatId: ids.tableChat, running: true }],
      ui: { ...open, workspace: { right: 'files', bottom: 'run' } }
    }, 'Keep going.'),
    afterSend: [
      { afterMs: 300, events: [{ type: 'chat.item', chatId: ids.tableChat, item: tool('rt4', 'Run the new tests', 'pnpm vitest run tests/invoice-pdf.spec.ts', { status: 'done', durationMs: 4100, input: { command: 'pnpm vitest run tests/invoice-pdf.spec.ts' } }) }] },
      { afterMs: 700, events: [{ type: 'chat.item', chatId: ids.tableChat, item: { kind: 'text', id: 'rx2', ts: Date.now(), text: 'All three invoice types now have snapshot tests with frozen dates.' } }] },
      { afterMs: 1100, events: [{ type: 'chat.item', chatId: ids.tableChat, item: { kind: 'result', id: 'rres', ts: Date.now(), durationMs: 134_000, ok: true } }, { type: 'chat.running', chatId: ids.tableChat, running: false }] }
    ]
  })), motion: { action: { click: 'Queue message' }, ms: 1900, area: '.ws-main' } },
  /** 10.3: a long command in flight stays on one line, ending in an ellipsis at the column's edge. */
  WorkspaceRunningLongCommand: scene((f) => works(f, [
    jBrief(ago(123)),
    tool('j-long', 'Run a command', 'pnpm exec vitest run', { ts: ago(20), status: 'running', durationMs: undefined, input: { command: "pnpm exec vitest run test/journey.test.ts --reporter=verbose -t 'step 6 compares the review screen with the release candidate on a clean account'" } })
  ], { running: true })),
  /** 10.2: the moment between two steps. The last one is done and the next has not started, so only the header's loader moves. */
  WorkspaceRunningBetweenSteps: scene((f) => works(f, [jBrief(ago(46)), jRead(ago(42)), jIssue(ago(38)), jRun15(ago(34), { durationMs: 12_000 })], { running: true })),
  /** The Lead's turn from KERNEL-784: seven issues filed with one failure and five handoffs fold into rows, and the step in flight sits under them with the clock. */
  WorkspaceStepRuns: scene((f) => ({
    ...leadRunning(f, stepRunItems(false)),
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', leadRight: 'prs', bottom: 'run', checkpoints: false } }
  })),
  /** The same turn finished: its summary names what happened, and with the fold open the run with a failure is open too. */
  WorkspaceStepRunsDone: scene((f) => ({
    ...leadRunning(f, stepRunItems(true), false),
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', leadRight: 'prs', bottom: 'run', checkpoints: false, toolCalls: 'open' } }
  })),
  /** A running turn of 500 steps stays one fold and a live line. */
  WorkspaceStepsLong: scene((f) => ({
    ...leadRunning(f, longSteps()),
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', leadRight: 'prs', bottom: 'run', checkpoints: false } }
  })),
  /** 7.7: a permission approval. The fold says Waiting on your approval, and the card says what Teng wants to run, why, and which rule asked. */
  WorkspacePerm: scene((f) => jPermScene(f)),
  /** 14.4: Allow once pressed. The decision goes at once and the card folds to its result (DESIGN.md, Motion: Approvals), so the motion is the evidence. */
  WorkspacePermAllowOnce: { ...scene((f) => jPermScene(f)), motion: { action: { click: 'Allow once' }, ms: 700, area: '.ws-main' } },
  /** 14.5: allowed. The card says what Teng wanted and that you allowed it, and the step it ran follows in the fold. */
  WorkspacePermAllowed: scene((f) => {
    const a = { ...jPerm({ createdAt: J(45) }), status: 'allowed' as const }
    const placed: ChatItem = { kind: 'approval', id: `approval-${a.id}`, ts: J(45, 5), approvalId: a.id }
    return works(f, [...jAsked(300).slice(0, 4).map((i, n) => (n === 0 ? jBrief(J(43)) : i)), placed, jTool('j-clear', J(45, 20), 'rm -rf ~/Library/Application\\ Support/Kernel-qa', "Clear the test account's data", { durationMs: 300 }), jSay('j-fresh', J(45, 40), 'Fresh install starts clean. Running steps 1 to 5.'), jRun15(J(46)), jResult(J(47), 240_000)], { placed: [a], view: { toolCalls: 'open' } })
  }),
  /** 14.1: an approval says why it asked, on one line under the command: the classifier's reason on Claude in Auto, the sandbox's on Codex (KERNEL-459). */
  WorkspacePermReason: scene((f) => jPermScene(f, { mode: 'auto', reason: 'Auto mode asked because the command deletes files outside the worktree.' })),
  WorkspacePermReasonCodex: scene((f) => jPermScene(f, {
    ws: { agentId: 'sean' }, chat: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' }, mode: 'acceptEdits', models: true, say: 'Installs the release candidate so step 6 can open it.',
    approvals: [jPerm({ agentId: 'sean', input: { command: 'hdiutil attach ~/Downloads/Kernel-1.4.0-rc.2.dmg' }, title: 'Run hdiutil attach ~/Downloads/Kernel-1.4.0-rc.2.dmg', detail: 'Installs the release candidate so step 6 can open it.', reason: "Codex's sandbox blocks commands that write outside the worktree." })]
  })),
  // KERNEL-785: an MCP call's approval card says what the chat's row says, not the server and tool names.
  WorkspacePermMcp: scene((f) => jPermScene(f, {
    say: 'Step 6 found one difference, so I am filing it in Linear.',
    approvals: [pending('tool', 'teng', { toolName: 'mcp__claude_ai_Linear__save_issue', input: { team: 'Kernel', title: 'Review screen is 2px taller on a clean account', labels: ['Bug', 'Workspace'] }, ...describeTool('mcp__claude_ai_Linear__save_issue', { team: 'Kernel', title: 'Review screen is 2px taller on a clean account', labels: ['Bug', 'Workspace'] }), reason: "Linear's save_issue has no rule yet.", createdAt: Date.now() - 4_000 })]
  })),
  // KERNEL-1114: two permissions waiting in one chat are one card that pages through them. Next pages to the second, and an answer takes one out of the queue.
  WorkspacePermQueue: { ...scene((f) => queued(jPermScene(f, { approvals: [
    { ...jPerm(), id: 'ap-tool-teng-1' },
    { ...jPerm({ input: { command: 'pnpm test:journey --steps 1-5' }, title: 'Run pnpm test:journey --steps 1-5', detail: 'Runs the first five steps on the clean account.', createdAt: Date.now() - 3_000 }), id: 'ap-tool-teng-2' }
  ] }))), motion: { action: { click: 'Show permission 2' }, ms: 700, area: '.ws-main' } },
  WorkspacePlan: scene(planWaiting),
  /** KERNEL-950: back to a Lead chat with a plan waiting from another tab. The transcript must not move once the strip has opened. */
  WorkspacePlanRoundTrip: { ...scene((f) => { const s = planAfterHistory(planWaiting(f)); return { ...s, chats: [...(s.chats ?? f.chats), { ...extraChat('chat-other', 'Empty state copy'), workspaceId: ids.lead, threadId: 't-lead' }], items: { ...s.items, 'chat-other': [userMsg('o1', 'Shorten the empty state copy.')] }, ui: { ...s.ui, workspace: { right: 'changes', bottom: 'run' }, tabs: { [ids.lead]: { tab: ids.leadChat, files: [], diffs: [] } } } } }), motion: { action: { press: ['click:Empty state copy', 'click:Export invoices as PDF'] }, ms: 600, area: '.ws-scroll' } },
  /** KERNEL-952 (a): a pending plan in a chat left at its end, to another tab and back. */
  WorkspaceScrollPlanRoundTripMotion: { ...scene((f) => planWithOtherChat(f)), motion: { action: { press: ['click:Empty state copy', 'click:Export invoices as PDF'] }, ms: 600, area: '.ws-scroll' } },
  /** KERNEL-952 (b): a pending plan taller than the view, scrolled to its task list, then to another tab and back. */
  WorkspaceScrollTallPlanRoundTripMotion: { ...scene((f) => planWithOtherChat(f, TALL_PLAN)), motion: { action: { press: ['click:Empty state copy', 'click:Export invoices as PDF'] }, ms: 600, area: '.ws-scroll' } },
  /** KERNEL-952 (KERNEL-953 acceptance): a pending plan taller than the view, opened for the first time from another tab. The chat must open at the top of the plan. */
  WorkspaceScrollTallPlanFirstOpenMotion: { ...scene((f) => startOnOtherChat(planWithOtherChat(f, TALL_PLAN))), motion: { action: { click: 'Export invoices as PDF' }, ms: 900, area: '.ws-scroll' } },
  /** KERNEL-952 (KERNEL-953 acceptance): a plan that fits, opened for the first time from another tab. The end of the chat stays in view while the strip opens. */
  WorkspaceScrollFitPlanFirstOpenMotion: { ...scene((f) => startOnOtherChat(planWithOtherChat(f))), motion: { action: { click: 'Export invoices as PDF' }, ms: 900, area: '.ws-scroll' } },
  /** KERNEL-952 (c): a revised plan with a new approval id arriving while the reader is scrolled up. */
  WorkspaceScrollRevisedPlanMotion: { ...scene((f) => planAfterHistory(planWaiting(f))), motion: { action: { push: revisedPlan(scene(() => ({}))) }, ms: 1500, area: '.ws-main' } },
  /** KERNEL-991: a plan taller than the view arriving live in a chat open at its end. It opens at its top. */
  WorkspaceScrollLiveTallPlanMotion: { ...scene((f) => livePlan(f, TALL_PLAN).start), motion: { action: { push: livePlan(scene(() => ({})) as Fixture, TALL_PLAN).push }, ms: 2200, area: '.ws-main' } },
  /** KERNEL-952 (d): a pasted image grows the composer while the chat is at its end. */
  WorkspaceScrollComposerImageMotion: { ...scene(() => ({ items: { [ids.tableChat]: [...scrollHistory('ci'), ...tableItems] }, ui: open })), motion: { action: { press: ['Meta+v'] }, ms: 900, area: '.ws-main' } },
  /** KERNEL-952 (d): several typed lines grow the composer while the chat is at its end. */
  WorkspaceScrollComposerLinesMotion: { ...scene(() => ({ items: { [ids.tableChat]: [...scrollHistory('cl'), ...tableItems] }, ui: open })), motion: { action: { press: ['a', 'Shift+Enter', 'b', 'Shift+Enter', 'c', 'Shift+Enter', 'd', 'Shift+Enter', 'e', 'Shift+Enter', 'f'] }, ms: 900, area: '.ws-main' } },
  /** KERNEL-952 (d): a queued message grows the tray above the composer while the chat is at its end. */
  WorkspaceScrollComposerQueueMotion: { ...scene((f) => ({ ...withDraft({ items: { [ids.tableChat]: [...scrollHistory('cq'), ...runningItems()] }, push: [...f.push, runningEvent(ids.tableChat, true)], ui: open }, 'Also add a loading skeleton to the table') })), motion: { action: { click: 'Queue message' }, ms: 900, area: '.ws-main' } },
  /** KERNEL-952 (e): a turn ends and folds its steps while the reader is scrolled up. */
  WorkspaceScrollTurnFoldMotion: { ...scene((f) => ({ items: { [ids.tableChat]: [...scrollHistory('tf'), ...runningItems()] }, push: [...f.push, runningEvent(ids.tableChat, true)], ui: open })), motion: { action: { push: [{ type: 'chat.item', chatId: ids.tableChat, item: { kind: 'text', id: 'tf-done', ts: Date.now(), text: 'All three snapshot tests pass with frozen dates.' } }, { type: 'chat.item', chatId: ids.tableChat, item: { kind: 'result', id: 'tf-res', ts: Date.now(), durationMs: 134_000, ok: true } }, runningEvent(ids.tableChat, false)] }, ms: 1500, area: '.ws-main' } },
  /** KERNEL-952 (f): case (a) under reduced motion. */
  WorkspaceScrollPlanRoundTripReducedMotion: { ...scene((f) => planWithOtherChat(f)), motion: { action: { press: ['click:Empty state copy', 'click:Export invoices as PDF'] }, ms: 600, area: '.ws-scroll' } },
  WorkspacePlanApprove: { ...scene(planWaiting), motion: { action: { click: 'Approve' }, ms: 1000, area: '.ws-main' } },
  WorkspacePlanApproved: scene(planApproved), // an older chat: no answer row, so the plan card draws the bubble
  WorkspacePlanApprovedItem: scene(planApprovedItem),
  // Tasks still open: no counter. All merged: the line shows (KERNEL-1063).
  WorkspacePlanOpenTasks: scene((f) => { const s = planApproved(f); const id = s.approvals?.[0]?.id ?? ''; return { ...s, attention: { [id]: { prsMerged: 1, needed: 3, byKind: { plan: 1, tool: 1, question: 0, blocker: 0, merge: 1 }, finished: false } } } }),
  WorkspacePlanFinished: scene(planFinished),
  // The breakdown open over the chat rows that follow the plan card (KERNEL-1068).
  WorkspacePlanFinishedFollowed: scene((f) => {
    const s = planFinished(f)
    const after: ChatItem[] = [
      { kind: 'user', id: 'pf-u', ts: at(10, 40), parts: [{ type: 'text', text: 'Thanks. Is the invoice export ready to ship?' }] },
      { kind: 'text', id: 'pf-a', ts: at(10, 41), text: 'Yes. All four PRs are merged and the export runs against a real invoice.' }
    ]
    return { ...s, items: { [ids.leadChat]: [...(s.items?.[ids.leadChat] ?? []), ...after] } }
  }),
  // The same breakdown with more than 12 rows after the plan card, where older rows skip paint (KERNEL-1082).
  WorkspacePlanFinishedLong: scene((f) => {
    const s = planFinished(f)
    const after: ChatItem[] = Array.from({ length: 7 }, (_, i): ChatItem[] => [
      { kind: 'user', id: `pfl-u${i}`, ts: at(10, 40 + i), parts: [{ type: 'text', text: `Question ${i + 1}: is the export ready for another invoice?` }] },
      { kind: 'text', id: `pfl-a${i}`, ts: at(10, 40 + i), text: 'Yes. The export runs against a real invoice.' }
    ]).flat()
    return { ...s, items: { [ids.leadChat]: [...(s.items?.[ids.leadChat] ?? []), ...after] } }
  }),
  WorkspacePlanChanges: scene(planChanges),
  WorkspacePlanReplaced: scene(planReplaced),
  WorkspacePlanExit: scene(planExit),
  // The other plan mode states (KERNEL-322). The typing shots also focus the box (scripts/shots.ts).
  WorkspacePlanMode: scene((f) => planMode(f)),
  WorkspacePlanModeTyping: scene((f) => withDraft(planMode(f), 'Plan the Download PDF action for the row menu. Do not edit anything yet.')),
  WorkspacePlanTyping: scene((f) => withDraft(planWaiting(f), 'Split step 2 into its own PR, after step 1 merges.')),
  WorkspacePlanApproveDraft: { ...scene((f) => withDraft(planWaiting(f), 'Split step 2 into its own PR, after step 1 merges.')), motion: { action: { click: 'Approve' }, ms: 900, area: '.cmp' } },
  /** 7.5: a question from the agent. The turn waits on you, so its fold says Waiting on your answer with the amber hourglass, and the question is a chat card under what Teng said. */
  WorkspaceQuestion: scene((f) => works(f, jAsked(280, 'Steps 1 to 5 pass on a clean account. Step 6 found one difference from the release candidate.'), { running: true, approvals: [jQuestion([JOURNEY_QUESTIONS[0]], { createdAt: ago(0) })] })),
  /** 13.1: one option picked, the next hovered and the one after focused from the keyboard: the pick is the strongest of the three (KERNEL-676, scripts/shots.ts). */
  WorkspaceQuestionStates: scene((f) => works(f, jAsked(280, 'Steps 1 to 5 pass on a clean account. Step 6 found one difference from the release candidate.'), { running: true, approvals: [jQuestion([{ ...JOURNEY_QUESTIONS[0], options: [...JOURNEY_QUESTIONS[0].options, { label: 'Ask me again after the review' }] }], { createdAt: ago(0) })] })),
  /** 13.3: long options read as an ink label with a muted description, and the recommended one carries a tag (KERNEL-414, KERNEL-416). Nothing is picked, so Send waits. */
  WorkspaceQuestionLong: scene((f) => works(f, jAsked(280, 'Step 6 compares against the release candidate.'), { running: true, approvals: [jQuestion([{ question: 'Step 6 compares against the release candidate. Which build should it use?', options: [...JOURNEY_QUESTIONS[1].options, { label: 'Something else', description: 'Tell Teng which build to compare against.' }] }], { createdAt: ago(0) })] })),
  /** 13.4: a sign-in link in the question wraps inside the card, and the AskUserQuestion call has a row of its own above it (KERNEL-591). */
  WorkspaceQuestionUrl: scene((f) => {
    const url = 'https://linear.app/oauth/authorize?client_id=kernel-desktop&scope=read,write&redirect_uri=kernel://linear'
    const question = `Linear needs a fresh sign-in before I can file issues. Open ${url} and tell me when it's done.`
    const options = [{ label: 'Done, I signed in' }, { label: 'Skip filing, just comment on KERNEL-232' }]
    return works(f, [...jAsked(120, 'Step 6 found one difference, and I need Linear to file it.'), tool('j-ask', 'AskUserQuestion', '', { name: 'AskUserQuestion', status: 'running', durationMs: undefined, input: { questions: [{ question, options }] } })], { running: true, approvals: [jQuestion([{ question, options }], { createdAt: ago(0) })] })
  }),
  /** 7.6: saving the project's scripts. Teng ran setup by hand, so the card lists each script in its own box, and nothing is written until you answer. */
  WorkspaceQuestionScripts: scene((f) => {
    const question = 'Save these scripts to .kernel/settings.local.toml?'
    const options = [{ label: 'Save', description: 'Write them to .kernel/settings.local.toml, on this Mac only' }, { label: 'Cancel', description: 'Write nothing' }]
    const detail = 'Setup script\npnpm install\npnpm rebuild better-sqlite3\ncp ../../.env.local .env.local\n\nRun script\npnpm dev\n\nArchive script\nrm -rf shots/'
    return {
      ...works(f, jAsked(138, "This project has no setup script, so every new worktree starts without node_modules. These are the commands I ran by hand to get step 1 going."), { running: true, ws: { setupRun: undefined }, approvals: [pending('question', 'teng', { title: question, detail, options: options.map((o) => o.label), questions: [{ question, options }], createdAt: ago(0) })] }),
      projectSettings: { [ids.projectA]: { scripts: {}, runScripts: [], files: { copy: [] }, workspace: {} } }
    }
  }),
  /** 13.2: several questions page through with Next. The card shows question 1 of 3, with Skip and Next. */
  WorkspaceQuestionSteps: scene((f) => works(f, jAsked(280, 'Steps 1 to 5 pass on a clean account. Step 6 found one difference from the release candidate.'), { running: true, approvals: [jQuestion(JOURNEY_QUESTIONS, { title: `Teng has 3 questions`, createdAt: ago(0) })] })),
  /** 13.5: question 3 of 3 with Something else typed; the step and the typing are local to the card (scripts/shots.ts). */
  WorkspaceQuestionOther: scene((f) => works(f, jAsked(280, 'Steps 1 to 5 pass on a clean account. Step 6 found one difference from the release candidate.'), { running: true, approvals: [jQuestion(JOURNEY_QUESTIONS, { createdAt: ago(0) })] })),
  /** 13.7: the card keeps its place once answered, each question with your answer under it, and the agent's reply comes after it. */
  WorkspaceQuestionAnswers: scene(() => jAfterAnswer(jAnswered(JOURNEY_QUESTIONS, ['File it as its own issue', 'The release candidate from Friday', 'Only the ones that moved']))),
  /** 13.8: one question, answered: the card keeps the question and your answer is the bubble in it. */
  WorkspaceQuestionAnswered: scene(() => jAfterAnswer(jAnswered([JOURNEY_QUESTIONS[0]], ['File it as its own issue']))),
  /** 13.9: the same with your answer as the chat's own message (KERNEL-838): the card draws no bubble of its own, and the message sits under it. */
  WorkspaceQuestionAnsweredItem: scene(() => jAfterAnswer(jAnswered([JOURNEY_QUESTIONS[0]], ['File it as its own issue']), true)),
  /** 7.8: Kernel's note. Two turns with Kernel's own message between them as one line, with a toggle that opens what it told Teng. */
  WorkspaceKernelNote: scene((f) => works(f, jKernelNote())),
 // the same, opened by scripts/shots.ts
  WorkspaceKernelNoteOpen: scene((f) => works(f, jKernelNote())), // the same, opened by scripts/shots.ts
 // the same, opened by scripts/shots.ts
  /** 15.5: after a relaunch the quit folds into one line, and the message Kernel gave Teng is a click away. */
  WorkspaceRelaunch: scene((f) => works(f, [
    jBrief(), jRead(), jIssue(), jRun15(),
    jShots(J(45, 40), { status: 'failed', durationMs: undefined, output: 'Stopped when Kernel quit' }),
    { kind: 'note', id: 'j-quit', ts: J(46), text: 'Kernel quit while this agent was working.' },
    { kind: 'user', id: 'j-back', ts: J(47), from: 'kernel', parts: [{ type: 'text', text: 'Kernel restarted while you were working on this chat. Check git status for edits that were not saved, then carry on from where you stopped.' }] },
    jSay('j-picked', J(47, 40), 'git status was clean, so nothing was lost. All six steps pass on a clean account.'), jResult(J(47, 52), 125_000)
  ])),
  /** 15.4: Kernel quit mid-turn. The fold says Worked for, the step it was on stays in view, and Kernel's note names it with Continue. */
  WorkspaceInterrupted: scene((f) => works(f, [
    jBrief(), jRead(), jIssue(), jRun15(),
    jShots(J(45, 40), { status: 'failed', durationMs: undefined, output: 'Stopped when Kernel quit' }),
    { kind: 'note', id: 'j-quit', ts: J(46), text: 'Kernel quit while this agent was working.' }
  ])),
  /** 15.6: an error is a toast, and the chat stays as it was. */
  WorkspaceError: scene((f) => works(f, [
    jBrief(J(41, 40)), jRun15(J(41, 50)), jSay('j-e1', J(42, 30), 'Step 3 passes on the fresh account too.'), jResult(J(42, 42), 62_000)
  ], { toasts: [{ id: 'save-failed', title: "Couldn't save this chat", sub: 'The database is locked. Kernel retries in a moment.', detail: JOURNEY_TITLE, glyph: 'error', action: { label: 'Retry', retryNow: ids.tableChat, primary: true } }] })),
  /** 16.1: a transcript that can't load is a calm state with Try again, and a toast with the same. The load fails the way main's would. */
  ChatLoadFailed: scene(() => ({ items: { [ids.tableChat]: tableItems }, fails: { 'chats.items': "The transcript file couldn't be read." }, ui: open })),
  /** 16.2: a step's menu: Copy output and Copy raw call. */
  StepMenu: scene((f) => {
    const s = works(f, [jBrief(), jTool('j-test', J(44), 'pnpm test:changed', 'Run the changed tests', { durationMs: 8_000, output: 'Tests  21 passed (21)' }), jSay('j-sm', J(44, 20), 'The changed tests pass.'), jResult(J(44, 22), 80_000)], { view: { toolCalls: 'open' } })
    return { ...s, ui: { ...s.ui!, menu: 'step:j-test' as const } }
  }),
  // UX audit states (docs/audits/ux-chat-workspace.md). An existing chat whose items have not loaded yet: the answer to chats.items never comes.
  AuditItemsLoading: scene(() => ({ items: { [ids.tableChat]: tableItems }, hold: ['chats.items'], ui: open })),
  /** 11.13: a command that printed 200 lines shows the last few, with a row that says how many there are. The shot opens the row. */
  AuditLongOutput: scene((f) => works(f, [
    jBrief(), jTool('j-suite', J(44), 'pnpm test', 'Run the full suite', { durationMs: 96_000, output: [...Array.from({ length: 188 }, (_, i) => `✓ test/part-${i + 1}.test.ts (${i % 9 + 2} tests) ${(i % 7) + 1}.2s`), '', 'Test Files  42 passed (42)', '     Tests  611 passed (611)', '  Duration  96.4s'].join('\n') }),
    jSay('j-lo', J(45, 40), 'The whole suite passes.'), jResult(J(45, 42), 102_000)
  ], { view: { toolCalls: 'open' } })),
  // One message with ten images, whose data loads late in a real run.
  AuditTenImages: scene(() => ({
    items: { [ids.tableChat]: [
      { kind: 'user', id: 'ti0', ts: at(10, 27), parts: [{ type: 'text', text: 'These are the ten screens that still look wrong.' }, ...Array.from({ length: 10 }, (_, i) => ({ type: 'image' as const, name: i ? `image-${i + 1}.png` : 'image.png', dataUrl: imageAfter, width: 640, height: 400 }))] },
      { kind: 'text', id: 'ti1', ts: at(10, 28), text: 'I looked at all ten. Seven share the same header spacing bug, the other three are separate.' },
      { kind: 'result', id: 'ti-res', ts: at(10, 28), durationMs: 41_000, ok: true }
    ] },
    ui: open
  })),
  // The same chat as WorkspaceScrolledUp, then a click on Scroll to bottom (scripts/shots.ts scrolls it up first).
  AuditScrollToBottomMotion: { ...scene(() => ({ items: { [ids.tableChat]: longChat }, ui: open })), motion: { action: { click: 'Scroll to bottom' }, ms: 1000, area: '.ws-main' } },
  /** Answering a question: the first option is picked by scripts/shots.ts, the answer is not sent. */
  AuditQuestionPicked: scene((f) => works(f, jAsked(280, 'Steps 1 to 5 pass on a clean account. Step 6 found one difference from the release candidate.'), { running: true, approvals: [jQuestion([JOURNEY_QUESTIONS[0]], { createdAt: ago(0) })] })),
  /** The answer sent as motion: the option is ticked first, then Send is pressed. The call is answered by the fixture, so the card folds the way a real answer does. */
  AuditQuestionAnswerMotion: { ...scene((f) => works(f, jAsked(280, 'Steps 1 to 5 pass on a clean account. Step 6 found one difference from the release candidate.'), { running: true, approvals: [jQuestion([JOURNEY_QUESTIONS[0]], { createdAt: ago(0) })] })), motion: { action: { press: ['Enter'] }, ms: 1000, area: '.ws-main' } },
  /** A jump from the chat rail as motion: the list is opened from the keyboard on the chat's end, Home picks the first message and Enter jumps to it. */
  AuditRailJumpMotion: { ...railScene(), motion: { action: { press: ['Home', 'Enter'] }, ms: 1400, area: '.ws-main' } },
  /** A rail jump interrupted by a send as motion: Home and Enter start the jump, then Send is pressed while it glides. The jumped-to message still rings (KERNEL-881). */
  AuditRailJumpSendMotion: { ...scene(() => ({
    ...withDraft({ items: { [ids.tableChat]: railChat() }, ui: open }, 'Now add a CSV export for the filtered rows.'),
    afterSend: [{ afterMs: 40, events: [{ type: 'chat.running', chatId: ids.tableChat, running: true }, { type: 'chat.item', chatId: ids.tableChat, item: { kind: 'user', id: 'rs-u', ts: Date.now(), parts: [{ type: 'text', text: 'Now add a CSV export for the filtered rows.' }] } }] }]
  })), motion: { action: { press: ['Home', 'Enter', 'click:Send'] }, ms: 1400, area: '.ws-main' } },
  /** A group of steps collapsing as motion: its header is focused and Enter folds it (KERNEL-881). */
  AuditGroupCollapseMotion: { ...scene(() => ({
    items: { [ids.tableChat]: foldedMessages },
    ui: { ...open, workspace: { right: 'changes', bottom: 'run', toolCalls: 'open' } }
  })), motion: { action: { press: ['Enter'] }, ms: 600, area: '.ws-main' } },
  /** KERNEL-912: a folded group of steps opened by hand in a chat that has settled. It must still animate, so the opening rule does not leak past the first 600ms. The header is focused by scripts/shots.ts and Enter opens it. */
  AuditGroupOpenMotion: { ...scene(() => ({
    items: { [ids.tableChat]: foldedMessages },
    ui: open
  })), motion: { action: { press: ['Enter'] }, ms: 600, area: '.ws-main' } },
  // Kernel's plan for T-15 waits in the Lead's own worktree, on the Grouped sidebar, before the export chat hands anything off (KERNEL-355).
  WorkspaceLead: scene((f) => leadWaiting(f)),
  WorkspaceLeadPlan: scene((f) => leadPlan(f, { agentId: 'kernel-lead' })),
  // KERNEL-1091: the plan opened from its path link in a file tab (4.4), the New tab menu over the Lead's chat, and a Lead turn's steps opened in place (4.2). The shots click the step.
  WorkspacePlanFile: scene((f) => { const p = planWaiting(f); return { ...p, fileText: { [ids.lead]: { 'plans/t-15-invoice-pdf.md': LEAD_PLAN } }, ui: { ...p.ui, tabs: { [ids.lead]: { tab: 'file:plans/t-15-invoice-pdf.md', lastChat: ids.leadChat, files: ['plans/t-15-invoice-pdf.md'], diffs: [] } } } } }),
  WorkspaceNewTabMenu: scene((f) => { const p = leadWaiting(f); return { ...p, ui: { ...p.ui, menu: 'newTab' } } }),
  // KERNEL-1064: the same plan with acceptance criteria under three of its four tasks. The third has none and looks as it always did.
  WorkspaceLeadPlanCriteria: scene((f) => leadPlan(f, { agentId: 'kernel-lead' }, { steps: T15_CRITERIA_STEPS })),
  /** What the Lead chat still owes, above the composer (KERNEL-792): a question, blockers and a proposed hand-off. The collapsed line, and the same with the list opened by scripts/shots.ts. */
  LeadOpenItems: scene((f) => leadOpenItems(f)),
  LeadOpenItemsOpen: scene((f) => leadOpenItems(f)),
  // The Lead's PRs tab: two ready PRs with Merge, six that wait, and the same panel with nothing open (KERNEL-354).
  LeadPrs: scene((f) => leadPrsScene(f, [P10_LEAD.journey, P10_LEAD.banner, P10_LEAD.soak], 'What can I merge?', P10_LEAD_REPLY)),
  PanelResize: idleRun(headerScene('ready', [], { panel: true })),
  // The panel at its narrowest, 320px, where the strips scroll sideways (KERNEL-514). The top strip sits beside the PRs toolbar's refresh.
  // The bottom's two terminals past Run are stand-ins the shot adds.
  PanelTabsOverflow: scene((f) => {
    const s = leadPrsScene(f, [MERGE_A, MERGE_B], 'What can I merge?', LEAD_PRS_REPLY, LEAD_RUN)
    return { ...s, ui: { ...s.ui, bottomCollapsed: { lead: false, teammate: false } } }
  }),
  // The right panel's strip carries the tab on show's own actions (KERNEL-515): PRs has refresh, All files a filter and collapse, Changes Review all, a filter and the tree toggle, Checks refresh and
  // open on GitHub. The filter's field opens under the strip from the search button, the way PanelFilter draws it with "inbox" typed.
  PanelToolbarPrs: scene((f) => {
    const s = leadPrsScene(f, [P10_LEAD.journey, P10_LEAD.banner, P10_LEAD.soak], 'What can I merge?', P10_LEAD_REPLY)
    return { ...s, workspaces: s.workspaces!.map((w) => (w.id === ids.lead ? { ...w, port: 4303 } : w)), ui: { ...s.ui, bottomCollapsed: { lead: false, teammate: false } } }
  }),
  LeadPrsEmpty: scene((f) => leadPrsScene(f, [], 'What can I merge?', 'Nothing is open right now. Every PR your agents opened has merged.')),
  LeadPrsReviewPlanned: scene((f) => leadPrsScene(f, [{ ...P10_LEAD.journey, state: 'checks', review: 'planned' }], 'What can I merge?', "Teng's #1153 is running its checks. Artkin reviews it once they pass.")),
  // A PR with blockers on its latest commit isn't ready: it sits under Needs attention, says Blockers found and offers Merge anyway (KERNEL-501, KERNEL-757).
  LeadPrsBlockers: scene((f) => leadPrsScene(f, [{ ...P10_LEAD.soak, state: 'ready', review: 'blockers' }], 'What can I merge?', "Artkin found 2 blockers on #1154, so it isn't ready. Sean can fix them, or you can merge past them.")),
  // One row per state word (KERNEL-897): both approvals and code alone in green, a failure in red, a spinner, a clock, and two plain muted rows.
  LeadPrsStateWords: scene((f) => leadPrsScene(f, [
    { ...P10_LEAD.journey, id: 'ws-1150', n: 1150, title: 'Draft fixture', state: 'draft', review: undefined, stat: [8, 0] },
    { ...P10_LEAD.soak, id: 'ws-1151', n: 1151, title: 'Soak harness', stat: [318, 12] },
    { ...P10_LEAD.banner, id: 'ws-1152', n: 1152, title: 'Banner copy', state: 'changes', stat: [6, 6] },
    { ...P10_LEAD.banner, id: 'ws-1153b', n: 1153, title: 'Lockfile bump', state: 'conflict', stat: [210, 190] },
    { ...P10_LEAD.journey, id: 'ws-1154b', n: 1154, title: 'Review screen', review: 'stale', stat: [32, 4] },
    { ...P10_LEAD.journey, id: 'ws-1155b', n: 1155, title: 'Journey test', stat: [67, 1] }
  ], 'What can I merge?', P10_LEAD_REPLY)),
  LeadPrsOverruled: scene((f) => leadPrsScene(f, [{ ...P10_LEAD.soak, state: 'ready', review: 'blockers', overruled: true }], 'What can I merge?', "You overruled Artkin's 2 blockers on #1154, so it can merge.")),
  // A PR merging keeps its row in Ready to merge and spins there, though this tab didn't start it (KERNEL-411, KERNEL-417).
  LeadPrsMerging: scene((f) => leadPrsScene(f, [{ ...P10_LEAD.journey, state: 'merging' }, { ...P10_LEAD.soak, state: 'ready', review: 'approved' }], 'Merge #1153.', 'Merging #1153 now. #1154 is ready too.')),
  // Every open PR ready: one Merge per row and nothing to merge them all at once (KERNEL-757).
  LeadPrsAllReady: scene((f) => leadPrsScene(f, [P10_LEAD.journey, { ...P10_LEAD.soak, state: 'ready', review: 'approved' }, { ...P10_LEAD.banner, state: 'ready', review: 'approved' }], 'What can I merge?', "All three are ready. Artkin approved each one. Tell me which to merge, or merge them from the PRs tab.")),
  // The PRs tab at the panel's narrowest, 320px, with every list and a blocked PR's Merge anyway: titles end in an ellipsis and nothing overlaps (KERNEL-757).
  LeadPrsNarrow: scene((f) => leadPrsScene(f, [LEAD_PRS[0], LEAD_PRS[1], BLOCKERS_PR, LEAD_PRS[3], LEAD_PRS[4], LEAD_PRS[6], LEAD_PRS[7]], 'What can I merge?', LEAD_PRS_REPLY)),
  // Open PRs, none of them ready: the band counts them instead of saying there are none (KERNEL-411).
  LeadPrsNoneReady: scene((f) => leadPrsScene(f, [P10_LEAD.banner, P10_LEAD.soak], 'What can I merge?', "Nothing yet. #1155 failed its Test check, and #1154 is still running its checks.")),
  // Kernel's team updates in Kernel's chat (KERNEL-127). No PNG: the card follows the canvas card and note values.
  WorkspaceLeadUpdate: scene((f) => leadUpdate(f)),
  // KERNEL-1000: Not reviewed with automatic review off. The card reads as it always did; the pointer on those words says why (TeamUpdateNotReviewedTip).
  TeamUpdateNotReviewed: scene((f) => leadUpdate(f)),
  TeamUpdateNotReviewedTip: scene((f) => teamUpdateMergedUnreviewed(f)),
  TeamUpdateMerge: scene((f) => teamUpdateMerge(f)),
  // A merged PR whose workspace isn't archived yet: the row reads the merged icon and Merged beside Open.
  TeamUpdateMerged: scene((f) => { const m = teamUpdateMerge(f); return { ...m, workspaces: (m.workspaces ?? []).map((w) => (w.id === 'ws-163' ? { ...w, status: 'ready' as const, archivedAt: undefined } : w)) } }),
  // KERNEL-557: a merge Kernel made by itself, a PR still blocked after its review rounds, and a skipped review.
  TeamUpdateReview: scene((f) => teamUpdateReview(f)),
  // KERNEL-747: a teammate's question and a hand-off another teammate proposed.
  TeamUpdateAsk: scene((f) => teamUpdateAsk(f)),
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
    items: { 'chat-table': groupedTurn('gt', 38, 'Build the invoice table with sorting, plus the empty, loading and error states.', 'The table and the schema change are independent. Christian and Sean can start together.', [
      tool('gt-t1', 'Write the plan', 'cat > plans/t-14-invoice-table.md', { name: 'Write' })
    ], 'Christian has the table and its states. Sean has the schema change the table needs. I will tell you when either opens a PR.').concat([
      tool('gt-t2', 'Check on Christian and Sean', 'kernel workspaces')
    ]) }
  })),
  GroupedNewTabMenu: scene((f) => { const g = grouped(f); return { ...g, ui: { ...g.ui!, menu: 'newTab' } } }),
  GroupedSharedWork: scene((f) => grouped(f, {
    tab: 'chat-christian-pr',
    items: { 'chat-christian-pr': [
      userMsg('sw', "How is Christian's PR going?"),
      tool('sw-t1', "List this chat's workspaces", 'kernel workspaces', { name: 'Bash' }),
      tool('sw-t2', 'Read the approved plan', 'cat plans/t-15-invoice-pdf.md', { name: 'Read' }),
      { kind: 'text', id: 'sw-tx', ts: at(10, 56), text: [
        "Christian's PR is open as #43 on invoice-pdf-button. Checks pass and Artkin is reviewing it. Here is where your other workspaces in this chat stand.", '',
        '**Your workspaces in this chat**', '', '```', 'invoice-pdf-renderer  Sean  working', 'invoice-pdf-button    Christian   PR #43 open', 'invoice-pdf-tests     Teng   waiting on the renderer', '```', '',
        '**From the plan you approved in the first tab**', '', '1. T-15a PDF renderer with embedded fonts · Sean', '2. T-15b Download PDF in the row actions · Christian', '3. T-15c Snapshot tests for three invoice types · Teng'
      ].join('\n') },
      { kind: 'result', id: 'sw-res', ts: at(10, 56), durationMs: 11_000, ok: true }
    ] }
  })),
  GroupedContextFull: scene((f) => grouped(f, { chats: (c) => c.map((x) => (x.id === ids.leadChat ? { ...x, context: 92 } : x)) })),
  // The same chat after New tab in the banner: a fourth tab, empty, in the same chat.
  GroupedContextFullAfter: scene((f) => grouped(f, { tab: 'chat-new', chats: (c) => [...c.slice(0, 3), leadTab('chat-new', GROUPED.export, 'New tab', 14), ...c.slice(3)] })),
  // Christian finished in the first tab, which you closed since. The update goes to a tab that is still open, and says where the work came from.
  GroupedUpdateRouted: scene((f) => {
    const row: TeamUpdateRow = {
      workspaceId: 'ws-pdf-button', agentId: 'christian', name: 'Christian', task: 'T-15b Download PDF in the row actions', prNumber: 43, fromChat: 'Export invoices as PDF', fromTab: true,
      events: [{ kind: 'turn', text: 'Finished a turn', actionable: false }, { kind: 'pr.opened', text: 'Opened PR #43', actionable: false }],
      reply: 'PR #43 is ready to merge. Checks pass and Artkin approved it.'
    }
    return grouped(f, {
      tab: 'chat-christian-pr', chats: (c) => c.map((x) => (x.id === ids.leadChat ? { ...x, closed: true } : x)),
      items: { 'chat-christian-pr': [
        userMsg('ur', "How is Christian's PR going?"),
        { kind: 'text', id: 'ur-tx', ts: at(10, 30), text: "Christian's PR is open as #43 on invoice-pdf-button. Checks are still running." },
        { kind: 'user', id: 'ur-up', ts: at(10, 41), from: 'kernel', update: { rows: [row] }, parts: [{ type: 'text', text: ['Team update from Kernel, not from the user.', '', 'From "Export invoices as PDF", a tab you closed:', '- Christian (christian) · T-15b Download PDF in the row actions · workspace ws-pdf-button: PR #43 is ready to merge.'].join('\n') }] }
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
    return { ...g, ui: { ...g.ui!, modal: { name: 'confirm', kind: 'closeChats', workspaceId: CHAT_WS[GROUPED.table], chatIds: ['chat-table'] } } }
  }),
  // Hovering a chat row shows Archive, like a workspace row's (KERNEL-405). The shot hovers the table chat (scripts/shots.ts).
  GroupedChatArchive: scene((f) => grouped(f, { running: [] })),
  SidebarUnread: scene(sidebarUnread),
  SidebarPlanChat: scene(sidebarPlanChat),
  SidebarChatPrs: scene(sidebarChatPrs),
  SidebarChatPrPlan: scene(sidebarChatPrPlan),
  // Archiving the export chat would stop Christian's open PR and drop the renderer's uncommitted changes, so it asks first (KERNEL-405).
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
  // A project with no open chat (KERNEL-365): New chat with Kernel, with no workspace before the first message, and no chat row (KERNEL-366, KERNEL-405).
  // The workspaces the archived chats handed off stay as unowned rows when Archive a chat's workspaces is off.
  // The line under the title says what the project is doing, and Up next lists the tracker's Todo issues, urgent first.
  LeadNoChats: scene(leadNoChats),
  // New branch from main opened: the remote's branches with the default checked. The menu is the composer's own, so the shot opens it (scripts/shots.ts).
  LeadNoChatsBranch: scene(leadNoChats),
  // KERNEL-781: New chat's box is a chat's box. NewChat is the page at rest and ChatComposer an open chat, to compare the box's top edge and toolbar. NewChatLongDraft is eight lines in the box, which grows up
  // with Up next and the title moving ahead of it. NewChatPlan has plan mode on: the box is hatched and the permission slot reads Plan.
  NewChat: scene((f) => noPlan(leadNoChats(f))),
  NewChatLongDraft: scene((f) => {
    const g = noPlan(leadNoChats(f))
    const draft = ['Settings search should land on the setting, not only open its page. When I pick a result:', '1. Open the Settings page the setting belongs to.', '2. Scroll the matching row into view, centered when it fits.', '3. Outline the row for about a second, then let the outline fade.', '4. Put focus on the row\'s control so I can change it from the keyboard.', 'Enter in the search field opens the first match.', 'If I come back to search, my query is still in the field.'].join('\n')
    return { ...g, ui: { ...g.ui!, workspace: { right: 'changes', bottom: 'run', composer: { parts: [], draft } } } }
  }),
  // KERNEL-869: the first visit to New chat in a project with no tracker. The tracker answers late, and nothing was held for Up next, so the box stays where it was.
  NewChatNoTracker: scene((f) => ({ ...noPlan(leadNoChats(f)), trackers: { [ids.projectA]: { kind: 'none' as const, available: { linear: false } } } })),
  NewChatNoTrackerMotion: { ...scene((f) => ({ ...noPlan(leadNoChats(f)), ui: { ...open, workspace: { right: 'changes', bottom: 'run' } }, trackers: { [ids.projectA]: { kind: 'none' as const, available: { linear: false } } }, lag: { 'issues.next': 700, 'issues.tracker': 700 } })), motion: { action: { click: 'New chat in Client A' }, ms: 1000, area: '.lead-new' } },
  NewChatPlan: scene((f) => ({ ...leadNoChats(f), settings: { ...DEFAULT_SETTINGS('/Users/you'), models: { ...DEFAULT_SETTINGS('/Users/you').models, leadPlanMode: true } } })),
  // KERNEL-786: the + menu with Run in and Branch, and each picker open (the shot opens them, scripts/shots.ts). NewChatLocal has Local picked by Settings' workspace mode, so the chip beside + says Local.
  // NewChatBranch lists branches with two that have an open workspace, one that is local only, and the default first. NewChatBranchChip picks one, so the chip says where the chat starts from.
  // NewChatLinked has an issue chip in the box.
  NewChatProjectPicker: scene((f) => noPlan(leadNoChats(f))),
  // New chat on a project that was archived under it: the title asks without a project, and Pick a project opens the same menu.
  NewChatNoProject: scene((f) => {
    const p = noPlan(leadNoChats(f))
    const gone = { ...f.projects[0], id: 'project-gone', name: 'Old app', archived: true }
    return { ...p, projects: [...(p.projects ?? f.projects), gone], ui: { ...p.ui!, route: { name: 'leadNew', projectId: gone.id } } }
  }),
  // KERNEL-1090: a send with no project picked, and a send to a project that was archived or removed. Each is a toast in the bottom right, and the draft stays in the box.
  NewChatPickProject: scene((f) => {
    const p = noPlan(leadNoChats(f))
    return { ...p, ui: { ...p.ui!, route: { name: 'leadNew', projectId: '' }, workspace: { right: 'changes', bottom: 'run', composer: { parts: [], draft: 'Plan the soak harness before anyone writes code.' } }, toasts: [{ id: 'pick-project', title: 'Pick a project first', sub: 'Kernel and its team work inside one repo at a time.', action: { label: 'Pick project', pickProject: true } }] } }
  }),
  NewChatProjectGone: scene((f) => {
    const p = noPlan(leadNoChats(f))
    const gone = { ...f.projects[0], id: 'project-gone', name: 'Old app', archived: true }
    return { ...p, projects: [...(p.projects ?? f.projects), gone], ui: { ...p.ui!, route: { name: 'leadNew', projectId: gone.id }, workspace: { right: 'changes', bottom: 'run', composer: { parts: [], draft: 'Plan the soak harness before anyone writes code.' } }, toasts: [{ id: 'project-gone', title: 'This project is archived or gone', sub: 'There is nowhere to start the chat. Pick another project.', action: { label: 'Pick project', pickProject: true } }] } }
  }),
  // KERNEL-1090: the two confirms New chat opens, drawn over New chat. Bypass permissions asks once, and an issue someone may already be on holds the brief until Start anyway.
  ConfirmBypassNewChat: scene((f) => {
    const p = noPlan(leadNoChats(f))
    return { ...p, ui: { ...p.ui!, modal: { name: 'confirm', kind: 'bypass' } } }
  }),
  ConfirmIssueTakenNewChat: scene((f) => {
    const p = noPlan(leadNoChats(f))
    const held = { projectId: ids.projectA, source: { kind: 'issue' as const, id: 'KERNEL-232', title: 'Soak harness for the sync engine' }, parts: [{ type: 'text' as const, text: 'KERNEL-232: Soak harness for the sync engine' }], picks: { mode: 'worktree' as const, model: 'claude-opus-5-5', effort: 'high' as const, plan: false, baseRef: '' } }
    return { ...p, ui: { ...p.ui!, modal: { name: 'confirm', kind: 'issueTaken', issue: 'KERNEL-232', findings: [{ kind: 'branch', ref: 'origin/feat/kernel-232-soak-harness' }, { kind: 'pr', number: 41, title: 'Soak harness for the sync engine' }, { kind: 'assignee', name: 'Maya Chen' }], held } } }
  }),
  // KERNEL-943: no project at all yet. The title asks what we're building, and the three ways to add a project sit above the box.
  NewChatFirstProject: scene(() => ({ projects: [], agents: {}, status: {}, workspaces: [], chats: [], items: {}, approvals: [], activity: [], changes: {}, diffs: {}, push: [], ui: { route: { name: 'leadNew', projectId: '' }, workspace: { right: 'changes', bottom: 'run' } } })),
  // docs/decisions/workspace-picker.md: the chip beside + opens the Workspace menu (the shot opens it, scripts/shots.ts). NewChatWorkspace has one previous worktree and a free checkout. NewChatWorkspaceTaken
  // has the checkout held by the demo chat, so Current checkout is off with that chat named. NewChatWorkspaceRecent has four previous worktrees, newest first, in the list under Previous worktree.
  // NewChatWorkspacePrevious picks the one previous worktree, so the chip names its chat.
  NewChatWorkspace: scene((f) => noPlan(leadNoChats(f, 1))),
  NewChatWorkspaceTaken: scene((f) => {
    const g = noPlan(leadNoChats(f, 2))
    return { ...g, workspaces: g.workspaces!.map((w) => (w.id === 'ws-chat-demo' ? { ...w, mode: 'current' as const, branch: 'main', path: '/Users/you/Projects/client-a', baselineRef: 'f3a9c21' } : w)) }
  }),
  NewChatWorkspaceRecent: scene((f) => noPlan(leadNoChats(f, 4))),
  NewChatWorkspacePrevious: scene((f) => noPlan(leadNoChats(f, 1))),
  NewChatKeyboard: scene((f) => noPlan(leadNoChats(f))),
  NewChatBranch: scene(newChatBranches),
  NewChatBranchChip: scene(newChatBranches),
  NewChatLocal: scene((f) => ({ ...leadNoChats(f), settings: { ...DEFAULT_SETTINGS('/Users/you'), workspace: { ...DEFAULT_SETTINGS('/Users/you').workspace, mode: 'current' }, models: { ...DEFAULT_SETTINGS('/Users/you').models, leadPlanMode: false } } })),
  NewChatPlus: scene((f) => noPlan(leadNoChats(f))),
  NewChatLinkIssue: scene((f) => noPlan(leadNoChats(f))), // the + menu's Link issue picker over the project's Linear issues
  // New chat with the permission menu open from its own button (scripts/shots.ts).
  NewChatPermissionMenu: scene((f) => noPlan(leadNoChats(f))),
  NewChatNarrow: scene((f) => noPlan(leadNoChats(f))),
  // KERNEL-788: NewChat is the page at rest, with the header a chat has and one New chat tab. NewChatAfterSend is the chat right after the send: the box stays at the same y, the
  // breadcrumb and tab take the chat's title, and the panel setting is on but held closed. ChatPanelOpened is that chat after the toggle was pressed.
  NewChatAfterSend: scene((f) => noPlan(startedFromNewChat(f, false))),
  ChatPanelOpened: scene((f) => noPlan(startedFromNewChat(f, true))),
  NewChatLinked: scene((f) => {
    const g = noPlan(leadNoChats(f))
    const issue = { type: 'issue' as const, name: 'T-17', title: 'Email an invoice to the client from the row actions', url: 'https://linear.app/client-a/issue/T-17', source: 'linear' as const }
    return { ...g, ui: { ...g.ui!, workspace: { right: 'changes', bottom: 'run', composer: { parts: [issue, { type: 'text', text: ' ' }], draft: '' } } }, motion: { action: { hold: 'Open issue T-17, Email an invoice to the client from the row actions' }, ms: 500 } }
  }),
  WorkspaceSharedMissing: scene((f) => ({ ...renderer(f), shared: sharedFiles(2).filter((x) => x.workspaceId === ids.table && x.id !== 'sh-html'), ui: { ...open, workspace: { right: 'changes', bottom: 'run' } } })), // the chat's HTML card with its file gone from the store (KERNEL-870)
  WorkspaceSharedHtml: sharedTab('sh-html'),
  WorkspaceSharedPhone: sharedTab('sh-html'),
  WorkspaceSharedImage: sharedTab('sh-image'),
  WorkspaceSharedImageZoom: sharedTab('sh-image'), // the same image at 200%, with the zoom control in the toolbar; the shot presses Zoom in twice (KERNEL-598)
  WorkspaceSharedMarkdown: sharedTab('sh-md'),
  WorkspaceSharedPdf: sharedTab('sh-pdf'),
  WorkspaceSharedCrashed: sharedTab('sh-html'),
  WorkspaceSharedVersions: sharedTab('sh-html'),
  // KERNEL-934: a viewer tab keeps the box to one line (WorkspaceSharedHtml and WorkspaceSharedImage show it closed). Open with the model menu, a plan waiting on a file tab, and a draft waiting.
  WorkspaceViewerOpenMenu: scene((f) => ({ ...sharedTabScene(f, 'sh-html'), ui: { ...sharedTabScene(f, 'sh-html').ui, menu: 'model' } })),
  WorkspaceViewerPlan: scene((f) => {
    const p = planWaiting(f)
    return { ...p, fileText: { [ids.lead]: { 'plans/t-15-invoice-pdf.md': LEAD_PLAN } }, ui: { ...p.ui, workspace: { right: 'changes', bottom: 'run' }, tabs: { [ids.lead]: { tab: 'file:plans/t-15-invoice-pdf.md', lastChat: ids.leadChat, files: ['plans/t-15-invoice-pdf.md'], diffs: [] } } } }
  }),
  WorkspaceViewerDraft: scene((f) => withDraft(sharedTabScene(f, 'sh-html'), 'Make the totals row bold in the detailed layout.')),
  // Comment mode (KERNEL-311). The shots click Comment and the spot (scripts/shots.ts); the state they reach is not a fixture's to force.
  WorkspaceSharedComment: commentTab('sh-pricing'),
  WorkspaceSharedCommentImage: commentTab('sh-image'),
  WorkspaceSharedCommentSent: commentSent,
  WorkspaceSharedCommentArchived: scene((f) => commentArchived(f)),
  WorkspaceSharedCommentOlder: commentTab('sh-pricing', 3, 2),
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
  // ---- Redesign 10, Pull request and merge (KERNEL-1097). 10.1 to 10.8 follow the flow, and 10.9 to 10.13 are the sheets, a fixture for each state on them. ----
  // 10.1: the Session rail with its pull request open and nothing in the way, so Merge PR is green.
  WorkspacePROpen: scene((f) => pr10(f, { state: 'open' })),
  // 10.2: Merge anyway asks first, and lists what the review found on the latest commit.
  ConfirmMergeAnyway: scene((f) => pr10(f, { state: 'ready', ws: { reviews: [p10Blockers()] }, ui: { modal: { name: 'confirm', kind: 'mergeAnyway', workspaceId: ids.table } } })),
  // 10.3: neither the rail nor the panel shows, so the title bar carries the pull request and its one action.
  PrReadyHidden: scene((f) => pr10(f, { state: 'ready', hidden: true })),
  // 10.4: a project with no GitHub merges the branch on this Mac, and the rail says so.
  PrLocalReady: scene((f) => p10Local(f, 'ready')),
  // 10.5: the Pull request tab with its acceptance criteria, one in each state, the reviewer's judgment labeled.
  WorkspaceCriteria: scene((f) => p10Criteria(f, [0, 1, 2, 3, 4], 'codex')),
  WorkspaceCriteriaPassed: scene((f) => p10Criteria(f, [0], 'codex')),
  WorkspaceCriteriaFailed: scene((f) => p10Criteria(f, [2], 'codex')),
  WorkspaceCriteriaUnverified: scene((f) => p10Criteria(f, [3])),
  WorkspaceCriteriaReviewerMet: scene((f) => p10Criteria(f, [1], 'codex')),
  WorkspaceCriteriaStale: scene((f) => p10Criteria(f, [4], 'claude')),
  // 10.9: every state the Review stage can be in, on GitHub and on this Mac.
  WorkspacePRNone: scene((f) => pr10(f, { state: 'none' })),
  WorkspacePRCreating: scene((f) => pr10(f, { state: 'creating', pending: 'create' })),
  WorkspaceDraftPR: scene((f) => pr10(f, { state: 'draft' })),
  WorkspacePRNoChanges: scene((f) => pr10(f, { state: 'none', noChanges: true })),
  WorkspacePRChecks: scene((f) => pr10(f, { state: 'checks', pr: { checks: [{ name: 'Test', state: 'pass' }, { name: 'Build', state: 'pass' }, { name: 'Release note', state: 'running' }, { name: 'Other apps', state: 'queued' }] } })),
  // A ready PR whose repo requires only Test: Lint failed and is optional, so it doesn't hold the merge (KERNEL-388).
  WorkspacePRChecksOptional: scene((f) => pr10(f, { state: 'ready', pr: { checks: [{ name: 'Test', state: 'pass' }, { name: 'Build', state: 'pass' }, { name: 'Lint', state: 'fail', optional: true }] } })),
  WorkspaceCIFailed: scene((f) => pr10(f, { state: 'cifail', pr: { checks: [{ name: 'Test', state: 'fail' }, { name: 'Build', state: 'pass' }, { name: 'Release note', state: 'pass' }, { name: 'Other apps', state: 'pass' }] } })),
  // Waiting for the reviewer: the review of the latest commit is planned and has not approved it yet (KERNEL-1071).
  PrWaitingReview: scene((f) => pr10(f, { state: 'ready', ws: { reviewRound: { n: 1, rounds: 3, head: 'h1153', prNumber: 1153, kinds: ['code'] } } })),
  WorkspaceReviewedByClaude: scene((f) => pr10(f, { state: 'ready', ws: { reviews: [p10Review({ provider: 'claude' })] } })),
  WorkspaceReviewedByCodex: scene((f) => pr10(f, { state: 'ready', ws: { reviews: [p10Review({ provider: 'codex' })] } })),
  WorkspaceChangesRequested: scene((f) => pr10(f, { state: 'changes', pr: { reviewDecision: 'changes', comments: [{ id: 'rv1', author: 'Artkin', path: 'test/journey.test.ts', line: 14, body: 'Name the threshold.', resolved: false }, { id: 'rv2', author: 'Artkin', path: 'fixtures/journey.ts', line: 3, body: 'Read the build from the release manifest.', resolved: false }] } })),
  // Blockers on the latest commit: the review found two, the agent can address them, and a person can merge past them on purpose (KERNEL-501).
  PrBlockers: scene((f) => pr10(f, { state: 'ready', ws: { reviews: [p10Blockers()] } })),
  PrBlockersOverruled: scene((f) => pr10(f, { state: 'ready', ws: { reviews: [p10Blockers()], overruled: { head: 'h1153', kinds: ['code'], by: 'user', ts: J(57) } } })),
  WorkspacePRConflict: scene((f) => pr10(f, { state: 'conflict', pr: { conflicts: ['test/journey.test.ts', 'fixtures/journey.ts'] } })),
  WorkspacePRResolving: scene((f) => pr10(f, { state: 'resolving', pr: { conflicts: ['test/journey.test.ts', 'fixtures/journey.ts'] } })),
  // A ready PR GitHub won't merge until someone approves it (KERNEL-388).
  WorkspacePRBlocked: scene((f) => pr10(f, { state: 'ready', ws: { prBlocked: 'review' }, pr: { blocked: 'review' } })),
  WorkspacePRReady: scene((f) => pr10(f, { state: 'ready', ws: { reviews: [p10Review()] } })),
  WorkspacePRMerging: scene((f) => pr10(f, { state: 'merging', pending: 'merge' })),
  WorkspacePRClosed: scene((f) => pr10(f, { state: 'closed' })),
  // A branch that merges on the Mac, in a project with no GitHub (KERNEL-478).
  PrLocalBehind: scene((f) => p10Local(f, 'behind')),
  PrLocalDirty: scene((f) => p10Local(f, 'dirty')),
  PrLocalConflict: scene((f) => p10Local(f, 'conflict')),
  PrLocalMerging: scene((f) => p10Local(f, 'merging')),
  PrLocalMerged: scene((f) => p10Local(f, 'merged')),
  // 10.10: with the Session rail hidden, the pull request's state moves into the title bar, and its menu opens under Open PR.
  PrNoPrHidden: scene((f) => pr10(f, { state: 'none', hidden: true })),
  PrCiFailHidden: scene((f) => pr10(f, { state: 'cifail', hidden: true, pr: { checks: [{ name: 'Test', state: 'fail' }, { name: 'Build', state: 'pass' }] } })),
  PrMergedHidden: scene((f) => pr10(f, { state: 'merged', hidden: true })),
  PrMergedHiddenLong: scene((f) => pr10(f, { state: 'merged', hidden: true, ws: { title: 'Clean-account journey on a fresh Mac user with several accounts, a long brief and every shot kept' } })),
  PrClosedHidden: scene((f) => pr10(f, { state: 'closed', hidden: true })),
  WorkspacePRMenu: scene((f) => pr10(f, { state: 'open', ui: { menu: 'pr' } })),
  // 10.13: the Create PR menu, the Archive and Continue pair after a merge, and the toast that says the branch's name was copied.
  CreatePrMenu: scene((f) => pr10(f, { state: 'none', ui: { menu: 'pr' } })),
  ContinueAfterMerge: scene((f) => pr10(f, { state: 'merged', ws: { reviews: [p10Review()], mergedAt: J(59) } })),
  BranchCopied: scene((f) => pr10(f, { state: 'open', ws: { branch: 'feat/kernel-1075-automatic-review' }, ui: { toasts: [{ id: 'bc', glyph: 'done', title: 'Branch copied', sub: 'feat/kernel-1075-automatic-review' }] } })),
  WorkspaceMerged: prScene('merged', [
    ...prTurn('m', ['# Create a pull request', '1. Rebase on origin/main and run pnpm test', '2. Title it as a Conventional Commit'], 6, 'Opened PR #42. Artkin approved it and every check passed.'),
    prNote('m-note', 'PR #42 was squashed into main.', 'merged')
  ], { prs: prInfo('merged') }),
  // KERNEL-685: a project with no setup script. The Setup tab offers Kernel's suggestion, Ask Kernel and Add manually.
  WorkspaceSetupAddConductor: scene((f) => ({
    projectSettings: { [ids.projectA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } },
    scriptSuggestions: { [ids.projectA]: [{ source: 'conductor', file: '.conductor/settings.toml', patch: { scripts: { setup: 'pnpm install\ncp ../../.env.local .env.local' } }, notes: ['The archive script was left out because this project already has one.'] }] },
    push: f.push.filter((e) => e.type !== 'script.output' || e.kind !== 'setup'),
    ui: { ...open, workspace: { right: 'changes', bottom: 'setup' } }
  })),
  WorkspaceSetupAddDetected: scene((f) => ({
    projectSettings: { [ids.projectA]: { scripts: { run: 'pnpm dev --port $KERNEL_PORT', runMode: 'concurrent' }, runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }], files: { copy: [] }, workspace: {} } },
    scriptSuggestions: { [ids.projectA]: [{ source: 'detected', file: 'pnpm-lock.yaml', patch: { scripts: { setup: 'pnpm install' } }, notes: [] }] },
    push: f.push.filter((e) => e.type !== 'script.output' || e.kind !== 'setup'),
    ui: { ...open, workspace: { right: 'changes', bottom: 'setup' } }
  })),
  // Redesign 18 (Pen 18.1): two toasts over the merged chat with its Session rail, the newest at the bottom: a PR that merged, with its View, then a plain Copied.
  WorkspaceToast: scene((f) => pr10(f, { state: 'merged', ws: { reviews: [p10Review()], mergedAt: J(59) }, ui: { toasts: [
    { id: 't1', glyph: 'merged', title: 'PR #1153 merged', sub: 'Noor squashed it into main.', action: { label: 'View', href: P10_URL } },
    { id: 't2', glyph: 'done', title: 'Copied', sub: 'The message is on the clipboard.' }
  ] } })),
  // The picker with the cursor moved up one row by the arrow key.
  WorkspaceModelPickerKeys: scene((f) => ({
    settings: codexRoleSettings(),
    chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, sessionId: 'session-christian' } : c)),
    models: { codex: codexModels },
    ui: { ...open, menu: 'model' }
  })),
  // KERNEL-987: the keyboard path. Down to the Legacy row, Right opens the flyout.
  WorkspaceModelPickerLegacyKeys: { ...scene((f) => ({ settings: codexRoleSettings(), chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, sessionId: 'session-christian' } : c)), models: { codex: codexModels }, ui: { ...open, menu: 'model' } })), motion: { action: { press: ['ArrowDown', 'ArrowDown', 'ArrowRight'] }, ms: 600 } },
  // KERNEL-746: in the Lead's chat @ offers the project's teammates above Files. A teammate's chat (WorkspaceMention) lists files only.
  ComposerMentionAgent: scene((f) => ({
    agents: { ...f.agents, [ids.projectA]: [...(f.agents[ids.projectA] ?? [team[0]]), agent('ivy', 'Ivy', 'QA', 'sonnet'), agent('rio', 'Rio', 'Platform', 'sonnet'), agent('theo', 'Theo', 'Review', 'sonnet'), agent('noor', 'Noor', 'Engine', 'opus')] },
    tree: { [ids.lead]: mentionAgentTree },
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', bottom: 'run', composer: { parts: [], draft: '@' } } }
  })),
  ComposerMentionAgentEmpty: scene((f) => ({
    agents: { ...f.agents, [ids.projectA]: [team[0]] },
    workspaces: f.workspaces.map((w) => (w.projectId === ids.projectA ? { ...w, agentId: team[0].id } : w)),
    status: { ...f.status, [ids.projectA]: {} },
    tree: { [ids.lead]: mentionAgentTree },
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'changes', bottom: 'run', composer: { parts: [], draft: '@' } } }
  })),
  ComposerMentionAgentSent: scene((f) => ({
    items: { [ids.leadChat]: [{ kind: 'user', id: 'u-agent', ts: at(10, 41), parts: [{ type: 'agent', name: 'Ivy', agentId: 'ivy' }, { type: 'text', text: 'can rerun the journey on the release candidate?' }] }] },
    chats: f.chats.map((c) => (c.id === ids.leadChat ? { ...c, plan: false } : c)),
    ui: { route: { name: 'workspace', workspaceId: ids.lead } }
  })),
  ComposerModes: scene((f) => bypassPicked(f)),
  ComposerModesNarrow: scene((f) => bypassPicked(f)),
  // A Codex chat with a turn running: Auto can't run for Codex, and the Bypass pick waits on the turn.
  ComposerModeMenu: scene((f) => {
    const b = bypassPicked(f, 'mode')
    return { ...b, workspaces: f.workspaces, chats: b.chats.map((c) => (c.id === ids.leadChat ? { ...c, provider: 'codex' as const, model: 'gpt-6-astra', effort: 'medium' as const } : c)), models: { codex: codexModels }, push: [{ type: 'chat.running', chatId: ids.leadChat, running: true }] }
  }),
  // KERNEL-751: a modal opened while the mode menu was open closes it, so nothing sits above the backdrop.
  ComposerModeMenuUnderModal: scene((f) => ({ ...bypassPicked(f, 'mode'), ui: { ...bypassPicked(f).ui, modal: { name: 'search' } } })),
  /** 11.12: an edit with two hunks: Codex's patch for one file, each hunk under its own header. The shot opens the row. */
  WorkspaceHunks: scene((f) => works(f, [
    jBrief(),
    tool('j-hunks', 'Edit journey.test.ts', 'test/journey.test.ts', { name: 'Edit', ts: J(44), durationMs: 120, input: { file_path: 'test/journey.test.ts' }, output: [
      'diff --git a/test/journey.test.ts b/test/journey.test.ts', '--- a/test/journey.test.ts', '+++ b/test/journey.test.ts',
      '@@ -12,4 +12,5 @@', " import { shots, diff } from './support'", "+import { ReviewRc } from '../fixtures'",
      '@@ -40,6 +41,7 @@', "-  await shots(['Review'])", '-  expect(missing()).toBe(0)', "+  await shots(['Review', 'ReviewRc'])", "+  expect(diff('Review', 'ReviewRc')).toBeLessThan(0.01)", '+  expect(missing()).toEqual([])'
    ].join('\n') }),
    jSay('j-h', J(44, 10), 'Added the release candidate comparison.'), jResult(J(44, 12), 70_000)
  ], { view: { toolCalls: 'open' } })),
  /** The card for a file that holds changes from before the workspace started as well as the agent's (commit hunks). */
  WorkspaceHunkCommit: scene((f) => ({
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
