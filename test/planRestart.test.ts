import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { Chat, ChatItem } from '@shared/types'
import { setUp, tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { Store } from '../src/main/db'
import { kernelTools } from '../src/main/services/kernelMcp'
import { HANDOFF_NOW, planApproval, planChanges } from '../src/main/services/handoff'
import { QUIT_NOTE, CRASH_NOTE, RELAUNCH_NUDGE, TOOL_STOPPED } from '../src/main/services/sessions'

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

async function until<T>(read: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 200; i++) { const v = read(); if (v) return v; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error('timed out')
}

async function kernel() {
  const repo = await tempRepo({
    'README.md': '# client\n',
    '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
    '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const where = { dataDir, home }
  const k = new Kernel(where)
  await k.start()
  const room = await k.addRoom(repo)
  return { k, where, room }
}

/** Kai in plan mode, blocked on ExitPlanMode with its plan saved, and a Bash card waiting in the same chat. */
async function planning() {
  const { k, where, room } = await kernel()
  const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
  const kai = k.store.chats(ws.id)[0]
  await k.sessions.configure(kai.id, { plan: true })
  const call = callIn(ws.path)!
  call.feed({ type: 'system', subtype: 'init', session_id: 'kai-session', apiKeySource: 'none' })
  call.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'ExitPlanMode', input: { plan: PLAN } }] } })
  await flush()
  const answer = (call.options.canUseTool as CanUseTool)('ExitPlanMode', { plan: PLAN }, { signal: call.options.abortController.signal, toolUseID: 't1', suggestions: [] } as never)
  const card = await until(() => plans(k, kai).find((a) => a.planFile))
  const tool = k.approvals.request({ kind: 'tool', source: 'sdk', roomId: room.id, workspaceId: ws.id, chatId: kai.id, title: 'Run pnpm db:reset' })
  return { k, where, room, ws, kai, card, answer, tool: tool.approval }
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
    const { k, where, ws, kai, card, answer, tool } = await planning()
    expect(card.planFile).toBe('.kernel/plans/invoice-table.md')
    await k.stop()
    // The turn that asked was cut off, so ExitPlanMode got no approval.
    expect(await answer).toMatchObject({ behavior: 'deny' })
    const { k: k2, before } = await relaunch(where)

    // The card is back and the tool card ended as before (KERNEL-215).
    expect(k2.store.approval(card.id)?.status).toBe('pending')
    expect(k2.store.approval(tool.id)?.status).toBe('expired')
    // The stuck row stopped and the quit note shows, but nothing carries the chat on: it waits for the card.
    expect(k2.store.items(kai.id).find((i) => i.kind === 'tool')).toMatchObject({ status: 'failed', output: TOOL_STOPPED })
    expect(notes(k2, kai)).toEqual([QUIT_NOTE])
    expect(k2.sessions.isRunning(kai.id)).toBe(false)
    expect(k2.sessions.queued(kai.id)).toEqual([])
    expect(users(k2, kai)).not.toContain(RELAUNCH_NUDGE)
    expect(callIn(ws.path, before)).toBeUndefined()
    expect(k2.store.meta('cutOff')).not.toHaveProperty(kai.id)

    const decided = await k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })
    expect(decided).toMatchObject({ id: card.id, status: 'allowed' })
    expect(k2.store.chat(kai.id)?.plan).toBe(false)
    const note = planApproval({ lead: false, planFile: card.planFile, restarted: true }).text
    expect(note).toBe('Plan approved. Build it from `.kernel/plans/invoice-table.md`.\n\nKernel restarted while the plan waited, so check git status before you start.')
    expect(users(k2, kai).at(-1)).toBe(note)
    expect(k2.store.items(kai.id).filter((i) => i.kind === 'user').at(-1)).toMatchObject({ from: 'kernel' })
    // One turn, in the same conversation, out of plan mode. The note is the message itself, so no other note is added.
    expect(k2.sessions.isRunning(kai.id)).toBe(true)
    expect(callIn(ws.path, before)?.options).toMatchObject({ resume: 'kai-session', permissionMode: expect.not.stringMatching(/^plan$/) })
    expect(notes(k2, kai)).toEqual([QUIT_NOTE])
    // A second answer finds nothing waiting.
    await expect(k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })).rejects.toThrow(/already/)
  }, 30000)

  it('keeps it after a crash or Ctrl+C too, where only the launch sees the card', async () => {
    const { k, where, kai, card } = await planning()
    await k.stop()
    // What a kill leaves: no clean exit marker, and the card still saved as pending.
    const store = new Store(join(where.dataDir, 'kernel.db'))
    store.saveMeta('cleanExit', false)
    expect(store.approval(card.id)?.status).toBe('pending')
    store.db.close()
    const { k: k2 } = await relaunch(where)
    expect(k2.store.approval(card.id)?.status).toBe('pending')
    expect(notes(k2, kai)).toEqual([CRASH_NOTE])
    expect(k2.sessions.isRunning(kai.id)).toBe(false)
    await k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })
    expect(users(k2, kai).at(-1)).toBe(planApproval({ lead: false, planFile: card.planFile, restarted: true }).text)
  }, 30000)

  it('uses the plan text when the file is gone', async () => {
    const { k, where, ws, kai, card } = await planning()
    await k.stop()
    const { rm } = await import('node:fs/promises')
    await rm(join(ws.path, card.planFile!))
    const { k: k2 } = await relaunch(where)
    await k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })
    expect(users(k2, kai).at(-1)).toBe(`Plan approved. Build it from the plan below.\n\n${PLAN}\n\nKernel restarted while the plan waited, so check git status before you start.`)
  }, 30000)

  it('sends requested changes and images after a restart, and the revision overwrites the same file', async () => {
    const { k, where, ws, kai, card } = await planning()
    await k.stop()
    const { k: k2, before } = await relaunch(where)
    const decided = await k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'deny', message: 'Split the API work out', images: [{ name: 'mock.png', dataUrl: PNG }] } })
    expect(decided.status).toBe('denied')
    expect(k2.store.chat(kai.id)?.plan).toBe(true)
    const sent = users(k2, kai).at(-1)!
    expect(sent.startsWith(planChanges('Split the API work out', card.planFile))).toBe(true)
    expect(sent).toMatch(/\.kernel\/attachments\/mock\.png/)
    // The agent writes the revision, which goes to the same file.
    const call = callIn(ws.path, before)!
    void (call.options.canUseTool as CanUseTool)('ExitPlanMode', { plan: `${PLAN}\n3. API in its own task` }, { signal: call.options.abortController.signal, toolUseID: 't2', suggestions: [] } as never)
    const revised = await until(() => plans(k2, kai).find((a) => a.id !== card.id && a.planFile))
    expect(revised.planFile).toBe(card.planFile)
    expect(await readFile(join(ws.path, card.planFile!), 'utf8')).toContain('3. API in its own task')
  }, 30000)

  it('sends what was queued first and keeps the card, and a new plan replaces it', async () => {
    const { k, where, ws, kai, card } = await planning()
    expect(await k.sessions.send(kai.id, text('Also cover refunds'))).toMatchObject({ queued: true })
    await k.stop()
    const { k: k2, before } = await relaunch(where)
    expect(users(k2, kai).at(-1)).toBe('Also cover refunds')
    expect(k2.sessions.queued(kai.id)).toEqual([])
    expect(users(k2, kai)).not.toContain(RELAUNCH_NUDGE)
    expect(k2.store.approval(card.id)?.status).toBe('pending')
    const call = callIn(ws.path, before)!
    void (call.options.canUseTool as CanUseTool)('ExitPlanMode', { plan: `${PLAN}\n3. Refunds` }, { signal: call.options.abortController.signal, toolUseID: 't2', suggestions: [] } as never)
    await until(() => plans(k2, kai).length === 2 && plans(k2, kai).every((a) => a.planFile))
    expect(k2.store.approval(card.id)?.status).toBe('expired')
    expect(plans(k2, kai).filter((a) => a.status === 'pending')).toHaveLength(1)
  }, 30000)

  it('ends the card when the workspace is archived or the chat is closed', async () => {
    const a = await planning()
    await a.k.stop()
    const { k: k2 } = await relaunch(a.where)
    await k2.archiveWorkspace(a.ws.id, false)
    expect(k2.store.approval(a.card.id)?.status).toBe('expired')

    const b = await planning()
    await b.k.stop()
    const { k: k3 } = await relaunch(b.where)
    await k3.handlers()['chats.close']({ chatId: b.kai.id })
    expect(k3.store.approval(b.card.id)?.status).toBe('expired')
  }, 60000)

  it('queues the note in a paused room and sends it when the room resumes', async () => {
    const { k, where, room, kai, card } = await planning()
    await k.stop()
    const { k: k2 } = await relaunch(where)
    k2.sessions.pause(room.id)
    await k2.handlers()['approvals.decide']({ id: card.id, decision: { behavior: 'allow' } })
    const note = planApproval({ lead: false, planFile: card.planFile, restarted: true }).text
    expect(k2.sessions.queued(kai.id).map((q) => (q.parts[0] as { text: string }).text)).toEqual([note])
    expect(k2.sessions.isRunning(kai.id)).toBe(false)
    k2.sessions.resume(room.id)
    await flush()
    expect(k2.sessions.isRunning(kai.id)).toBe(true)
    expect(users(k2, kai).at(-1)).toBe(note)
  }, 30000)

  it("answers a Codex plan left from before the restart the same way, as Kernel's message", async () => {
    const { k, where, room } = await kernel()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    await until(() => callIn(ws.path))
    await k.stop()
    // What a Codex plan waiting after its turn leaves: a card on a Codex chat that isn't in the working journal.
    const store = new Store(join(where.dataDir, 'kernel.db'))
    const codex: Chat = { id: 'codex-chat', workspaceId: ws.id, title: 'Plan', kind: 'chat', provider: 'codex', model: 'gpt-6-astra', effort: 'medium', plan: true, createdAt: 2 }
    store.saveChat(codex)
    store.saveApproval({ id: 'codex-plan', kind: 'plan', source: 'sdk', roomId: room.id, workspaceId: ws.id, chatId: codex.id, title: 'Plan for invoice-table', detail: PLAN, status: 'pending', createdAt: Date.now() })
    store.db.close()
    const { k: k2 } = await relaunch(where)
    expect(k2.store.approval('codex-plan')?.status).toBe('pending')
    // Paused, so the message waits instead of starting Codex.
    k2.sessions.pause(room.id)
    expect(await k2.handlers()['approvals.decide']({ id: 'codex-plan', decision: { behavior: 'allow' } })).toMatchObject({ status: 'allowed' })
    expect(k2.store.chat(codex.id)?.plan).toBe(false)
    expect(k2.sessions.queued(codex.id)).toEqual([expect.objectContaining({ from: 'kernel', parts: text(planApproval({ lead: false, plan: PLAN, restarted: true }).text) })])
  }, 30000)

  it("has the Lead hand off once after a restart, with the hand-off reminder armed", async () => {
    const { k, where, room } = await kernel()
    const lead = await k.leadChat(room.id)
    const leadWs = await setUp(k, lead.id)
    await k.sessions.configure(lead.id, { plan: true })
    await k.sessions.send(lead.id, text('Plan the invoice table'))
    callIn(leadWs.path)!.feed({ type: 'system', subtype: 'init', session_id: 'rowan-session', apiKeySource: 'none' })
    const rowan = (await k.team.agents(room.id)).find((a) => a.lead)!
    const tool = kernelTools(k.lead.leadToolDeps(room.id, rowan, k.store.chat(lead.id)!)).find((t) => t.name === 'request_plan_approval')!
    const asked = tool.handler({ title: 'Invoice table', plan: PLAN, steps: ['Build the table · Kai'] } as never, {})
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
