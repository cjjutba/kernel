import { describe, expect, it } from 'vitest'
import type { AskedQuestion, ChatItem } from '../src/shared/types'
import { answerDecision, answeredList, emptyPick, isStepList, isStepped, noteFromParts, outcome, pickReady, planSteps, planTitle, waitingPlan } from '../src/renderer/src/screens/workspace/cards/steps'
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

  describe('questions that step', () => {
    const qs: AskedQuestion[] = [
      { question: 'Keep the number?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { question: 'Where?', multiSelect: true, options: [{ label: 'Menu' }, { label: 'Header' }, { label: 'Bar' }] }
    ]

    it('steps through several questions or any multi-select, and keeps one single-select as one click', () => {
      expect(isStepped({ questions: qs })).toBe(true)
      expect(isStepped({ questions: [qs[1]] })).toBe(true)
      expect(isStepped({ questions: [qs[0]] })).toBe(false)
      expect(isStepped({})).toBe(false)
    })

    it('waits for a pick, and for text when Something else is on', () => {
      expect(pickReady(emptyPick())).toBe(false)
      expect(pickReady({ sel: ['Menu'], other: false, text: '' })).toBe(true)
      expect(pickReady({ sel: ['Menu'], other: true, text: '  ' })).toBe(false)
      expect(pickReady({ sel: [], other: true, text: 'Somewhere' })).toBe(true)
    })

    it('sends one answer keyed by question text, multi-select labels joined with ", " in the order asked', () => {
      const d = answerDecision(qs, [{ sel: ['Yes'], other: false, text: '' }, { sel: ['Header', 'Menu'], other: true, text: ' Footer ' }])
      expect(d).toEqual({
        behavior: 'answer',
        text: 'Yes · Menu, Header, Footer',
        answers: { 'Keep the number?': 'Yes', 'Where?': 'Menu, Header, Footer' }
      })
    })

    it('lists answers for several questions only when they were kept', () => {
      expect(answeredList({ questions: qs, answers: { 'Keep the number?': 'Yes', 'Where?': 'Menu' } })).toEqual([
        { question: 'Keep the number?', answer: 'Yes' }, { question: 'Where?', answer: 'Menu' }
      ])
      expect(answeredList({ questions: qs })).toBeUndefined()
      expect(answeredList({ questions: [qs[0]], answers: { 'Keep the number?': 'Yes' } })).toBeUndefined()
    })
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

describe('who sent a message, as the transcript draws it (KERNEL-120)', () => {
  it("draws the user's and the Lead's messages as the bubble, Kernel's nudges as a note, and team updates as a card", async () => {
    const { userView } = await import('../src/renderer/src/screens/workspace/sender')
    const user = (extra: object): Extract<ChatItem, { kind: 'user' }> => ({ kind: 'user', id: 'u', ts: 0, parts: [{ type: 'text', text: 'Your session ended unexpectedly. Check the worktree and pick up where you left off.' }], ...extra })
    expect(userView(user({}))).toBe('bubble')
    expect(userView(user({ from: 'lead' }))).toBe('bubble')
    expect(userView(user({ from: 'kernel' }))).toBe('note')
    expect(userView(user({ from: 'kernel', update: { rows: [] } }))).toBe('update')
    expect(userView({ kind: 'user', id: 'u', ts: 0, parts: [{ type: 'text', text: 'Update from Kernel (not the user):\n- Kai · X (workspace w): PR #1 is ready to merge' }] })).toBe('update')
    // The user typing the old header themselves gets their own bubble.
    expect(userView({ kind: 'user', id: 'u', ts: 0, parts: [{ type: 'text', text: 'Update from Kernel (not the user): what does this line mean?' }] })).toBe('bubble')
  })

  it('draws a Kernel note with Copy and no Edit', async () => {
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    Object.assign(globalThis, { React })
    const path = '../src/renderer/src/screens/workspace/KernelNote'
    const { KernelNote } = await import(/* @vite-ignore */ path) as { KernelNote: (p: { item: ChatItem }) => React.ReactElement }
    const html = renderToStaticMarkup(React.createElement(KernelNote, { item: { kind: 'user', id: 'n', ts: 1, from: 'kernel', parts: [{ type: 'text', text: 'Your session ended unexpectedly.' }] } }))
    expect(html).toContain('class="note"')
    expect(html).toContain('Your session ended unexpectedly.')
    expect(html).toContain('Copy')
    expect(html).not.toContain('Edit')
  })

  it('still starts a new turn at a Kernel nudge', () => {
    const nudge: ChatItem = { kind: 'user', id: 'n', ts: 3, from: 'kernel', parts: [{ type: 'text', text: 'The usage limit that stopped you no longer applies. Pick up where you left off.' }] }
    const blocks = buildThread([{ kind: 'user', id: 'u', ts: 0, parts: [] }, { kind: 'text', id: 't', ts: 1, text: 'Working.' }, nudge, { kind: 'text', id: 't2', ts: 4, text: 'Carrying on.' }])
    expect(blocks.filter((b) => b.kind === 'item' && b.item.kind === 'user').map((b) => (b as { item: ChatItem }).item.id)).toEqual(['u', 'n'])
  })
})
