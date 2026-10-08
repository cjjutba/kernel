import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../src/shared/types'
import { isStepList, noteFromParts, outcome, planSteps, planTitle, waitingPlan } from '../src/renderer/src/screens/workspace/cards/steps'
import { buildThread } from '../src/renderer/src/screens/workspace/thread'

describe('turn cards', () => {
  it('reads plan steps from steps or numbered text', () => {
    expect(planSteps({ steps: [{ title: 'A', agentId: 'kai' }] })).toEqual([{ title: 'A', agentId: 'kai' }])
    expect(planSteps({ detail: '1. Build it\n2) Test it\n- Ship it' }).map((s) => s.title)).toEqual(['Build it', 'Test it', 'Ship it'])
  })

  it('words a resolved approval', () => {
    expect(outcome({ kind: 'plan', status: 'denied' } as never)).toBe('Changes requested')
    expect(outcome({ kind: 'question', status: 'answered', answer: 'Yes' } as never)).toBe('You answered: Yes')
  })

  it('shows a failed turn as an error and a stopped turn as a marker with its time', () => {
    const user: ChatItem = { kind: 'user', id: 'u', ts: 0, parts: [] }
    const tool: ChatItem = { kind: 'tool', id: 't', ts: 1, toolUseId: 'x', name: 'Bash', label: 'Run', detail: 'x', status: 'failed', output: 'boom' }
    const failed = buildThread([user, tool, { kind: 'result', id: 'r', ts: 2, durationMs: 1000, ok: false, error: '2 tests failed' }])
    expect(failed.at(-1)).toEqual({ kind: 'error', id: 'r', message: '2 tests failed', output: 'boom' })
    const stopped = buildThread([user, { kind: 'interrupted', id: 'i', ts: 1 }, { kind: 'result', id: 'r', ts: 2, durationMs: 28_000, ok: false }])
    expect(stopped.at(-1)).toMatchObject({ kind: 'meta' })
    expect(stopped.some((b) => b.kind === 'error')).toBe(false)
  })
})

describe('Lead requests', () => {
  it('turns "task · agent" lines into steps with the agent id and task id', async () => {
    const { parsePlanSteps } = await import('../src/main/services/approvals')
    const agents = [{ id: 'noor', name: 'Noor' }, { id: 'kai', name: 'Kai' }]
    expect(parsePlanSteps(['T-15a PDF renderer · Noor', 'T-15b Button · kai', 'Write the docs'], agents)).toEqual([
      { title: 'T-15a PDF renderer', taskId: 'T-15a', agentId: 'noor' },
      { title: 'T-15b Button', taskId: 'T-15b', agentId: 'kai' },
      { title: 'Write the docs' }
    ])
  })

  it('updates an approval in place and tells the windows', async () => {
    const { Approvals } = await import('../src/main/services/approvals')
    const { Store } = await import('../src/main/db')
    const { mkdtemp } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-ap-')), 'kernel.db'))
    const approvals = new Approvals(store)
    const { approval } = approvals.request({ kind: 'plan', source: 'sdk', roomId: 'r', title: 'Plan', steps: [{ title: 'A', agentId: 'kai' }] })
    approvals.update(approval.id, { steps: [{ title: 'A', agentId: 'kai', workspaceId: 'ws1' }] })
    expect(store.approvals().find((a) => a.id === approval.id)?.steps?.[0].workspaceId).toBe('ws1')
  })

  it('reads a plan from ExitPlanMode input when there is no detail', () => {
    expect(planSteps({ input: { plan: '1. One\n2. Two' } }).map((s) => s.title)).toEqual(['One', 'Two'])
  })

  it('shows a plan with sections as a document, titled by its heading, and one list as rows', () => {
    const doc = { title: 'Plan for lead', detail: '# KERNEL-83 Fix batch\n\n## Context\nWhy.\n\n## Task 1 · **Engine**\n- a\n- b' }
    expect(isStepList(doc)).toBe(false)
    expect(planTitle(doc)).toBe('KERNEL-83 Fix batch')
    // The floor's card lists the sections, without the title or markdown markers.
    expect(planSteps(doc).map((s) => s.title)).toEqual(['Context', 'Task 1 · Engine'])
    expect(isStepList({ detail: '1. Build it\n2. Test it' })).toBe(true)
    expect(isStepList({ detail: '1. Build it\n   - first the table' })).toBe(false)
    expect(planTitle({ title: 'Plan for lead', detail: '1. Build it' })).toBe('Plan for lead')
  })

  it("finds the plan waiting in a chat, which puts Copy and Approve on that chat's composer", () => {
    const plan = (o: object) => ({ id: 'p', kind: 'plan', source: 'sdk', title: 'Plan', status: 'pending', createdAt: 0, workspaceId: 'ws', ...o }) as never
    const chat = { id: 'c1', workspaceId: 'ws' }
    expect(waitingPlan([plan({ chatId: 'c1' })], chat)).toBeTruthy()
    expect(waitingPlan([plan({ chatId: 'c2' })], chat)).toBeUndefined()
    expect(waitingPlan([plan({ chatId: 'c1', status: 'allowed' })], chat)).toBeUndefined()
    expect(waitingPlan([plan({ kind: 'tool', toolName: 'ExitPlanMode' })], chat)).toBeTruthy()
    expect(waitingPlan([plan({ kind: 'tool', toolName: 'Bash' })], chat)).toBeUndefined()
  })

  it('turns what you type under a plan into the note sent back with it', () => {
    expect(noteFromParts([
      { type: 'text', text: 'Split task 2' },
      { type: 'file', name: 'a.ts', path: 'src/a.ts' },
      { type: 'file', name: 'Pasted text', text: 'line' },
      { type: 'text', text: '  ' }
    ])).toBe('Split task 2 @src/a.ts <pasted name="Pasted text">\nline\n</pasted>')
    expect(noteFromParts([{ type: 'issue', name: '#41', title: 'Export fails', source: 'github' }])).toBe('Linked issue #41: Export fails')
  })
})
