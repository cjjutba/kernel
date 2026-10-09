import { describe, expect, it } from 'vitest'
import type { ChatItem, TeamUpdate } from '../src/shared/types'
import { isKernelUpdate, LEGACY_UPDATE_HEADER } from '../src/shared/teamUpdate'

const user = (text: string, extra: Partial<Extract<ChatItem, { kind: 'user' }>> = {}): ChatItem =>
  ({ kind: 'user', id: 'u', ts: 1, parts: [{ type: 'text', text }], ...extra })

const update: TeamUpdate = {
  rows: [{ workspaceId: 'w1', agentId: 'kai', name: 'Kai', task: 'Remove the Try section', prNumber: 108, events: [{ kind: 'pr.ready', text: 'Passed checks, no conflicts. Not reviewed yet', actionable: true }] }]
}

describe('isKernelUpdate (KERNEL-112)', () => {
  it('is true for an item that carries the card data', () => {
    expect(isKernelUpdate(user('Team update from Kernel, not from the user.', { from: 'kernel', update }))).toBe(true)
  })

  it("is true for an older item that starts with the legacy header, also once Retry sent it again as Kernel's", () => {
    const legacy = `${LEGACY_UPDATE_HEADER}\n- Kai · Remove the Try section (workspace w1): PR #108 is ready to merge`
    expect(isKernelUpdate(user(legacy))).toBe(true)
    expect(isKernelUpdate(user(legacy, { from: 'kernel' }))).toBe(true)
  })

  it('is false for a message the user typed', () => {
    expect(isKernelUpdate(user('Add PDF export to invoices.'))).toBe(false)
    // Quoting the old header mid-message doesn't make it an update, and neither does starting with it without an update's lines.
    expect(isKernelUpdate(user(`What does "${LEGACY_UPDATE_HEADER}" mean?`))).toBe(false)
    expect(isKernelUpdate(user(`${LEGACY_UPDATE_HEADER} what does this mean?`))).toBe(false)
  })

  it('is false for Kernel and Lead messages without the card data', () => {
    expect(isKernelUpdate(user('Your session ended unexpectedly. Check the worktree and pick up where you left off.', { from: 'kernel' }))).toBe(false)
    expect(isKernelUpdate(user(LEGACY_UPDATE_HEADER, { from: 'lead' }))).toBe(false)
  })

  it('is false for other kinds', () => {
    expect(isKernelUpdate({ kind: 'text', id: 't', ts: 1, text: LEGACY_UPDATE_HEADER })).toBe(false)
  })
})
