import { describe, expect, it, vi } from 'vitest'
import type { Decision, Workspace } from '@shared/types'
import { HANDOFF_NOW, HANDOFF_REMINDER, Handoffs } from '../src/main/services/handoff'
import { kernelTools, type KernelToolDeps } from '../src/main/services/kernelMcp'

/** The Lead's tools with a user who answers every card with `answer`. */
function leadTools(answer: Decision | null) {
  const planApproved = vi.fn()
  const handedOff = vi.fn()
  const ws = { id: 'ws-1', branch: 'kernel/symlink-node-modules', agentId: 'noor' } as Workspace
  const deps: KernelToolDeps = {
    roomId: 'room', lead: undefined, agents: async () => [], workspaces: () => [],
    createWorkspace: async () => ws, messageWorkspace: async () => ({ ok: true, sent: true, note: 'Sent.' }), askUser: async () => answer, hireAgent: async () => '',
    archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false,
    planApproved, handedOff
  }
  const byName = Object.fromEntries(kernelTools(deps).map((t) => [t.name, t]))
  const call = async (name: string, args: object) => ((await byName[name].handler(args as never, {})).content[0] as { text: string }).text
  return { call, planApproved, handedOff }
}

describe('request_plan_approval and create_workspace (KERNEL-67)', () => {
  it('answers an approval with "hand it off now" and marks the plan approved', async () => {
    const t = leadTools({ behavior: 'allow' })
    expect(await t.call('request_plan_approval', { title: 'KERNEL-53', steps: ['Symlink node_modules · Noor'] })).toBe(`approved. ${HANDOFF_NOW}`)
    expect(t.planApproved).toHaveBeenCalledOnce()
  })

  it('does not mark a plan approved when the user asks for changes', async () => {
    const t = leadTools({ behavior: 'deny', message: 'Split it in two' })
    expect(await t.call('request_plan_approval', { title: 'KERNEL-53', steps: ['Symlink node_modules · Noor'] })).toBe('changes requested: Split it in two')
    expect(t.planApproved).not.toHaveBeenCalled()
  })

  it('counts a created workspace as the hand-off', async () => {
    const t = leadTools(null)
    expect(await t.call('create_workspace', { agent: 'noor', title: 'Symlink node_modules', brief: 'Goal, files, acceptance criteria' })).toBe('Created ws-1 on kernel/symlink-node-modules for noor.')
    expect(t.handedOff).toHaveBeenCalledOnce()
  })
})

describe('Handoffs', () => {
  it('reminds once per approval, and not at all once handed off', () => {
    const h = new Handoffs()
    expect(h.reminder('chat')).toBeUndefined()
    h.approved('chat')
    expect(h.due('chat')).toBe(true)
    expect(h.reminder('chat')).toBe(HANDOFF_REMINDER)
    expect(h.due('chat')).toBe(false)
    expect(h.reminder('chat')).toBeUndefined()
    h.approved('chat')
    h.done('chat')
    expect(h.reminder('chat')).toBeUndefined()
  })

  it('keeps chats apart', () => {
    const h = new Handoffs()
    h.approved('lead-a')
    expect(h.due('lead-b')).toBe(false)
    expect(h.reminder('lead-b')).toBeUndefined()
    expect(h.reminder('lead-a')).toBe(HANDOFF_REMINDER)
  })
})
