import { describe, expect, it } from 'vitest'
import type { Approval } from '../src/shared/types'
import { pendingRequest, runTarget } from '../src/renderer/src/screens/workspace/shortcuts'

// KERNEL-539: the shortcuts Settings, Shortcuts lists that no button owned.
const req = (id: string, extra: Partial<Approval> = {}): Approval => ({ id, kind: 'tool', source: 'sdk', roomId: 'r', chatId: 'c1', toolName: 'Bash', title: 'Run x', status: 'pending', createdAt: 1, ...extra })

describe('workspace shortcuts', () => {
  it('answers the oldest permission request waiting in the open chat', () => {
    const list = [req('late', { createdAt: 5 }), req('early', { createdAt: 2 }), req('other', { chatId: 'c2', createdAt: 1 }), req('done', { status: 'allowed', createdAt: 0 })]
    expect(pendingRequest(list, 'c1')?.id).toBe('early')
    expect(pendingRequest(list, 'c3')).toBeUndefined()
    expect(pendingRequest(list, undefined)).toBeUndefined()
  })

  it('leaves plans and questions to their own keys', () => {
    expect(pendingRequest([req('p', { kind: 'plan' }), req('q', { kind: 'question' })], 'c1')).toBeUndefined()
  })

  it('stops the run script that is running, else starts the room\'s first', () => {
    expect(runTarget(['web'], ['run', 'web'])).toEqual({ name: 'web', stop: true })
    expect(runTarget([], ['storybook', 'run'])).toEqual({ name: 'storybook', stop: false })
    expect(runTarget([], [])).toEqual({ name: 'run', stop: false })
  })
})
