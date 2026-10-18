import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { Chat, ChatItem } from '@shared/types'
import { setUp, tempRepo, freePort } from './helpers'
import { Kernel } from '../src/main/kernel'
import { Store } from '../src/main/db'
import { kernelTools } from '../src/main/services/kernelMcp'
import { HANDOFF_NOW, planApproval, planChanges } from '../src/main/services/handoff'
import { RELAUNCH_NUDGE } from '../src/main/services/sessions'

// A scripted SDK, as in restore.test.ts: each query() records its options and yields what the test feeds it. An interrupt
// ends the turn with error_during_execution, as the real one does, and an abort ends the stream.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}), tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
  query: ({ options }: { options: { abortController?: AbortController } }) => {
    const items: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    const signal = options.abortController?.signal
    const aborted = () => new Error('Claude Code process aborted by user')
    signal?.addEventListener('abort', () => { for (const w of waiters.splice(0)) w.reject(aborted()) })
    const feed = (m: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: m, done: false }); else items.push(m) }
    sdk.calls.push({ options, feed })
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
          : signal?.aborted ? Promise.reject(aborted()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
      }),
      interrupt: async () => { feed({ type: 'result', subtype: 'error_during_execution', uuid: `i${sdk.calls.length}`, duration_ms: 1 }) },
      setModel: async () => {}, setPermissionMode: async () => {}, applyFlagSettings: async () => {}
    }
  }
}))

const flush = () => new Promise((r) => setTimeout(r, 20))
const text = (t: string) => [{ type: 'text' as const, text: t }]
const PLAN = '# Invoice table\n\n1. Add the table component\n2. Wire it to the API'
const PNG = 'data:image/png;base64,iVBORw0KGgo='
const callIn = (cwd: string, after = 0) => sdk.calls.slice(after).find((c) => c.options.cwd === cwd)
const users = (k: Kernel, chat: Chat) => k.store.items(chat.id).flatMap((i: ChatItem) => (i.kind === 'user' ? [(i.parts[0] as { text: string }).text] : []))
const notes = (k: Kernel, chat: Chat) => k.store.items(chat.id).flatMap((i: ChatItem) => (i.kind === 'note' ? [i.text] : []))
const plans = (k: Kernel, chat: Chat) => k.store.approvals({}).filter((a) => a.chatId === chat.id && a.kind === 'plan')
/** The user's answer rows (KERNEL-836): user rows with an approval and no sender, as the ids around them. */
const answers = (k: Kernel, chatId: string) => {
  const items = k.store.items(chatId)
  return items.flatMap((i, at) => (i.kind === 'user' && i.approvalId && !i.from ? [{ item: i, before: items[at - 1]?.id, after: items[at + 1] }] : []))
}

async function until<T>(read: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 200; i++) { const v = read(); if (v) return v; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error('timed out')
}

async function kernel() {
  const repo = await tempRepo({
    'README.md': '# client\n',
    '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
    '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.'
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const where = { dataDir, home }
  const k = new Kernel(where)
  await k.start()
  const project = await k.addProject(repo)
  return { k, where, project }
}

/** Christian in plan mode, blocked on ExitPlanMode with its plan saved, and a Bash card waiting in the same chat. */
async function planning() {
  const { k, where, project } = await kernel()
  const ws = await k.createWorkspace(project.id, { prompt: 'Build the table', agentId: 'christian', title: 'Invoice table' })
  const christian = k.store.chats(ws.id)[0]
  await k.sessions.configure(christian.id, { plan: true })
  const call = callIn(ws.path)!
  call.feed({ type: 'system', subtype: 'init', session_id: 'christian-session', apiKeySource: 'none' })
  call.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'ExitPlanMode', input: { plan: PLAN } }] } })
  await flush()
  const answer = (call.options.canUseTool as CanUseTool)('ExitPlanMode', { plan: PLAN }, { signal: call.options.abortController.signal, toolUseID: 't1', suggestions: [] } as never)
  const card = await until(() => plans(k, christian).find((a) => a.planFile))
  const tool = k.approvals.request({ kind: 'tool', source: 'sdk', projectId: project.id, workspaceId: ws.id, chatId: christian.id, title: 'Run pnpm db:reset' })
  return { k, where, project, ws, christian, card, answer, tool: tool.approval }
}

async function relaunch(where: { dataDir: string; home: string }) {
  const before = sdk.calls.length
  const k = new Kernel(where)
  k.signedInReader = async () => true
  await k.start()
  // Carried-on chats wait for the launch check, which runs in the background after start().
  await flush()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  return { k, before }
}

describe('plan cards outlive a restart', () => {
  it('keeps a Claude plan card through a quit, with no nudge, and approving sends one note that builds from the file', async () => {
    const { k, where, ws, christian, card, answer, tool } = await planning()
    expect(card.planFile).toBe('.kernel/plans/plan.md')
    await k.stop()
    // The turn that asked was cut off, so ExitPlanMode got no approval.
    expect(await answer).toMatchObject({ behavior: 'deny' })
    const { k: k2, before } = await relaunch(where)

    // The card is back and the tool card ended as before (KERNEL-215).
    expect(k2.store.approval(card.id)?.status).toBe('pending')
    expect(k2.store.approval(tool.id)?.status).toBe('expired')
    // The agent wasn't working, so no quit note, even with a tool card up beside the plan, and the plan's row finished:
    // the plan is in the card. Nothing carries the chat on: it waits for the card.
    expect(k2.store.items(christian.id).find((i) => i.kind === 'tool')).toMatchObject({ name: 'ExitPlanMode', status: 'done' })
    expect(notes(k2, christian)).toEqual([])
    expect(k2.sessions.isRunning(christian.id)).toBe(false)
    expect(k2.sessions.queued(christian.id)).toEqual([])
    expect(users(k2, christian)).not.toContain(RELAUNCH_NUDGE)
    expect(callIn(ws.path, before)).toBeUndefined()
    expect(k2.store.meta('cutOff')).not.toHaveProperty(christian.id)

    const decided = await k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })
    expect(decided).toMatchObject({ id: card.id, status: 'allowed' })
    expect(k2.store.chat(christian.id)?.plan).toBe(false)
    const note = planApproval({ lead: false, planFile: card.planFile, restarted: true }).text
    expect(note).toBe('Plan approved. Build it from `.kernel/plans/plan.md`.\n\nKernel restarted while the plan waited, so check git status before you start.')
    expect(users(k2, christian).at(-1)).toBe(note)
    expect(k2.store.items(christian.id).filter((i) => i.kind === 'user').at(-1)).toMatchObject({ from: 'kernel', approvalId: card.id })
    // The user's answer is its own row after the card, and Kernel's message, which the chat hides, follows it (KERNEL-836).
    expect(answers(k2, christian.id)).toEqual([expect.objectContaining({ item: expect.objectContaining({ id: `answer-${card.id}`, parts: text('Approved') }), after: expect.objectContaining({ from: 'kernel', approvalId: card.id }) })])
    const ids = k2.store.items(christian.id).map((i) => i.id)
    expect(ids.indexOf(`answer-${card.id}`)).toBeGreaterThan(ids.indexOf(`approval-${card.id}`))
    // One turn, in the same conversation, out of plan mode. The note is the message itself, so no other note is added.
    expect(k2.sessions.isRunning(christian.id)).toBe(true)
    expect(callIn(ws.path, before)?.options).toMatchObject({ resume: 'christian-session', permissionMode: expect.not.stringMatching(/^plan$/) })
    expect(notes(k2, christian)).toEqual([])
    // A second answer finds nothing waiting.
    await expect(k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })).rejects.toThrow(/already/)
    expect(answers(k2, christian.id)).toHaveLength(1)
  }, 30000)

  it('keeps it after a crash or Ctrl+C too, where only the launch sees the card', async () => {
    const { k, where, christian, card } = await planning()
    await k.stop()
    // What a kill leaves: no clean exit marker, and the card still saved as pending.
    const store = new Store(join(where.dataDir, 'kernel.db'))
    store.saveMeta('cleanExit', false)
    expect(store.approval(card.id)?.status).toBe('pending')
    store.db.close()
    const { k: k2 } = await relaunch(where)
    expect(k2.store.approval(card.id)?.status).toBe('pending')
    expect(notes(k2, christian)).toEqual([])
    expect(k2.sessions.isRunning(christian.id)).toBe(false)
    await k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })
    expect(users(k2, christian).at(-1)).toBe(planApproval({ lead: false, planFile: card.planFile, restarted: true }).text)
  }, 30000)

  it('uses the plan text when the file is gone', async () => {
    const { k, where, ws, christian, card } = await planning()
    await k.stop()
    const { rm } = await import('node:fs/promises')
    await rm(join(ws.path, card.planFile!))
    const { k: k2 } = await relaunch(where)
    await k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })
    expect(users(k2, christian).at(-1)).toBe(`Plan approved. Build it from the plan below.\n\n${PLAN}\n\nKernel restarted while the plan waited, so check git status before you start.`)
  }, 30000)

  it('sends requested changes and images after a restart, and the revision overwrites the same file', async () => {
    const { k, where, ws, christian, card } = await planning()
    await k.stop()
    const { k: k2, before } = await relaunch(where)
    const decided = await k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'deny', message: 'Split the API work out', images: [{ name: 'mock.png', dataUrl: PNG }] } })
    expect(decided.status).toBe('denied')
    expect(k2.store.chat(christian.id)?.plan).toBe(true)
    const sent = users(k2, christian).at(-1)!
    expect(sent.startsWith(planChanges('Split the API work out', card.planFile))).toBe(true)
    expect(sent).toMatch(/\.kernel\/attachments\/1\/mock\.png/)
    // The card keeps what the user typed, without the image lines, and Kernel's message names it.
    expect(decided.answer).toBe('Split the API work out')
    // It keeps the image too, as the image part a user message carries, for the chip in the bubble.
    const image = { type: 'image', name: 'mock.png', dataUrl: PNG, path: '.kernel/attachments/1/mock.png' }
    expect(decided.images).toEqual([image])
    expect(k2.store.approval(card.id)?.images).toEqual([image])
    expect(k2.store.items(christian.id).filter((i) => i.kind === 'user').at(-1)).toMatchObject({ from: 'kernel', approvalId: card.id })
    // The user's answer row says what they typed, with the image, and not Kernel's lines for it (KERNEL-836).
    expect(answers(k2, christian.id).map((r) => r.item.parts)).toEqual([[...text('Split the API work out'), image]])
    // The agent writes the revision, which goes to the same file.
    const call = callIn(ws.path, before)!
    void (call.options.canUseTool as CanUseTool)('ExitPlanMode', { plan: `${PLAN}\n3. API in its own task` }, { signal: call.options.abortController.signal, toolUseID: 't2', suggestions: [] } as never)
    const revised = await until(() => plans(k2, christian).find((a) => a.id !== card.id && a.planFile))
    expect(revised.planFile).toBe(card.planFile)
    expect(await readFile(join(ws.path, card.planFile!), 'utf8')).toContain('3. API in its own task')
  }, 30000)

  it('sends what was queued first and keeps the card, and a new plan replaces it', async () => {
    const { k, where, ws, christian, card } = await planning()
    expect(await k.sessions.send(christian.id, text('Also cover refunds'))).toMatchObject({ queued: true })
    await k.stop()
    const { k: k2, before } = await relaunch(where)
    expect(users(k2, christian).at(-1)).toBe('Also cover refunds')
    expect(k2.sessions.queued(christian.id)).toEqual([])
    expect(users(k2, christian)).not.toContain(RELAUNCH_NUDGE)
    expect(k2.store.approval(card.id)?.status).toBe('pending')
    const call = callIn(ws.path, before)!
    void (call.options.canUseTool as CanUseTool)('ExitPlanMode', { plan: `${PLAN}\n3. Refunds` }, { signal: call.options.abortController.signal, toolUseID: 't2', suggestions: [] } as never)
    await until(() => plans(k2, christian).length === 2 && plans(k2, christian).every((a) => a.planFile))
    expect(k2.store.approval(card.id)).toMatchObject({ status: 'expired', expiredBy: 'replaced' })
    expect(plans(k2, christian).filter((a) => a.status === 'pending')).toHaveLength(1)
    expect(answers(k2, christian.id)).toEqual([])
  }, 30000)

  it('ends the card when the workspace is archived or the chat is closed', async () => {
    const a = await planning()
    await a.k.stop()
    const { k: k2 } = await relaunch(a.where)
    await k2.archiveWorkspace(a.ws.id, false)
    expect(k2.store.approval(a.card.id)).toMatchObject({ status: 'expired', expiredBy: 'archived' })

    const b = await planning()
    await b.k.stop()
    const { k: k3 } = await relaunch(b.where)
    await k3.handlers()['chats.close']({ chatId: b.christian.id })
    expect(k3.store.approval(b.card.id)).toMatchObject({ status: 'expired', expiredBy: 'closed' })
  }, 60000)

  it('says the chat closed or the workspace was archived when the launch ends a card for that', async () => {
    const { k, where, ws, christian, card } = await planning()
    await k.stop()
    const store = new Store(join(where.dataDir, 'kernel.db'))
    store.saveChat({ ...store.chat(christian.id)!, closed: true })
    store.db.close()
    const { k: k2 } = await relaunch(where)
    expect(k2.store.approval(card.id)).toMatchObject({ status: 'expired', expiredBy: 'closed' })
    expect(k2.store.workspace(ws.id)?.status).not.toBe('archived')
  }, 30000)

  it('queues the note in a paused project and sends it when the project resumes', async () => {
    const { k, where, project, christian, card } = await planning()
    await k.stop()
    const { k: k2 } = await relaunch(where)
    k2.sessions.pause(project.id)
    await k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })
    const note = planApproval({ lead: false, planFile: card.planFile, restarted: true }).text
    expect(k2.sessions.queued(christian.id).map((q) => (q.parts[0] as { text: string }).text)).toEqual([note])
    expect(k2.sessions.isRunning(christian.id)).toBe(false)
    k2.sessions.resume(project.id)
    await flush()
    expect(k2.sessions.isRunning(christian.id)).toBe(true)
    expect(users(k2, christian).at(-1)).toBe(note)
  }, 30000)

  it("answers a Codex plan left from before the restart the same way, as Kernel's message", async () => {
    const { k, where, project } = await kernel()
    const ws = await k.createWorkspace(project.id, { prompt: 'Build the table', agentId: 'christian', title: 'Invoice table' })
    await until(() => callIn(ws.path))
    await k.stop()
    // What a Codex plan waiting after its turn leaves: a card on a Codex chat that isn't in the working journal.
    const store = new Store(join(where.dataDir, 'kernel.db'))
    const codex: Chat = { id: 'codex-chat', workspaceId: ws.id, title: 'Plan', kind: 'chat', provider: 'codex', model: 'gpt-6-astra', effort: 'medium', plan: true, createdAt: 2 }
    store.saveChat(codex)
    store.saveApproval({ id: 'codex-plan', kind: 'plan', source: 'sdk', projectId: project.id, workspaceId: ws.id, chatId: codex.id, title: 'Plan for invoice-table', detail: PLAN, status: 'pending', createdAt: Date.now() })
    store.db.close()
    const { k: k2 } = await relaunch(where)
    expect(k2.store.approval('codex-plan')?.status).toBe('pending')
    // Paused, so the message waits instead of starting Codex.
    k2.sessions.pause(project.id)
    expect(await k2.handlers()['approvals.decide']({ id: 'codex-plan', decision: { behavior: 'allow' } })).toMatchObject({ status: 'allowed' })
    expect(k2.store.chat(codex.id)?.plan).toBe(false)
    expect(k2.sessions.queued(codex.id)).toEqual([expect.objectContaining({ from: 'kernel', approvalId: 'codex-plan', parts: text(planApproval({ lead: false, plan: PLAN, restarted: true }).text) })])
    // The queued message keeps the approval when it goes out.
    k2.sessions.resume(project.id)
    expect(answers(k2, codex.id).map((r) => r.item)).toEqual([expect.objectContaining({ id: 'answer-codex-plan', parts: text('Approved') })])
    await until(() => k2.store.items(codex.id).find((i) => i.kind === 'user' && i.from))
    expect(k2.store.items(codex.id).find((i) => i.kind === 'user' && i.from)).toMatchObject({ from: 'kernel', approvalId: 'codex-plan' })
    expect(answers(k2, codex.id)).toHaveLength(1)
  }, 30000)

  it("keeps each step's criteria after a restart", async () => {
    const { k, where, project } = await kernel()
    const lead = await k.leadChat(project.id)
    const leadWs = await setUp(k, lead.id)
    await k.sessions.configure(lead.id, { plan: true })
    await k.sessions.send(lead.id, text('Plan the invoice table'))
    callIn(leadWs.path)!.feed({ type: 'system', subtype: 'init', session_id: 'kernel-session', apiKeySource: 'none' })
    const leadAgent = (await k.team.agents(project.id)).find((a) => a.lead)!
    const tool = kernelTools(k.lead.leadToolDeps(project.id, leadAgent, k.store.chat(lead.id)!)).find((t) => t.name === 'request_plan_approval')!
    void tool.handler({ title: 'Invoice table', plan: PLAN, steps: [{ task: 'Build the table · Christian', criteria: ['Totals match the lines'] }] } as never, {})
    const card = await until(() => plans(k, lead).find((a) => a.planFile))
    await k.stop()
    const { k: k2 } = await relaunch(where)
    expect(k2.store.approval(card.id)?.steps).toEqual([{ title: 'Build the table', criteria: ['Totals match the lines'], agentId: 'christian' }])
  }, 30000)

  it("has the Lead hand off once after a restart, with the hand-off reminder armed", async () => {
    const { k, where, project } = await kernel()
    const lead = await k.leadChat(project.id)
    const leadWs = await setUp(k, lead.id)
    await k.sessions.configure(lead.id, { plan: true })
    await k.sessions.send(lead.id, text('Plan the invoice table'))
    callIn(leadWs.path)!.feed({ type: 'system', subtype: 'init', session_id: 'kernel-session', apiKeySource: 'none' })
    const leadAgent = (await k.team.agents(project.id)).find((a) => a.lead)!
    const tool = kernelTools(k.lead.leadToolDeps(project.id, leadAgent, k.store.chat(lead.id)!)).find((t) => t.name === 'request_plan_approval')!
    const asked = tool.handler({ title: 'Invoice table', plan: PLAN, steps: ['Build the table · Christian'] } as never, {})
    const card = await until(() => plans(k, lead).find((a) => a.planFile))
    await k.stop()
    expect(await asked).toMatchObject({ content: [{ text: 'No answer yet. Wait and ask again later.' }] })
    const { k: k2 } = await relaunch(where)
    expect(k2.store.approval(card.id)?.status).toBe('pending')
    expect(k2.sessions.isRunning(lead.id)).toBe(false)
    expect(users(k2, lead)).not.toContain(RELAUNCH_NUDGE)

    await k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })
    const note = planApproval({ lead: true, planFile: card.planFile, restarted: true }).text
    expect(note.startsWith(`Plan approved. Hand off each task from \`${card.planFile}\` now.\n\n${HANDOFF_NOW}`)).toBe(true)
    expect(users(k2, lead).at(-1)).toBe(note)
    expect(users(k2, lead).filter((u) => u.includes(HANDOFF_NOW))).toHaveLength(1)
    expect(k2.sessions.handoffs.due(lead.id)).toBe(true)
    expect(k2.store.chat(lead.id)?.plan).toBe(false)
  }, 30000)
})

describe('plan answers while the agent waits', () => {
  it('approving adds no note to the chat, and the agent reads the same approval', async () => {
    const { k, christian, card, answer } = await planning()
    await k.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })
    expect(await answer).toMatchObject({ behavior: 'allow' })
    expect(notes(k, christian)).toEqual([])
    expect(k.store.chat(christian.id)?.plan).toBe(false)
    await k.stop({ budgetMs: 0 })
  }, 30000)

  it('Request changes keeps what the user typed and attached on the card, without the image lines', async () => {
    const { k, card, answer } = await planning()
    const decided = await k.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'deny', message: ' Split the API work out ', images: [{ name: 'mock.png', dataUrl: PNG }] } })
    const images = [{ type: 'image', name: 'mock.png', dataUrl: PNG, path: '.kernel/attachments/1/mock.png' }]
    expect(decided).toMatchObject({ status: 'denied', answer: 'Split the API work out', images })
    expect(k.store.approval(card.id)?.images).toEqual(images)
    expect(await answer).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/\.kernel\/attachments\/1\/mock\.png/) })
    await k.stop({ budgetMs: 0 })
  }, 30000)

  it('ends a waiting card as closed with its chat and as archived with its workspace, and a tool card says neither', async () => {
    const a = await planning()
    await a.k.handlers()['chats.close']({ chatId: a.christian.id })
    expect(await a.answer).toMatchObject({ behavior: 'deny' })
    expect(a.k.store.approval(a.card.id)).toMatchObject({ status: 'expired', expiredBy: 'closed' })
    await a.k.stop({ budgetMs: 0 })

    const b = await planning()
    await b.k.archiveWorkspace(b.ws.id, false)
    expect(b.k.store.approval(b.card.id)).toMatchObject({ status: 'expired', expiredBy: 'archived' })
    expect(b.k.store.approval(b.tool.id)?.status).toBe('expired')
    expect(b.k.store.approval(b.tool.id)).not.toHaveProperty('expiredBy')
    await b.k.stop({ budgetMs: 0 })
  }, 60000)
})

describe("a live decision is the user's message in the chat (KERNEL-836)", () => {
  it('adds the answer under each plan, question and agent card decided in Kernel, and none for a tool or a timeout', async () => {
    const { k, project, ws, christian, card, answer, tool } = await planning()
    onTestFinished(() => k.stop({ budgetMs: 0 }))
    const decide = k.handlers()['approvals.decide']
    const ask = (kind: 'question' | 'agent', timeoutMs?: number) => {
      const { approval } = k.approvals.request({ kind, source: 'sdk', projectId: project.id, workspaceId: ws.id, chatId: christian.id, title: kind }, { timeoutMs })
      k.sessions.placeApproval(christian.id, approval.id)
      return approval
    }
    await decide({ id: tool.id, decision: { behavior: 'allow' } })
    const question = ask('question')
    await decide({ id: question.id, decision: { behavior: 'answer', text: 'S3' } })
    const hire = ask('agent')
    await decide({ id: hire.id, decision: { behavior: 'deny', message: 'Please change the agent file.' } })
    await decide({ id: card.id, decision: { behavior: 'allow' } })
    // The agent gets the plan approval itself, as before.
    expect(await answer).toMatchObject({ behavior: 'allow' })
    const late = ask('question', 10)
    await until(() => k.store.approval(late.id)?.status === 'expired')
    expect(answers(k, christian.id).map((r) => [r.before, r.item.parts])).toEqual([
      [`approval-${question.id}`, text('S3')],
      [`approval-${hire.id}`, text('Not now')],
      [`answer-${hire.id}`, text('Approved')]
    ])
    // The plan's card went up first, so its answer is the latest row after it, not the one under it.
    const ids = k.store.items(christian.id).map((i) => i.id)
    expect(ids.indexOf(`answer-${card.id}`)).toBeGreaterThan(ids.indexOf(`approval-${card.id}`))
  }, 30000)
})
