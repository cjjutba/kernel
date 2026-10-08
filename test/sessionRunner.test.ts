import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, ChatItem, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { Sessions } from '../src/main/services/sessions'
import { HANDOFF_NOW, HANDOFF_REMINDER, LEAD_RULE } from '../src/main/services/handoff'
import type { AppSettings } from '../src/main/services/settings'

// The SDK is replaced by a scripted session: each query() records its options and yields whatever the test feeds it.
// After an abort it yields what was already fed, then throws, as the real one does.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void; interrupts: number }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { abortController?: AbortController } }) => {
    const items: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    const signal = options.abortController?.signal
    const aborted = () => new Error('Claude Code process aborted by user')
    signal?.addEventListener('abort', () => { for (const w of waiters.splice(0)) w.reject(aborted()) })
    const call = { options, interrupts: 0, feed: (m: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: m, done: false }); else items.push(m) } }
    sdk.calls.push(call)
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
          : signal?.aborted ? Promise.reject(aborted()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
      }),
      interrupt: async () => { call.interrupts++ },
      setModel: async () => {},
      setPermissionMode: async () => {}
    }
  }
}))

const flush = () => new Promise((r) => setTimeout(r, 10))

async function setup(mode = 'acceptEdits', hooks: { mcpFor?: (ws: Workspace, agent: unknown, chat: Chat) => undefined; agent?: AgentDef; models?: Partial<AppSettings['models']> } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-runner-')), 'kernel.db'))
  const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
  const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 }
  store.saveWorkspace(ws)
  store.saveChat(chat)
  const allow: string[] = []
  const approvals = new Approvals(store)
  const settings = { permissions: { mode, alwaysAsk: ['drizzle-kit push'], neverAllow: ['git push origin main'], protectedBranches: [], approvalTimeoutSec: 300 }, ...(hooks.models ? { models: hooks.models } : {}) } as unknown as AppSettings
  const sessions = new Sessions({
    store, approvals, settings: () => settings, agentFor: () => hooks.agent, mcpFor: (ws, agent, chat) => hooks.mcpFor?.(ws, agent, chat),
    roomAllow: () => allow, allowInRoom: (_room, rule) => { allow.push(rule) }
  })
  await sessions.send(chat.id, [{ type: 'text', text: 'Add a pdf_url column' }])
  const call = sdk.calls[sdk.calls.length - 1]
  const options = call.options as Options
  const guard = options.hooks!.PreToolUse!.find((m) => m.matcher === 'Bash')!.hooks[0] as HookCallback
  const runGuard = (id: string, command: string) => guard({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, session_id: 's', transcript_path: '', cwd: ws.path } as never, id, { signal: new AbortController().signal } as never)
  const kinds = () => store.items(chat.id).map((i: ChatItem) => i.kind)
  return { store, sessions, call, options, runGuard, allow, approvals, kinds, chat }
}

describe('questions to the user', () => {
  it('sends ExitPlanMode to the user as a plan card even when worktrees bypass permissions, and keeps the card in the chat', async () => {
    const { options, approvals, store, kinds } = await setup('bypassInWorktrees')
    const answer = (options.canUseTool as CanUseTool)('ExitPlanMode', { plan: '1. Add the column\n2. Backfill it' }, { signal: new AbortController().signal, toolUseID: 'p1', requestId: 'r1' })
    await flush()
    const pending = store.approvals({ pendingOnly: true })[0]
    expect(pending).toMatchObject({ kind: 'plan', toolName: 'ExitPlanMode', workspaceId: 'ws', chatId: 'chat', detail: '1. Add the column\n2. Backfill it' })
    expect(kinds()).toContain('approval')
    approvals.decide(pending.id, { behavior: 'allow' })
    expect(await answer).toMatchObject({ behavior: 'allow' })
    expect(store.items('chat').find((i) => i.kind === 'approval')).toMatchObject({ approvalId: pending.id })
  })

  it('hands the MCP builder the chat that is running, so Rowan\'s cards land there', async () => {
    const seen: string[] = []
    const { chat } = await setup('acceptEdits', { mcpFor: (_ws, _agent, c) => { seen.push(c.id); return undefined } })
    expect(seen).toEqual([chat.id])
  })

  it('leaves plan mode once the plan is approved', async () => {
    const { options, approvals, store } = await setup()
    store.saveChat({ ...store.chat('chat')!, plan: true })
    const answer = (options.canUseTool as CanUseTool)('ExitPlanMode', { plan: '1. Go' }, { signal: new AbortController().signal, toolUseID: 'p2', requestId: 'r3' })
    await flush()
    approvals.decide(store.approvals({ pendingOnly: true })[0].id, { behavior: 'allow' })
    await answer
    expect(store.chat('chat')?.plan).toBe(false)
  })

  it('still lets bypass answer an ordinary tool', async () => {
    const { options } = await setup('bypassInWorktrees')
    expect(await (options.canUseTool as CanUseTool)('Edit', { file_path: 'a.ts' }, { signal: new AbortController().signal, toolUseID: 'e1', requestId: 'r2' })).toMatchObject({ behavior: 'allow' })
  })
})

describe('session runner (SDK scripted)', () => {
  it('guards Bash with Kernel lists and leaves everything else to Claude Code', async () => {
    const { runGuard, allow } = await setup()
    expect(await runGuard('t1', 'git push origin main')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(await runGuard('t2', 'pnpm drizzle-kit push')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
    expect(await runGuard('t3', 'npm test')).toEqual({})
    allow.push('pnpm drizzle-kit push')
    expect(await runGuard('t4', 'pnpm drizzle-kit push')).toEqual({})
  })

  it('asks with the command the hook saw, and Always allow saves it on the room', async () => {
    const { runGuard, options, approvals, store, allow } = await setup()
    await runGuard('t5', 'pnpm drizzle-kit push')
    const rewritten = { command: 'rtk pnpm drizzle-kit push', description: 'Push the schema' }
    const answer = (options.canUseTool as CanUseTool)('Bash', rewritten, { signal: new AbortController().signal, toolUseID: 't5', requestId: 'r1' })
    await flush()
    const pending = store.approvals({ pendingOnly: true })[0]
    expect(pending).toMatchObject({ title: 'Run pnpm drizzle-kit push', input: { command: 'pnpm drizzle-kit push' } })
    approvals.decide(pending.id, { behavior: 'allow', always: true })
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: rewritten, updatedPermissions: undefined })
    expect(allow).toEqual(['pnpm drizzle-kit push'])
  })

  it('knows its session id up front, runs from init to result, and hides the error result of an interrupted turn', async () => {
    const { sessions, call, options, kinds, chat } = await setup()
    expect(options.sessionId).toBeTruthy()
    expect(sessions.isManaged(options.sessionId!)).toBe(true)
    expect(options.thinking).toEqual({ type: 'adaptive', display: 'summarized' })

    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none' })
    call.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'Schema first.' }] } })
    call.feed({ type: 'assistant', uuid: 'a2', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 30' } }] } })
    await flush()
    expect(sessions.isRunning(chat.id)).toBe(true)
    expect(sessions.billingOf(chat.id)).toBe('none')

    await sessions.interrupt(chat.id)
    await sessions.interrupt(chat.id)
    expect(call.interrupts).toBe(1)
    call.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Interrupted' }] } })
    call.feed({ type: 'result', subtype: 'error_during_execution', uuid: 'r1', duration_ms: 900 })
    await flush()
    expect(sessions.isRunning(chat.id)).toBe(false)
    expect(kinds()).toEqual(['user', 'thinking', 'tool', 'interrupted'])

    await sessions.send(chat.id, [{ type: 'text', text: 'Carry on' }])
    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none' })
    call.feed({ type: 'assistant', uuid: 'a3', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done.' }] } })
    call.feed({ type: 'result', subtype: 'success', uuid: 'r2', duration_ms: 400 })
    await flush()
    expect(kinds().slice(-3)).toEqual(['user', 'text', 'result'])
    expect(sessions.isRunning(chat.id)).toBe(false)
  })

  it('keeps the new session when a stopped one ends after the next send', async () => {
    const { sessions, call, options, chat } = await setup()
    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none' })
    await flush()
    const running: boolean[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'chat.running' && e.chatId === chat.id) running.push(e.running) }
    bus.on('push', onPush)
    try {
      const before = sdk.calls.length
      // send() starts the new session before the stopped loop gets to clean up.
      sessions.stop(chat.id)
      await sessions.send(chat.id, [{ type: 'text', text: 'Actually, add it to invoices' }])
      await flush()
      expect(sdk.calls.length).toBe(before + 1)
      expect(sessions.isRunning(chat.id)).toBe(true)
      expect(running).toEqual([true])

      expect(await sessions.send(chat.id, [{ type: 'text', text: 'And backfill it' }])).toEqual({ queued: true })
      expect(sdk.calls.length).toBe(before + 1)

      sessions.stop(chat.id)
      await flush()
      expect(sessions.isRunning(chat.id)).toBe(false)
      expect(running).toEqual([true, false])
    } finally {
      bus.off('push', onPush)
    }
  })

  it('drops what a stopped session still delivers once a new one owns the chat', async () => {
    const { sessions, call, options, chat, kinds } = await setup()
    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none' })
    await flush()
    const running: boolean[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'chat.running' && e.chatId === chat.id) running.push(e.running) }
    bus.on('push', onPush)
    try {
      // The old process wrote its result before it was stopped; the loop reads it after the new send.
      call.feed({ type: 'result', subtype: 'error_during_execution', uuid: 'late', duration_ms: 900 })
      sessions.stop(chat.id)
      await sessions.send(chat.id, [{ type: 'text', text: 'Start over' }])
      await flush()
      expect(sessions.isRunning(chat.id)).toBe(true)
      expect(running).toEqual([true])
      expect(kinds()).toEqual(['user', 'user'])
    } finally {
      bus.off('push', onPush)
    }
  })

  it('flags a session billed to an API key', async () => {
    const { sessions, call, options, store, chat } = await setup()
    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'ANTHROPIC_API_KEY' })
    await flush()
    expect(sessions.billingOf(chat.id)).toBe('ANTHROPIC_API_KEY')
    expect(store.items(chat.id).find((i) => i.kind === 'note')).toMatchObject({ text: 'This session is billed through ANTHROPIC_API_KEY, not your Claude plan.' })
  })
  it('holds follow-ups while a turn runs and sends them in order when it ends', async () => {
    const { sessions, call, options, chat, kinds } = await setup()
    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none' })
    await flush()
    const queues: number[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'chat.queue' && e.chatId === chat.id) queues.push(e.queue.length) }
    bus.on('push', onPush)
    try {
      expect(await sessions.send(chat.id, [{ type: 'text', text: 'Also add a skeleton' }])).toEqual({ queued: true })
      expect(await sessions.send(chat.id, [{ type: 'text', text: 'Use EmptyState' }])).toEqual({ queued: true })
      expect(sessions.queued(chat.id).map((q) => (q.parts[0] as { text: string }).text)).toEqual(['Also add a skeleton', 'Use EmptyState'])
      expect(kinds()).toEqual(['user'])

      call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 10 })
      await flush()
      expect(kinds().filter((k) => k === 'user')).toHaveLength(2)
      expect(sessions.queued(chat.id)).toHaveLength(1)
      expect(sessions.isRunning(chat.id)).toBe(true)

      call.feed({ type: 'result', subtype: 'success', uuid: 'r2', duration_ms: 10 })
      await flush()
      expect(kinds().filter((k) => k === 'user')).toHaveLength(3)
      expect(sessions.queued(chat.id)).toEqual([])
      expect(queues).toEqual([1, 2, 1, 0])
    } finally {
      bus.off('push', onPush)
    }
  })

  it('removes a queued message, and sendNow interrupts and puts one first', async () => {
    const { sessions, call, options, chat, store } = await setup()
    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none' })
    await flush()
    await sessions.send(chat.id, [{ type: 'text', text: 'one' }])
    await sessions.send(chat.id, [{ type: 'text', text: 'two' }])
    await sessions.send(chat.id, [{ type: 'text', text: 'three' }])
    const [one, , three] = sessions.queued(chat.id)
    expect(sessions.unqueue(chat.id, one.id).map((q) => q.parts[0])).toEqual([{ type: 'text', text: 'two' }, { type: 'text', text: 'three' }])
    const after = await sessions.sendNow(chat.id, three.id)
    expect(after.map((q) => q.parts[0])).toEqual([{ type: 'text', text: 'three' }, { type: 'text', text: 'two' }])
    expect(call.interrupts).toBe(1)
    call.feed({ type: 'result', subtype: 'error_during_execution', uuid: 'r1', duration_ms: 10 })
    await flush()
    const users = store.items(chat.id).filter((i: ChatItem) => i.kind === 'user').map((i: ChatItem) => (i as { parts: { text: string }[] }).parts[0].text)
    expect(users).toEqual(['Add a pdf_url column', 'three'])
  })

  it('retries by sending the message before the reply again', async () => {
    const { sessions, call, options, chat, store } = await setup()
    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none' })
    call.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done.' }] } })
    call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 10 })
    await flush()
    const reply = store.items(chat.id).find((i: ChatItem) => i.kind === 'text')!
    await sessions.retry(chat.id, reply.id)
    const users = store.items(chat.id).filter((i: ChatItem) => i.kind === 'user')
    expect(users).toHaveLength(2)
    await expect(sessions.retry(chat.id, 'nope')).rejects.toThrow('no longer')
  })

  it('drops the queue when the turn is stopped, instead of starting the next message', async () => {
    const { sessions, call, options, chat, kinds } = await setup()
    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none' })
    await flush()
    await sessions.send(chat.id, [{ type: 'text', text: 'later' }])
    expect(sessions.queued(chat.id)).toHaveLength(1)
    await sessions.interrupt(chat.id)
    call.feed({ type: 'result', subtype: 'error_during_execution', uuid: 'r1', duration_ms: 10 })
    await flush()
    expect(sessions.queued(chat.id)).toEqual([])
    expect(sessions.isRunning(chat.id)).toBe(false)
    expect(kinds().filter((k) => k === 'user')).toHaveLength(1)
  })
})

describe('Approve and hand off (KERNEL-67)', () => {
  // The kernel repo's own Lead, which only plans and says nothing about create_workspace.
  const rowan: AgentDef = { id: 'rowan', file: '.claude/agents/rowan.md', name: 'Rowan', role: 'Lead', description: 'Plans sprint work', lead: true, prompt: "You are Rowan, the lead for building Kernel itself. You plan, you don't write feature code." }
  const noor: AgentDef = { id: 'noor', file: '.claude/agents/noor.md', name: 'Noor', role: 'Backend', description: 'Engine', lead: false, prompt: 'You build the engine.' }

  const hooksFor = (options: Options, event: 'PostToolUse' | 'Stop', matcher?: string) => options.hooks![event]!.filter((m) => m.matcher === matcher).flatMap((m) => m.hooks)
  /** Runs every hook for one event and returns the context they send the model. */
  const contexts = async (options: Options, event: 'PostToolUse' | 'Stop', matcher?: string) => {
    const input = event === 'Stop'
      ? { hook_event_name: 'Stop', stop_hook_active: false, session_id: 's', transcript_path: '', cwd: '/tmp/ws' }
      : { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: {}, tool_response: {}, tool_use_id: 'p9', session_id: 's', transcript_path: '', cwd: '/tmp/ws' }
    const outs = await Promise.all(hooksFor(options, event, matcher).map((h) => h(input as never, undefined, { signal: new AbortController().signal } as never)))
    return outs.map((o: any) => o?.hookSpecificOutput?.additionalContext).filter(Boolean)
  }
  async function approvePlan(s: Awaited<ReturnType<typeof setup>>) {
    const answer = (s.options.canUseTool as CanUseTool)('ExitPlanMode', { plan: '1. Symlink node_modules into worktrees · Noor' }, { signal: new AbortController().signal, toolUseID: 'p9', requestId: 'r9' })
    await flush()
    s.approvals.decide(s.store.approvals({ pendingOnly: true })[0].id, { behavior: 'allow' })
    expect(await answer).toMatchObject({ behavior: 'allow' })
  }

  it("adds Kernel's hand-off rule to a Lead whose own file only plans, and to no one else", async () => {
    const lead = (await setup('acceptEdits', { agent: rowan })).options.systemPrompt as { append: string }
    expect(lead.append).toContain(rowan.prompt)
    expect(lead.append).toContain(LEAD_RULE)
    expect(LEAD_RULE).toContain('mcp__kernel__create_workspace')
    const builder = (await setup('acceptEdits', { agent: noor })).options.systemPrompt as { append: string }
    expect(builder.append).not.toContain(LEAD_RULE)
  })

  it('tells the Lead to hand off right after the approval, then reminds it once if it tries to stop first', async () => {
    const s = await setup('acceptEdits', { agent: rowan })
    expect(await contexts(s.options, 'Stop')).toEqual([])
    await approvePlan(s)
    expect(await contexts(s.options, 'PostToolUse', 'ExitPlanMode')).toEqual([HANDOFF_NOW])
    expect(await contexts(s.options, 'Stop')).toEqual([HANDOFF_REMINDER])
    // One reminder per approval: the next Stop ends the turn.
    expect(await contexts(s.options, 'Stop')).toEqual([])
  })

  it('stops holding the Lead once it has created a workspace', async () => {
    const s = await setup('acceptEdits', { agent: rowan })
    await approvePlan(s)
    s.sessions.handoffs.done('chat') // what create_workspace does
    expect(await contexts(s.options, 'PostToolUse', 'ExitPlanMode')).toEqual([])
    expect(await contexts(s.options, 'Stop')).toEqual([])
  })

  it('drops the reminder when the user stops the turn', async () => {
    const s = await setup('acceptEdits', { agent: rowan })
    await approvePlan(s)
    await s.sessions.interrupt('chat')
    expect(await contexts(s.options, 'Stop')).toEqual([])
  })

  it('drops the reminder when the user sends something else, even while it waits in the queue', async () => {
    const s = await setup('acceptEdits', { agent: rowan })
    await approvePlan(s)
    expect(await s.sessions.send('chat', [{ type: 'text', text: 'Hold off, post it to Linear instead' }])).toEqual({ queued: true })
    expect(await contexts(s.options, 'Stop')).toEqual([])
  })

  it('takes a Kernel post into an idle chat without cancelling a pending hand-off, and refuses one while running (KERNEL-72)', async () => {
    const s = await setup('acceptEdits', { agent: rowan })
    s.sessions.handoffs.approved('chat')
    expect(s.sessions.post('chat', [{ type: 'text', text: 'Update from Kernel (not the user):' }])).toBe(false)
    s.call.feed({ type: 'system', subtype: 'init', session_id: s.options.sessionId, apiKeySource: 'none' })
    s.call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 10 })
    await flush()
    expect(s.sessions.isRunning('chat')).toBe(false)
    expect(s.sessions.post('chat', [{ type: 'text', text: 'Update from Kernel (not the user):' }])).toBe(true)
    expect(s.sessions.isRunning('chat')).toBe(true)
    expect(s.sessions.handoffs.due('chat')).toBe(true)
  })

  it('leaves agents that are not the Lead alone', async () => {
    const s = await setup('acceptEdits', { agent: noor })
    await approvePlan(s)
    expect(hooksFor(s.options, 'PostToolUse', 'ExitPlanMode')).toEqual([])
    expect(await contexts(s.options, 'Stop')).toEqual([])
  })
})

describe('agent teams (KERNEL-73)', () => {
  it('starts sessions with agent teams on when the setting is on, and off when it is off', async () => {
    const on = await setup('acceptEdits', { models: { agentTeams: true } })
    expect((on.options.env as Record<string, string>).CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
    const off = await setup('acceptEdits', { models: { agentTeams: false } })
    expect((off.options.env as Record<string, string>).CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
  })

  it('reports TeammateIdle from Kernel sessions', async () => {
    const { options } = await setup()
    expect(Object.keys(options.hooks!)).toContain('TeammateIdle')
  })
})
