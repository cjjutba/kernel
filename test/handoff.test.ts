import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Chat, Decision, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { tempRepo } from './helpers'
import { HANDOFF_NOW, HANDOFF_REMINDER, Handoffs, LEAD_RULE } from '../src/main/services/handoff'
import { kernelTools, PLAN_MODE_OFF, type KernelToolDeps } from '../src/main/services/kernelMcp'

/** The Lead's tools with a user who answers every card with `answer`, in a chat whose plan mode `plan` holds. */
function leadTools(answer: Decision | null, plan = { on: true }) {
  const planApproved = vi.fn()
  const handedOff = vi.fn()
  const askUser = vi.fn(async () => answer)
  const ws = { id: 'ws-1', branch: 'kernel/symlink-node-modules', agentId: 'noor' } as Workspace
  const deps: KernelToolDeps = {
    roomId: 'room', lead: undefined, agents: async () => [{ id: 'noor', name: 'Noor', role: 'Engine', lead: false } as AgentDef], workspaces: () => [],
    createWorkspace: async () => ws, messageWorkspace: async () => ({ ok: true, sent: true, note: 'Sent.' }), askUser, hireAgent: async () => '',
    archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false,
    planMode: () => plan.on, planApproved, handedOff
  }
  const byName = Object.fromEntries(kernelTools(deps).map((t) => [t.name, t]))
  const run = async (name: string, args: object) => {
    const r = await byName[name].handler(args as never, {})
    return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
  }
  const call = async (name: string, args: object) => (await run(name, args)).text
  return { call, run, askUser, planApproved, handedOff }
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

describe('request_plan_approval follows the chat\'s plan mode (KERNEL-176)', () => {
  const plan = { title: 'KERNEL-53', steps: ['Symlink node_modules · Noor'] }

  it('refuses with plan mode off and creates no approval', async () => {
    const t = leadTools({ behavior: 'allow' }, { on: false })
    expect(await t.run('request_plan_approval', plan)).toEqual({ isError: true, text: PLAN_MODE_OFF })
    expect(t.askUser).not.toHaveBeenCalled()
    expect(t.planApproved).not.toHaveBeenCalled()
  })

  it('asks with plan mode on', async () => {
    const t = leadTools({ behavior: 'allow' }, { on: true })
    expect(await t.run('request_plan_approval', plan)).toEqual({ isError: false, text: `approved. ${HANDOFF_NOW}` })
    expect(t.askUser).toHaveBeenCalledWith(expect.objectContaining({ kind: 'plan', title: 'KERNEL-53', steps: plan.steps }))
  })

  it('reads plan mode on each call, so turning it on mid-session lets the next call ask', async () => {
    const mode = { on: false }
    const t = leadTools({ behavior: 'allow' }, mode)
    expect((await t.run('request_plan_approval', plan)).isError).toBe(true)
    mode.on = true
    expect(await t.run('request_plan_approval', plan)).toEqual({ isError: false, text: `approved. ${HANDOFF_NOW}` })
    expect(t.askUser).toHaveBeenCalledOnce()
  })

  it('refuses when the chat gives no plan mode', async () => {
    const askUser = vi.fn(async () => null)
    const tool = kernelTools({ askUser } as unknown as KernelToolDeps).find((x) => x.name === 'request_plan_approval')!
    expect((await tool.handler(plan as never, {})).isError).toBe(true)
    expect(askUser).not.toHaveBeenCalled()
  })

  it("follows the Lead chat's saved toggle in a real Kernel, not the one the session started with", { timeout: 30_000 }, async () => {
    const repo = await tempRepo({ 'README.md': '# app\n', '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    onTestFinished(() => k.stop())
    await k.start()
    const room = await k.addRoom(repo)
    const chat = await k.leadChat(room.id)
    const lead = (await k.agents(room.id)).find((a) => a.lead)!
    const deps = (k as unknown as { leadToolDeps(roomId: string, lead: AgentDef, chat: Chat): KernelToolDeps }).leadToolDeps(room.id, lead, chat)
    const tool = kernelTools(deps).find((x) => x.name === 'request_plan_approval')!
    const plans = () => k.store.approvals({ roomId: room.id }).filter((a) => a.kind === 'plan')

    await k.sessions.configure(chat.id, { plan: false })
    const off = await tool.handler(plan as never, {})
    expect(off).toMatchObject({ isError: true, content: [{ text: PLAN_MODE_OFF }] })
    expect(plans()).toEqual([])

    await k.sessions.configure(chat.id, { plan: true })
    const asked = tool.handler(plan as never, {})
    for (let i = 0; i < 100 && !plans().length; i++) await new Promise((r) => setTimeout(r, 20))
    expect(plans()).toEqual([expect.objectContaining({ chatId: chat.id, status: 'pending', title: 'KERNEL-53' })])
    k.approvals.decide(plans()[0].id, { behavior: 'allow' })
    expect(((await asked).content[0] as { text: string }).text).toBe(`approved. ${HANDOFF_NOW}`)
  })

  it('tells the Lead to ask for approval only in plan mode, and otherwise to ask in the chat before handing off', () => {
    expect(LEAD_RULE).toContain('Ask for plan approval only while the chat is in plan mode')
    expect(LEAD_RULE).not.toContain('in plan mode or through request_plan_approval')
    expect(LEAD_RULE).toContain('With plan mode off there is no plan to approve. Answer in the chat, suggest what you would hand off and to whom, and ask the user before calling mcp__kernel__create_workspace.')
    expect(PLAN_MODE_OFF).toContain('ask the user before calling create_workspace')
    // "Don't ask" holds only after an approved plan, so it can't be read against asking first with plan mode off.
    const dontAsk = LEAD_RULE.split('\n').filter((l) => /don't ask/i.test(l))
    expect(dontAsk).toEqual([expect.stringMatching(/^After an approved plan, don't end the turn with only the plan, and don't ask again whether to hand it off\./)])
    const tool = kernelTools({} as KernelToolDeps).find((x) => x.name === 'request_plan_approval')!
    expect(tool.description).toContain('Only while the chat is in plan mode. With plan mode off it refuses, and you ask in the chat before handing off.')
  })
})

describe('create_workspace with issue (KERNEL-163)', () => {
  it('passes the issue key through, and the rule tells the Lead to', async () => {
    const asked: Parameters<KernelToolDeps['createWorkspace']>[0][] = []
    const deps: KernelToolDeps = {
      roomId: 'room', lead: undefined, agents: async () => [{ id: 'noor', name: 'Noor', role: 'Engine', lead: false } as AgentDef], workspaces: () => [],
      createWorkspace: async (o) => { asked.push(o); return { id: 'ws-1', branch: 'cj/kernel-83-issues', agentId: 'noor' } as Workspace },
      messageWorkspace: async () => ({ ok: true, sent: true, note: 'Sent.' }), askUser: async () => null, hireAgent: async () => '',
      archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false
    }
    const tool = kernelTools(deps).find((t) => t.name === 'create_workspace')!
    await tool.handler({ agent: 'noor', title: 'Issues screen', brief: 'Goal', issue: 'KERNEL-83' } as never, {})
    await tool.handler({ agent: 'noor', title: 'Other', brief: 'Goal' } as never, {})
    expect(asked[0]).toMatchObject({ agentId: 'noor', title: 'Issues screen', issue: 'KERNEL-83' })
    expect(asked[1]).not.toHaveProperty('issue')
    expect(LEAD_RULE).toContain('When a task builds a Linear issue, pass its key as issue to create_workspace.')
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
