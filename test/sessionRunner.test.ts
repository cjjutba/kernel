import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readdir, readFile, symlink } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, ChatItem, ChatPart, Decision, OpenItem, Room, TeamUpdate, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { askReason, awaitDecision, HOLD_TIMEOUT_SEC, HOOK_ASK_MS, muteShadowedWarning, ROOM_TOOLS, SHADOWED_WARNING, type ClaudeRunner } from '../src/main/services/providers/claude'
import { ALWAYS_ASK, NETWORK_OFF, neverAllowed, pushOwnBranch } from '../src/main/services/permissions'
import type { Ask } from '../src/main/services/providers/types'
import { CRASH_NOTE, freshNudge, isNudge, LIMIT_LIFTED, QUIT_NOTE, RELAUNCH_NUDGE, RESTART_NUDGE, SESSION_GONE_NOTE, Sessions, TOOL_STOPPED, type SessionDeps, type TurnBy } from '../src/main/services/sessions'
import { LEGACY_UPDATE_HEADER } from '../src/shared/teamUpdate'
import { HANDOFF_NOW, HANDOFF_REMINDER, LEAD_RULE } from '../src/main/services/handoff'
import { OpenItems, openReminder } from '../src/main/features/openItems'
import type { Kernel } from '../src/main/kernel'
import type { AppSettings } from '../src/main/services/settings'
import { run } from '../src/main/services/exec'
import { tempRepo } from './helpers'

// The SDK is replaced by a scripted session: each query() records its options and yields whatever the test feeds it.
// After an abort it yields what was already fed, then throws, as the real one does. A `late` session keeps its stream
// open after the abort until the test ends it, as a real process does while it exits.
// It records every setPermissionMode call, holds the answer while `modeGate` is set, and refuses them while `refuseModes` is
// set (KERNEL-447).
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; prompt: AsyncIterable<any>; feed: (m: unknown) => void; end: () => void; fail: (e: Error) => void; interrupts: number; flags: unknown[]; late: boolean; modes: string[]; refuseModes?: Error; modeGate?: Promise<void>; models: unknown[] }[] }))
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
      options, prompt, interrupts: 0, flags: [] as unknown[], late: false, modes: [] as string[], refuseModes: undefined as Error | undefined, modeGate: undefined as Promise<void> | undefined, models: [] as unknown[],
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
      setPermissionMode: async (mode: string) => { await call.modeGate; if (call.refuseModes) throw call.refuseModes; call.modes.push(mode) },
      initializationResult: async () => ({ models: call.models }),
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

async function setup(mode = 'acceptEdits', hooks: { mcpFor?: (ws: Workspace, agent: unknown, chat: Chat) => Options['mcpServers']; disabledFor?: SessionDeps['disabledFor']; aliasesFor?: SessionDeps['aliasesFor']; onMcp?: SessionDeps['onMcp']; agent?: AgentDef; agentFor?: (ws: Workspace) => AgentDef | undefined; models?: Partial<AppSettings['models']>; usage?: AppSettings['usage']; onTurnDone?: SessionDeps['onTurnDone']; onExit?: SessionDeps['onExit']; ws?: Partial<Workspace>; chat?: Partial<Chat>; room?: Partial<Room>; availability?: SessionDeps['availability']; permissions?: Partial<AppSettings['permissions']>; deps?: Partial<SessionDeps> } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-runner-')), 'kernel.db'))
  const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1, ...hooks.ws }
  const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1, ...hooks.chat }
  store.saveWorkspace(ws)
  store.saveChat(chat)
  if (hooks.room) store.saveRoom({ id: 'room', name: 'invoices', path: '/tmp/room', kind: 'repo', createdAt: 1, ...hooks.room } as Room)
  const allow: string[] = []
  const allowTools: string[] = []
  const approvals = new Approvals(store)
  const settings = { permissions: { mode, alwaysAsk: ['drizzle-kit push'], neverAllow: ['git push origin main'], protectedBranches: [], approvalTimeoutSec: 300, ...hooks.permissions }, ...(hooks.models ? { models: hooks.models } : {}), ...(hooks.usage ? { usage: hooks.usage } : {}) } as unknown as AppSettings
  const sessions = new Sessions({
    store, approvals, settings: () => settings, agentFor: (ws) => (hooks.agentFor ? hooks.agentFor(ws) : hooks.agent), mcpFor: (ws, agent, chat) => hooks.mcpFor?.(ws, agent, chat), disabledFor: hooks.disabledFor, aliasesFor: hooks.aliasesFor, onMcp: hooks.onMcp,
    roomAllow: () => allow, allowInRoom: (_room, rule) => { allow.push(rule) }, roomTools: () => allowTools, allowToolInRoom: (_room, rule) => { allowTools.push(rule) },
    onTurnDone: hooks.onTurnDone, onExit: hooks.onExit, availability: hooks.availability, ...hooks.deps
  })
  await sessions.send(chat.id, [{ type: 'text', text: 'Add a pdf_url column' }])
  const call = sdk.calls[sdk.calls.length - 1]
  const options = call.options as Options
  const guard = options.hooks!.PreToolUse!.find((m) => m.matcher === 'Bash')!.hooks[0] as HookCallback
  const runGuard = (id: string, command: string) => guard({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, session_id: 's', transcript_path: '', cwd: ws.path } as never, id, { signal: new AbortController().signal } as never)
  const kinds = () => store.items(chat.id).map((i: ChatItem) => i.kind)
  return { store, sessions, call, options, runGuard, allow, allowTools, approvals, kinds, chat, settings }
}

describe('questions to the user', () => {
  it('sends ExitPlanMode to the user as a plan card even when worktrees bypass permissions, and keeps the card in the chat', async () => {
    const { options, approvals, store, kinds } = await setup('bypassPermissions')
    const answer = (options.canUseTool as CanUseTool)('ExitPlanMode', { plan: '1. Add the column\n2. Backfill it' }, { signal: new AbortController().signal, toolUseID: 'p1', requestId: 'r1' })
    await flush()
    const pending = store.approvals({ pendingOnly: true })[0]
    expect(pending).toMatchObject({ kind: 'plan', toolName: 'ExitPlanMode', workspaceId: 'ws', chatId: 'chat', detail: '1. Add the column\n2. Backfill it' })
    expect(kinds()).toContain('approval')
    approvals.decide(pending.id, { behavior: 'allow' })
    expect(await answer).toMatchObject({ behavior: 'allow' })
    expect(store.items('chat').find((i) => i.kind === 'approval')).toMatchObject({ approvalId: pending.id })
  })

  it('hands the MCP builder the chat that is running, so Kernel\'s cards land there', async () => {
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
    const { options, store } = await setup('bypassPermissions')
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

  it('in Bypass permissions asks the user about whatever Claude Code still sends, and never answers it for them (KERNEL-433)', async () => {
    const { options, store, approvals } = await setup('bypassPermissions')
    const answer = (options.canUseTool as CanUseTool)('Bash', { command: 'rm -rf node_modules' }, { signal: new AbortController().signal, toolUseID: 'e1', requestId: 'r2' })
    await flush()
    const card = store.approvals({ pendingOnly: true })[0]
    expect(card).toMatchObject({ kind: 'tool', toolName: 'Bash', title: 'Run rm -rf node_modules' })
    approvals.decide(card.id, { behavior: 'deny' })
    expect(await answer).toMatchObject({ behavior: 'deny' })
  })
})

describe('session runner (SDK scripted)', () => {
  it('guards Bash with Kernel lists and leaves everything else to Claude Code', async () => {
    const { runGuard, allow, store, approvals } = await setup()
    expect(await runGuard('t1', 'git push origin main')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    // Always ask waits in the hook for the user's answer, and only a yes lets the command run (KERNEL-447).
    const asked = runGuard('t2', 'pnpm drizzle-kit push')
    await flush()
    const card = store.approvals({ pendingOnly: true })[0]
    expect(card).toMatchObject({ kind: 'tool', toolName: 'Bash', title: 'Run pnpm drizzle-kit push', reason: ALWAYS_ASK })
    approvals.decide(card.id, { behavior: 'allow' })
    expect(await asked).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
    expect(await runGuard('t3', 'npm test')).toEqual({})
    // A room rule answers in the hook, and beats Always ask (D-016, KERNEL-454).
    allow.push('pnpm drizzle-kit push')
    expect(await runGuard('t4', 'pnpm drizzle-kit push')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
  })

  it('asks about Always ask with the command the hook saw, and Always allow saves it on the room', async () => {
    const { runGuard, approvals, store, allow } = await setup()
    const asked = runGuard('t5', 'pnpm drizzle-kit push')
    await flush()
    const pending = store.approvals({ pendingOnly: true })[0]
    expect(pending).toMatchObject({ title: 'Run pnpm drizzle-kit push', input: { command: 'pnpm drizzle-kit push' } })
    approvals.decide(pending.id, { behavior: 'allow', always: true })
    expect(await asked).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } })
    expect(allow).toEqual(['pnpm drizzle-kit push'])
  })

  it('asks in canUseTool with the command the hook saw when another hook rewrote it, and Always allow saves that', async () => {
    const { runGuard, options, approvals, store, allow } = await setup()
    expect(await runGuard('t6', 'pnpm build')).toEqual({})
    const rewritten = { command: 'rtk pnpm build', description: 'Build' }
    const answer = (options.canUseTool as CanUseTool)('Bash', rewritten, { signal: new AbortController().signal, toolUseID: 't6', requestId: 'r1' })
    await flush()
    const pending = store.approvals({ pendingOnly: true })[0]
    expect(pending).toMatchObject({ title: 'Run pnpm build', input: { command: 'pnpm build' } })
    approvals.decide(pending.id, { behavior: 'allow', always: true })
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: rewritten, updatedPermissions: undefined })
    expect(allow).toEqual(['pnpm build'])
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

  describe('on an API key account (KERNEL-523)', () => {
    const KEY = 'sk-ant-api03-' + 'k'.repeat(40)
    const mac = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-api03-from-the-mac', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-from-the-shell' }
    const onKey: Partial<SessionDeps> = { accountFor: () => 'key', authOf: (_p, id) => (id === 'key' ? 'apiKey' : 'subscription'), claudeEnv: () => ({ ANTHROPIC_API_KEY: KEY }), envFor: () => mac }

    it("starts the session with the picked key account's key, and no other key or token", async () => {
      const { options } = await setup('acceptEdits', { deps: onKey })
      expect(options.env).toMatchObject({ PATH: '/bin', ANTHROPIC_API_KEY: KEY })
      expect(options.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
      expect(options.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
      // A token account still gets no API key at all, the Mac's included.
      const token = await setup('acceptEdits', { deps: { accountFor: () => 'side', claudeEnv: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-added' }), envFor: () => mac } })
      expect(token.options.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-added' })
      expect(token.options.env).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(token.options.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    })

    it('says nothing when the key pays, and a note when anything else does', async () => {
      const notes: Record<string, string | undefined> = {}
      for (const source of ['ANTHROPIC_API_KEY', 'none', 'apiKeyHelper']) {
        const { call, options, store, chat } = await setup('acceptEdits', { deps: onKey })
        call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: source })
        await flush()
        notes[source] = store.items(chat.id).find((i): i is Extract<ChatItem, { kind: 'note' }> => i.kind === 'note' && i.text.includes('billed'))?.text
      }
      expect(notes).toEqual({
        ANTHROPIC_API_KEY: undefined,
        none: 'This session is billed through your Claude plan, not the API key account you picked.',
        apiKeyHelper: 'This session is billed through apiKeyHelper, not the API key account you picked.'
      })
    })

    it('keeps no usage window from it, so a rejected one cuts nothing off', async () => {
      const run = async (deps: Partial<SessionDeps>) => {
        const cutOff: Record<string, string>[] = []
        const s = await setup('acceptEdits', { deps: { ...deps, onCutOff: (ids) => { cutOff.push(ids) } } })
        s.call.feed({ type: 'system', subtype: 'init', session_id: s.options.sessionId, apiKeySource: deps === onKey ? 'ANTHROPIC_API_KEY' : 'none' })
        s.call.feed({ type: 'rate_limit_event', uuid: 'l1', session_id: 's', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: Math.round(Date.now() / 1000) + 3600 } })
        s.call.feed({ type: 'result', subtype: 'error_during_execution', is_error: true, uuid: 'r1', duration_ms: 1, session_id: 's' })
        await flush()
        return { limits: await s.sessions.usage(), cutOff: cutOff.at(-1) ?? {} }
      }
      // On the CLI's own login the window counts, and the turn waits for it to reset.
      expect(await run({})).toMatchObject({ limits: [{ type: 'five_hour', status: 'rejected' }], cutOff: { chat: 'limit' } })
      expect(await run(onKey)).toEqual({ limits: [], cutOff: {} })
    })
  })

  it("says once when the agent file lists an MCP server the session doesn't have", async () => {
    const agent = { id: 'theo', name: 'Theo', role: 'Reviewer', description: 'Reviews.', lead: false, prompt: 'You review.', file: '/r/theo.md', tools: ['Read', 'mcp__linear', 'mcp__kernel__submit_review'] } as AgentDef
    // Claude Code lists a claude.ai connector by its own name, and its tools by the name made from it (KERNEL-464).
    const servers = [{ name: 'kernel', status: 'connected', source: 'sdk' }, { name: 'claude.ai Linear', status: 'connected', source: 'claudeai' }]
    const { call, options, store, chat } = await setup('acceptEdits', { agent })
    for (let i = 0; i < 2; i++) call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none', mcp_servers: servers })
    await flush()
    expect(store.items(chat.id).filter((i) => i.kind === 'note').map((i) => (i as { text: string }).text)).toEqual(["This agent's file lists mcp__linear, but no MCP server named linear is connected. Did you mean mcp__claude_ai_Linear?"])

    const ok = await setup('acceptEdits', { agent: { ...agent, tools: ['mcp__claude_ai_Linear__get_issue'] } })
    ok.call.feed({ type: 'system', subtype: 'init', session_id: ok.options.sessionId, apiKeySource: 'none', mcp_servers: servers })
    await flush()
    expect(ok.store.items(ok.chat.id).filter((i) => i.kind === 'note')).toEqual([])
  })

  // KERNEL-464: a server whose name matches but that can't be used says why, and every init's statuses reach the room.
  it('says why a listed MCP server the session has can\'t be used, and tells the room each init\'s statuses', async () => {
    const agent = { id: 'noor', name: 'Noor', role: 'Backend', description: 'APIs.', lead: false, prompt: 'You build.', file: '/r/noor.md', tools: ['Read', 'mcp__neon', 'mcp__claude_ai_Notion__search', 'mcp__fal-ai', 'mcp__figma', 'mcp__linear__get_issue', 'mcp__claude_ai_Gmail'] } as AgentDef
    const reports: unknown[][] = []
    // The room heard from a probe that the Gmail connector is up, before this session's first init lists it.
    const room = [{ name: 'claude.ai Gmail', status: 'connected' as const, source: 'claudeai' }]
    const { call, options, store, chat } = await setup('acceptEdits', {
      agent, disabledFor: () => ({ skills: [], mcp: ['figma'] }), aliasesFor: () => ({ linear: 'claude.ai Linear' }), deps: { accessFor: () => ({ unlisted: 'hide', allow: [] }) },
      onMcp: (_ws, provider, list) => { reports.push([provider, list]); return [...room, ...list] }
    })
    const servers = [
      { name: 'kernel', status: 'connected', source: 'sdk' }, { name: 'neon', status: 'failed', source: 'user' }, { name: 'claude.ai Notion', status: 'needs-auth', source: 'claudeai' },
      { name: 'fal-ai', status: 'disabled', source: 'user' }, { name: 'claude.ai Linear', status: 'connected', source: 'claudeai' }, { name: 'odd', status: 'warming' }
    ]
    for (let i = 0; i < 2; i++) call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none', mcp_servers: servers })
    await flush()
    expect(store.items(chat.id).filter((i) => i.kind === 'note').map((i) => (i as { text: string }).text)).toEqual([[
      "This agent's file lists mcp__neon, but the MCP server neon failed to connect.",
      "This agent's file lists mcp__claude_ai_Notion__search, but the MCP server claude.ai Notion needs you to sign in. Sign in with /mcp in Claude Code.",
      "This agent's file lists mcp__fal-ai, but the MCP server fal-ai is switched off in Claude Code. Turn it on with /mcp.",
      "This agent's file lists mcp__figma, but the MCP server figma is switched off in this room. Turn it on in Settings, Skills and MCP."
    ].join(' ')])
    // Every init reports, with a status Kernel doesn't know left out.
    expect(reports).toHaveLength(2)
    expect(reports[0]).toEqual(['claude', servers.slice(0, 5)])
    // The tools line reads through the room's aliases.
    const unmatched = options.hooks!.PreToolUse!.filter((m) => !m.matcher).flatMap((m) => m.hooks)
    const gate = unmatched[unmatched.length - 1] as HookCallback
    const use = (tool: string) => gate({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/tmp/ws' } as never, 't', { signal: new AbortController().signal } as never)
    expect(await use('mcp__claude_ai_Linear__get_issue')).toEqual({})
    expect(await use('mcp__claude_ai_Linear__save_issue')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
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

describe('prompt suggestions (KERNEL-530)', () => {
  type S = Awaited<ReturnType<typeof setup>>
  const init = (s: S, call = s.call) => call.feed({ type: 'system', subtype: 'init', session_id: s.options.sessionId, apiKeySource: 'none' })
  const finish = async (call: Call, uuid: string) => { call.feed({ type: 'result', subtype: 'success', uuid, duration_ms: 10 }); await flush() }
  const suggest = async (call: Call, suggestion: string) => { call.feed({ type: 'prompt_suggestion', suggestion, uuid: `ps-${suggestion}`, session_id: 's' }); await flush() }
  const saved = (s: S) => s.store.chat('chat')?.suggestion

  it('turns them on, and saves the one that comes after a turn on the chat and pushes it', async () => {
    const s = await setup()
    expect(s.options.promptSuggestions).toBe(true)
    const pushed: (string | undefined)[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'chat' && e.chat.id === 'chat') pushed.push(e.chat.suggestion) }
    bus.on('push', onPush)
    try {
      init(s)
      await finish(s.call, 'r1')
      await suggest(s.call, '  Run the migration  ')
      expect(saved(s)).toBe('Run the migration')
      expect(pushed.at(-1)).toBe('Run the migration')
    } finally {
      bus.off('push', onPush)
    }
  })

  it('drops one that comes once the next turn is running', async () => {
    const s = await setup()
    init(s)
    expect(await s.sessions.send('chat', [{ type: 'text', text: 'And backfill it' }])).toEqual({ queued: true, why: 'running' })
    // The turn ends, the queued message goes out at once, and the first turn's guess arrives after it.
    await finish(s.call, 'r1')
    expect(s.sessions.isRunning('chat')).toBe(true)
    await suggest(s.call, 'Run the migration')
    expect(saved(s)).toBeUndefined()
  })

  it('drops one from a stopped process once a newer one owns the chat', async () => {
    const s = await setup()
    init(s)
    await finish(s.call, 'r1')
    // The old process keeps writing while it exits.
    s.call.late = true
    s.sessions.stop('chat')
    await s.sessions.send('chat', [{ type: 'text', text: 'Start over' }])
    const fresh = sdk.calls[sdk.calls.length - 1]
    expect(fresh).not.toBe(s.call)
    init(s, fresh)
    await finish(fresh, 'r2')
    await suggest(s.call, 'Old guess')
    expect(saved(s)).toBeUndefined()
    await suggest(fresh, 'New guess')
    expect(saved(s)).toBe('New guess')
    s.call.end()
  })

  it('clears it when anything starts a turn: the user, a queued message, a Team update, the Lead, and /clear', async () => {
    const update: TeamUpdate = { rows: [{ workspaceId: 'w1', agentId: 'kai', name: 'Kai', task: 'Remove the Try section', events: [{ kind: 'turn', text: 'Finished a turn', actionable: false }] }] }
    const s = await setup()
    init(s)
    const turn = async (n: number) => { await finish(s.call, `r${n}`); await suggest(s.call, `Guess ${n}`); expect(saved(s)).toBe(`Guess ${n}`) }

    await turn(1)
    await s.sessions.send('chat', [{ type: 'text', text: 'Thanks' }])
    expect(saved(s)).toBeUndefined()

    await turn(2)
    s.sessions.pause('room')
    expect(await s.sessions.send('chat', [{ type: 'text', text: 'Next' }])).toEqual({ queued: true, why: 'paused' })
    s.sessions.resume('room')
    expect(s.sessions.isRunning('chat')).toBe(true)
    expect(saved(s)).toBeUndefined()

    await turn(3)
    expect(s.sessions.post('chat', [{ type: 'text', text: 'Team update from Kernel, not from the user.' }], { update })).toBe(true)
    expect(saved(s)).toBeUndefined()

    await turn(4)
    await s.sessions.send('chat', [{ type: 'text', text: 'Build T-14 from the plan' }], { from: 'lead' })
    expect(saved(s)).toBeUndefined()

    await turn(5)
    // /clear that Claude Code reports on its own still leaves no guess about the old conversation.
    s.call.feed({ type: 'conversation_reset', trigger: 'clear' })
    await flush()
    expect(saved(s)).toBeUndefined()
  })
})

describe('Approve and hand off (KERNEL-67)', () => {
  // The kernel repo's own Lead, which only plans and says nothing about create_workspace.
  const kernel: AgentDef = { id: 'kernel', file: '.claude/agents/kernel.md', name: 'Kernel', role: 'Lead', description: 'Plans sprint work', lead: true, prompt: "You are Kernel, the lead for building Kernel itself. You plan, you don't write feature code." }
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
    const lead = (await setup('acceptEdits', { agent: kernel })).options.systemPrompt as { append: string }
    expect(lead.append).toContain(kernel.prompt)
    expect(lead.append).toContain(LEAD_RULE)
    expect(LEAD_RULE).toContain('mcp__kernel__create_workspace')
    // KERNEL-129: what the rule asks of the Lead beyond the hand-off.
    for (const part of ['Never hand a task to yourself', 'Team update', 'Never leave a teammate waiting', 'mcp__kernel__ask_user', 'pass on the details', 'tell the user it is ready to merge', 'Call teammates by name, not he or she', 'one or two short lines', 'Leave workspace ids out', 'tell the user what is stuck']) expect(LEAD_RULE).toContain(part)
    const builder = (await setup('acceptEdits', { agent: noor })).options.systemPrompt as { append: string }
    expect(builder.append).not.toContain(LEAD_RULE)
  })

  it('tells the Lead to hand off right after the approval, then reminds it once if it tries to stop first', async () => {
    const s = await setup('acceptEdits', { agent: kernel })
    expect(await contexts(s.options, 'Stop')).toEqual([])
    await approvePlan(s)
    const [note] = await contexts(s.options, 'PostToolUse', 'ExitPlanMode')
    expect(note).toBe(`Plan approved.\n\n${HANDOFF_NOW}`)
    // The settled card says the plan was approved, so the chat adds no note.
    expect(s.store.items('chat').filter((i) => i.kind === 'note')).toEqual([])
    expect(await contexts(s.options, 'Stop')).toEqual([HANDOFF_REMINDER])
    // One reminder per approval: the next Stop ends the turn.
    expect(await contexts(s.options, 'Stop')).toEqual([])
  })

  it("gives every agent the approval's note once with ExitPlanMode's answer, and adds no note to the chat", async () => {
    const s = await setup('acceptEdits', { agent: noor })
    await approvePlan(s)
    // The agent still has its plan in context, so the note names no file and carries no plan.
    expect(await contexts(s.options, 'PostToolUse', 'ExitPlanMode')).toEqual(['Plan approved.'])
    expect(await contexts(s.options, 'PostToolUse', 'ExitPlanMode')).toEqual([])
    expect(s.store.items('chat').filter((i) => i.kind === 'note')).toEqual([])
    expect(s.store.chat('chat')?.plan).toBe(false)
    // It rides on the tool's answer, so no message and no extra turn follows.
    expect(s.store.items('chat').filter((i) => i.kind === 'user' && i.from === 'kernel')).toEqual([])
    expect(s.sessions.queued('chat')).toEqual([])
  })

  it('stops holding the Lead once it has created a workspace', async () => {
    const s = await setup('acceptEdits', { agent: kernel })
    await approvePlan(s)
    s.sessions.handoffs.done('chat') // what create_workspace does
    expect(await contexts(s.options, 'Stop')).toEqual([])
  })

  it('drops the reminder when the user stops the turn', async () => {
    const s = await setup('acceptEdits', { agent: kernel })
    await approvePlan(s)
    await s.sessions.interrupt('chat')
    expect(await contexts(s.options, 'Stop')).toEqual([])
  })

  it('drops the reminder when the user sends something else, even while it waits in the queue', async () => {
    const s = await setup('acceptEdits', { agent: kernel })
    await approvePlan(s)
    expect(await s.sessions.send('chat', [{ type: 'text', text: 'Hold off, post it to Linear instead' }])).toEqual({ queued: true, why: 'running' })
    expect(await contexts(s.options, 'Stop')).toEqual([])
  })

  it('takes a Kernel post into an idle chat without cancelling a pending hand-off, and refuses one while running (KERNEL-72)', async () => {
    const s = await setup('acceptEdits', { agent: kernel })
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

  it('gives agents that are not the Lead no hand-off', async () => {
    const s = await setup('acceptEdits', { agent: noor })
    await approvePlan(s)
    expect((await contexts(s.options, 'PostToolUse', 'ExitPlanMode'))[0]).not.toContain(HANDOFF_NOW)
    expect(hooksFor(s.options, 'Stop').length).toBe(1)
    expect(await contexts(s.options, 'Stop')).toEqual([])
  })

  describe('teammates the user addressed (KERNEL-745)', () => {
    const kai: AgentDef = { ...noor, id: 'kai', name: 'Kai', role: 'Frontend' }
    const at = (a: AgentDef): ChatPart => ({ type: 'agent', name: a.name, agentId: a.id })
    const reminded = (...names: string[]) => openReminder(names.map((name) => ({ kind: 'mention', name }) as OpenItem))
    /** A Lead chat whose first turn has ended, then a message from the user to `mentioned`. */
    async function addressed(...mentioned: AgentDef[]) {
      // What the Lead chat owes lives in its feature, on the same store, built once setup has the store (KERNEL-749).
      const items: { open?: OpenItems } = {}
      const s = await setup('acceptEdits', { agent: kernel, deps: { teamOf: () => [kernel, noor, kai], openItems: {
        mentioned: (c, m) => items.open?.mentioned(c, m), userSent: (id) => items.open?.userSent(id), atStop: (id) => items.open?.atStop(id)
      } } })
      items.open = new OpenItems({ store: s.store } as unknown as Kernel)
      s.call.feed({ type: 'system', subtype: 'init', session_id: s.options.sessionId, apiKeySource: 'none' })
      s.call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 10 })
      await flush()
      await nextSent(s.call)
      await s.sessions.send('chat', [...mentioned.map(at), { type: 'text', text: 'take the Stop hook' }])
      const { value } = await s.call.prompt[Symbol.asyncIterator]().next()
      return { ...s, open: items.open, read: (value.message.content as { text: string }[]).map((c) => c.text) }
    }

    it('tells the Lead who the user addressed, and keeps the chat row as the user wrote it', async () => {
      const s = await addressed(noor, kai)
      expect(s.read).toEqual(['@Noor', '@Kai', 'take the Stop hook', 'The user addressed this to Noor and Kai.'])
      expect(s.store.items('chat').filter((i) => i.kind === 'user').at(-1)).toMatchObject({ parts: [at(noor), at(kai), { type: 'text', text: 'take the Stop hook' }] })
    })

    it('reminds the Lead once when the turn ends without acting for each one', async () => {
      const s = await addressed(noor)
      expect(await contexts(s.options, 'Stop')).toEqual([reminded('Noor')])
      expect(await contexts(s.options, 'Stop')).toEqual([])
    })

    it('reminds only for the teammates the Lead has not acted for', async () => {
      const s = await addressed(noor, kai)
      s.open.created('chat', 'noor') // what create_workspace for Noor does
      expect(await contexts(s.options, 'Stop')).toEqual([reminded('Kai')])
    })

    it('drops the reminder when the user stops the turn or writes again', async () => {
      const stopped = await addressed(noor)
      await stopped.sessions.interrupt('chat')
      expect(await contexts(stopped.options, 'Stop')).toEqual([])
      const redirected = await addressed(noor)
      await redirected.sessions.send('chat', [{ type: 'text', text: 'Never mind' }])
      expect(await contexts(redirected.options, 'Stop')).toEqual([])
    })

    it('reminds about the hand-off and the mention in one Stop', async () => {
      const s = await addressed(noor)
      await approvePlan(s)
      expect(await contexts(s.options, 'Stop')).toEqual([`${HANDOFF_REMINDER}\n\n${reminded('Noor')}`])
    })

    it('gives a teammate who is mentioned nothing extra', async () => {
      const s = await setup('acceptEdits', { agent: noor, deps: { teamOf: () => [kernel, noor] } })
      s.call.feed({ type: 'system', subtype: 'init', session_id: s.options.sessionId, apiKeySource: 'none' })
      s.call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 10 })
      await flush()
      await nextSent(s.call)
      await s.sessions.send('chat', [at(kai), { type: 'text', text: 'ask Kai' }])
      const { value } = await s.call.prompt[Symbol.asyncIterator]().next()
      expect((value.message.content as { text: string }[]).map((c) => c.text)).toEqual(['@Kai', 'ask Kai'])
      expect(s.store.openItems('chat')).toEqual([])
    })
  })
})

describe('a note before the next turn (KERNEL-764)', () => {
  it('starts only the next turn with the note, and the chat row shows the message alone', async () => {
    const note = 'Files were reverted to 10:24. Re-read files before editing.'
    const notes = [note]
    const s = await setup('acceptEdits', { deps: { turnNote: () => notes.shift() } })
    const texts = async () => ((await s.call.prompt[Symbol.asyncIterator]().next()).value.message.content as { text: string }[]).map((c) => c.text)
    expect(await texts()).toEqual([note, 'Add a pdf_url column'])
    expect(s.store.items('chat').find((i) => i.kind === 'user')).toMatchObject({ parts: [{ type: 'text', text: 'Add a pdf_url column' }] })

    s.call.feed({ type: 'system', subtype: 'init', session_id: s.options.sessionId, apiKeySource: 'none' })
    s.call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 10 })
    await flush()
    await s.sessions.send('chat', [{ type: 'text', text: 'Backfill it' }])
    expect(await texts()).toEqual(['Backfill it'])
  })
})

describe('compact window per role (feat-compact-window-per-role-with-plan)', () => {
  const WINDOW = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
  const compact: AppSettings['models']['compact'] = { lead: 'full', engineers: '200k', qa: '200k', reviewer: '200k' }
  const noor: AgentDef = { id: 'noor', file: '.claude/agents/noor.md', name: 'Noor', role: 'Backend', description: 'Engine', lead: false, prompt: 'You build the engine.' }
  const envOf = (call: Call) => call.options.env as Record<string, string>
  const stopped = (call: Call) => !!call.options.abortController?.signal.aborted
  const done = async (call: Call, uuid: string) => { call.feed({ type: 'result', subtype: 'success', uuid, duration_ms: 5 }); await flush() }

  it("starts a chat with its role's window, and takes the variable away at the model's own window", async () => {
    const mac = process.env[WINDOW]
    process.env[WINDOW] = '500000'
    onTestFinished(() => { if (mac === undefined) delete process.env[WINDOW]; else process.env[WINDOW] = mac })
    const roles: unknown[] = []
    const engineer = await setup('acceptEdits', { models: { compact }, agent: noor, deps: { roleFor: (ws, agent) => { roles.push([ws.id, agent?.id]); return 'engineers' } } })
    expect(envOf(engineer.call)[WINDOW]).toBe('200000')
    expect(roles).toEqual([['ws', 'noor']])
    const lead = await setup('acceptEdits', { models: { compact }, deps: { roleFor: () => 'lead' } })
    expect(envOf(lead.call)).not.toHaveProperty(WINDOW)
    // Changing the model mid-chat keeps the process, and so its window.
    await lead.sessions.configure(lead.chat.id, { model: 'claude-opus-5-5' })
    expect(sdk.calls.at(-1)).toBe(lead.call)
  })

  it('restarts an idle chat when a compact window changes, and a busy one when its turn ends', async () => {
    const s = await setup('acceptEdits', { models: { compact }, deps: { roleFor: () => 'engineers' } })
    const settings = s.settings as unknown as AppSettings
    const change = (to: object) => { const before = structuredClone(settings); Object.assign(settings.models, to); s.sessions.applySettings(before) }
    // Mid-turn: the process finishes its turn on the window it started with.
    change({ compact: { ...compact, engineers: 'full' } })
    expect(stopped(s.call)).toBe(false)
    await done(s.call, 'r1')
    expect(stopped(s.call)).toBe(true)
    await s.sessions.send(s.chat.id, [{ type: 'text', text: 'Run the tests' }])
    const next = sdk.calls.at(-1)!
    expect(next).not.toBe(s.call)
    expect(envOf(next)).not.toHaveProperty(WINDOW)
    // The next message resumes the same conversation.
    await done(next, 'r2')
    // Idle: it ends at once.
    change({ compact: { ...compact, engineers: '200k' } })
    expect(stopped(next)).toBe(true)
    await s.sessions.send(s.chat.id, [{ type: 'text', text: 'And typecheck' }])
    const third = sdk.calls.at(-1)!
    expect(envOf(third)[WINDOW]).toBe('200000')
    await done(third, 'r3')
    // A setting that isn't a compact window leaves the process alone.
    change({ agentLimit: 3 })
    expect(stopped(third)).toBe(false)
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
    const { options } = await setup('acceptEdits', { agent: theo, deps: { accessFor: () => ({ unlisted: 'hide', allow: [] }) } })
    expect(options.disallowedTools).toEqual(['WebFetch', 'WebSearch', 'NotebookEdit', 'Agent'])
    const gate = gateOf(options)!
    expect(await use(gate, 'mcp__linear__save_issue')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: "Your agent file doesn't list mcp__linear__save_issue. Use another tool, or ask the user to add mcp__linear__save_issue to the tools line in your agent file." } })
    expect(await use(gate, 'Write')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    for (const tool of ['Read', 'Bash', 'mcp__linear__get_issue', 'mcp__kernel__submit_review', 'ExitPlanMode', 'ToolSearch']) expect(await use(gate, tool), tool).toEqual({})
  })

  it('asks about an MCP server the file does not list, unless the room hides it or allows it (KERNEL-537)', async () => {
    const { options, store, approvals, allowTools } = await setup('acceptEdits', { agent: theo })
    const gate = gateOf(options)!
    const answer = use(gate, 'mcp__linear__save_issue')
    await flush()
    const pending = store.approvals({ pendingOnly: true })[0]
    expect(pending).toMatchObject({ kind: 'tool', toolName: 'mcp__linear__save_issue' })
    approvals.decide(pending.id, { behavior: 'allow', always: true })
    expect(await answer).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
    expect(allowTools.length).toBe(1)
    // Built-in tools the file leaves out are still refused without asking.
    expect(await use(gate, 'Write')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    // A server the room's allow names counts as listed.
    const allowed = await setup('acceptEdits', { agent: theo, deps: { accessFor: () => ({ unlisted: 'hide', allow: ['github'] }) } })
    expect(await use(gateOf(allowed.options)!, 'mcp__github__merge_pull_request')).toEqual({})
  })

  describe('in Bypass permissions (bypass-allows-unlisted-mcp)', () => {
    const asks = async (t: Awaited<ReturnType<typeof setup>>, tool: string) => {
      const answer = use(gateOf(t.options)!, tool)
      await flush()
      const pending = t.store.approvals({ pendingOnly: true })
      expect(pending, `${tool} should ask`).toMatchObject([{ kind: 'tool', toolName: tool }])
      t.approvals.decide(pending[0].id, { behavior: 'deny' })
      await answer
    }
    const allowed = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }

    it('runs an MCP server the file does not list with no card, while the room asks about it', async () => {
      for (const access of [undefined, { unlisted: 'ask' as const, allow: [] }]) {
        const t = await setup('bypassPermissions', { agent: theo, deps: access ? { accessFor: () => access } : {} })
        expect(await use(gateOf(t.options)!, 'mcp__linear__save_issue')).toEqual(allowed)
        expect(await use(gateOf(t.options)!, 'mcp__claude_ai_Linear__get_issue')).toEqual(allowed)
        expect(t.store.approvals({ pendingOnly: true })).toEqual([])
        // Built-in tools the file leaves out are still refused.
        expect(await use(gateOf(t.options)!, 'Write')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
      }
    })

    it('still asks in every other mode', async () => {
      for (const mode of ['default', 'acceptEdits', 'auto']) await asks(await setup(mode, { agent: theo, availability: () => ({ auto: true, bypass: true }) }), 'mcp__linear__save_issue')
      // Plan mode in a Bypass chat runs in plan, so it asks too.
      await asks(await setup('bypassPermissions', { agent: theo, chat: { plan: true } }), 'mcp__linear__save_issue')
    })

    it('still refuses what the room hides and what disallowedTools takes away, with the same reasons', async () => {
      const hidden = await setup('bypassPermissions', { agent: theo, deps: { accessFor: () => ({ unlisted: 'hide', allow: [] }) } })
      expect(await use(gateOf(hidden.options)!, 'mcp__linear__save_issue')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: "Your agent file doesn't list mcp__linear__save_issue. Use another tool, or ask the user to add mcp__linear__save_issue to the tools line in your agent file." } })
      const taken = await setup('bypassPermissions', { agent: { ...theo, disallowedTools: ['mcp__github'] } })
      expect(await use(gateOf(taken.options)!, 'mcp__github__merge_pull_request')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: "Your agent file's disallowedTools takes away mcp__github__merge_pull_request. Use another tool, or ask the user to take mcp__github__merge_pull_request off disallowedTools in your agent file." } })
      expect(taken.store.approvals({ pendingOnly: true })).toEqual([])
    })

    it('asks again once the chat leaves Bypass permissions, while the switch is pending and after it lands', async () => {
      const t = await setup('bypassPermissions', { agent: theo })
      t.call.feed({ type: 'system', subtype: 'init', session_id: t.options.sessionId, apiKeySource: 'none', permissionMode: 'bypassPermissions' })
      await flush()
      let answer!: () => void
      t.call.modeGate = new Promise((resolve) => { answer = resolve })
      const switched = t.sessions.configure('chat', { mode: 'acceptEdits' })
      await flush()
      expect(t.call.modes).toEqual([])
      await asks(t, 'mcp__linear__save_issue')
      answer()
      await switched
      await asks(t, 'mcp__linear__save_issue')
    })

    it('asks while Claude Code reports a stricter mode, until it reports Bypass permissions again', async () => {
      const t = await setup('bypassPermissions', { agent: theo })
      t.call.feed({ type: 'system', subtype: 'init', session_id: t.options.sessionId, apiKeySource: 'none', permissionMode: 'default' })
      await flush()
      await asks(t, 'mcp__linear__save_issue')
      t.call.feed({ type: 'system', subtype: 'status', status: null, permissionMode: 'bypassPermissions', uuid: 's1', session_id: 's' })
      await flush()
      expect(await use(gateOf(t.options)!, 'mcp__linear__save_issue')).toEqual(allowed)
    })
  })

  it("leaves out what disallowedTools takes away, and the gate says which line refused (KERNEL-451)", async () => {
    const { options } = await setup('acceptEdits', { agent: { ...theo, tools: undefined, disallowedTools: ['WebFetch', 'mcp__github', 'mcp__linear__save_issue'] } })
    expect(options.disallowedTools).toEqual(['WebFetch', 'mcp__github', 'mcp__linear__save_issue'])
    const gate = gateOf(options)!
    expect(await use(gate, 'mcp__github__merge_pull_request')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: "Your agent file's disallowedTools takes away mcp__github__merge_pull_request. Use another tool, or ask the user to take mcp__github__merge_pull_request off disallowedTools in your agent file." } })
    for (const tool of ['Edit', 'Write', 'mcp__linear__get_issue', 'mcp__kernel__submit_review']) expect(await use(gate, tool), tool).toEqual({})
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

describe('asking from inside a hook (KERNEL-446)', () => {
  const noor = { id: 'noor', name: 'Noor', role: 'Engine', description: '', lead: false, prompt: '', file: '/r/noor.md' } as AgentDef
  const ask: Ask = { kind: 'tool', toolName: 'Bash', input: { command: 'pnpm drizzle-kit push' }, title: 'Run pnpm drizzle-kit push' }
  // The host Sessions gave the chat's runner, so the card and the status are the ones a canUseTool ask gets.
  const hostOf = (sessions: Sessions) => (sessions['live'].get('chat') as unknown as { runner: ClaudeRunner }).runner['host']
  const open = () => new AbortController().signal
  const denied = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
  const late = denied('No decision was made in time.')

  it('puts the card in the chat, shows the agent as needing the user, and allows the call on yes', async () => {
    const { sessions, call, options, store, approvals, kinds } = await setup('acceptEdits', { agent: noor })
    const statuses: string[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'agent.status') statuses.push(e.status) }
    bus.on('push', onPush)
    onTestFinished(() => { bus.off('push', onPush) })
    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'none' })
    await flush()
    const answer = awaitDecision(hostOf(sessions), ask, open())
    await flush()
    const pending = store.approvals({ pendingOnly: true })[0]
    expect(pending).toMatchObject({ kind: 'tool', source: 'sdk', toolName: 'Bash', chatId: 'chat', title: 'Run pnpm drizzle-kit push' })
    expect(kinds()).toContain('approval')
    expect(statuses.at(-1)).toBe('needs')
    approvals.decide(pending.id, { behavior: 'allow' })
    expect(await answer).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
    expect(statuses.at(-1)).toBe('working')
  })

  it("denies with the user's reason, or with what the user typed instead", async () => {
    const { sessions, store, approvals } = await setup()
    const cases: [Decision, string][] = [
      [{ behavior: 'deny', message: 'Use the staging database.' }, 'Use the staging database.'],
      [{ behavior: 'deny' }, 'Denied in Kernel.'],
      [{ behavior: 'answer', text: 'Run the migration instead' }, 'The user answered: Run the migration instead']
    ]
    for (const [decision, reason] of cases) {
      const answer = awaitDecision(hostOf(sessions), ask, open())
      await flush()
      approvals.decide(store.approvals({ pendingOnly: true })[0].id, decision)
      expect(await answer).toEqual(denied(reason))
    }
  })

  it('denies when the hook is aborted, and opens no card for a hook already aborted', async () => {
    const { sessions, store } = await setup()
    const abort = new AbortController()
    const answer = awaitDecision(hostOf(sessions), ask, abort.signal)
    await flush()
    abort.abort()
    expect(await answer).toEqual(late)
    expect(store.approvals({}).map((a) => a.status)).toEqual(['expired'])
    expect(await awaitDecision(hostOf(sessions), ask, abort.signal)).toEqual(late)
    expect(store.approvals({})).toHaveLength(1)
  })

  it('denies once the wait runs out, which comes before the CLI stops waiting on the hook and lets the call go', async () => {
    expect(HOOK_ASK_MS).toBeLessThan(HOLD_TIMEOUT_SEC * 1000)
    // Past this, Node fires the timer at once and every ask would deny before the user saw it.
    expect(HOOK_ASK_MS).toBeLessThanOrEqual(2 ** 31 - 1)
    const waits: (number | undefined)[] = []
    await awaitDecision({ ask: async (_a, o) => { waits.push(o.timeoutMs); return { behavior: 'allow' } } }, ask, open())
    expect(waits).toEqual([HOOK_ASK_MS])

    const { sessions, store } = await setup()
    expect(await awaitDecision(hostOf(sessions), ask, open(), 20)).toEqual(late)
    expect(store.approvals({}).map((a) => a.status)).toEqual(['expired'])
  })

  it('denies when the ask ends with no decision: the workspace archived, or Kernel quitting', async () => {
    const { sessions, approvals } = await setup()
    const archived = awaitDecision(hostOf(sessions), ask, open())
    await flush()
    approvals.expireWorkspace('ws')
    expect(await archived).toEqual(late)
    const quitting = awaitDecision(hostOf(sessions), ask, open())
    await flush()
    approvals.expirePending()
    expect(await quitting).toEqual(late)
    // Once Kernel is quitting, an ask gets no decision at once.
    expect(await awaitDecision(hostOf(sessions), ask, open())).toEqual(late)
  })
})

describe('who sent a message (KERNEL-116)', () => {
  const lead: AgentDef = { id: 'kernel', file: '.claude/agents/kernel.md', name: 'Kernel', role: 'Lead', description: 'Plans', lead: true, prompt: 'You are Kernel.' }
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
    // Kernel's message, then a restart after a crash: the restarted turn is still Kernel's.
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

describe('permission modes on Claude (KERNEL-447)', () => {
  const autoWorks: SessionDeps['availability'] = () => ({ auto: true, bypass: true })
  const signal = () => new AbortController().signal
  const notes = (store: Store) => store.items('chat').flatMap((i) => (i.kind === 'note' ? [i.text] : []))
  const denied = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
  const hook = (options: Options, matcher: string) => options.hooks!.PreToolUse!.find((m) => m.matcher === matcher)!
  const run = (options: Options, matcher: string, tool: string, input: Record<string, unknown>) =>
    (hook(options, matcher).hooks[0] as HookCallback)({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'w1', session_id: 's', transcript_path: '', cwd: '/tmp/ws' } as never, 'w1', { signal: signal() } as never)

  it("starts each mode under Claude Code's name for it, and lets only a chat in Bypass permissions take bypass", async () => {
    for (const mode of ['default', 'acceptEdits'] as const) {
      const { options } = await setup(mode)
      expect(options.permissionMode).toBe(mode)
      expect(options).not.toHaveProperty('allowDangerouslySkipPermissions')
    }
    expect((await setup('bypassPermissions')).options).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
    expect((await setup('auto', { availability: autoWorks })).options.permissionMode).toBe('auto')
    // Plan mode comes first. A chat that leaves it for Bypass permissions can take it then.
    expect((await setup('bypassPermissions', { chat: { plan: true } })).options).toMatchObject({ permissionMode: 'plan', allowDangerouslySkipPermissions: true })
  })

  it("runs Auto as Accept edits until Kernel knows the chat's model runs it, and moves the live session once it does", async () => {
    let known = false
    const { options, sessions, call } = await setup('auto', { availability: () => ({ auto: known, bypass: true }) })
    expect(options.permissionMode).toBe('acceptEdits')
    known = true
    sessions.applyModes()
    await flush()
    expect(call.modes).toEqual(['auto'])
  })

  it('leaves Auto when the chat moves to a model that does not run it', async () => {
    const { sessions, call } = await setup('auto', { availability: (chat) => ({ auto: chat.model === 'claude-sonnet-5-5', bypass: true }) })
    await sessions.configure('chat', { model: 'claude-haiku-4-5-20251001' })
    expect(call.modes).toEqual(['acceptEdits'])
  })

  it("takes the chat's mode over the room's, the room's over the app's, and an agent file's only when it is stricter", async () => {
    expect((await setup('default', { room: { permissionMode: 'acceptEdits' } })).options.permissionMode).toBe('acceptEdits')
    expect((await setup('default', { room: { permissionMode: 'acceptEdits' }, chat: { mode: 'bypassPermissions' } })).options.permissionMode).toBe('bypassPermissions')
    const careful = { id: 'noor', name: 'Noor', role: 'Engine', description: '', lead: false, prompt: '', file: '/r/noor.md', permissionMode: 'acceptEdits' } as AgentDef
    const tightened = (await setup('bypassPermissions', { agent: careful })).options
    expect(tightened.permissionMode).toBe('acceptEdits')
    expect(tightened).not.toHaveProperty('allowDangerouslySkipPermissions')
    expect((await setup('default', { agent: { ...careful, permissionMode: 'bypassPermissions' } })).options.permissionMode).toBe('default')
  })

  it('never runs a current-branch workspace in Bypass permissions while Only in worktrees is on, however the mode is picked', async () => {
    const t = await setup('bypassPermissions', { ws: { mode: 'current' }, permissions: { bypassOnlyInWorktrees: true } })
    expect(t.options.permissionMode).toBe('acceptEdits')
    expect(t.options).not.toHaveProperty('allowDangerouslySkipPermissions')
    const ended = (id: string) => { t.call.feed({ type: 'result', subtype: 'success', uuid: id, duration_ms: 1 }); return flush() }
    await ended('r0')
    await t.sessions.configure('chat', { mode: 'bypassPermissions' })
    t.store.saveRoom({ id: 'room', name: 'invoices', path: '/tmp/room', permissionMode: 'bypassPermissions', createdAt: 1 } as Room)
    t.sessions.applyModes()
    t.sessions.applySettings()
    await flush()
    await t.sessions.send('chat', [{ type: 'text', text: 'Push it' }])
    for (const c of sdk.calls.slice(sdk.calls.indexOf(t.call))) {
      expect(c.options.permissionMode).not.toBe('bypassPermissions')
      expect(c.options).not.toHaveProperty('allowDangerouslySkipPermissions')
      expect(c.modes).not.toContain('bypassPermissions')
    }
    // With Only in worktrees off, the same chat may take it, from a process started for it once the turn ends.
    const before = structuredClone(t.settings)
    t.settings.permissions.bypassOnlyInWorktrees = false
    t.sessions.applySettings(before)
    await ended('r1')
    await t.sessions.send('chat', [{ type: 'text', text: 'Now push it' }])
    expect(sdk.calls[sdk.calls.length - 1]).not.toBe(t.call)
    expect(sdk.calls[sdk.calls.length - 1].options).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
  })

  it('moves a live session with setPermissionMode when the chat, plan mode, the room or Settings changes its mode', async () => {
    const t = await setup('acceptEdits', { room: {} })
    await t.sessions.configure('chat', { mode: 'default' })
    await t.sessions.configure('chat', { plan: true })
    await t.sessions.configure('chat', { plan: false })
    expect(t.call.modes).toEqual(['default', 'plan', 'default'])
    // The chat's own mode wins over Settings and the room, so neither moves it.
    const before = structuredClone(t.settings)
    t.settings.permissions.mode = 'auto'
    t.sessions.applySettings(before)
    t.store.saveRoom({ ...t.store.room('room')!, permissionMode: 'acceptEdits' })
    t.sessions.applyModes()
    await flush()
    expect(t.call.modes).toEqual(['default', 'plan', 'default'])

    const u = await setup('acceptEdits', { room: {} })
    u.store.saveRoom({ ...u.store.room('room')!, permissionMode: 'default' })
    u.sessions.applyModes()
    await flush()
    const was = structuredClone(u.settings)
    u.settings.permissions.mode = 'default'
    u.sessions.applySettings(was)
    await flush()
    // Settings changed to the mode the room already gives, so only the room's change moved it.
    expect(u.call.modes).toEqual(['default'])
  })

  it('leaves a note when Claude Code refuses a switch, and keeps checking steps in the stricter mode', async () => {
    const t = await setup('bypassPermissions')
    t.call.refuseModes = new Error('the session is busy')
    await t.sessions.configure('chat', { plan: true })
    expect(notes(t.store)).toEqual(["Claude Code didn't switch this chat to Plan (the session is busy), so it stays in Bypass permissions."])
    // Claude Code still runs Bypass permissions, but Kernel checks steps as plan mode would: Always ask asks.
    const asked = t.runGuard('t1', 'pnpm drizzle-kit push')
    await flush()
    expect(t.store.approvals({ pendingOnly: true })).toHaveLength(1)
    t.approvals.decide(t.store.approvals({ pendingOnly: true })[0].id, { behavior: 'deny' })
    expect(await asked).toEqual(denied('Denied in Kernel.'))
  })

  // A chat leaving Bypass permissions while its turn runs. Claude Code runs in bypass until it takes the switch, and its process
  // can take bypass until it ends, so a push that might reach main stays denied all along.
  const leaving = async () => {
    const t = await setup('bypassPermissions', { permissions: { protectedBranches: ['main'] } })
    t.call.feed({ type: 'system', subtype: 'init', session_id: t.options.sessionId, apiKeySource: 'none', permissionMode: 'bypassPermissions' })
    await flush()
    return t
  }
  const own = () => denied(pushOwnBranch(['main'], 'feat/invoice-schema'))
  const askedOnce = async (t: Awaited<ReturnType<typeof setup>>, id: string) => {
    const asked = t.runGuard(id, 'pnpm drizzle-kit push')
    await flush()
    const card = t.store.approvals({ pendingOnly: true })[0]
    expect(card, 'Always ask should ask in the stricter mode').toMatchObject({ toolName: 'Bash', reason: ALWAYS_ASK })
    t.approvals.decide(card.id, { behavior: 'deny' })
    expect(await asked).toEqual(denied('Denied in Kernel.'))
  }

  it('denies a push that might reach main while a switch out of Bypass permissions is pending, and asks about Always ask', async () => {
    const t = await leaving()
    let answer!: () => void
    t.call.modeGate = new Promise((resolve) => { answer = resolve })
    const switched = t.sessions.configure('chat', { mode: 'acceptEdits' })
    await flush()
    expect(t.call.modes).toEqual([])
    expect(await t.runGuard('t1', 'git push')).toEqual(own())
    expect(await t.runGuard('t2', 'git push origin main')).toEqual(own())
    expect(await t.runGuard('t3', 'git push -u origin HEAD')).toEqual(own())
    await askedOnce(t, 't4')
    answer()
    await switched
    expect(t.call.modes).toEqual(['acceptEdits'])
  })

  it('keeps denying it after Claude Code refuses the switch', async () => {
    const t = await leaving()
    t.call.refuseModes = new Error('not now')
    await t.sessions.configure('chat', { mode: 'acceptEdits' })
    expect(notes(t.store)).toEqual(["Claude Code didn't switch this chat to Accept edits (not now), so it stays in Bypass permissions."])
    expect(await t.runGuard('t1', 'git push')).toEqual(own())
    expect(await t.runGuard('t2', 'git push origin "$BRANCH"')).toEqual(own())
    await askedOnce(t, 't3')
  })

  it('keeps denying it after the switch lands mid-turn, until the process that could bypass ends with the turn', async () => {
    const t = await leaving()
    await t.sessions.configure('chat', { mode: 'acceptEdits' })
    expect(t.call.modes).toEqual(['acceptEdits'])
    t.call.feed({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits', uuid: 's1', session_id: 's' })
    await flush()
    // A subagent with its own bypass could still push from this process.
    expect(await t.runGuard('t1', 'git push')).toEqual(own())
    await askedOnce(t, 't2')
    t.call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 1 })
    await flush()
    await t.sessions.send('chat', [{ type: 'text', text: 'Push it' }])
    const next = sdk.calls[sdk.calls.length - 1]
    expect(next).not.toBe(t.call)
    expect(next.options).toMatchObject({ permissionMode: 'acceptEdits' })
    expect(next.options).not.toHaveProperty('allowDangerouslySkipPermissions')
    // Accept edits leaves a bare push to the user's own settings, as it always has.
    expect(await run(next.options, 'Bash', 'Bash', { command: 'git push' })).toEqual({})
  })

  it('asks about Always ask while Claude Code reports a stricter mode than Bypass permissions, until it reports bypass again', async () => {
    const t = await setup('bypassPermissions')
    t.call.feed({ type: 'system', subtype: 'init', session_id: t.options.sessionId, apiKeySource: 'none', permissionMode: 'default' })
    await flush()
    await askedOnce(t, 't1')
    t.call.feed({ type: 'system', subtype: 'status', status: null, permissionMode: 'bypassPermissions', uuid: 's1', session_id: 's' })
    await flush()
    expect(await t.runGuard('t2', 'pnpm drizzle-kit push')).toEqual({})
  })

  it('moves into Bypass permissions by restarting a process that started without it, and out of it by switching first', async () => {
    const t = await setup('acceptEdits')
    expect(t.options).not.toHaveProperty('allowDangerouslySkipPermissions')
    t.call.feed({ type: 'system', subtype: 'init', session_id: t.options.sessionId, apiKeySource: 'none' })
    t.call.feed({ type: 'result', subtype: 'success', uuid: 'r0', duration_ms: 1 })
    await flush()
    const before = sdk.calls.length
    // Idle: the process ends now, and the next message starts one that may take Bypass permissions.
    await t.sessions.configure('chat', { mode: 'bypassPermissions' })
    expect(t.call.modes).toEqual([])
    await t.sessions.send('chat', [{ type: 'text', text: 'Go on' }])
    expect(sdk.calls.length).toBe(before + 1)
    const bypassing = sdk.calls[sdk.calls.length - 1]
    expect(bypassing.options).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, resume: t.options.sessionId })

    // Busy: the stricter mode applies at once, and the process that could bypass ends with the turn.
    bypassing.feed({ type: 'system', subtype: 'init', session_id: t.options.sessionId, apiKeySource: 'none' })
    await flush()
    await t.sessions.configure('chat', { mode: 'acceptEdits' })
    expect(bypassing.modes).toEqual(['acceptEdits'])
    bypassing.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 1 })
    await flush()
    await t.sessions.send('chat', [{ type: 'text', text: 'And again' }])
    expect(sdk.calls[sdk.calls.length - 1].options).toMatchObject({ permissionMode: 'acceptEdits' })
    expect(sdk.calls[sdk.calls.length - 1].options).not.toHaveProperty('allowDangerouslySkipPermissions')
  })

  it('says when Bypass permissions waits for the running turn to end', async () => {
    const t = await setup('acceptEdits')
    t.call.feed({ type: 'system', subtype: 'init', session_id: t.options.sessionId, apiKeySource: 'none' })
    await flush()
    await t.sessions.configure('chat', { mode: 'bypassPermissions' })
    expect(notes(t.store)).toEqual(['Bypass permissions starts once this turn ends.'])
    expect(t.call.modes).toEqual([])
  })

  it('tells the renderer the chat runs in its last mode until the turn ends, then in Bypass permissions (KERNEL-572)', async () => {
    const t = await setup('acceptEdits')
    const pushed: unknown[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'chat.runMode') pushed.push(e.mode) }
    bus.on('push', onPush)
    onTestFinished(() => { bus.off('push', onPush) })
    t.call.feed({ type: 'system', subtype: 'init', session_id: t.options.sessionId, apiKeySource: 'none' })
    await flush()
    await t.sessions.configure('chat', { mode: 'bypassPermissions' })
    expect(t.sessions.runMode('chat')).toEqual({ mode: 'acceptEdits', picked: 'bypassPermissions', pickedIn: 'chat', why: 'turnRunning' })
    expect(pushed).toEqual([{ mode: 'acceptEdits', picked: 'bypassPermissions', pickedIn: 'chat', why: 'turnRunning' }])
    t.call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 1 })
    await flush()
    expect(pushed.at(-1)).toEqual({ mode: 'bypassPermissions', picked: 'bypassPermissions', pickedIn: 'chat' })
  })

  it('in Bypass permissions, denies Never allow, a push that might reach a protected branch and network use, and has no opinion on Always ask', async () => {
    const t = await setup('bypassPermissions', { permissions: { protectedBranches: ['main'] } })
    expect(await t.runGuard('t1', 'git push origin main')).toEqual(denied(pushOwnBranch(['main'], 'feat/invoice-schema')))
    expect(await t.runGuard('t2', 'git push')).toEqual(denied(pushOwnBranch(['main'], 'feat/invoice-schema')))
    expect(await t.runGuard('t3', 'git push -u origin HEAD')).toEqual(denied(pushOwnBranch(['main'], 'feat/invoice-schema')))
    expect(await t.runGuard('t4', 'git push -u origin feat/invoice-schema')).toEqual({})
    expect(await t.runGuard('t5', 'pnpm drizzle-kit push')).toEqual({})
    expect(t.store.approvals({})).toEqual([])

    const never = await setup('bypassPermissions', { permissions: { neverAllow: ['rm -rf /'] } })
    expect(await never.runGuard('t6', 'rm -rf /')).toEqual(denied(neverAllowed('rm -rf /')))

    const off = await setup('bypassPermissions', { permissions: { network: false } })
    expect(await off.runGuard('t7', 'curl https://example.com')).toEqual(denied(neverAllowed('curl https://example.com')))
    expect(await run(off.options, 'WebFetch|WebSearch', 'WebFetch', { url: 'https://example.com' })).toEqual(denied(NETWORK_OFF))
    expect(await (off.options.canUseTool as CanUseTool)('WebSearch', { query: 'zod' }, { signal: signal(), toolUseID: 'w2', requestId: 'r' })).toEqual({ behavior: 'deny', message: NETWORK_OFF })
  })

  it("asks the user about Always ask in Auto from inside the hook, so Auto mode's classifier never answers it", async () => {
    const t = await setup('auto', { availability: autoWorks })
    expect(t.options.permissionMode).toBe('auto')
    expect(hook(t.options, 'Bash').timeout).toBe(HOLD_TIMEOUT_SEC)
    const asked = t.runGuard('t1', 'pnpm drizzle-kit push')
    await flush()
    const card = t.store.approvals({ pendingOnly: true })[0]
    expect(card).toMatchObject({ kind: 'tool', toolName: 'Bash', chatId: 'chat', title: 'Run pnpm drizzle-kit push', reason: ALWAYS_ASK })
    t.approvals.decide(card.id, { behavior: 'deny', message: 'Use the staging database.' })
    expect(await asked).toEqual(denied('Use the staging database.'))
  })

  it("doesn't ask about an Always ask command the agent file's tools line refuses, which the gate denies", async () => {
    const reader = { id: 'noor', name: 'Noor', role: 'Engine', description: '', lead: false, prompt: '', file: '/r/noor.md', tools: ['Read', 'Grep'] } as AgentDef
    const t = await setup('acceptEdits', { agent: reader })
    expect(await t.runGuard('t1', 'pnpm drizzle-kit push')).toEqual({})
    expect(t.store.approvals({})).toEqual([])
  })

  it("leaves a note naming what Auto mode's classifier refused, and none for other denials", async () => {
    const t = await setup('auto', { availability: autoWorks })
    t.call.feed({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf build' } }] } })
    t.call.feed({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu1', decision_reason_type: 'classifier', decision_reason: 'It deletes files the task never mentioned', message: 'Denied', uuid: 'd1', session_id: 's' })
    t.call.feed({ type: 'system', subtype: 'permission_denied', tool_name: 'Edit', tool_use_id: 'tu2', decision_reason_type: 'rule', decision_reason: 'Edit(.env) is denied', message: 'Denied', uuid: 'd2', session_id: 's' })
    t.call.feed({ type: 'system', subtype: 'permission_denied', tool_name: 'WebFetch', tool_use_id: 'tu3', decision_reason_type: 'classifier', message: '', uuid: 'd3', session_id: 's' })
    await flush()
    const row = t.store.items('chat').find((i) => i.kind === 'tool')
    expect(notes(t.store)).toEqual([`Auto mode refused "${row?.kind === 'tool' ? row.label : ''}": It deletes files the task never mentioned`, 'Auto mode refused WebFetch.'])
  })

  it('puts why Claude Code asked on the card: its reason, the path it stopped at and its description', async () => {
    const t = await setup()
    const answer = (t.options.canUseTool as CanUseTool)('Read', { file_path: '/etc/hosts' }, { signal: signal(), toolUseID: 'r1', requestId: 'x', decisionReason: 'Outside the allowed working directories.', blockedPath: '/etc/hosts', description: 'Claude will read files in /etc' })
    await flush()
    const card = t.store.approvals({ pendingOnly: true })[0]
    expect(card.reason).toBe('Outside the allowed working directories. Blocked path: /etc/hosts. Claude will read files in /etc.')
    t.approvals.decide(card.id, { behavior: 'allow' })
    await answer
    expect(askReason({})).toBeUndefined()
    expect(askReason({ decisionReason: 'Reads /etc/hosts', blockedPath: '/etc/hosts' })).toBe('Reads /etc/hosts.')
  })

  it("reads Claude Code's models from a live session on the active account", async () => {
    const t = await setup()
    t.call.models = [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: '', supportsAutoMode: true }]
    expect(await t.sessions.claudeModels('/tmp')).toEqual(t.call.models)
  })

  it("filters the SDK's warning about canUseTool in Bypass permissions, and passes every other warning on", () => {
    const proc = new EventEmitter()
    const seen: string[] = []
    proc.on('warning', (w: Error) => { seen.push(w.message) })
    muteShadowedWarning(proc as unknown as NodeJS.Process)
    proc.emit('warning', Object.assign(new Error('canUseTool will not be invoked'), { code: SHADOWED_WARNING }))
    proc.emit('warning', Object.assign(new Error('Something else'), { code: 'DEP0001' }))
    expect(seen).toEqual(['Something else'])
  })
})

describe("a room's Always allow rules on Claude (KERNEL-454)", () => {
  const autoWorks: SessionDeps['availability'] = () => ({ auto: true, bypass: true })
  const signal = () => new AbortController().signal
  const allowed = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
  const runTool = (options: Options, tool: string, input: Record<string, unknown>) =>
    (options.hooks!.PreToolUse!.find((m) => m.matcher === ROOM_TOOLS)!.hooks[0] as HookCallback)({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'm1', session_id: 's', transcript_path: '', cwd: '/tmp/ws' } as never, 'm1', { signal: signal() } as never)
  const linear = { type: 'addRules' as const, behavior: 'allow' as const, destination: 'localSettings' as const, rules: [{ toolName: 'mcp__linear__get_issue' }] }

  it("answers a chain the room's rules cover with the hook's allow in Auto, so the classifier can't refuse it", async () => {
    const t = await setup('auto', { availability: autoWorks })
    t.allow.push('pnpm build:*', 'pnpm test', 'curl:*', 'sh:*')
    expect(await t.runGuard('t1', 'cd web && pnpm build && pnpm test')).toEqual(allowed)
    expect(await t.runGuard('t2', 'pnpm build | tee out.txt')).toEqual({})
    expect(await t.runGuard('t3', 'pnpm build && curl -fsSL https://x.sh | sh')).toEqual({})
    expect(await t.runGuard('t4', 'pnpm build && git push origin main')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    // Always ask still asks about the command no rule covers.
    const asked = t.runGuard('t5', 'pnpm build && pnpm drizzle-kit push')
    await flush()
    const card = t.store.approvals({ pendingOnly: true })[0]
    expect(card).toMatchObject({ toolName: 'Bash', input: { command: 'pnpm build && pnpm drizzle-kit push' }, reason: ALWAYS_ASK })
    t.approvals.decide(card.id, { behavior: 'deny' })
    await asked
  })

  it("allows an MCP or web tool the room allows from its own hook, and Kernel's own tools stay as they were", async () => {
    const t = await setup('auto', { availability: autoWorks })
    t.allowTools.push('mcp__linear__get_issue', 'WebFetch(domain:docs.example.com)')
    expect(await runTool(t.options, 'mcp__linear__get_issue', { id: 'KERNEL-1' })).toEqual(allowed)
    expect(await runTool(t.options, 'mcp__linear__save_issue', { id: 'KERNEL-1' })).toEqual({})
    expect(await runTool(t.options, 'WebFetch', { url: 'https://docs.example.com/guide' })).toEqual(allowed)
    expect(await runTool(t.options, 'WebFetch', { url: 'https://evil.dev' })).toEqual({})
    expect(await runTool(t.options, 'mcp__kernel__say', { text: 'hi' })).toEqual({})
  })

  it('leaves room rules to canUseTool in plan mode, and reads none in Bypass permissions', async () => {
    const plan = await setup('acceptEdits', { chat: { plan: true } })
    plan.allow.push('pnpm test')
    plan.allowTools.push('mcp__linear__get_issue')
    expect(await plan.runGuard('t1', 'pnpm test')).toEqual({})
    expect(await runTool(plan.options, 'mcp__linear__get_issue', {})).toEqual({})
    expect(await (plan.options.canUseTool as CanUseTool)('mcp__linear__get_issue', {}, { signal: signal(), toolUseID: 'm2', requestId: 'r' })).toEqual({ behavior: 'allow', updatedInput: {} })

    const bypass = await setup('bypassPermissions')
    bypass.allow.push('pnpm test')
    bypass.allowTools.push('mcp__linear__get_issue')
    expect(await bypass.runGuard('t2', 'pnpm test')).toEqual({})
    expect(await runTool(bypass.options, 'mcp__linear__get_issue', {})).toEqual({})
    // What Claude Code still sends in Bypass permissions goes to the user, a room rule or not (KERNEL-433).
    void (bypass.options.canUseTool as CanUseTool)('mcp__linear__get_issue', {}, { signal: signal(), toolUseID: 'm3', requestId: 'r' })
    await flush()
    expect(bypass.store.approvals({ pendingOnly: true })).toHaveLength(1)
  })

  it("lets Network off and the agent file's tools line hold over a tool rule", async () => {
    const off = await setup('auto', { availability: autoWorks, permissions: { network: false } })
    off.allowTools.push('WebSearch')
    expect(await runTool(off.options, 'WebSearch', { query: 'zod' })).toEqual({})
    expect(await (off.options.canUseTool as CanUseTool)('WebSearch', { query: 'zod' }, { signal: signal(), toolUseID: 'w1', requestId: 'r' })).toEqual({ behavior: 'deny', message: NETWORK_OFF })

    const reader = { id: 'noor', name: 'Noor', role: 'Engine', description: '', lead: false, prompt: '', file: '/r/noor.md', tools: ['Read', 'mcp__linear__get_issue'] } as AgentDef
    const gated = await setup('acceptEdits', { agent: reader })
    gated.allow.push('pnpm test')
    gated.allowTools.push('mcp__linear')
    expect(await runTool(gated.options, 'mcp__linear__save_issue', {})).toEqual({})
    expect(await runTool(gated.options, 'mcp__linear__get_issue', {})).toEqual(allowed)
    expect(await gated.runGuard('t1', 'pnpm test')).toEqual({})
  })

  it('checks the room in canUseTool before it asks about an MCP tool', async () => {
    const t = await setup('default')
    t.allowTools.push('mcp__linear')
    expect(await (t.options.canUseTool as CanUseTool)('mcp__linear__get_issue', { id: 'KERNEL-1' }, { signal: signal(), toolUseID: 'm1', requestId: 'r', suggestions: [linear] })).toEqual({ behavior: 'allow', updatedInput: { id: 'KERNEL-1' } })
    expect(t.store.approvals({})).toEqual([])
  })

  it("saves Always allow on an MCP tool on the room, not as Claude Code's suggestion in the worktree", async () => {
    const t = await setup('default')
    const answer = (t.options.canUseTool as CanUseTool)('mcp__linear__get_issue', { id: 'KERNEL-1' }, { signal: signal(), toolUseID: 'm1', requestId: 'r', suggestions: [linear] })
    await flush()
    t.approvals.decide(t.store.approvals({ pendingOnly: true })[0].id, { behavior: 'allow', always: true })
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: { id: 'KERNEL-1' }, updatedPermissions: undefined })
    expect(t.allowTools).toEqual(['mcp__linear__get_issue'])
    // The next call in this room, from any chat, goes through without a card.
    expect(await (t.options.canUseTool as CanUseTool)('mcp__linear__get_issue', { id: 'KERNEL-2' }, { signal: signal(), toolUseID: 'm2', requestId: 'r' })).toMatchObject({ behavior: 'allow' })

    // A tool no room rule covers keeps Claude Code's own suggestion.
    const dirs = [{ type: 'addDirectories' as const, directories: ['/etc'], destination: 'session' as const }]
    const read = (t.options.canUseTool as CanUseTool)('Read', { file_path: '/etc/hosts' }, { signal: signal(), toolUseID: 'r1', requestId: 'r', suggestions: dirs })
    await flush()
    t.approvals.decide(t.store.approvals({ pendingOnly: true })[0].id, { behavior: 'allow', always: true })
    expect(await read).toEqual({ behavior: 'allow', updatedInput: { file_path: '/etc/hosts' }, updatedPermissions: dirs })
    expect(t.allowTools).toEqual(['mcp__linear__get_issue'])
  })
})

describe('Bypass permissions without the sandbox (KERNEL-571)', () => {
  const denied = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })

  it('starts every process without a sandbox, a process that may take Bypass permissions included', async () => {
    for (const mode of ['default', 'acceptEdits'] as const) expect((await setup(mode)).options).not.toHaveProperty('sandbox')
    expect((await setup('auto', { availability: () => ({ auto: true, bypass: true }) })).options).not.toHaveProperty('sandbox')
    expect((await setup('bypassPermissions')).options).not.toHaveProperty('sandbox')
    expect((await setup('bypassPermissions')).options).toMatchObject({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
    // A chat that plans before it bypasses still has the flag from its start (KERNEL-447).
    const planning = (await setup('bypassPermissions', { chat: { plan: true } })).options
    expect(planning).toMatchObject({ permissionMode: 'plan', allowDangerouslySkipPermissions: true })
    expect(planning).not.toHaveProperty('sandbox')
  })

  it("keeps Kernel's denials in Bypass permissions: Never allow, a push that might reach a protected branch, and network off", async () => {
    const t = await setup('bypassPermissions', { permissions: { protectedBranches: ['main'], neverAllow: ['rm -rf /'] } })
    expect(await t.runGuard('t1', 'rm -rf /')).toEqual(denied(neverAllowed('rm -rf /')))
    expect(await t.runGuard('t2', 'git push origin main')).toEqual(denied(pushOwnBranch(['main'], 'feat/invoice-schema')))
    expect(await t.runGuard('t3', 'git push')).toEqual(denied(pushOwnBranch(['main'], 'feat/invoice-schema')))
    // The screenshot commands an agent chains after a cd run without a word from Kernel.
    expect(await t.runGuard('t4', 'cd /tmp/ws && pnpm shots Settings')).toEqual({})
    const off = await setup('bypassPermissions', { permissions: { network: false } })
    expect(await off.runGuard('t5', 'curl https://github.com')).toEqual(denied(neverAllowed('curl https://github.com')))
    expect(await (off.options.canUseTool as CanUseTool)('WebFetch', { url: 'https://github.com' }, { signal: new AbortController().signal, toolUseID: 'w1', requestId: 'r' })).toEqual({ behavior: 'deny', message: NETWORK_OFF })
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
    expect(row(store, 'ag1')).toMatchObject({ label: 'Run agent: Explore engine for Linear plan · Haiku 4.5', detail: 'Explore engine for Linear plan', status: 'running' })
    call.feed(sub('ag1', 'claude-sonnet-5-5', 1))
    call.feed(result('ag1'))
    await flush()
    expect(row(store, 'ag1')).toMatchObject({ label: 'Run agent: Explore engine for Linear plan · Haiku 4.5', detail: 'Explore engine for Linear plan', status: 'done' })
  })

  it("names the subagent's real model from its first message and keeps it on the saved done row", async () => {
    const { call, store, kinds } = await setup()
    call.feed(agent('ag2', { description: 'Explore design canvas and docs' }))
    await flush()
    expect(row(store, 'ag2')).toMatchObject({ label: 'Run agent: Explore design canvas and docs', detail: 'Explore design canvas and docs' })
    call.feed(sub('ag2', 'claude-sonnet-5-5', 1))
    call.feed(sub('ag2', 'claude-opus-5-5', 2))
    await flush()
    expect(row(store, 'ag2')).toMatchObject({ label: 'Run agent: Explore design canvas and docs · Sonnet 5.5', status: 'running' })
    call.feed(result('ag2'))
    await flush()
    expect(row(store, 'ag2')).toMatchObject({ label: 'Run agent: Explore design canvas and docs · Sonnet 5.5', detail: 'Explore design canvas and docs', status: 'done', output: 'Found it' })
    // The subagent's own steps stay inside the row.
    expect(kinds()).toEqual(['user', 'tool'])
  })

  it('names a subagent that answers after its row is done', async () => {
    const { call, store } = await setup()
    call.feed(agent('ag3', { description: 'Check the logs' }))
    call.feed(result('ag3'))
    call.feed(sub('ag3', 'claude-haiku-4-5-20251001', 1))
    await flush()
    expect(row(store, 'ag3')).toMatchObject({ label: 'Run agent: Check the logs · Haiku 4.5', detail: 'Check the logs', status: 'done', output: 'Found it' })
  })

  it('keeps an unknown model id as it is, and reads the old Task name', async () => {
    const { call, store } = await setup()
    call.feed({ type: 'assistant', uuid: 'a-t1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: 'Check the logs', prompt: 'Go' } }] } })
    call.feed(sub('t1', 'claude-mystery-9', 1))
    await flush()
    expect(row(store, 't1')).toMatchObject({ label: 'Run agent: Check the logs · claude-mystery-9', detail: 'Check the logs' })
  })

  it("names a fork from its first message, since a fork ignores the call's model", async () => {
    const { call, store } = await setup()
    call.feed(agent('f1', { description: 'Try the other approach', subagent_type: 'fork', model: 'haiku' }))
    await flush()
    expect(row(store, 'f1')).toMatchObject({ label: 'Run agent: Try the other approach' })
    call.feed(sub('f1', 'claude-sonnet-5-5', 1))
    await flush()
    expect(row(store, 'f1')).toMatchObject({ label: 'Run agent: Try the other approach · Sonnet 5.5' })
  })

  it('leaves the row as Agent when no model is known', async () => {
    const { call, store } = await setup()
    call.feed(agent('ag4', { description: 'Stopped early' }))
    call.feed(sub('ag4', '<synthetic>', 1))
    call.feed(result('ag4'))
    await flush()
    expect(row(store, 'ag4')).toMatchObject({ label: 'Run agent: Stopped early', detail: 'Stopped early' })
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
    expect(row(store, 'r1')).toMatchObject({ label: 'Read: src/main/db.ts', detail: 'src/main/db.ts' })
    expect(row(store, 'm1')).toMatchObject({ label: 'Say', detail: '' })
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

describe('holding teammates near a usage limit (KERNEL-220)', () => {
  const kernel: AgentDef = { id: 'kernel', file: '.claude/agents/kernel.md', name: 'Kernel', role: 'Lead', description: 'Plans', lead: true, prompt: 'You are Kernel.' }
  const text = (t: string) => [{ type: 'text' as const, text: t }]
  const result = (id: string) => ({ type: 'result', subtype: 'success', is_error: false, uuid: id, duration_ms: 1, result: '', session_id: 's' })
  const secs = (ms: number) => Math.round(ms / 1000)
  /** A `rate_limit_event`, as Claude Code sends it. */
  const event = (type: 'five_hour' | 'seven_day', utilization: number | undefined, o: { status?: string; resetsAt?: number } = {}) => ({
    type: 'rate_limit_event', uuid: `l-${type}-${utilization}-${Math.random()}`, session_id: 's',
    rate_limit_info: { status: o.status ?? 'allowed', rateLimitType: type, ...(utilization === undefined ? {} : { utilization }), resetsAt: o.resetsAt ?? secs(Date.now() + 3600_000) }
  })

  /** A teammate chat that finished a turn, and the Lead's chat in another workspace. Near-limit holds are on. */
  async function room(usage: AppSettings['usage'] = { pauseNearLimit: true, warnBeforeWeekly: true }) {
    const s = await setup('acceptEdits', { usage, agentFor: (ws) => (ws.id === 'wsLead' ? kernel : undefined) })
    s.store.saveWorkspace({ id: 'wsLead', roomId: 'room', name: 'lead', branch: 'HEAD', baseRef: 'main', path: '/tmp/wsLead', mode: 'worktree', agentId: 'kernel', lead: true, port: 4302, status: 'ready', prState: 'none', createdAt: 3 })
    s.store.saveChat({ ...s.chat, id: 'leadChat', workspaceId: 'wsLead', title: 'Lead' })
    s.call.feed(result('r1'))
    await flush()
    expect(s.sessions.isRunning('chat')).toBe(false)
    const lines: { chatId: string; why?: string }[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'chat.queue') lines.push({ chatId: e.chatId, why: e.why }) }
    bus.on('push', onPush)
    onTestFinished(() => { bus.off('push', onPush) })
    return { ...s, lines }
  }

  it('holds a teammate\'s new turn at 91% of the 5-hour window with reason limit, and lets the Lead\'s run', async () => {
    const s = await room()
    s.call.feed(event('five_hour', 0.91))
    await flush()
    const before = sdk.calls.length
    expect(await s.sessions.send('chat', text('Next task'))).toEqual({ queued: true, why: 'limit' })
    expect(s.sessions.queueReason('chat')).toBe('limit')
    expect(s.sessions.isRunning('chat')).toBe(false)
    // The Lead's chats are never held, so Kernel can still answer the user.
    expect(await s.sessions.send('leadChat', text('Plan it'))).toEqual({ queued: false })
    expect(s.sessions.isRunning('leadChat')).toBe(true)
    expect(sdk.calls).toHaveLength(before + 1)
    await flush()
    expect(s.lines.filter((l) => l.chatId === 'chat').at(-1)).toEqual({ chatId: 'chat', why: 'limit' })
  })

  it('goes out when usage drops, and when the window resets', async () => {
    const s = await room()
    s.call.feed(event('five_hour', 0.91))
    await flush()
    await s.sessions.send('chat', text('Next task'))
    expect(s.sessions.queued('chat')).toHaveLength(1)
    // A reading back under 90% sends what waited.
    s.call.feed(event('five_hour', 0.5))
    await flush()
    expect(s.sessions.isRunning('chat')).toBe(true)
    expect(s.sessions.queued('chat')).toEqual([])
    expect(s.lines.filter((l) => l.chatId === 'chat').at(-1)).toEqual({ chatId: 'chat', why: undefined })
    s.call.feed(result('r2'))
    await flush()
    // The window fills again and then resets: the reset sends it.
    s.call.feed(event('five_hour', 0.95))
    await flush()
    await s.sessions.send('chat', text('Third task'))
    expect(s.sessions.queueReason('chat')).toBe('limit')
    s.sessions.resetLimit('five_hour')
    expect(s.sessions.isRunning('chat')).toBe(true)
    expect(s.sessions.queued('chat')).toEqual([])
  })

  it('lets a running turn finish, and holds what comes after it', async () => {
    const s = await room()
    await s.sessions.send('chat', text('Working'))
    expect(s.sessions.isRunning('chat')).toBe(true)
    s.call.feed(event('five_hour', 0.92))
    await flush()
    expect(s.sessions.isRunning('chat')).toBe(true)
    expect(await s.sessions.send('chat', text('Then this'))).toEqual({ queued: true, why: 'running' })
    s.call.feed(result('r2'))
    await flush()
    // The turn ended, and the held message waits for the limit instead of going out.
    expect(s.sessions.isRunning('chat')).toBe(false)
    expect(s.sessions.queueReason('chat')).toBe('limit')
  })

  it('holds at 95% of the weekly window, and at neither 89% of the 5-hour window nor 94% of the weekly one', async () => {
    const s = await room()
    for (const [type, used] of [['five_hour', 0.89], ['seven_day', 0.94]] as const) {
      s.call.feed(event(type, used))
      await flush()
      expect(s.sessions.waitsFor('chat'), `${type} ${used}`).toBeUndefined()
    }
    s.call.feed(event('seven_day', 0.95))
    await flush()
    expect(s.sessions.waitsFor('chat')).toBe('limit')
    s.call.feed(event('seven_day', 0.2))
    await flush()
    expect(s.sessions.waitsFor('chat')).toBeUndefined()
  })

  it('reads a warning with no number as close to the limit, and a number as the number', async () => {
    const s = await room()
    s.call.feed(event('five_hour', undefined, { status: 'allowed_warning' }))
    await flush()
    expect(s.sessions.waitsFor('chat')).toBe('limit')
    // Claude Code warns early. A warning at 50% of the weekly window holds nothing.
    s.call.feed(event('five_hour', 0.5))
    s.call.feed(event('seven_day', 0.5, { status: 'allowed_warning' }))
    await flush()
    expect(s.sessions.waitsFor('chat')).toBeUndefined()
  })

  it('holds nothing when the switch in Settings, Account is off, or when the window has already reset', async () => {
    const off = await room({ pauseNearLimit: false, warnBeforeWeekly: true })
    off.call.feed(event('five_hour', 0.99))
    await flush()
    expect(off.sessions.waitsFor('chat')).toBeUndefined()
    const past = await room()
    past.call.feed(event('five_hour', 0.99, { resetsAt: secs(Date.now() - 60_000) }))
    await flush()
    expect(past.sessions.waitsFor('chat')).toBeUndefined()
  })

  it('releases what waited when the switch is turned off', async () => {
    const s = await room()
    s.call.feed(event('five_hour', 0.93))
    await flush()
    await s.sessions.send('chat', text('Next task'))
    expect(s.sessions.queueReason('chat')).toBe('limit')
    const before = structuredClone(s.settings)
    s.settings.usage.pauseNearLimit = false
    s.sessions.applySettings(before)
    expect(s.sessions.isRunning('chat')).toBe(true)
  })

  it("holds Kernel's own posts and a carried-on chat too, and Send now goes past it", async () => {
    const s = await room()
    s.call.feed(event('five_hour', 0.93))
    await flush()
    expect(s.sessions.post('chat', text('Team update from Kernel'))).toBe(false)
    expect(s.sessions.isRunning('chat')).toBe(false)
    // A chat a limit cut off waits here too, and carries on when usage drops.
    s.sessions.restore([], { chat: 'limit' })
    expect(s.sessions.isRunning('chat')).toBe(false)
    s.call.feed(event('five_hour', 0.4))
    await flush()
    expect(s.sessions.isRunning('chat')).toBe(true)
    s.call.feed(result('r2'))
    await flush()
    // The user pressing Send now chooses to go past the hold.
    s.call.feed(event('five_hour', 0.97))
    await flush()
    await s.sessions.send('chat', text('Urgent'))
    expect(s.sessions.queueReason('chat')).toBe('limit')
    await s.sessions.sendNow('chat', s.sessions.queued('chat')[0].id)
    expect(s.sessions.isRunning('chat')).toBe(true)
  })

  /** `count` teammate chats, c1 to cN, each in its own workspace, none running. */
  function cutOffChats(s: Awaited<ReturnType<typeof room>>, count: number) {
    const ids = Array.from({ length: count }, (_, i) => `c${i + 1}`)
    ids.forEach((id, i) => {
      s.store.saveWorkspace({ id: `w-${id}`, roomId: 'room', name: id, branch: `feat/${id}`, baseRef: 'main', path: `/tmp/${id}`, mode: 'worktree', agentId: 'noor', port: 4400 + i, status: 'ready', prState: 'none', createdAt: 10 + i })
      s.store.saveChat({ ...s.chat, id, workspaceId: `w-${id}`, title: id })
    })
    const runningNow = () => ids.filter((id) => s.sessions.isRunning(id))
    // The newest session in that folder, since an earlier test used the same ones.
    const callOf = (id: string) => [...sdk.calls].reverse().find((c) => c.options.cwd === `/tmp/${id}`)!
    const finish = async (id: string) => { callOf(id).feed(result(`done-${id}`)); await flush() }
    return { ids, runningNow, finish, callOf }
  }

  it('resumes 5 chats a limit cut off two at a time, the next as one ends its turn', async () => {
    const s = await room()
    const { ids, runningNow, finish } = cutOffChats(s, 5)
    s.sessions.restore([], Object.fromEntries(ids.map((id) => [id, 'limit' as const])))
    expect(runningNow()).toEqual(['c1', 'c2'])
    await finish('c1')
    expect(runningNow()).toEqual(['c2', 'c3'])
    await finish('c2')
    expect(runningNow()).toEqual(['c3', 'c4'])
    await finish('c3')
    await finish('c4')
    expect(runningNow()).toEqual(['c5'])
    await finish('c5')
    expect(runningNow()).toEqual([])
    // Each one was told the limit lifted, once.
    for (const id of ids) expect(s.store.items(id).filter((i) => i.kind === 'user').map((i) => (i as { parts: { text: string }[] }).parts[0].text)).toEqual([LIMIT_LIFTED])
  })

  it('resumes chats with a message queued two at a time too, whichever way their queues are released', async () => {
    const s = await room()
    const { ids, runningNow, finish } = cutOffChats(s, 4)
    s.sessions.pause('room')
    for (const id of ids) expect(await s.sessions.send(id, text(`Queued for ${id}`))).toEqual({ queued: true, why: 'paused' })
    s.sessions.restore([], Object.fromEntries(ids.map((id) => [id, 'limit' as const])))
    expect(runningNow()).toEqual([])
    s.sessions.resume('room')
    expect(runningNow()).toEqual(['c1', 'c2'])
    await finish('c1')
    expect(runningNow()).toEqual(['c2', 'c3'])
    await finish('c2')
    await finish('c3')
    expect(runningNow()).toEqual(['c4'])
    // What each had queued went out, in place of the nudge.
    for (const id of ids) expect(s.store.items(id).filter((i) => i.kind === 'user').map((i) => (i as { parts: { text: string }[] }).parts[0].text)).toEqual([`Queued for ${id}`])
  })

  it('does not stagger the chats a quit cut off', async () => {
    const s = await room()
    const { ids, runningNow } = cutOffChats(s, 5)
    s.sessions.restore([], Object.fromEntries(ids.map((id) => [id, 'quit' as const])))
    expect(runningNow()).toEqual(ids)
  })

  it('keeps the two slots when a resumed chat ends without a turn, so the rest still start', async () => {
    const s = await room()
    const { ids, runningNow, callOf } = cutOffChats(s, 3)
    s.sessions.restore([], Object.fromEntries(ids.map((id) => [id, 'limit' as const])))
    expect(runningNow()).toEqual(['c1', 'c2'])
    // c1's process dies mid-turn instead of finishing it.
    callOf('c1').end()
    await flush()
    s.sessions.drainWaiting()
    expect(runningNow()).toContain('c3')
  })

  it('tells the Lead why a hand-off waits (the tools word it for Kernel)', async () => {
    const { queuedNote } = await import('../src/main/services/kernelMcp')
    expect(queuedNote('limit', { name: 'Kai', brief: true })).toBe("Usage is close to the limit, so Kai hasn't started. The brief goes out when it resets or usage drops.")
    expect(queuedNote('limit', { name: 'Kai' })).toBe('Usage is close to the limit, so the message goes out when it resets or usage drops.')
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
    const lead: AgentDef = { id: 'kernel', file: '.claude/agents/kernel.md', name: 'Kernel', role: 'Lead', description: 'Plans', lead: true, prompt: 'You are Kernel.' }
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

describe('images in a chat message (KERNEL-545)', () => {
  const png = (bytes: string) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
  const parts: ChatPart[] = [
    { type: 'text', text: 'look at' },
    { type: 'image', name: 'image.png', dataUrl: png('first'), width: 800, height: 600 },
    { type: 'text', text: 'and compare with' },
    { type: 'image', name: 'image.png', dataUrl: png('second'), width: 1440, height: 900 }
  ]
  const sentText = [
    'look at',
    '[Image 1: .kernel/attachments/image.png, 800x600]',
    'and compare with',
    '[Image 2: .kernel/attachments/image-2.png, 1440x900]',
    'Read each of the 2 attached images with the Read tool before answering.'
  ]
  /** The text blocks of the next message Kernel sent the session. */
  const nextBlocks = async (call: Call) => ((await call.prompt[Symbol.asyncIterator]().next()).value.message.content as { text?: string }[]).map((b) => b.text)

  it('saves the images of a queued message to the workspace when it goes, and names each where it sat', async () => {
    const repo = await tempRepo()
    const s = await setup('acceptEdits', { ws: { path: repo } })
    expect(await s.sessions.send('chat', parts)).toEqual({ queued: true, why: 'running' })
    await expect(readdir(join(repo, '.kernel/attachments'))).rejects.toThrow()
    expect(await nextSent(s.call)).toBe('Add a pdf_url column')
    s.call.feed({ type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 5 })
    expect(await nextBlocks(s.call)).toEqual(sentText)
    expect(await readFile(join(repo, '.kernel/attachments/image.png'), 'utf8')).toBe('first')
    expect(await readFile(join(repo, '.kernel/attachments/image-2.png'), 'utf8')).toBe('second')
    expect((await run('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'])).trim()).toBe('')
    // The user's bubble shows the images as they were sent.
    expect(s.store.items('chat').filter((i) => i.kind === 'user').at(-1)).toMatchObject({ parts })
  })

  it('sends a fresh session the same files when the resumed one is gone, without saving them again', async () => {
    const repo = await tempRepo()
    const s = await setup('acceptEdits', { ws: { path: repo } })
    s.store.saveChat({ ...s.chat, id: 'old', sessionId: 'gone-1' })
    await s.sessions.send('old', parts)
    const first = sdk.calls.at(-1)!
    expect(await nextBlocks(first)).toEqual(sentText)
    gone(first, 'gone-1')
    await flush()
    const fresh = sdk.calls.at(-1)!
    expect(fresh).not.toBe(first)
    expect(await nextBlocks(fresh)).toEqual(sentText)
    expect((await readdir(join(repo, '.kernel/attachments'))).sort()).toEqual(['image-2.png', 'image.png'])
  })
})
