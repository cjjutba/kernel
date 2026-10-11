import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, symlink } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, ChatItem, TeamUpdate, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { CRASH_NOTE, freshNudge, isNudge, LIMIT_LIFTED, QUIT_NOTE, RELAUNCH_NUDGE, RESTART_NUDGE, SESSION_GONE_NOTE, Sessions, TOOL_STOPPED, type SessionDeps, type TurnBy } from '../src/main/services/sessions'
import { LEGACY_UPDATE_HEADER } from '../src/shared/teamUpdate'
import { HANDOFF_NOW, HANDOFF_REMINDER, LEAD_RULE } from '../src/main/services/handoff'
import type { AppSettings } from '../src/main/services/settings'

// The SDK is replaced by a scripted session: each query() records its options and yields whatever the test feeds it.
// After an abort it yields what was already fed, then throws, as the real one does. A `late` session keeps its stream
// open after the abort until the test ends it, as a real process does while it exits.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; prompt: AsyncIterable<any>; feed: (m: unknown) => void; end: () => void; fail: (e: Error) => void; interrupts: number; flags: unknown[]; late: boolean }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { abortController?: AbortController } }) => {
    const items: unknown[] = []
    const waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []
    const signal = options.abortController?.signal
    const aborted = () => new Error('Claude Code process aborted by user')
    signal?.addEventListener('abort', () => { if (!call.late) for (const w of waiters.splice(0)) w.reject(aborted()) })
    // end() is the process exiting on its own: the stream finishes once what was fed is read. fail() is the SDK
    // throwing instead, as after an error result.
    let ended = false
    let failed: Error | undefined
    const call = {
      options, prompt, interrupts: 0, flags: [] as unknown[], late: false,
      feed: (m: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: m, done: false }); else items.push(m) },
      end: () => { ended = true; for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true }) },
      fail: (e: Error) => { failed = e; for (const w of waiters.splice(0)) w.reject(e) }
    }
    sdk.calls.push(call)
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
          : signal?.aborted && !call.late ? Promise.reject(aborted()) : failed ? Promise.reject(failed) : ended ? Promise.resolve({ value: undefined, done: true })
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

type Call = (typeof sdk.calls)[number]

/** What the SDK gives a resume of a session Claude Code 2.1.292 has no transcript for: this error result, then a throw (KERNEL-286). */
function gone(call: Call, id: string) {
  const text = `No conversation found with session ID: ${id}`
  call.feed({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, duration_ms: 0, session_id: id, uuid: `gone-${id}`, errors: [text] })
  call.fail(new Error(`Claude Code returned an error result: ${text}`))
}

/** The text of the next message Kernel sent the session. */
async function nextSent(call: Call): Promise<string> {
  const { value } = await call.prompt[Symbol.asyncIterator]().next()
  return value.message.content[0].text
}

async function setup(mode = 'acceptEdits', hooks: { mcpFor?: (ws: Workspace, agent: unknown, chat: Chat) => Options['mcpServers']; disabledFor?: SessionDeps['disabledFor']; agent?: AgentDef; models?: Partial<AppSettings['models']>; onTurnDone?: SessionDeps['onTurnDone']; onExit?: SessionDeps['onExit'] } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-runner-')), 'kernel.db'))
  const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
  const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 }
  store.saveWorkspace(ws)
  store.saveChat(chat)
  const allow: string[] = []
  const approvals = new Approvals(store)
  const settings = { permissions: { mode, alwaysAsk: ['drizzle-kit push'], neverAllow: ['git push origin main'], protectedBranches: [], approvalTimeoutSec: 300 }, ...(hooks.models ? { models: hooks.models } : {}) } as unknown as AppSettings
  const sessions = new Sessions({
    store, approvals, settings: () => settings, agentFor: () => hooks.agent, mcpFor: (ws, agent, chat) => hooks.mcpFor?.(ws, agent, chat), disabledFor: hooks.disabledFor,
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

  it("starts the session without the room's switched-off skills and MCP servers, and never without Kernel's own server (KERNEL-226)", async () => {
    const kernel = { type: 'sdk', name: 'kernel', instance: {} } as never
    const { options } = await setup('acceptEdits', { mcpFor: () => ({ kernel }), disabledFor: () => ({ skills: ['impeccable', 'impeccable'], mcp: ['chrome-devtools', 'kernel'] }) })
    expect(options.mcpServers).toEqual({ kernel })
    expect(options.settings).toEqual({ skillOverrides: { impeccable: 'off' }, deniedMcpServers: [{ serverName: 'chrome-devtools' }] })
    // Everything else Claude Code finds still loads: plugin skills, claude.ai connectors, servers Settings doesn't list.
    expect(options).not.toHaveProperty('strictMcpConfig')
    expect(options).not.toHaveProperty('skills')
  })

  it("adds no settings when the room switched nothing off, and leaves the compact window to the model (context-window-follows-model)", async () => {
    const { options } = await setup('acceptEdits', { disabledFor: () => ({ skills: [], mcp: [] }) })
    expect(options).not.toHaveProperty('settings')
    expect(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  })

  it('leaves plan mode once the plan is approved, and tells the composer', async () => {
    const { options, approvals, store } = await setup()
    store.saveChat({ ...store.chat('chat')!, plan: true })
    const pushed: Chat[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'chat') pushed.push(e.chat) }
    bus.on('push', onPush)
    onTestFinished(() => { bus.off('push', onPush) })
    const answer = (options.canUseTool as CanUseTool)('ExitPlanMode', { plan: '1. Go' }, { signal: new AbortController().signal, toolUseID: 'p2', requestId: 'r3' })
    await flush()
    approvals.decide(store.approvals({ pendingOnly: true })[0].id, { behavior: 'allow' })
    await answer
    expect(store.chat('chat')?.plan).toBe(false)
    // Without it the box stays blue until the workspace reloads.
    expect(pushed.at(-1)).toMatchObject({ id: 'chat', plan: false })
  })

  const asked = {
    questions: [
      { question: 'Which store?', header: 'Store', options: [{ label: 'Postgres', description: 'The main database' }, { label: 'SQLite' }], multiSelect: false },
      { question: 'Which regions?', header: 'Regions', options: [{ label: 'EU' }, { label: 'US' }], multiSelect: true },
      { question: 'Ship it today?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }
    ]
  }
  const ask = (options: Options, id: string) => (options.canUseTool as CanUseTool)('AskUserQuestion', asked, { signal: new AbortController().signal, toolUseID: id, requestId: `r-${id}` })

  it('keeps every question of an AskUserQuestion call on one approval, titled with the first', async () => {
    const { options, store } = await setup('bypassInWorktrees')
    void ask(options, 'q1')
    await flush()
    const pending = store.approvals({ pendingOnly: true })
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ kind: 'question', title: 'Which store?', options: ['Postgres', 'SQLite'] })
    expect(pending[0].questions).toEqual([
      { question: 'Which store?', header: 'Store', options: [{ label: 'Postgres', description: 'The main database' }, { label: 'SQLite' }], multiSelect: false },
      { question: 'Which regions?', header: 'Regions', options: [{ label: 'EU' }, { label: 'US' }], multiSelect: true },
      { question: 'Ship it today?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }
    ])
  })

  it('sends each answer back in the tool input, and saves them on the approval', async () => {
    const { options, approvals, store } = await setup()
    const result = ask(options, 'q2')
    await flush()
    const id = store.approvals({ pendingOnly: true })[0].id
    const answers = { 'Which store?': 'Postgres', 'Which regions?': 'EU, US', 'Ship it today?': 'No' }
    approvals.decide(id, { behavior: 'answer', text: 'Postgres · EU, US · No', answers })
    expect(await result).toEqual({ behavior: 'allow', updatedInput: { ...asked, answers } })
    expect(store.approvals().find((a) => a.id === id)).toMatchObject({ status: 'answered', answer: 'Postgres · EU, US · No', answers })
  })

  it('tells the model a text-only answer to several questions covered only the first, so it asks the rest again', async () => {
    const { options, approvals, store } = await setup()
    const result = ask(options, 'q3')
    await flush()
    approvals.decide(store.approvals({ pendingOnly: true })[0].id, { behavior: 'answer', text: 'Use whatever is cheapest' })
    expect(await result).toEqual({ behavior: 'deny', message: 'The user saw and answered only your first question, "Which store?": Use whatever is cheapest. Ask the other 2 again.' })
  })

  it('treats an empty answers map as a text-only answer', async () => {
    const { options, approvals, store } = await setup()
    const result = ask(options, 'q4')
    await flush()
    approvals.decide(store.approvals({ pendingOnly: true })[0].id, { behavior: 'answer', text: 'Postgres', answers: {} })
    expect(await result).toMatchObject({ behavior: 'deny', message: expect.stringContaining('Ask the other 2 again.') })
  })

  it('gives a text-only answer to a lone question', async () => {
    const { options, approvals, store } = await setup()
    const one = { questions: [asked.questions[0]] }
    const result = (options.canUseTool as CanUseTool)('AskUserQuestion', one, { signal: new AbortController().signal, toolUseID: 'q5', requestId: 'r-q5' })
    await flush()
    approvals.decide(store.approvals({ pendingOnly: true })[0].id, { behavior: 'answer', text: 'Use whatever is cheapest' })
    expect(await result).toEqual({ behavior: 'allow', updatedInput: { ...one, answers: { 'Which store?': 'Use whatever is cheapest' } } })
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

describe("an agent file's tools line (KERNEL-397)", () => {
  const theo = { id: 'theo', name: 'Theo', role: 'Reviewer', description: 'Reviews.', lead: false, prompt: 'You review.', file: '/r/theo.md', tools: ['Read', 'Grep', 'Glob', 'Bash', 'mcp__linear__get_issue'] } as AgentDef
  const gateOf = (options: Options) => {
    const hooks = options.hooks!.PreToolUse!.filter((m) => !m.matcher).flatMap((m) => m.hooks)
    return hooks.length > 2 ? hooks[hooks.length - 1] as HookCallback : undefined
  }
  const use = (gate: HookCallback, tool: string) => gate({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: tool, session_id: 's', transcript_path: '', cwd: '/tmp/ws' } as never, tool, { signal: new AbortController().signal } as never)

  it('leaves out the built-in tools the file leaves out, and refuses any other tool it does not list', async () => {
    const { options } = await setup('acceptEdits', { agent: theo })
    expect(options.disallowedTools).toEqual(['Write', 'Edit', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent'])
    const gate = gateOf(options)!
    expect(await use(gate, 'mcp__linear__save_issue')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: "Your agent file doesn't list mcp__linear__save_issue. Use another tool, or ask the user to add mcp__linear__save_issue to the tools line in your agent file." } })
    expect(await use(gate, 'Write')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    for (const tool of ['Read', 'Bash', 'mcp__linear__get_issue', 'mcp__kernel__submit_review', 'ExitPlanMode', 'ToolSearch']) expect(await use(gate, tool), tool).toEqual({})
  })

  it('restricts nothing for an agent with no tools line', async () => {
    const { options } = await setup('acceptEdits', { agent: { ...theo, tools: undefined } })
    expect(options).not.toHaveProperty('disallowedTools')
    expect(gateOf(options)).toBeUndefined()
  })

  it('starts a changed agent fresh once its turn ends, and keeps the conversation', async () => {
    const { sessions, call, options, chat } = await setup('acceptEdits', { agent: theo })
    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none' })
    await flush()
    sessions.restartIdle(['ws'])
    // Busy: the process stays until the turn ends.
    expect(sessions.isRunning(chat.id)).toBe(true)
    const signal = (options.abortController as AbortController).signal
    expect(signal.aborted).toBe(false)
    call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 5 })
    await flush()
    expect(signal.aborted).toBe(true)
    await sessions.send(chat.id, [{ type: 'text', text: 'Again' }])
    expect(sdk.calls[sdk.calls.length - 1].options.resume).toBe(options.sessionId)
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

  it('names a subagent that answers after its row is done', async () => {
    const { call, store } = await setup()
    call.feed(agent('ag3', { description: 'Check the logs' }))
    call.feed(result('ag3'))
    call.feed(sub('ag3', 'claude-haiku-4-5-20251001', 1))
    await flush()
    expect(row(store, 'ag3')).toMatchObject({ label: 'Agent · Haiku 4.5', detail: 'Check the logs', status: 'done', output: 'Found it' })
  })

  it('keeps an unknown model id as it is, and reads the old Task name', async () => {
    const { call, store } = await setup()
    call.feed({ type: 'assistant', uuid: 'a-t1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: 'Check the logs', prompt: 'Go' } }] } })
    call.feed(sub('t1', 'claude-mystery-9', 1))
    await flush()
    expect(row(store, 't1')).toMatchObject({ label: 'Task · claude-mystery-9', detail: 'Check the logs' })
  })

  it("names a fork from its first message, since a fork ignores the call's model", async () => {
    const { call, store } = await setup()
    call.feed(agent('f1', { description: 'Try the other approach', subagent_type: 'fork', model: 'haiku' }))
    await flush()
    expect(row(store, 'f1')).toMatchObject({ label: 'Agent' })
    call.feed(sub('f1', 'claude-sonnet-5-5', 1))
    await flush()
    expect(row(store, 'f1')).toMatchObject({ label: 'Agent · Sonnet 5.5' })
  })

  it('leaves the row as Agent when no model is known', async () => {
    const { call, store } = await setup()
    call.feed(agent('ag4', { description: 'Stopped early' }))
    call.feed(sub('ag4', '<synthetic>', 1))
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

describe('Tool rows keep the full input and more output (KERNEL-197)', () => {
  type Tool = ChatItem & { kind: 'tool' }
  const row = (store: Store, toolUseId: string) => store.items('chat').find((i): i is Tool => i.kind === 'tool' && i.toolUseId === toolUseId)
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', uuid: `a-${id}`, parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } })
  const result = (id: string, content: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })

  it('keeps a multi-line Bash command whole, while the row still shows its first line', async () => {
    const { call, store } = await setup()
    const command = 'cd src\npnpm test\necho done'
    call.feed(use('b1', 'Bash', { command, description: 'Run tests' }))
    call.feed(result('b1', 'ok'))
    await flush()
    expect(row(store, 'b1')).toMatchObject({ detail: 'cd src', input: { command, description: 'Run tests' }, output: 'ok', status: 'done' })
    expect(row(store, 'b1')?.outputCut).toBeUndefined()
  })

  it("keeps an Edit's old and new text", async () => {
    const { call, store } = await setup()
    call.feed(use('e1', 'Edit', { file_path: 'src/a.ts', old_string: 'const a = 1\n', new_string: 'const a = 2\n', replace_all: false }))
    await flush()
    expect(row(store, 'e1')).toMatchObject({ detail: 'src/a.ts', input: { file_path: 'src/a.ts', old_string: 'const a = 1\n', new_string: 'const a = 2\n', replace_all: false } })
  })

  it('keeps 20,000 characters of output and says when it was cut', async () => {
    const { call, store } = await setup()
    call.feed(use('r1', 'Bash', { command: 'cat big.log' }))
    call.feed(result('r1', 'x'.repeat(25_000)))
    call.feed(use('r2', 'Bash', { command: 'cat exact.log' }))
    call.feed(result('r2', 'y'.repeat(20_000)))
    await flush()
    expect(row(store, 'r1')?.output).toHaveLength(20_000)
    expect(row(store, 'r1')?.outputCut).toBe(true)
    expect(row(store, 'r2')?.output).toHaveLength(20_000)
    expect(row(store, 'r2')?.outputCut).toBeUndefined()
  })

  it("clips a long Write content, nested strings too, and leaves the rest of the input alone", async () => {
    const { call, store } = await setup()
    call.feed(use('w1', 'Write', { file_path: 'big.txt', content: 'z'.repeat(30_000) }))
    call.feed(use('m1', 'MultiEdit', { file_path: 'b.ts', edits: [{ old_string: 'q'.repeat(21_000), new_string: 'r' }] }))
    await flush()
    const write = row(store, 'w1')!.input as { file_path: string; content: string }
    expect(write.file_path).toBe('big.txt')
    expect(write.content).toHaveLength(20_000)
    const multi = row(store, 'm1')!.input as { edits: { old_string: string; new_string: string }[] }
    expect(multi.edits[0].old_string).toHaveLength(20_000)
    expect(multi.edits[0].new_string).toBe('r')
  })
})

describe('Send now past the agent limit, and why a queue waits (KERNEL-271)', () => {
  const result = { type: 'result', subtype: 'success', is_error: false, uuid: 'r', duration_ms: 1, result: '', session_id: 's' }
  const text = (t: string) => [{ type: 'text' as const, text: t }]

  /** The limit at 1 and `chat` running. `other` is a second teammate's chat in the same room, idle. */
  async function busy() {
    const s = await setup('acceptEdits', { models: { agentLimit: 1 } })
    s.store.saveWorkspace({ id: 'ws2', roomId: 'room', name: 'pdf-export', branch: 'feat/pdf-export', baseRef: 'main', path: '/tmp/ws2', mode: 'worktree', agentId: 'kai', port: 4301, status: 'ready', prState: 'none', createdAt: 2 })
    s.store.saveChat({ ...s.chat, id: 'other', workspaceId: 'ws2', title: 'PDF export' })
    const why: Record<string, (string | undefined)[]> = {}
    const onPush = (e: PushEvent) => { if (e.type === 'chat.queue') (why[e.chatId] ??= []).push(e.why) }
    bus.on('push', onPush)
    return { ...s, why, done: () => bus.off('push', onPush) }
  }

  it('queues a second chat for a slot, and Send now starts it over the limit', async () => {
    const { sessions, call, why, done } = await busy()
    try {
      expect(await sessions.send('other', text('Export the invoice'))).toEqual({ queued: true, why: 'capacity' })
      expect(sessions.queueReason('other')).toBe('capacity')
      await flush()
      expect(why.other).toEqual(['capacity'])
      const before = sdk.calls.length
      expect(await sessions.sendNow('other', sessions.queued('other')[0].id)).toEqual([])
      expect(sessions.isRunning('other')).toBe(true)
      expect(sdk.calls).toHaveLength(before + 1)
      // The running chat goes on: Send now in one chat never stops another.
      expect(sessions.isRunning('chat')).toBe(true)
      expect(call.interrupts).toBe(0)
      expect(sessions.queueReason('other')).toBeUndefined()
      await flush()
      expect(why.other.at(-1)).toBeUndefined()
    } finally { done() }
  })

  it('tells the renderer when what a queue waits for changes', async () => {
    const { sessions, call, why, done } = await busy()
    try {
      await sessions.send('other', text('Export the invoice'))
      await sessions.send('chat', text('Then add a test'))
      await flush()
      expect(why.chat).toEqual(['running'])
      sessions.pause('room')
      await flush()
      expect(why.other.at(-1)).toBe('paused')
      expect(why.chat.at(-1)).toBe('running')
      sessions.holdAll('offline')
      await flush()
      expect(why.other.at(-1)).toBe('offline')
      sessions.releaseAll('offline')
      await flush()
      expect(why.other.at(-1)).toBe('paused')
      // The turn ends while the room is paused: the chat's own queue now waits for the pause, not the turn.
      call.feed(result)
      await flush()
      expect(sessions.isRunning('chat')).toBe(false)
      expect(why.chat.at(-1)).toBe('paused')
      // Resuming sends the chat's own message first, which takes the slot again.
      sessions.resume('room')
      expect(sessions.isRunning('chat')).toBe(true)
      await flush()
      expect(why.other.at(-1)).toBe('capacity')
      // The running turn ends and the slot frees: the second chat's message goes out.
      call.feed(result)
      await flush()
      expect(sessions.isRunning('other')).toBe(true)
      expect(sessions.queueReason('other')).toBeUndefined()
      expect(why.other.at(-1)).toBeUndefined()
    } finally { done() }
  })

  it('keeps a user pause: Send now waits for Resume', async () => {
    const { sessions, call, done } = await busy()
    try {
      call.feed(result)
      await flush()
      sessions.pause('room')
      await sessions.send('other', text('Export the invoice'))
      expect(sessions.queueReason('other')).toBe('paused')
      await sessions.sendNow('other', sessions.queued('other')[0].id)
      expect(sessions.isRunning('other')).toBe(false)
      expect(sessions.queued('other')).toHaveLength(1)
    } finally { done() }
  })
})

describe('agents that were working when Kernel quit or crashed (KERNEL-215)', () => {
  type Setup = Awaited<ReturnType<typeof setup>>
  const result = (uuid: string, subtype = 'success') => ({ type: 'result', subtype, uuid, duration_ms: 5 })
  const texts = (store: Store, chatId = 'chat') => store.items(chatId).flatMap((i) => (i.kind === 'user' ? [(i.parts[0] as { text: string }).text] : []))
  const notes = (store: Store, chatId = 'chat') => store.items(chatId).flatMap((i) => (i.kind === 'note' ? [i.text] : []))

  /** The chat mid-turn with a tool running and a message queued behind it, as when Cmd+Q or a crash comes. */
  async function midTurn(o: Parameters<typeof setup>[1] = {}) {
    const s = await setup('acceptEdits', o)
    s.call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
    s.call.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }] } })
    await flush()
    await s.sessions.send('chat', [{ type: 'text', text: 'Then add a test' }])
    return s
  }

  /** Kernel opening again on the same database: a new Sessions, what the last run left, and `restore`. */
  function relaunch(s: Setup, o: { clean?: boolean; agentLimit?: number; before?: (sessions: Sessions) => void; cutOff?: string[] | Record<string, 'limit' | 'quit'> } = {}) {
    const exits: { reason: string; midTurn: boolean; resumed: boolean }[] = []
    let cutOff: Record<string, string> = {}
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: o.agentLimit ?? 0 } } as unknown as AppSettings
    // As in Kernel: a sign-out a session reports holds every room until sign-in.
    const sessions: Sessions = new Sessions({
      store: s.store, approvals: new Approvals(s.store), settings: () => settings, agentFor: () => undefined, mcpFor: () => undefined,
      roomAllow: () => [], allowInRoom: () => {}, onExit: (_ws, _chat, reason, midTurn, resumed) => { exits.push({ reason, midTurn, resumed }) },
      onFailure: (failure) => { if (failure === 'auth') sessions.holdAll('auth') },
      onCutOff: (c) => { cutOff = c }
    })
    o.before?.(sessions)
    const calls = sdk.calls.length
    sessions.restore([], o.cutOff ?? {}, {}, { clean: o.clean })
    return { sessions, exits, started: () => sdk.calls.slice(calls), cutOff: () => cutOff }
  }

  it('saves the chats with a running turn at every turn start and end', async () => {
    const s = await setup()
    expect(s.store.meta('working')).toEqual(['chat'])
    s.call.feed(result('r1'))
    await flush()
    expect(s.store.meta('working')).toEqual([])
  })

  it('interrupts every running turn on quit, keeps the journal and the queue, and starts nothing new', async () => {
    const turns: TurnBy[] = []
    const s = await midTurn({ onTurnDone: (_ws, _chat, t) => { turns.push(t.by) } })
    const calls = sdk.calls.length
    const quit = s.sessions.shutdown(5_000)
    expect(s.call.interrupts).toBe(1)
    // The interrupted turn ends well inside the budget. It drops out of nothing and sends nothing.
    s.call.feed(result('r1', 'error_during_execution'))
    const t0 = Date.now()
    await quit
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(s.store.meta('working')).toEqual(['chat'])
    expect(s.store.meta<Record<string, { parts: { text: string }[] }[]>>('queues')?.chat.map((q) => q.parts[0].text)).toEqual(['Then add a test'])
    expect(s.sessions.queued('chat')).toHaveLength(1)
    expect(sdk.calls.length).toBe(calls)
    expect(s.options.abortController?.signal.aborted).toBe(true)
    expect(turns).toEqual([])
    expect(s.store.items('chat').some((i) => i.kind === 'interrupted')).toBe(false)
    // An interrupted Lead turn that messages a teammate on its way out: the message waits for the next launch.
    expect(await s.sessions.send('chat', [{ type: 'text', text: 'From the Lead' }], { from: 'lead' })).toEqual({ queued: true })
    expect(s.sessions.post('chat', [{ type: 'text', text: 'Team update' }])).toBe(false)
  })

  it('ends a turn that ignores the interrupt once the budget runs out', async () => {
    const s = await midTurn()
    await s.sessions.shutdown(50)
    expect(s.options.abortController?.signal.aborted).toBe(true)
    expect(s.store.meta('working')).toEqual(['chat'])
  })

  it("saves a tool the quit's interrupt cut off as stopped by the quit, not with Claude Code's rejection (KERNEL-396)", async () => {
    const s = await midTurn()
    const quit = s.sessions.shutdown(5_000)
    // What Claude Code answers the running Bash call with when it gets the interrupt.
    const rejected = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
    s.call.feed({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: rejected }] } })
    s.call.feed(result('r1', 'error_during_execution'))
    await quit
    expect(s.store.items('chat').find((i) => i.kind === 'tool')).toMatchObject({ status: 'failed', output: TOOL_STOPPED })
    relaunch(s, { clean: true })
    expect(s.store.items('chat').find((i) => i.kind === 'tool')).toMatchObject({ status: 'failed', output: TOOL_STOPPED })
  })

  it('leaves the store alone once the quit ended a process, however late its stream ends (KERNEL-396)', async () => {
    const s = await midTurn()
    s.call.late = true
    const rejections: unknown[] = []
    const onRejection = (e: unknown) => { rejections.push(e) }
    process.on('unhandledRejection', onRejection)
    onTestFinished(() => { process.off('unhandledRejection', onRejection) })
    await s.sessions.shutdown(0)
    // Kernel closes the database right after the quit, while the process is still exiting.
    s.store.db.close()
    // Lines it had already written, then the SDK's throw once the process is gone.
    s.call.feed({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Interrupted' }] } })
    s.call.feed(result('r1', 'error_during_execution'))
    s.call.fail(new Error('Claude Code process aborted by user'))
    await flush()
    expect(rejections).toEqual([])
  })

  it('carries on after a quit: stuck tool rows fail, the note says Kernel quit, and what was queued goes before the nudge', async () => {
    const s = await midTurn()
    await s.sessions.shutdown(0)
    const next = relaunch(s, { clean: true })
    expect(s.store.items('chat').find((i) => i.kind === 'tool')).toMatchObject({ status: 'failed', output: TOOL_STOPPED })
    expect(notes(s.store)).toEqual([QUIT_NOTE])
    expect(next.exits).toEqual([{ reason: 'Kernel quit', midTurn: true, resumed: true }])
    // It resumes the same conversation, with the queued message first and the nudge after it.
    expect(next.sessions.isRunning('chat')).toBe(true)
    expect(next.started()[0].options.resume).toBe('session-1')
    expect(texts(s.store).at(-1)).toBe('Then add a test')
    expect(next.sessions.queued('chat').map((q) => [q.parts[0].type === 'text' && q.parts[0].text, q.from])).toEqual([[RELAUNCH_NUDGE, 'kernel']])
    next.started()[0].feed(result('r2'))
    await flush()
    expect(texts(s.store).at(-1)).toBe(RELAUNCH_NUDGE)
    expect(isNudge([{ type: 'text', text: RELAUNCH_NUDGE }])).toBe(true)
    // The nudge's turn is the user's turn it carries on, and it ends the journal entry like any other.
    expect(next.sessions.turnFrom('chat')).toBeUndefined()
    next.started()[0].feed(result('r3'))
    await flush()
    expect(s.store.meta('working')).toEqual([])
    expect(s.store.meta('cutOff')).toBeUndefined()
  })

  it('says Kernel closed unexpectedly after a crash, and sends the nudge at once when nothing was queued', async () => {
    const s = await setup()
    s.call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
    await flush()
    // A crash, a force quit or a power cut: no shutdown ran, and the journal is what the last turn start wrote.
    const next = relaunch(s)
    expect(notes(s.store)).toEqual([CRASH_NOTE])
    expect(next.exits[0]).toMatchObject({ reason: 'Kernel closed unexpectedly', resumed: true })
    expect(next.sessions.isRunning('chat')).toBe(true)
    expect(s.store.items('chat').filter((i) => i.kind === 'user').at(-1)).toMatchObject({ from: 'kernel', parts: [{ type: 'text', text: RELAUNCH_NUDGE }] })
  })

  it('adds one nudge however many times Kernel quits before it goes', async () => {
    const s = await midTurn()
    await s.sessions.shutdown(0)
    relaunch(s, { before: (sessions) => sessions.pause('room') }).sessions.shutdown(0)
    const third = relaunch(s, { clean: true, before: (sessions) => sessions.pause('room') })
    expect(third.sessions.queued('chat').map((q) => q.parts[0].type === 'text' && q.parts[0].text)).toEqual(['Then add a test', RELAUNCH_NUDGE])
  })

  it('waits for Resume in a paused room, for the connection when offline, and for a slot at the agent limit', async () => {
    const s = await midTurn()
    s.store.saveWorkspace({ ...s.store.workspace('ws')!, id: 'ws2', name: 'invoice-export', path: '/tmp/ws2' })
    s.store.saveChat({ ...s.chat, id: 'other', workspaceId: 'ws2' })
    await s.sessions.shutdown(0)

    const paused = relaunch(s, { before: (sessions) => sessions.pause('room') })
    expect(paused.sessions.isRunning('chat')).toBe(false)
    expect(paused.started()).toHaveLength(0)
    paused.sessions.resume('room')
    expect(paused.sessions.isRunning('chat')).toBe(true)
    await paused.sessions.shutdown(0)

    const offline = relaunch(s, { before: (sessions) => sessions.holdAll('offline') })
    expect(offline.sessions.isRunning('chat')).toBe(false)
    offline.sessions.releaseAll('offline')
    expect(offline.sessions.isRunning('chat')).toBe(true)
    await offline.sessions.shutdown(0)

    // Both were working, and the limit is one: the first takes the slot and the second waits for it to free.
    s.store.saveMeta('working', ['other', 'chat'])
    const full = relaunch(s, { agentLimit: 1 })
    expect(full.sessions.isRunning('other')).toBe(true)
    expect(full.sessions.isRunning('chat')).toBe(false)
    sdk.calls.at(-1)!.feed(result('r-other'))
    await flush()
    expect(full.sessions.isRunning('chat')).toBe(true)
  })

  it('puts a carry-on that failed on a sign-out back to wait, and carries it on again after sign-in', async () => {
    const s = await setup()
    s.call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
    await flush()
    const next = relaunch(s)
    // The nudge goes out and meets a sign-out, which holds every room.
    const call = next.started()[0]
    call.feed({ type: 'assistant', uuid: 'a2', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [] } })
    call.feed(result('r2', 'error_during_execution'))
    await flush()
    expect(next.sessions.heldFor()).toEqual(['auth'])
    expect(next.sessions.isRunning('chat')).toBe(false)
    expect(next.cutOff()).toEqual({ chat: 'quit' })
    // Signed in again: it carries on with a new nudge.
    next.sessions.releaseAll('auth')
    expect(next.sessions.isRunning('chat')).toBe(true)
    expect(texts(s.store).filter((t) => t === RELAUNCH_NUDGE)).toHaveLength(2)
  })

  it('leaves a failed carry-on stopped when nothing holds the rooms, so it cannot loop', async () => {
    const s = await setup()
    s.call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
    await flush()
    const next = relaunch(s)
    const call = next.started()[0]
    // A connection error with the network check saying online: no hold comes, so nothing would lift one.
    call.feed({ type: 'system', subtype: 'api_retry', attempt: 10, max_retries: 10, retry_delay_ms: 1, error: 'connection_error', error_status: null })
    call.feed(result('r2', 'error_during_execution'))
    await flush()
    expect(next.sessions.isRunning('chat')).toBe(false)
    expect(next.cutOff()).toEqual({})
  })

  it('respects a Stop pressed just before the quit: the queue goes and the chat does not carry on', async () => {
    const s = await midTurn()
    // The Stop's interrupt is on its way when Cmd+Q comes.
    const stop = s.sessions.interrupt('chat')
    const quit = s.sessions.shutdown(5_000)
    expect(s.call.interrupts).toBe(1)
    s.call.feed(result('r1', 'error_during_execution'))
    await stop
    await quit
    expect(s.store.meta('working')).toEqual([])
    expect(s.store.meta('queues')).toEqual({})
    const next = relaunch(s)
    expect(next.sessions.isRunning('chat')).toBe(false)
    expect(notes(s.store)).toEqual([])
  })

  it('holds only the chats that carry on during the launch check: other sends and queues go at once', async () => {
    const s = await midTurn()
    s.store.saveWorkspace({ ...s.store.workspace('ws')!, id: 'ws2', name: 'invoice-export', path: '/tmp/ws2' })
    s.store.saveChat({ ...s.chat, id: 'other', workspaceId: 'ws2' })
    s.store.saveChat({ ...s.chat, id: 'third', workspaceId: 'ws2' })
    await s.sessions.shutdown(0)
    // A message that waited for a free slot in another chat before the quit.
    s.store.saveMeta('queues', { ...s.store.meta<Record<string, unknown>>('queues'), third: [{ id: 'q3', chatId: 'third', parts: [{ type: 'text', text: 'Export the CSV' }], ts: 1 }] })
    const next = relaunch(s, { before: (sessions) => sessions.holdCarryOn() })
    expect(next.sessions.heldFor()).toEqual([])
    expect(next.sessions.isRunning('third')).toBe(true)
    expect(next.sessions.isRunning('chat')).toBe(false)
    expect(next.sessions.queued('chat').map((q) => q.parts[0].type === 'text' && q.parts[0].text)).toEqual(['Then add a test', RELAUNCH_NUDGE])
    expect(await next.sessions.send('other', [{ type: 'text', text: 'Export it' }])).toEqual({ queued: false })
    expect(next.sessions.isRunning('other')).toBe(true)
    // A turn ending elsewhere drains queues, but not the chat that waits for the check.
    next.started().find((c) => c.options.cwd === '/tmp/ws2')!.feed(result('r-other'))
    await flush()
    expect(next.sessions.isRunning('chat')).toBe(false)
    next.sessions.releaseCarryOn()
    expect(next.sessions.isRunning('chat')).toBe(true)
    expect(texts(s.store).at(-1)).toBe('Then add a test')
  })

  it("keeps Kernel's own updates out of a chat that waits for the launch check, so it still gets the nudge", async () => {
    const s = await setup()
    s.call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
    await flush()
    const next = relaunch(s, { before: (sessions) => sessions.holdCarryOn() })
    // The Lead's update batch fires while the checks still run: refused, like any held message, and the chat stays cut off.
    expect(next.sessions.post('chat', [{ type: 'text', text: 'Team update from Kernel' }])).toBe(false)
    expect(next.sessions.isRunning('chat')).toBe(false)
    expect(next.cutOff()).toEqual({ chat: 'quit' })
    next.sessions.releaseCarryOn()
    expect(texts(s.store).at(-1)).toBe(RELAUNCH_NUDGE)
  })

  it('leaves a closed chat and an archived workspace alone', async () => {
    const s = await midTurn()
    await s.sessions.shutdown(0)
    s.store.saveChat({ ...s.store.chat('chat')!, closed: true })
    const closed = relaunch(s)
    expect(closed.sessions.isRunning('chat')).toBe(false)
    expect(closed.sessions.queued('chat')).toEqual([])
    expect(notes(s.store)).toEqual([])
    expect(s.store.meta('working')).toEqual([])
  })

  it('still reads cut-off chats saved as a list before KERNEL-215 as stopped by a limit', async () => {
    const s = await setup()
    s.call.feed(result('r1'))
    await flush()
    const next = relaunch(s, { cutOff: ['chat'] })
    expect(texts(s.store).at(-1)).toBe(LIMIT_LIFTED)
    expect(next.sessions.isRunning('chat')).toBe(true)
  })

  it('starts a fresh session for a chat that carries on and finds its session gone, keeping its queue and carry-on (KERNEL-286)', async () => {
    const s = await midTurn()
    await s.sessions.shutdown(0)
    const next = relaunch(s, { clean: true })
    const resumed = next.started()[0]
    expect(resumed.options.resume).toBe('session-1')
    gone(resumed, 'session-1')
    await flush()
    const fresh = next.started()[1]
    expect(fresh.options.resume).toBeUndefined()
    expect(await nextSent(fresh)).toBe('Then add a test')
    expect(notes(s.store)).toEqual([QUIT_NOTE, SESSION_GONE_NOTE])
    // Still a teammate carrying on: nothing more than the launch's report, the journal stands and the nudge still waits.
    expect(next.exits).toEqual([{ reason: 'Kernel quit', midTurn: true, resumed: true }])
    expect(next.sessions.isRunning('chat')).toBe(true)
    expect(s.store.meta('working')).toEqual(['chat'])
    // The nudge that waits no longer tells an agent with no memory to pick up where it left off.
    const nudge = freshNudge('Add a pdf_url column')
    expect(next.sessions.queued('chat').map((q) => [q.parts[0].type === 'text' && q.parts[0].text, q.from])).toEqual([[nudge, 'kernel']])
    // The fresh session meets a sign-out: the chat waits to carry on, nudge and all, as the resumed one would have.
    fresh.feed({ type: 'assistant', uuid: 'a2', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [] } })
    fresh.feed(result('r2', 'error_during_execution'))
    await flush()
    expect(next.cutOff()).toEqual({ chat: 'quit' })
    expect(next.sessions.queued('chat')).toHaveLength(1)
    next.sessions.releaseAll('auth')
    expect(next.sessions.isRunning('chat')).toBe(true)
    expect(await nextSent(fresh)).toBe(nudge)
    expect(texts(s.store)).not.toContain(RELAUNCH_NUDGE)
  })

  it('leaves a session found gone while Kernel quits to the next launch (KERNEL-286)', async () => {
    const s = await midTurn()
    await s.sessions.shutdown(0)
    const next = relaunch(s, { clean: true })
    const quit = next.sessions.shutdown(5_000)
    gone(next.started()[0], 'session-1')
    await quit
    expect(next.started()).toHaveLength(1)
    expect(s.store.chat('chat')?.sessionId).toBe('session-1')
    expect(s.store.meta('working')).toEqual(['chat'])
    const third = relaunch(s, { clean: true })
    gone(third.started()[0], 'session-1')
    await flush()
    expect(third.started()[1].options.resume).toBeUndefined()
    expect(third.sessions.isRunning('chat')).toBe(true)
    expect(notes(s.store).at(-1)).toBe(SESSION_GONE_NOTE)
  })

  it('records the pid of every Claude Code process it starts, and ends ones a crash left behind', async () => {
    const s = await setup()
    // A stand-in for the claude binary that the test can name: sleep, through a link (macOS kills a copied system binary).
    const dir = await mkdtemp(join(tmpdir(), 'kernel-pids-'))
    const claude = join(dir, 'claude')
    await symlink('/bin/sleep', claude)
    const abort = new AbortController()
    const proc = s.options.spawnClaudeCodeProcess!({ command: claude, args: ['30'], env: process.env, signal: abort.signal })
    // The SDK listens for the abort error on a real session.
    proc.on('error', () => undefined)
    const pid = (proc as unknown as { pid: number }).pid
    expect(s.store.meta('claudePids')).toEqual([{ pid, command: claude, arg: '30' }])
    const exited = new Promise((r) => proc.once('exit', r))
    abort.abort()
    await exited
    expect(s.store.meta('claudePids')).toEqual([])

    // What a crash leaves: a claude process from the last run, and pids now used by other programs, one of them the
    // same binary started another way (as `node other.js` would be next to `node cli.js`).
    const left = spawn(claude, ['30'], { stdio: 'ignore' })
    const other = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    const sameBinary = spawn(claude, ['31'], { stdio: 'ignore' })
    try {
      s.store.saveMeta('claudePids', [{ pid: left.pid, command: claude, arg: '30' }, { pid: other.pid, command: claude, arg: '30' }, { pid: sameBinary.pid, command: claude, arg: '3' }])
      const gone = new Promise((r) => left.once('exit', (_code, sig) => r(sig)))
      expect(await s.sessions.endLeftovers()).toEqual([left.pid])
      expect(await gone).toBe('SIGTERM')
      expect(other.exitCode).toBeNull()
      expect(sameBinary.exitCode).toBeNull()
      expect(s.store.meta('claudePids')).toEqual([])
    } finally { left.kill('SIGKILL'); other.kill('SIGKILL'); sameBinary.kill('SIGKILL') }
  })
})

describe('a terminal that ends Kernel (KERNEL-340)', () => {
  it("starts each Claude Code process in a process group of its own, out of reach of the terminal's Ctrl+C", async () => {
    const s = await setup()
    const abort = new AbortController()
    const proc = s.options.spawnClaudeCodeProcess!({ command: '/bin/sleep', args: ['30'], env: process.env, signal: abort.signal })
    proc.on('error', () => undefined)
    const pid = (proc as unknown as { pid: number }).pid
    const group = (p: number) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(p)], { encoding: 'utf8' }).trim())
    try {
      expect(group(pid)).toBe(pid)
      expect(group(pid)).not.toBe(group(process.pid))
    } finally {
      const exited = new Promise((r) => proc.once('exit', r))
      abort.abort()
      await exited
    }
  })
})

describe('a chat whose Claude Code session is gone (KERNEL-286)', () => {
  const texts = (store: Store, kind: 'user' | 'note') => store.items('old').flatMap((i) => (i.kind === 'user' && kind === 'user' ? [(i.parts[0] as { text: string }).text] : i.kind === 'note' && kind === 'note' ? [i.text] : []))

  /** A teammate's chat whose saved session Claude Code no longer has, with the Lead's message going out and one queued behind it. */
  async function lost() {
    const turns: string[] = []
    const exits: string[] = []
    const s = await setup('acceptEdits', { onTurnDone: (_ws, c, t) => { turns.push(`${c.id}:${t.ok}:${t.by}`) }, onExit: (_ws, c, _reason, midTurn) => { exits.push(`${c.id}:${midTurn}`) } })
    s.store.saveChat({ ...s.chat, id: 'old', sessionId: 'gone-1', model: 'claude-opus-5-5', effort: 'high', plan: true })
    const running: boolean[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'chat.running' && e.chatId === 'old') running.push(e.running) }
    bus.on('push', onPush)
    await s.sessions.send('old', [{ type: 'text', text: 'Build T-14' }], { from: 'lead' })
    const first = sdk.calls.at(-1)!
    expect(await s.sessions.send('old', [{ type: 'text', text: 'Then add a test' }], { from: 'lead' })).toEqual({ queued: true, why: 'running' })
    return { ...s, first, turns, exits, running, done: () => bus.off('push', onPush) }
  }

  it('starts a fresh session with the same model, effort and plan mode, sends the same message, then the queue, and adds a note', async () => {
    const s = await lost()
    expect(s.first.options.resume).toBe('gone-1')
    gone(s.first, 'gone-1')
    await flush()
    const fresh = sdk.calls.at(-1)!
    expect(fresh).not.toBe(s.first)
    expect(fresh.options).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', permissionMode: 'plan', sessionId: expect.any(String) })
    expect(fresh.options.resume).toBeUndefined()
    expect(s.store.chat('old')?.sessionId).toBeUndefined()
    expect(await nextSent(fresh)).toBe('Build T-14')
    // The message shows once and the note follows it. The old session's error shows nowhere and reaches no one.
    expect(s.store.items('old').map((i) => i.kind)).toEqual(['user', 'note'])
    expect(texts(s.store, 'note')).toEqual([SESSION_GONE_NOTE])
    expect(s.turns).toEqual([])
    expect(s.exits).toEqual([])
    // The turn never stopped: no running flicker, the journal keeps the chat, and it is still the Lead's turn.
    expect(s.sessions.isRunning('old')).toBe(true)
    expect(s.running).not.toContain(false)
    expect(s.store.meta<string[]>('working')).toContain('old')
    expect(s.sessions.turnFrom('old')).toBe('lead')
    // The fresh session answers, keeps its own id, and the queued message goes next in the same process.
    fresh.feed({ type: 'system', subtype: 'init', session_id: 'session-2', apiKeySource: 'none' })
    fresh.feed({ type: 'result', subtype: 'success', uuid: 'r2', duration_ms: 5 })
    await flush()
    expect(s.store.chat('old')?.sessionId).toBe('session-2')
    expect(s.turns).toEqual(['old:true:lead'])
    expect(sdk.calls.at(-1)).toBe(fresh)
    expect(await nextSent(fresh)).toBe('Then add a test')
    expect(texts(s.store, 'user')).toEqual(['Build T-14', 'Then add a test'])
    s.done()
  })

  it('does the same for Restart session', async () => {
    const s = await setup()
    s.call.feed({ type: 'system', subtype: 'init', session_id: 'session-1', apiKeySource: 'none' })
    await flush()
    s.call.end()
    await flush()
    await s.sessions.restart('chat')
    const resumed = sdk.calls.at(-1)!
    expect(resumed.options.resume).toBe('session-1')
    gone(resumed, 'session-1')
    await flush()
    const fresh = sdk.calls.at(-1)!
    expect(fresh.options.resume).toBeUndefined()
    // Not "pick up where you left off": the fresh session hears what it lost, the chat's brief and where to look.
    const nudge = freshNudge('Add a pdf_url column')
    expect(await nextSent(fresh)).toBe(nudge)
    expect(nudge).toContain('The chat started with this message:\n\nAdd a pdf_url column')
    expect(nudge).toContain('git status, git log and any open PR')
    expect(freshNudge()).not.toContain('The chat started')
    // The transcript shows what the agent got, once, in the restart nudge's place, and it still counts as a nudge.
    const rows = s.store.items('chat').filter((i) => i.kind === 'user' || i.kind === 'note').map((i) => (i.kind === 'note' ? i.text : (i.parts[0] as { text: string }).text))
    expect(rows).toEqual(['Add a pdf_url column', nudge, SESSION_GONE_NOTE])
    expect(isNudge([{ type: 'text', text: nudge }])).toBe(true)
    expect(s.sessions.isRunning('chat')).toBe(true)
  })

  it('ends the turn after a Stop pressed before the gone session answered: no fresh session, and the queue goes', async () => {
    const s = await lost()
    await s.sessions.interrupt('old')
    gone(s.first, 'gone-1')
    await flush()
    expect(sdk.calls.at(-1)).toBe(s.first)
    expect(s.sessions.isRunning('old')).toBe(false)
    expect(s.sessions.queued('old')).toEqual([])
    expect(s.store.items('old').map((i) => i.kind)).toEqual(['user', 'interrupted', 'note'])
    expect(s.turns).toEqual(['old:false:lead'])
    expect(s.exits).toEqual([])
    // The id is forgotten all the same, so the next message starts a fresh session.
    expect(s.store.chat('old')?.sessionId).toBeUndefined()
    await s.sessions.send('old', [{ type: 'text', text: 'Start over' }])
    expect(sdk.calls.at(-1)!.options.resume).toBeUndefined()
    s.done()
  })

  it('sends only the picked message after a Send now pressed before the gone session answered', async () => {
    const s = await lost()
    const picked = s.sessions.queued('old')[0]
    await s.sessions.sendNow('old', picked.id)
    gone(s.first, 'gone-1')
    await flush()
    const fresh = sdk.calls.at(-1)!
    expect(fresh).not.toBe(s.first)
    expect(fresh.options.resume).toBeUndefined()
    expect(await nextSent(fresh)).toBe('Then add a test')
    expect(s.sessions.isRunning('old')).toBe(true)
    expect(s.sessions.queued('old')).toEqual([])
    expect(texts(s.store, 'user')).toEqual(['Build T-14', 'Then add a test'])
    expect(texts(s.store, 'note')).toEqual([SESSION_GONE_NOTE])
    s.done()
  })

  it('renews only on the gone text, for the id it resumed, before init', async () => {
    const cases: [string, (call: Call) => void][] = [
      ['after init', (call) => { call.feed({ type: 'system', subtype: 'init', session_id: 'gone-1', apiKeySource: 'none' }); gone(call, 'gone-1') }],
      ['another error before init', (call) => {
        call.feed({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, duration_ms: 0, uuid: 'other', errors: ['The working directory was deleted'] })
        call.fail(new Error('Claude Code returned an error result: The working directory was deleted'))
      }],
      ['another id', (call) => gone(call, 'someone-else')]
    ]
    for (const [name, answer] of cases) {
      const s = await lost()
      answer(s.first)
      await flush()
      expect(sdk.calls.at(-1), name).toBe(s.first)
      expect(texts(s.store, 'note'), name).not.toContain(SESSION_GONE_NOTE)
      expect(s.store.chat('old')?.sessionId, name).toBe('gone-1')
      expect(s.store.items('old').some((i) => i.kind === 'result' && !i.ok), name).toBe(true)
      s.done()
    }
  })

  it("moves a team update to a Lead chat whose session is gone, and it stays Kernel's turn", async () => {
    const lead: AgentDef = { id: 'rowan', file: '.claude/agents/rowan.md', name: 'Rowan', role: 'Lead', description: 'Plans', lead: true, prompt: 'You are Rowan.' }
    const update: TeamUpdate = { rows: [{ workspaceId: 'w1', agentId: 'kai', name: 'Kai', task: 'Remove the Try section', prNumber: 108, events: [{ kind: 'pr.ready', text: 'Passed checks, no conflicts. Not reviewed yet', actionable: true }] }] }
    const s = await setup('acceptEdits', { agent: lead })
    s.store.saveChat({ ...s.chat, id: 'old', sessionId: 'gone-1' })
    expect(s.sessions.post('old', [{ type: 'text', text: 'Team update from Kernel, not from the user.' }], { update })).toBe(true)
    gone(sdk.calls.at(-1)!, 'gone-1')
    await flush()
    const fresh = sdk.calls.at(-1)!
    expect(fresh.options.resume).toBeUndefined()
    expect(await nextSent(fresh)).toBe('Team update from Kernel, not from the user.')
    expect(s.sessions.turnFrom('old')).toBe('kernel')
    const users = s.store.items('old').filter((i) => i.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ from: 'kernel', update })
  })

  it("shows a fresh session's own failure once, starts nothing more, and wakes the Lead", async () => {
    const s = await lost()
    gone(s.first, 'gone-1')
    await flush()
    const fresh = sdk.calls.at(-1)!
    const calls = sdk.calls.length
    fresh.feed({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, duration_ms: 0, uuid: 'r2', errors: ['cwd_unavailable'] })
    fresh.fail(new Error('Claude Code returned an error result: cwd_unavailable'))
    await flush()
    expect(sdk.calls.length).toBe(calls)
    expect(s.sessions.isRunning('old')).toBe(false)
    expect(texts(s.store, 'note')).toEqual([SESSION_GONE_NOTE, 'Session stopped: Claude Code returned an error result: cwd_unavailable'])
    // A turn the Lead started ended with an error and the session died mid-turn, which is what wakes the Lead.
    expect(s.turns).toEqual(['old:false:lead'])
    expect(s.exits).toEqual(['old:true'])
    s.done()
  })

  it('gives a chat one fresh session until a turn there ends well, so a broken setup cannot loop', async () => {
    const s = await lost()
    gone(s.first, 'gone-1')
    await flush()
    const fresh = sdk.calls.at(-1)!
    fresh.feed({ type: 'system', subtype: 'init', session_id: 'session-2', apiKeySource: 'none' })
    fresh.feed({ type: 'result', subtype: 'error_during_execution', uuid: 'r2', duration_ms: 5, errors: ['API Error: 500'] })
    await flush()
    s.sessions.stop('old')
    // The fresh session never finished a turn, and its conversation is gone as well: the error shows and nothing new starts.
    await s.sessions.send('old', [{ type: 'text', text: 'Try again' }])
    const again = sdk.calls.at(-1)!
    expect(again.options.resume).toBe('session-2')
    gone(again, 'session-2')
    await flush()
    expect(sdk.calls.at(-1)).toBe(again)
    expect(s.sessions.isRunning('old')).toBe(false)
    expect(texts(s.store, 'note')).toEqual([SESSION_GONE_NOTE, 'Session stopped: Claude Code returned an error result: No conversation found with session ID: session-2'])
    // The id is forgotten all the same, so the next send starts a new session instead of failing again.
    expect(s.store.chat('old')?.sessionId).toBeUndefined()
    await s.sessions.send('old', [{ type: 'text', text: 'Once more' }])
    expect(sdk.calls.at(-1)!.options.resume).toBeUndefined()
    s.done()
  })
})
