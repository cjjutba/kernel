import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Chat, Decision, QueueReason, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { tempRepo } from './helpers'
import { BLOCKER_RULE, HANDOFF_NOW, HANDOFF_REMINDER, Handoffs, LEAD_RULE, reviewRule } from '../src/main/services/handoff'
import { reviewTools } from '../src/main/services/reviewMcp'
import { kernelTools, LEAD_INSTRUCTIONS, NO_PLAN, PLAN_MODE_OFF, type KernelToolDeps } from '../src/main/services/kernelMcp'

// A chat with Rowan's held first message goes out through the real send once its setup passes (KERNEL-405).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

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

const PLAN = '# Symlink node_modules\n\nWorktrees reinstall every package. Link them to the main checkout instead.\n\n## Checks\n\n- pnpm test'

/** request_plan_approval in a real Kernel's Lead chat, and the room's plan approvals. */
async function realLead() {
  const repo = await tempRepo({ 'README.md': '# app\n', '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.', '.claude/agents/noor.md': '---\nname: noor\ndescription: Engine.\nrole: Engine\n---\nYou are Noor.' })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  onTestFinished(() => k.stop())
  await k.start()
  const room = await k.addRoom(repo)
  const chat = await k.leadChat(room.id)
  const lead = (await k.agents(room.id)).find((a) => a.lead)!
  const deps = k.lead.leadToolDeps(room.id, lead, chat)
  const tool = kernelTools(deps).find((x) => x.name === 'request_plan_approval')!
  const plans = () => k.store.approvals({ roomId: room.id }).filter((a) => a.kind === 'plan')
  // The plan file is written after the card shows, so a test waits for it before `k.stop()` closes the store (KERNEL-383).
  const planSaved = async () => {
    for (let i = 0; i < 100 && !plans()[0]?.planFile; i++) await new Promise((r) => setTimeout(r, 20))
    return plans()[0]?.planFile
  }
  return { k, room, chat, tool, plans, planSaved }
}

describe('request_plan_approval and create_workspace (KERNEL-67)', () => {
  it('answers an approval with "hand it off now" and marks the plan approved', async () => {
    const t = leadTools({ behavior: 'allow' })
    expect(await t.call('request_plan_approval', { title: 'KERNEL-53', plan: PLAN, steps: ['Symlink node_modules · Noor'] })).toBe(`approved. ${HANDOFF_NOW}`)
    expect(t.planApproved).toHaveBeenCalledOnce()
  })

  it('does not mark a plan approved when the user asks for changes', async () => {
    const t = leadTools({ behavior: 'deny', message: 'Split it in two' })
    expect(await t.call('request_plan_approval', { title: 'KERNEL-53', plan: PLAN, steps: ['Symlink node_modules · Noor'] })).toBe('changes requested: Split it in two')
    expect(t.planApproved).not.toHaveBeenCalled()
  })

  it('counts a created workspace as the hand-off', async () => {
    const t = leadTools(null)
    expect(await t.call('create_workspace', { agent: 'noor', title: 'Symlink node_modules', brief: 'Goal, files, acceptance criteria' })).toBe('Created ws-1 on kernel/symlink-node-modules for noor.')
    expect(t.handedOff).toHaveBeenCalledOnce()
  })
})

describe('request_plan_approval follows the chat\'s plan mode (KERNEL-176)', () => {
  const plan = { title: 'KERNEL-53', plan: PLAN, steps: ['Symlink node_modules · Noor'] }

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
    const { k, chat, tool, plans, planSaved } = await realLead()

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
    expect(await planSaved()).toBe('.kernel/plans/symlink-node-modules.md')
  })

  it('leaves plan mode once the plan is approved, as ExitPlanMode does, and tells the composer (D-074)', { timeout: 30_000 }, async () => {
    const { k, chat, tool, plans, planSaved } = await realLead()
    await k.sessions.configure(chat.id, { plan: true })
    const pushed: Chat[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'chat' && e.chat.id === chat.id) pushed.push(e.chat) }
    bus.on('push', onPush)
    onTestFinished(() => { bus.off('push', onPush) })

    const asked = tool.handler(plan as never, {})
    for (let i = 0; i < 100 && !plans().length; i++) await new Promise((r) => setTimeout(r, 20))
    expect(k.store.chat(chat.id)?.plan).toBe(true)
    k.approvals.decide(plans()[0].id, { behavior: 'allow' })
    await asked

    expect(k.store.chat(chat.id)?.plan).toBe(false)
    expect(pushed.at(-1)).toMatchObject({ id: chat.id, plan: false })
    expect(k.sessions.handoffs.due(chat.id)).toBe(true)
    expect(await planSaved()).toBe('.kernel/plans/symlink-node-modules.md')
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

describe('request_plan_approval carries the full plan (KERNEL-373)', () => {
  const steps = ['Symlink node_modules · Noor']

  it('refuses task lines without the plan and says what is missing', async () => {
    const t = leadTools({ behavior: 'allow' })
    expect(await t.run('request_plan_approval', { title: 'KERNEL-53', steps })).toEqual({ isError: true, text: NO_PLAN })
    expect(await t.run('request_plan_approval', { title: 'KERNEL-53', plan: '  \n', steps })).toEqual({ isError: true, text: NO_PLAN })
    expect(NO_PLAN).toContain('plan is missing')
    expect(t.askUser).not.toHaveBeenCalled()
  })

  it('asks with the plan as the detail and the task lines as they are', async () => {
    const t = leadTools({ behavior: 'allow' })
    await t.run('request_plan_approval', { title: 'KERNEL-53', plan: PLAN, steps })
    expect(t.askUser).toHaveBeenCalledWith({ kind: 'plan', title: 'KERNEL-53', detail: PLAN, steps })
  })

  it('saves the plan to .kernel/plans, a revision to the same file and the next plan after an approval to its own (D-092)', { timeout: 30_000 }, async () => {
    const { k, chat, tool, plans } = await realLead()
    // In the Lead's own worktree (KERNEL-355).
    const dir = k.store.workspace(chat.workspaceId)!.path
    await k.sessions.configure(chat.id, { plan: true })
    /** Asks with `plan` and waits until Kernel has saved it, newest approval first. */
    const ask = async (plan: string) => {
      const asked = tool.handler({ title: 'KERNEL-53', plan, steps } as never, {})
      for (let i = 0; i < 100 && !(plans()[0]?.status === 'pending' && plans()[0].planFile); i++) await new Promise((r) => setTimeout(r, 20))
      return { asked, approval: plans()[0] }
    }

    const first = await ask(PLAN)
    expect(first.approval).toMatchObject({ detail: PLAN, steps: [{ title: 'Symlink node_modules', agentId: 'noor' }], planFile: '.kernel/plans/symlink-node-modules.md' })
    expect(await readFile(join(dir, first.approval.planFile!), 'utf8')).toBe(`${PLAN}\n`)
    k.approvals.decide(first.approval.id, { behavior: 'deny', message: 'Add a rollback step' })
    expect(((await first.asked).content[0] as { text: string }).text).toBe('changes requested: Add a rollback step')

    const revised = `${PLAN}\n- Rollback: remove the link`
    const second = await ask(revised)
    expect(second.approval.id).not.toBe(first.approval.id)
    expect(second.approval.planFile).toBe(first.approval.planFile)
    expect(await readFile(join(dir, second.approval.planFile!), 'utf8')).toBe(`${revised}\n`)
    k.approvals.decide(second.approval.id, { behavior: 'allow' })
    await second.asked

    await k.sessions.configure(chat.id, { plan: true })
    const third = await ask(PLAN)
    expect(third.approval.planFile).toBe('.kernel/plans/symlink-node-modules-2.md')
    expect(await readFile(join(dir, first.approval.planFile!), 'utf8')).toBe(`${revised}\n`)
  })

  it('describes the same call in the rule, the instructions, the tool and the starter Rowan', async () => {
    const rowan = await readFile(join(__dirname, '..', 'docs', 'starter-agents', 'rowan.md'), 'utf8')
    const tool = kernelTools({} as KernelToolDeps).find((x) => x.name === 'request_plan_approval')!
    for (const said of [LEAD_RULE, LEAD_INSTRUCTIONS, tool.description, rowan]) {
      expect(said).toMatch(/full plan as markdown in plan/)
      expect(said).toMatch(/one line per task in steps/)
    }
    expect(LEAD_RULE).not.toContain('ExitPlanMode')
    expect(LEAD_INSTRUCTIONS).not.toContain('ExitPlanMode')
  })
})

describe('waiting for another PR (KERNEL-259)', () => {
  it('tells the Lead to pass wait_for, to call wait_for_merge for a teammate that waits, and how to start one anyway', async () => {
    expect(LEAD_RULE).toContain("When a task needs another task's PR merged first, pass that workspace's id in wait_for and tell the user which merge starts it.")
    expect(LEAD_RULE).toContain('When a teammate says it is waiting on another PR, call wait_for_merge for it.')
    expect(LEAD_RULE).toContain('To start a waiting teammate anyway, call wait_for_merge with an empty list.')
    const rowan = await readFile(join(__dirname, '..', 'docs', 'starter-agents', 'rowan.md'), 'utf8')
    expect(rowan).toContain("pass that workspace's id in wait_for and tell the user which merge starts it")
    const tools = kernelTools({} as KernelToolDeps)
    expect(tools.find((x) => x.name === 'create_workspace')!.description).not.toContain('Starts the agent right away')
    expect(tools.map((x) => x.name)).toContain('wait_for_merge')
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
  function tools(made: Partial<Workspace & { setupFailed: string; queued: QueueReason }> = {}) {
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

  it('says when the brief waits for a slot, a pause or the connection, so the teammate has not started (KERNEL-272)', async () => {
    const said: [QueueReason | undefined, string][] = [
      ['capacity', "Created ws-1 on feat/x for kai. Every agent slot in Settings, Models is in use, so Kai hasn't started. The brief goes out when a slot frees up."],
      ['paused', "Created ws-1 on feat/x for kai. The room is paused, so Kai hasn't started. The brief goes out when the user resumes it."],
      ['offline', "Created ws-1 on feat/x for kai. Kernel is offline or signed out, so Kai hasn't started. The brief goes out once it is back."],
      // The brief went out: a message the Lead sent during setup waiting behind it is not the teammate waiting.
      ['running', 'Created ws-1 on feat/x for kai.'],
      [undefined, 'Created ws-1 on feat/x for kai.']
    ]
    for (const [queued, note] of said) expect(await tools({ queued }).create('kai')).toEqual({ isError: false, text: note })
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

describe('reviews block only on real problems (KERNEL-377)', () => {
  const rule = reviewRule({ author: 'Kai', task: 'T', workspaceId: 'w', branch: 'feat/x', base: 'origin/main' })

  it('gives the reviewer, submit_review and both Theo files the same blocker list', async () => {
    const [submit] = reviewTools({ submit: async () => '' })
    const theos = await Promise.all([join('docs', 'starter-agents', 'theo.md'), join('.claude', 'agents', 'theo.md')].map((f) => readFile(join(__dirname, '..', f), 'utf8')))
    for (const text of [rule, submit.description, ...theos]) expect(text).toContain(BLOCKER_RULE)
    for (const theo of theos) expect(theo).not.toMatch(/nits|file, line, fix/)
  })

  it('keeps blockers short, approves with notes, and scopes a re-review to the earlier blockers', () => {
    expect(rule).toContain('Write each blocker in one or two sentences: what breaks, and its file and line. No code and no design proposal. Kai picks the fix.')
    expect(rule).toContain('When nothing blocks, approve. Put minor findings in the summary as at most three short notes.')
    expect(rule).toContain('check only your earlier blockers and anything the fix broke')
    expect(rule).toContain('Raise nothing new unless the fix caused it.')
    expect(rule).toContain('Run shots only for screens the PR changes, and run a test only to confirm a bug you suspect.')
  })

  it('has the Lead pass on blockers only and mention notes to the user', () => {
    expect(LEAD_RULE).toContain('When a review found blockers, pass on the blockers and nothing else.')
    expect(LEAD_RULE).toContain("mention them to the user in one line and don't send them to the author")
  })
})
