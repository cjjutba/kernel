import { describe, expect, it, vi } from 'vitest'
import type { AgentDef, Decision, Workspace } from '@shared/types'
import { HANDOFF_NOW, HANDOFF_REMINDER, Handoffs } from '../src/main/services/handoff'
import { kernelTools, type KernelToolDeps } from '../src/main/services/kernelMcp'

/** The Lead's tools with a user who answers every card with `answer`. */
function leadTools(answer: Decision | null) {
  const planApproved = vi.fn()
  const handedOff = vi.fn()
  const ws = { id: 'ws-1', branch: 'kernel/symlink-node-modules', agentId: 'noor' } as Workspace
  const deps: KernelToolDeps = {
    roomId: 'room', lead: undefined, agents: async () => [{ id: 'noor', name: 'Noor', role: 'Engine', lead: false } as AgentDef], workspaces: () => [],
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

describe('create_workspace picks a real teammate (KERNEL-119)', () => {
  const team = [
    { id: 'rowan', name: 'Rowan', role: 'Lead', lead: true },
    { id: 'kai', name: 'Kai', role: 'Frontend', lead: false },
    { id: 'theo', name: 'Theo', role: 'Reviewer', lead: false },
    { id: 'theo-2', name: 'Theo', role: 'Reviewer', lead: false },
    { id: 'ivy-qa', name: 'Ivy', role: 'QA', lead: false }
  ] as AgentDef[]
  function tools(made: Partial<Workspace & { setupFailed: string }> = {}) {
    const asked: string[] = []
    const deps: KernelToolDeps = {
      roomId: 'room', lead: team[0], agents: async () => team, workspaces: () => [],
      createWorkspace: async (o) => { asked.push(o.agentId); return { id: 'ws-1', branch: 'feat/x', agentId: o.agentId, ...made } as Workspace },
      messageWorkspace: async () => ({ ok: true, sent: true, note: 'Sent.' }), askUser: async () => null, hireAgent: async () => '',
      archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false
    }
    const tool = kernelTools(deps).find((t) => t.name === 'create_workspace')!
    const create = async (agent: string) => {
      const r = await tool.handler({ agent, title: 'Inbox actions', brief: 'Go' } as never, {})
      return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
    }
    return { create, asked }
  }

  it('takes an exact id, and an id or name in any case, with spaces around it', async () => {
    const t = tools()
    expect(await t.create('kai')).toEqual({ text: 'Created ws-1 on feat/x for kai.', isError: false })
    expect(await t.create('KAI')).toEqual({ text: 'Created ws-1 on feat/x for kai.', isError: false })
    expect(await t.create(' kai ')).toEqual({ text: 'Created ws-1 on feat/x for kai.', isError: false })
    expect(await t.create('theo-2')).toEqual({ text: 'Created ws-1 on feat/x for theo-2.', isError: false })
    // A name that isn't the id.
    expect(await t.create('ivy')).toEqual({ text: 'Created ws-1 on feat/x for ivy-qa.', isError: false })
    expect(t.asked).toEqual(['kai', 'kai', 'kai', 'theo-2', 'ivy-qa'])
  })

  it('refuses an agent the team does not have, listing the teammates, and creates nothing', async () => {
    const t = tools()
    expect(await t.create('Noor')).toEqual({ isError: true, text: 'Not created: no agent "Noor" on this team. Use an id from list_agents: kai (Kai, Frontend), theo (Theo, Reviewer), theo-2 (Theo, Reviewer), ivy-qa (Ivy, QA).' })
    expect(t.asked).toEqual([])
  })

  it('refuses a name two agents share', async () => {
    const t = tools()
    expect(await t.create('Theo')).toEqual({ isError: true, text: 'Not created: "Theo" matches more than one agent (theo, theo-2). Use the id from list_agents.' })
  })

  it('says when setup failed, so the teammate has not started, and keeps the Created prefix (KERNEL-126)', async () => {
    const t = tools({ status: 'failed', setupFailed: 'exit code 1' })
    expect(await t.create('kai')).toEqual({ isError: false, text: "Created ws-1 on feat/x for kai. Setup failed (exit code 1), so Kai hasn't started. The brief waits until the user fixes setup and clicks Run again in that workspace." })
  })

  it('refuses to hand a task to the Lead', async () => {
    const t = tools()
    expect(await t.create('Rowan')).toEqual({ isError: true, text: 'Not created: hand tasks to a teammate, not to yourself. Call list_agents for the team.' })
    expect(t.asked).toEqual([])
  })
})

describe('create_workspace with review_of (KERNEL-130)', () => {
  const team = [
    { id: 'rowan', name: 'Rowan', role: 'Lead', lead: true },
    { id: 'kai', name: 'Kai', role: 'Frontend', lead: false },
    { id: 'theo', name: 'Theo', role: 'Reviewer', lead: false }
  ] as AgentDef[]
  const ws = (id: string, extra: Partial<Workspace> = {}) => ({ id, name: id, agentId: 'kai', status: 'ready', mode: 'worktree', ...extra }) as Workspace
  function tools(list: Workspace[]) {
    const made: { reviewOf?: string }[] = []
    const deps: KernelToolDeps = {
      roomId: 'room', lead: team[0], agents: async () => team, workspaces: () => list,
      createWorkspace: async (o) => { made.push(o); return { id: 'rv', branch: 'feat/x-review', agentId: o.agentId } as Workspace },
      messageWorkspace: async () => ({ ok: true, sent: true, note: 'Sent.' }), askUser: async () => null, hireAgent: async () => '',
      archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false
    }
    const tool = kernelTools(deps).find((t) => t.name === 'create_workspace')!
    const review = async (of: string) => {
      const r = await tool.handler({ agent: 'theo', title: 'Review PR #108', brief: 'Review it', review_of: of } as never, {})
      return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
    }
    return { review, made }
  }

  it('passes the link through for open work', async () => {
    const t = tools([ws('w1')])
    expect(await t.review('w1')).toEqual({ isError: false, text: 'Created rv on feat/x-review for theo.' })
    expect(t.made).toEqual([expect.objectContaining({ agentId: 'theo', reviewOf: 'w1' })])
  })

  it('refuses unknown or archived work, the Lead\'s own, a review of a review, and a second open review by the same reviewer', async () => {
    const t = tools([ws('gone', { status: 'archived' }), ws('lead', { agentId: 'rowan', mode: 'current' }), ws('w1'), ws('rv1', { agentId: 'theo', reviewOf: 'w1' }), ws('main', { mode: 'current' }), ws('done', { prState: 'merged' })])
    expect(await t.review('nope')).toEqual({ isError: true, text: 'Not created: there is no workspace nope in this room to review. Call list_workspaces for the ids.' })
    expect(await t.review('gone')).toEqual({ isError: true, text: 'Not created: gone is archived. Ask the user to restore it from History first.' })
    expect(await t.review('lead')).toEqual({ isError: true, text: 'Not created: that is your own workspace.' })
    expect(await t.review('rv1')).toEqual({ isError: true, text: 'Not created: rv1 is itself a review. Review the work it reviews instead (workspace w1).' })
    expect(await t.review('w1')).toEqual({ isError: true, text: 'Not created: Theo already has a review of this open (workspace rv1). Ask for another pass with message_agent.' })
    expect(await t.review('done')).toEqual({ isError: true, text: "Not created: done's PR is already merged, so there is nothing left to review." })
    expect(await t.review('main')).toEqual({ isError: true, text: 'Not created: main works on the main checkout, not a branch of its own, so there is no branch to review. Ask its teammate to commit and open a pull request first.' })
    expect(t.made).toEqual([])
  })
})
