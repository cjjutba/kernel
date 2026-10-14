import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/db'
import { Approvals, describeTool } from '../src/main/services/approvals'
import { toActivity } from '../src/main/services/hookServer'
import { permissionTitle } from '../src/renderer/src/screens/workspace/cards/steps'
import { answerParts, approvalAnswer } from '../src/shared/approvalAnswer'
import type { Approval } from '../src/shared/types'

const tempStore = async () => new Store(join(await mkdtemp(join(tmpdir(), 'kernel-approvals-')), 'kernel.db'))

describe('how a request ends (KERNEL-446)', () => {
  it("gives the waiter the user's answer and saves it on the row", async () => {
    const store = await tempStore()
    const approvals = new Approvals(store)
    const yes = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', title: 'Run pnpm db:reset' })
    const no = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', title: 'Run rm -rf dist' })
    approvals.decide(yes.approval.id, { behavior: 'allow' })
    approvals.decide(no.approval.id, { behavior: 'deny', message: 'Not today.' })
    expect(await yes.decision).toEqual({ behavior: 'allow' })
    expect(await no.decision).toEqual({ behavior: 'deny', message: 'Not today.' })
    expect(store.approval(yes.approval.id)?.status).toBe('allowed')
    expect(store.approval(no.approval.id)?.status).toBe('denied')
  })

  it('expires when its time runs out or its signal aborts, and the waiter gets null', async () => {
    const store = await tempStore()
    const approvals = new Approvals(store)
    const slow = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', title: 'Run pnpm db:reset' }, { timeoutMs: 20 })
    expect(await slow.decision).toBeNull()
    const abort = new AbortController()
    const dropped = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', title: 'Run rm -rf dist' }, { signal: abort.signal })
    abort.abort()
    expect(await dropped.decision).toBeNull()
    expect([slow, dropped].map((r) => store.approval(r.approval.id)?.status)).toEqual(['expired', 'expired'])
    // An answer that comes after the row expired reaches nobody and changes nothing.
    expect(approvals.decide(slow.approval.id, { behavior: 'allow' })).toBeUndefined()
    expect(store.approval(slow.approval.id)?.status).toBe('expired')
  })
})

describe('approvals whose turn or session is gone (KERNEL-563)', () => {
  it('expires the ones still waiting, marks an orphaned row expired, and leaves an answered one as it was', async () => {
    const store = await tempStore()
    const approvals = new Approvals(store)
    const waiting = approvals.request({ kind: 'question', source: 'sdk', roomId: 'r', title: 'Which database?' })
    const answered = approvals.request({ kind: 'question', source: 'sdk', roomId: 'r', title: 'Which store?' })
    approvals.decide(answered.approval.id, { behavior: 'answer', text: 'S3' })
    // A row saved as pending that no waiter in this run holds.
    const orphan = { ...waiting.approval, id: 'orphan', title: 'Run pnpm db:reset' }
    store.saveApproval(orphan)
    const ended = approvals.expireIds([waiting.approval.id, answered.approval.id, 'orphan', 'unknown'])
    expect(ended.map((a) => [a.title, a.status])).toEqual([['Which database?', 'expired'], ['Run pnpm db:reset', 'expired']])
    expect(await waiting.decision).toBeNull()
    expect(store.approval(answered.approval.id)).toMatchObject({ status: 'answered', answer: 'S3' })
    expect(store.approval('orphan')?.status).toBe('expired')
  })

  it('leaves everything to expirePending once Kernel quits', async () => {
    const store = await tempStore()
    const approvals = new Approvals(store)
    const waiting = approvals.request({ kind: 'tool', source: 'sdk', roomId: 'r', title: 'Run pnpm db:reset' })
    approvals.expirePending()
    store.saveApproval({ ...waiting.approval, id: 'orphan' })
    expect(approvals.expireIds([waiting.approval.id, 'orphan'])).toEqual([])
    expect(store.approval('orphan')?.status).toBe('pending')
  })
})

describe('approvals while Kernel quits (KERNEL-215)', () => {
  it('ends what is waiting, then answers new requests at once without saving them', async () => {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-approvals-')), 'kernel.db'))
    const approvals = new Approvals(store)
    const waiting = approvals.request({ kind: 'tool', source: 'hook', roomId: 'r', title: 'Run pnpm db:reset' })
    expect(approvals.expirePending().map((a) => a.status)).toEqual(['expired'])
    expect(await waiting.decision).toBeNull()

    // A hook request that lands between that and the connections closing: no pending entry, nothing saved.
    const abort = new AbortController()
    const late = approvals.request({ kind: 'tool', source: 'hook', roomId: 'r', title: 'Run pnpm build' }, { signal: abort.signal })
    expect(await late.decision).toBeNull()
    expect(approvals.isPending(late.approval.id)).toBe(false)
    expect(store.approvals({}).map((a) => a.title)).toEqual(['Run pnpm db:reset'])
    // Its connection dropping after the database closed reaches nothing.
    store.db.close()
    expect(() => abort.abort()).not.toThrow()
  })
})

describe('plan cards outlive a quit (plan-cards-survive-restart)', () => {
  it('keeps a plan pending through quitting and at launch while its chat is open, and ends every other kind as before', async () => {
    const store = await tempStore()
    store.saveWorkspace({ id: 'ws', roomId: 'r', name: 'invoices', branch: 'feat/invoices', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'kai', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
    store.saveWorkspace({ id: 'gone', roomId: 'r', name: 'old', branch: 'feat/old', baseRef: 'main', path: '/tmp/old', mode: 'worktree', agentId: 'kai', port: 4301, status: 'archived', prState: 'none', createdAt: 1 })
    const chat = { kind: 'chat' as const, model: 'claude-sonnet-5-5', effort: 'low' as const, plan: true, createdAt: 1, title: 'Plan' }
    store.saveChat({ ...chat, id: 'open', workspaceId: 'ws' })
    store.saveChat({ ...chat, id: 'closed', workspaceId: 'ws', closed: true })
    store.saveChat({ ...chat, id: 'archived', workspaceId: 'gone' })
    const run = new Approvals(store)
    const abort = new AbortController()
    const plan = run.request({ kind: 'plan', source: 'sdk', roomId: 'r', workspaceId: 'ws', chatId: 'open', title: 'Plan' }, { signal: abort.signal })
    const tool = run.request({ kind: 'tool', source: 'sdk', roomId: 'r', workspaceId: 'ws', chatId: 'open', title: 'Run pnpm db:reset' })
    const question = run.request({ kind: 'question', source: 'sdk', roomId: 'r', workspaceId: 'ws', chatId: 'open', title: 'Which table?' })
    const closed = run.request({ kind: 'plan', source: 'sdk', roomId: 'r', workspaceId: 'ws', chatId: 'closed', title: 'Plan' })
    const archived = run.request({ kind: 'plan', source: 'sdk', roomId: 'r', workspaceId: 'gone', chatId: 'archived', title: 'Plan' })
    // The session stopping aborts the plan's turn: its waiter gets null, the card stays.
    run.quitting()
    abort.abort()
    expect(await plan.decision).toBeNull()
    run.expirePending()
    expect(await tool.decision).toBeNull()
    const status = (r: { approval: { id: string } }) => store.approval(r.approval.id)?.status
    expect([plan, tool, question, closed, archived].map(status)).toEqual(['pending', 'expired', 'expired', 'pending', 'pending'])
    // The next launch ends the ones whose chat is closed or archived, and keeps the open chat's plan for `settle`.
    const next = new Approvals(store)
    next.expireStale()
    expect([plan, closed, archived].map(status)).toEqual(['pending', 'expired', 'expired'])
    expect(next.waitingPlans('open', 'r').map((a) => a.id)).toEqual([plan.approval.id])
    expect(next.decide(plan.approval.id, { behavior: 'allow' })).toBeUndefined()
    expect(next.settle(plan.approval.id, { behavior: 'allow' })?.status).toBe('allowed')
    expect(next.waitingPlan(plan.approval.id)).toBeUndefined()
  })
})

describe('approval titles say what the chat says (KERNEL-785)', () => {
  it('names an MCP call as the chat row does, not as server and tool', () => {
    const input = { title: 'Export invoices as PDF', team: 'Kernel' }
    expect(describeTool('mcp__claude_ai_Linear__save_issue', input)).toEqual({ title: 'File issue in Linear: Export invoices as PDF' })
    expect(describeTool('mcp__claude_ai_Linear__save_issue', { id: 'KERNEL-785' }).title).toBe('Update KERNEL-785 in Linear')
    expect(describeTool('mcp__kernel__create_workspace', { agent: 'kai', title: 'Toasts rise from the bottom' }).title).toBe('Hand to Kai: Toasts rise from the bottom')
    expect(describeTool('mcp__acme__sync_widgets', {}).title).toBe('Sync widgets in Acme')
  })

  it('keeps the folder of a file it edits', () => {
    expect(describeTool('Edit', { file_path: '/Users/you/kernel/src/main/db.ts' }).title).toBe('Edit: kernel/src/main/db.ts')
  })

  it("keeps Kernel's share and plan tools readable", () => {
    expect(describeTool('mcp__kernel__share_file', { path: '.kernel/shared/checkout.html' }).title).toBe('Share checkout.html')
    expect(describeTool('mcp__kernel__read_plans', {}).title).toBe("Read this chat's plans")
  })

  it('shows the exact command on a Bash approval, and the whole address on a fetch', () => {
    expect(describeTool('Bash', { command: 'cd /tmp && pnpm drizzle-kit push\nmore', description: 'Push the schema' })).toEqual({ title: 'Run cd /tmp && pnpm drizzle-kit push', detail: 'Push the schema' })
    expect(describeTool('WebFetch', { url: 'https://example.com/a?b=1' })).toEqual({ title: 'Fetch: example.com', detail: 'https://example.com/a?b=1' })
  })

  it('logs an MCP call outside Kernel with the same title', () => {
    const line = toActivity({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'mcp__claude_ai_Linear__save_issue', tool_input: { title: 'Export invoices as PDF' }, tool_use_id: 't' } as never, { roomId: 'r' } as never)
    expect(line?.object).toBe('File issue in Linear: Export invoices as PDF')
  })
  it("heads the approval card with the same words, and keeps the command and file wording", () => {
    expect(permissionTitle({ toolName: 'mcp__claude_ai_Linear__save_issue', input: { title: 'Export invoices as PDF' } }, 'Noor')).toBe('Noor wants to file issue in Linear: Export invoices as PDF')
    expect(permissionTitle({ toolName: 'mcp__kernel__share_file', input: { path: '.kernel/shared/checkout.html' } }, 'Noor')).toBe('Noor wants to share checkout.html')
    expect(permissionTitle({ toolName: 'Bash', input: { command: 'pnpm test' } }, 'Noor')).toBe('Noor wants to run a command')
    expect(permissionTitle({ toolName: 'Edit', input: { file_path: 'src/a.ts' } }, 'Noor')).toBe('Noor wants to edit a file')
  })
})

describe("the user's answer to a card, as their message (KERNEL-836)", () => {
  const card = (over: Partial<Approval>): Approval => ({ id: 'a', kind: 'plan', source: 'sdk', title: 'Plan', status: 'pending', createdAt: 1, ...over })
  const image = { type: 'image' as const, name: 'mock.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', path: '.kernel/attachments/mock.png' }

  it('says Approved on a plan, or the notes and images of Request changes', () => {
    expect(approvalAnswer(card({ status: 'allowed' }))).toBe('Approved')
    expect(approvalAnswer(card({ kind: 'tool', toolName: 'ExitPlanMode', status: 'allowed' }))).toBe('Approved')
    expect(answerParts(card({ status: 'denied', answer: ' Split the API work out ', images: [image] }))).toEqual([{ type: 'text', text: 'Split the API work out' }, image])
    expect(approvalAnswer(card({ status: 'denied' }))).toBe('Changes requested')
  })

  it('gives one line per answer to several questions, in the order asked', () => {
    const questions = [{ question: 'Which store?', options: [] }, { question: 'Which region?', options: [] }]
    expect(approvalAnswer(card({ kind: 'question', status: 'answered', answer: 'S3', questions: questions.slice(0, 1) }))).toBe('S3')
    expect(approvalAnswer(card({ kind: 'question', status: 'answered', answer: 'S3 · eu', questions, answers: { 'Which region?': 'eu', 'Which store?': 'S3' } }))).toBe('S3\neu')
  })

  it('says Approve or Not now on an agent proposal', () => {
    expect(approvalAnswer(card({ kind: 'agent', status: 'allowed' }))).toBe('Approve')
    expect(approvalAnswer(card({ kind: 'agent', status: 'denied' }))).toBe('Not now')
  })

  it('has nothing for a tool permission, a card still waiting, or one that expired', () => {
    expect(approvalAnswer(card({ kind: 'tool', toolName: 'Bash', status: 'allowed' }))).toBeUndefined()
    expect(approvalAnswer(card({ kind: 'tool', toolName: 'Bash', status: 'denied' }))).toBeUndefined()
    for (const kind of ['plan', 'question', 'agent'] as const) {
      expect(answerParts(card({ kind, status: 'pending' }))).toBeUndefined()
      expect(answerParts(card({ kind, status: 'expired', expiredBy: 'replaced' }))).toBeUndefined()
    }
  })
})
