import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import type { Chat, ChatItem, Workspace } from '@shared/types'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { Sessions } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'

// The SDK is replaced by a scripted session: each query() records its options and yields whatever the test feeds it.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void; interrupts: number }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: unknown }) => {
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    const call = { options, interrupts: 0, feed: (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) } }
    sdk.calls.push(call)
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : new Promise((r) => waiters.push(r))) }),
      interrupt: async () => { call.interrupts++ },
      setModel: async () => {},
      setPermissionMode: async () => {}
    }
  }
}))

const flush = () => new Promise((r) => setTimeout(r, 10))

async function setup() {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-runner-')), 'kernel.db'))
  const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
  const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 }
  store.saveWorkspace(ws)
  store.saveChat(chat)
  const allow: string[] = []
  const approvals = new Approvals(store)
  const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: ['drizzle-kit push'], neverAllow: ['git push origin main'], protectedBranches: [], approvalTimeoutSec: 300 } } as unknown as AppSettings
  const sessions = new Sessions({
    store, approvals, settings: () => settings, agentFor: () => undefined, mcpFor: () => undefined,
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

  it('flags a session billed to an API key', async () => {
    const { sessions, call, options, store, chat } = await setup()
    call.feed({ type: 'system', subtype: 'init', session_id: options.sessionId, apiKeySource: 'ANTHROPIC_API_KEY' })
    await flush()
    expect(sessions.billingOf(chat.id)).toBe('ANTHROPIC_API_KEY')
    expect(store.items(chat.id).find((i) => i.kind === 'note')).toMatchObject({ text: 'This session is billed through ANTHROPIC_API_KEY, not your Claude plan.' })
  })
})
