import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../src/shared/types'
import { outcome, planSteps } from '../src/renderer/src/screens/workspace/cards/steps'
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
