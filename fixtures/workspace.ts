import type { ChatItem } from '@shared/types'
import type { Fixture } from './types'
import { at, ids, scene, tableItems, withWorkspace } from './base'

// Workspace lane: PR states (KERNEL-15), agent turns and requests (KERNEL-10, 14).

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

export const workspaceFixtures: Record<string, Fixture> = {
  Workspace: scene(() => ({ ui: open })),
  WorkspaceRunning: scene((f) => ({
    items: { [ids.tableChat]: [...midTurn.slice(0, -1), { ...(midTurn.at(-1) as Extract<ChatItem, { kind: 'tool' }>), status: 'running', durationMs: undefined }] },
    push: [...f.push, { type: 'chat.running', chatId: ids.tableChat, running: true }],
    ui: open
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
