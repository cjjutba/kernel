import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, ChatItem, TeamUpdate, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { LIMIT_LIFTED, RESTART_NUDGE, Sessions, type SessionDeps, type TurnBy } from '../src/main/services/sessions'
import { LEGACY_UPDATE_HEADER } from '../src/shared/teamUpdate'
import { HANDOFF_NOW, HANDOFF_REMINDER, LEAD_RULE } from '../src/main/services/handoff'
import type { AppSettings } from '../src/main/services/settings'

// The SDK is replaced by a scripted session: each query() records its options and yields whatever the test feeds it.
// After an abort it yields what was already fed, then throws, as the real one does.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void; end: () => void; interrupts: number; flags: unknown[] }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { abortController?: AbortController } }) => {
    const items: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    const signal = options.abortController?.signal
    const aborted = () => new Error('Claude Code process aborted by user')
    signal?.addEventListener('abort', () => { for (const w of waiters.splice(0)) w.reject(aborted()) })
    // end() is the process exiting on its own: the stream finishes once what was fed is read.
    let ended = false
    const call = {
      options, interrupts: 0, flags: [] as unknown[],
      feed: (m: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: m, done: false }); else items.push(m) },
      end: () => { ended = true; for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true }) }
    }
    sdk.calls.push(call)
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
          : signal?.aborted ? Promise.reject(aborted()) : ended ? Promise.resolve({ value: undefined, done: true })
          : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
      }),
      interrupt: async () => { call.interrupts++ },
      setModel: async () => {},
      setPermissionMode: async () => {},
      applyFlagSettings: async (s: unknown) => { call.flags.push(s) }
    }
  }
}))

const flush = () => new Promise((r) => setTimeout(r, 10))

async function setup(mode = 'acceptEdits', hooks: { mcpFor?: (ws: Workspace, agent: unknown, chat: Chat) => undefined; agent?: AgentDef; models?: Partial<AppSettings['models']>; onTurnDone?: SessionDeps['onTurnDone']; onExit?: SessionDeps['onExit'] } = {}) {
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
    roomAllow: () => allow, allowInRoom: (_room, rule) => { allow.push(rule) }, onTurnDone: hooks.onTurnDone, onExit: hooks.onExit
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

      expect(await sessions.send(chat.id, [{ type: 'text', text: 'And backfill it' }])).toEqual({ queued: true, why: 'running' })
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
      expect(await sessions.send(chat.id, [{ type: 'text', text: 'Also add a skeleton' }])).toEqual({ queued: true, why: 'running' })
      expect(await sessions.send(chat.id, [{ type: 'text', text: 'Use EmptyState' }])).toEqual({ queued: true, why: 'running' })
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

describe('model and effort (D-093)', () => {
  it('applies a new effort to the live session, so the next turn runs at it without a restart', async () => {
    const s = await setup()
    const call = sdk.calls[sdk.calls.length - 1]
    await s.sessions.configure('chat', { model: 'claude-opus-5-5', effort: 'xhigh' })
    expect(call.flags).toEqual([{ effortLevel: 'xhigh' }])
    await s.sessions.configure('chat', { plan: true })
    expect(call.flags).toHaveLength(1)
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
    // KERNEL-129: what the rule asks of the Lead beyond the hand-off.
    for (const part of ['Never hand a task to yourself', 'Team update from Kernel', 'Never leave a teammate waiting', 'mcp__kernel__ask_user', 'pass on the details', 'tell the user it is ready to merge', 'Call teammates by name, not he or she', 'one or two short lines', 'Leave workspace ids out', 'tell the user what is stuck']) expect(LEAD_RULE).toContain(part)
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
    expect(await s.sessions.send('chat', [{ type: 'text', text: 'Hold off, post it to Linear instead' }])).toEqual({ queued: true, why: 'running' })
    expect(await contexts(s.options, 'Stop')).toEqual([])
  })

  it('takes a Kernel post into an idle chat without cancelling a pending hand-off, and refuses one while running (KERNEL-72)', async () => {
    const s = await setup('acceptEdits', { agent: rowan })
    s.sessions.handoffs.approved('chat')
    expect(s.sessions.post('chat', [{ type: 'text', text: 'Team update from Kernel, not from the user.' }])).toBe(false)
    s.call.feed({ type: 'system', subtype: 'init', session_id: s.options.sessionId, apiKeySource: 'none' })
    s.call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 10 })
    await flush()
    expect(s.sessions.isRunning('chat')).toBe(false)
    expect(s.sessions.post('chat', [{ type: 'text', text: 'Team update from Kernel, not from the user.' }])).toBe(true)
    expect(s.sessions.isRunning('chat')).toBe(true)
    expect(s.sessions.handoffs.due('chat')).toBe(true)
    // The update is marked as Kernel's, so the transcript and Retry can tell it from the user's messages (KERNEL-116).
    expect(s.store.items('chat').filter((i: ChatItem) => i.kind === 'user').at(-1)).toMatchObject({ from: 'kernel' })
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

describe('who sent a message (KERNEL-116)', () => {
  const lead: AgentDef = { id: 'rowan', file: '.claude/agents/rowan.md', name: 'Rowan', role: 'Lead', description: 'Plans', lead: true, prompt: 'You are Rowan.' }
  const update: TeamUpdate = { rows: [{ workspaceId: 'w1', agentId: 'kai', name: 'Kai', task: 'Remove the Try section', prNumber: 108, events: [{ kind: 'pr.ready', text: 'Passed checks, no conflicts. Not reviewed yet', actionable: true }] }] }
  const HEADER = 'Team update from Kernel, not from the user.'
  const users = (s: Awaited<ReturnType<typeof setup>>) => s.store.items('chat').filter((i: ChatItem): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user')
  const init = (s: Awaited<ReturnType<typeof setup>>) => s.call.feed({ type: 'system', subtype: 'init', session_id: s.options.sessionId, apiKeySource: 'none' })
  const reply = (s: Awaited<ReturnType<typeof setup>>, uuid: string, text: string) => s.call.feed({ type: 'assistant', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } })
  const finish = async (s: Awaited<ReturnType<typeof setup>>, uuid: string) => { s.call.feed({ type: 'result', subtype: 'success', uuid, duration_ms: 10 }); await flush() }

  it("marks a Kernel post with its card, and reports who started each turn", async () => {
    const turns: TurnBy[] = []
    const s = await setup('acceptEdits', { onTurnDone: (_ws, _chat, t) => { turns.push(t.by) } })
    init(s)
    await finish(s, 'r1')
    expect(s.sessions.post('chat', [{ type: 'text', text: HEADER }], { update })).toBe(true)
    expect(s.sessions.kernelTurn('chat')).toBe(true)
    expect(users(s).at(-1)).toMatchObject({ from: 'kernel', update })
    await finish(s, 'r2')
    await s.sessions.send('chat', [{ type: 'text', text: 'Thanks' }])
    expect(s.sessions.kernelTurn('chat')).toBe(false)
    expect(users(s).at(-1)).not.toHaveProperty('from')
    await finish(s, 'r3')
    expect(turns).toEqual(['user', 'kernel', 'user'])
  })

  it("sends a Kernel update again as Kernel's, with its card, and leaves a pending hand-off alone", async () => {
    const s = await setup('acceptEdits', { agent: lead })
    init(s)
    await finish(s, 'r1')
    s.sessions.handoffs.approved('chat')
    s.sessions.post('chat', [{ type: 'text', text: HEADER }], { update })
    reply(s, 'a2', "Kai's PR #108 passed checks. Theo is reviewing it.")
    await finish(s, 'r2')
    const answer = s.store.items('chat').find((i: ChatItem) => i.kind === 'text')!
    // Idle, so the copy goes out at once and nothing waits.
    expect(await s.sessions.retry('chat', answer.id)).toBeUndefined()
    expect(users(s)).toHaveLength(3)
    expect(users(s).at(-1)).toMatchObject({ from: 'kernel', update })
    expect(s.sessions.handoffs.due('chat')).toBe(true)
  })

  it("treats an update saved before the marker as Kernel's when it is sent again", async () => {
    const s = await setup('acceptEdits', { agent: lead })
    init(s)
    await finish(s, 'r1')
    s.store.saveItem('chat', { kind: 'user', id: 'old', ts: 2, parts: [{ type: 'text', text: `${LEGACY_UPDATE_HEADER}\n- Kai · Inbox actions (workspace w2): PR #60 is ready to merge` }] })
    s.sessions.handoffs.approved('chat')
    // The id of the user message itself works too, as Retry now on the limit banner passes it.
    await s.sessions.retry('chat', 'old')
    expect(users(s).at(-1)).toMatchObject({ from: 'kernel' })
    expect(users(s).at(-1)?.id).not.toBe('old')
    expect(s.sessions.handoffs.due('chat')).toBe(true)
  })

  it("sends the user's own message again as the user's, which ends a pending hand-off", async () => {
    const s = await setup('acceptEdits', { agent: lead })
    init(s)
    reply(s, 'a1', 'Done.')
    await finish(s, 'r1')
    s.sessions.handoffs.approved('chat')
    await s.sessions.retry('chat', s.store.items('chat').find((i: ChatItem) => i.kind === 'text')!.id)
    expect(users(s).map((u) => u.from)).toEqual([undefined, undefined])
    expect(s.sessions.handoffs.due('chat')).toBe(false)
  })

  it('returns the copy that waits behind a running turn, so Retry now can send it first, and it keeps its marker and the hand-off as it drains', async () => {
    const s = await setup('acceptEdits', { agent: lead })
    init(s)
    await finish(s, 'r1')
    s.sessions.post('chat', [{ type: 'text', text: HEADER }], { update })
    expect(await s.sessions.send('chat', [{ type: 'text', text: 'later' }])).toEqual({ queued: true, why: 'running' })
    s.sessions.handoffs.approved('chat')
    const copy = await s.sessions.retry('chat', users(s).at(-1)!.id)
    expect(copy).toMatchObject({ from: 'kernel', update })
    await s.sessions.sendNow('chat', copy!.id)
    expect(s.call.interrupts).toBe(1)
    expect(s.sessions.handoffs.due('chat')).toBe(true)
    expect(s.sessions.queued('chat').map((q) => q.id)[0]).toBe(copy!.id)
    s.call.feed({ type: 'result', subtype: 'error_during_execution', uuid: 'r2', duration_ms: 10 })
    await flush()
    expect(users(s).at(-1)).toMatchObject({ from: 'kernel', update })
    expect(s.sessions.kernelTurn('chat')).toBe(true)
    expect(s.sessions.handoffs.due('chat')).toBe(true)
  })

  it('still ends a pending hand-off when the user stops the turn', async () => {
    const s = await setup('acceptEdits', { agent: lead })
    init(s)
    await finish(s, 'r1')
    s.sessions.post('chat', [{ type: 'text', text: HEADER }], { update })
    s.sessions.handoffs.approved('chat')
    await s.sessions.interrupt('chat')
    expect(s.sessions.handoffs.due('chat')).toBe(false)
  })

  it("says what a queued message waits for, and a brief held for setup stays the Lead's", async () => {
    const s = await setup()
    init(s)
    await finish(s, 'r1')
    s.sessions.hold('chat', [{ type: 'text', text: 'Build T-14 from the plan' }], { from: 'lead' })
    expect(await s.sessions.send('chat', [{ type: 'text', text: 'Use EmptyState' }], { from: 'lead' })).toEqual({ queued: true, why: 'setup' })
    expect(s.sessions.queued('chat').map((q) => q.from)).toEqual(['lead', 'lead'])
    s.sessions.release('chat')
    expect(users(s).at(-1)).toMatchObject({ from: 'lead', parts: [{ type: 'text', text: 'Build T-14 from the plan' }] })
    await finish(s, 'r2')
    expect(users(s).at(-1)).toMatchObject({ from: 'lead', parts: [{ type: 'text', text: 'Use EmptyState' }] })
    await finish(s, 'r3')
    s.sessions.pause('room')
    expect(await s.sessions.send('chat', [{ type: 'text', text: 'paused' }])).toEqual({ queued: true, why: 'paused' })
    s.sessions.holdAll('offline')
    expect(await s.sessions.send('chat', [{ type: 'text', text: 'offline' }])).toEqual({ queued: true, why: 'offline' })
  })

  it("marks Kernel's own nudges as Kernel's", async () => {
    const s = await setup()
    init(s)
    await finish(s, 'r1')
    // A chat a limit stopped carries on once nothing holds it.
    s.sessions.restore([], ['chat'])
    s.sessions.drainWaiting()
    expect(users(s).at(-1)).toMatchObject({ from: 'kernel', parts: [{ type: 'text', text: LIMIT_LIFTED }] })
    await finish(s, 'r2')
    await s.sessions.restart('chat')
    expect(users(s).at(-1)).toMatchObject({ from: 'kernel', parts: [{ type: 'text', text: RESTART_NUDGE }] })
  })

  it("counts a nudge's turn as the turn it picks up, not as one Kernel started (KERNEL-136)", async () => {
    const turns: TurnBy[] = []
    const s = await setup('acceptEdits', { onTurnDone: (_ws, _chat, t) => { turns.push(t.by) } })
    init(s)
    await finish(s, 'r1')
    // The user's turn, cut off by a limit, carries on as the user's.
    s.sessions.restore([], ['chat'])
    s.sessions.drainWaiting()
    expect(users(s).at(-1)).toMatchObject({ from: 'kernel', parts: [{ type: 'text', text: LIMIT_LIFTED }] })
    expect(s.sessions.kernelTurn('chat')).toBe(false)
    await finish(s, 'r2')
    // Rowan's message, then a restart after a crash: the restarted turn is still Rowan's.
    await s.sessions.send('chat', [{ type: 'text', text: 'Use EmptyState' }], { from: 'lead' })
    await finish(s, 'r3')
    await s.sessions.restart('chat')
    expect(s.sessions.turnFrom('chat')).toBe('lead')
    sdk.calls[sdk.calls.length - 1].feed({ type: 'result', subtype: 'success', uuid: 'r4', duration_ms: 10 })
    await flush()
    expect(turns).toEqual(['user', 'user', 'lead', 'lead'])
  })

  it('says when a message waiting for a chat whose session died started a new session at once', async () => {
    const exits: string[] = []
    const s = await setup('acceptEdits', { onExit: (_ws, _chat, _reason, midTurn, resumed) => { exits.push(`${midTurn}:${resumed}`) } })
    init(s)
    await flush()
    expect(await s.sessions.send('chat', [{ type: 'text', text: 'Also rename it' }])).toEqual({ queued: true, why: 'running' })
    s.call.end()
    await flush()
    expect(exits).toEqual(['true:true'])
    expect(users(s).at(-1)).toMatchObject({ parts: [{ type: 'text', text: 'Also rename it' }] })
    expect(s.sessions.isRunning('chat')).toBe(true)
  })

  it('lets go of messages held for setup when the workspace is archived (KERNEL-136)', async () => {
    const s = await setup()
    // A chat held for setup has no session yet.
    s.store.saveChat({ ...s.chat, id: 'held' })
    s.sessions.hold('held', [{ type: 'text', text: 'Build T-14' }], { from: 'lead' })
    // Stopping alone keeps the brief: an archive that fails still needs it for Run again.
    s.sessions.stopWorkspace('ws')
    expect(s.sessions.queued('held')).toHaveLength(1)
    s.sessions.dropHeld('ws')
    expect(s.sessions.queued('held')).toEqual([])
    // Restored, the chat no longer waits for a setup that will never run again.
    expect(await s.sessions.send('held', [{ type: 'text', text: 'Back again' }])).toEqual({ queued: false })
  })

  it('reports a session that ended on its own, mid-turn or idle, and not one that was stopped', async () => {
    const exits: string[] = []
    const s = await setup('acceptEdits', { onExit: (_ws, chat, reason, midTurn) => { exits.push(`${chat.id}:${reason}:${midTurn}`) } })
    init(s)
    await flush()
    s.call.end()
    await flush()
    expect(exits).toEqual(['chat::true'])
    await s.sessions.send('chat', [{ type: 'text', text: 'Carry on' }])
    await flush()
    s.sessions.stop('chat')
    await flush()
    expect(exits).toEqual(['chat::true'])
    await s.sessions.send('chat', [{ type: 'text', text: 'Once more' }])
    const idle = sdk.calls[sdk.calls.length - 1]
    idle.feed({ type: 'result', subtype: 'success', uuid: 'r9', duration_ms: 10 })
    await flush()
    idle.end()
    await flush()
    expect(exits).toEqual(['chat::true', 'chat::false'])
  })

  it("holds Kernel's posts to a chat whose session died mid-turn until the user sends or restarts (KERNEL-124)", async () => {
    const s = await setup()
    init(s)
    await flush()
    s.call.end()
    await flush()
    expect(s.sessions.post('chat', [{ type: 'text', text: HEADER }], { update })).toBe(false)
    await s.sessions.send('chat', [{ type: 'text', text: 'Try again' }])
    const next = sdk.calls[sdk.calls.length - 1]
    next.feed({ type: 'result', subtype: 'success', uuid: 'r2', duration_ms: 10 })
    await flush()
    expect(s.sessions.post('chat', [{ type: 'text', text: HEADER }], { update })).toBe(true)
    sdk.calls[sdk.calls.length - 1].end()
    await flush()
    expect(s.sessions.post('chat', [{ type: 'text', text: HEADER }], { update })).toBe(false)
    await s.sessions.restart('chat')
    sdk.calls[sdk.calls.length - 1].feed({ type: 'result', subtype: 'success', uuid: 'r3', duration_ms: 10 })
    await flush()
    expect(s.sessions.post('chat', [{ type: 'text', text: HEADER }], { update })).toBe(true)
    // The update kills the session again; the user retries it, which is still Kernel's message, and it succeeds.
    sdk.calls[sdk.calls.length - 1].end()
    await flush()
    expect(s.sessions.post('chat', [{ type: 'text', text: HEADER }], { update })).toBe(false)
    await s.sessions.retry('chat', users(s).at(-1)!.id)
    expect(users(s).at(-1)).toMatchObject({ from: 'kernel' })
    sdk.calls[sdk.calls.length - 1].feed({ type: 'result', subtype: 'success', uuid: 'r4', duration_ms: 10 })
    await flush()
    expect(s.sessions.post('chat', [{ type: 'text', text: HEADER }], { update })).toBe(true)
  })
})

describe('Agent rows name the subagent model (KERNEL-158)', () => {
  type Tool = ChatItem & { kind: 'tool' }
  const row = (store: Store, toolUseId: string) => store.items('chat').find((i): i is Tool => i.kind === 'tool' && i.toolUseId === toolUseId)
  const agent = (id: string, input: Record<string, unknown>) => ({ type: 'assistant', uuid: `a-${id}`, parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Agent', input: { prompt: 'Look around', ...input } }] } })
  const sub = (parent: string, model: string, n: number) => ({ type: 'assistant', uuid: `s-${parent}-${n}`, parent_tool_use_id: parent, message: { model, content: [{ type: 'tool_use', id: `in-${parent}-${n}`, name: 'Read', input: { file_path: 'README.md' } }] } })
  const result = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Found it' }] } })

  it('names the model from the call at once, and a subagent message never changes it', async () => {
    const { call, store } = await setup()
    call.feed(agent('ag1', { description: 'Explore engine for Linear plan', model: 'haiku' }))
    await flush()
    expect(row(store, 'ag1')).toMatchObject({ label: 'Agent · Haiku 4.5', detail: 'Explore engine for Linear plan', status: 'running' })
    call.feed(sub('ag1', 'claude-sonnet-5-5', 1))
    call.feed(result('ag1'))
    await flush()
    expect(row(store, 'ag1')).toMatchObject({ label: 'Agent · Haiku 4.5', detail: 'Explore engine for Linear plan', status: 'done' })
  })

  it("names the subagent's real model from its first message and keeps it on the saved done row", async () => {
    const { call, store, kinds } = await setup()
    call.feed(agent('ag2', { description: 'Explore design canvas and docs' }))
    await flush()
    expect(row(store, 'ag2')).toMatchObject({ label: 'Agent', detail: 'Explore design canvas and docs' })
    call.feed(sub('ag2', 'claude-sonnet-5-5', 1))
    call.feed(sub('ag2', 'claude-opus-5-5', 2))
    await flush()
    expect(row(store, 'ag2')).toMatchObject({ label: 'Agent · Sonnet 5.5', status: 'running' })
    call.feed(result('ag2'))
    await flush()
    expect(row(store, 'ag2')).toMatchObject({ label: 'Agent · Sonnet 5.5', detail: 'Explore design canvas and docs', status: 'done', output: 'Found it' })
    // The subagent's own steps stay inside the row.
    expect(kinds()).toEqual(['user', 'tool'])
  })

  it('names a subagent that answers after its row is done, keeps an unknown model id as it is, and reads the old Task name', async () => {
    const { call, store } = await setup()
    call.feed({ type: 'assistant', uuid: 'a-ag3', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'ag3', name: 'Task', input: { description: 'Check the logs', prompt: 'Go' } }] } })
    call.feed(result('ag3'))
    call.feed(sub('ag3', 'claude-mystery-9', 1))
    await flush()
    expect(row(store, 'ag3')).toMatchObject({ label: 'Task · claude-mystery-9', detail: 'Check the logs', status: 'done' })
  })

  it('leaves the row as Agent when no model is known', async () => {
    const { call, store } = await setup()
    call.feed(agent('ag4', { description: 'Stopped early' }))
    call.feed(result('ag4'))
    await flush()
    expect(row(store, 'ag4')).toMatchObject({ label: 'Agent', detail: 'Stopped early' })
  })

  it('leaves other tool rows as they were', async () => {
    const { call, store } = await setup()
    call.feed({ type: 'assistant', uuid: 'o1', parent_tool_use_id: null, message: { model: 'claude-sonnet-5-5', content: [
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pnpm test\necho done', description: 'Run tests', model: 'haiku' } },
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'src/main/db.ts' } },
      { type: 'tool_use', id: 'm1', name: 'mcp__kernel__say', input: { text: 'Hi', description: 'Greet' } }
    ] } })
    call.feed(sub('b1', 'claude-haiku-4-5-20251001', 1))
    await flush()
    expect(row(store, 'b1')).toMatchObject({ label: 'Run pnpm test', detail: 'pnpm test' })
    expect(row(store, 'r1')).toMatchObject({ label: 'Read', detail: 'src/main/db.ts' })
    expect(row(store, 'm1')).toMatchObject({ label: 'kernel · say', detail: '{"text":"Hi","description":"Greet"}' })
  })
})
