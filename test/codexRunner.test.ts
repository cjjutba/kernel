import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AgentDef, Chat, ChatItem, RateLimit, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { forProvider, HANDOFF_NOW, HANDOFF_REMINDER, kernelTool, LEAD_RULE, TEAMMATE_RULE } from '../src/main/services/handoff'
import { SESSION_GONE_NOTE, Sessions } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'
import { codexLimits, PLAN_APPROVED, planChanges, toCodexInput, unwrapShell } from '../src/main/services/providers/codex/runner'
import { callTool, mcpOverrides, toolSpecs } from '../src/main/services/providers/codex/tools'
import { toolPolicy } from '../src/main/services/agentTools'
import { fakeCodex, item, script } from './helpers/fakeCodex'
import { tempRepo } from './helpers'

/** Waits until `check` passes, for what the fake app-server sends on its own time. */
async function until<T>(check: () => T | Promise<T>, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    try { const v = await check(); if (v) return v as NonNullable<T> } catch (e) { if (Date.now() > end) throw e }
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const noor: AgentDef = { id: 'noor', file: '.claude/agents/noor.md', name: 'Noor', role: 'Engine', description: 'Engine engineer', lead: false, prompt: 'You are Noor.' } as AgentDef
const rowan: AgentDef = { ...noor, id: 'rowan', name: 'Rowan', role: 'Lead', lead: true, prompt: 'You are Rowan.' }

async function setup(o: { mode?: AppSettings['permissions']['mode']; network?: boolean; agent?: AgentDef; chat?: Partial<Chat>; neverAllow?: string[]; mcp?: string } = {}) {
  const fake = await fakeCodex()
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-codex-')), 'kernel.db'))
  const repo = await tempRepo()
  const ws: Workspace = { id: 'ws', roomId: 'room', name: 'invoice-schema', branch: 'feat/invoice-schema', baseRef: 'main', path: repo, mode: 'worktree', agentId: (o.agent ?? noor).id, port: 4300, status: 'ready', prState: 'none', createdAt: 1, ...(o.agent?.lead ? { lead: true } : {}) }
  const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Invoice schema', kind: 'chat', provider: 'codex', model: 'gpt-6-astra', effort: 'medium', plan: false, createdAt: 1, ...o.chat }
  store.saveWorkspace(ws)
  store.saveChat(chat)
  const allow: string[] = []
  const approvals = new Approvals(store)
  const settings = { permissions: { mode: o.mode ?? 'acceptEdits', network: o.network ?? true, alwaysAsk: ['drizzle-kit push'], neverAllow: o.neverAllow ?? ['git push origin main'], protectedBranches: ['main'], approvalTimeoutSec: 300 }, providers: { codex: { path: fake.bin, useSystem: false, personality: 'pragmatic' } } } as unknown as AppSettings
  const pings: unknown[] = []
  const reached = { count: 0 }
  const tools = [tool('ping', 'Ping Kernel.', { text: z.string() }, async ({ text }) => { pings.push(text); return { content: [{ type: 'text' as const, text: `pong ${text}` }] } })]
  const sessions = new Sessions({
    store, approvals, settings: () => settings, agentFor: () => o.agent ?? noor, mcpFor: () => undefined, envFor: () => (o.mcp ? { ...fake.env, FAKE_CODEX_MCP: o.mcp } : fake.env),
    roomAllow: () => allow, allowInRoom: (_room, rule) => { allow.push(rule) }, onReached: () => { reached.count++ },
    codexFor: () => ({ bin: fake.bin, personality: 'pragmatic', tools, instructions: o.agent?.lead ? 'Lead tools.' : undefined })
  })
  const items = () => store.items(chat.id)
  const of = <K extends ChatItem['kind']>(kind: K) => items().filter((i): i is Extract<ChatItem, { kind: K }> => i.kind === kind)
  const sent = async (method: string) => (await fake.messages()).filter((m) => m.method === method)
  const answers = async (method: string) => (await fake.messages()).filter((m) => m.answer === method).map((m) => m.result)
  const idle = () => until(() => !sessions.isRunning(chat.id))
  const pending = () => until(() => store.approvals({ pendingOnly: true })[0])
  return { fake, store, sessions, approvals, chat, ws, allow, items, of, sent, answers, idle, pending, pings, settings, repo, reached }
}

let open: Sessions[] = []
afterEach(() => { for (const s of open) s.stopAll(); open = []; bus.removeAllListeners('push') })
const track = <T extends { sessions: Sessions }>(t: T) => { open.push(t.sessions); return t }

describe('a chat on Codex (KERNEL-406)', () => {
  it("starts a thread with the agent's prompt, Kernel's tools and the sandbox, and resumes the chat by its id", async () => {
    const t = track(await setup())
    await t.sessions.send('chat', [{ type: 'text', text: 'hello' }])
    await t.idle()
    const [start] = await t.sent('thread/start')
    expect(start.params).toMatchObject({ cwd: t.repo, model: 'gpt-6-astra', approvalPolicy: 'untrusted', sandbox: 'workspace-write', personality: 'pragmatic' })
    expect(start.params.developerInstructions).toContain('You are Noor.')
    expect(start.params.dynamicTools).toEqual([{ type: 'function', name: 'kernel_ping', description: 'Ping Kernel.', inputSchema: expect.objectContaining({ type: 'object', required: ['text'] }) }])
    const [turn] = await t.sent('turn/start')
    expect(turn.params).toMatchObject({ threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }], model: 'gpt-6-astra', effort: 'medium', summary: 'auto', approvalPolicy: 'untrusted', collaborationMode: { mode: 'default' } })
    // A worktree commits into the repo's shared git folder, which sits outside it.
    expect(turn.params.sandboxPolicy).toEqual({ type: 'workspaceWrite', writableRoots: [join(t.repo, '.git')], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false })
    expect(t.store.chat('chat')?.sessionId).toBe('thread-1')
    expect(t.of('text').map((i) => i.text)).toEqual(['Done.'])
    expect(t.of('result')).toMatchObject([{ ok: true, durationMs: 1200 }])
    // The finished turn tells Kernel's network check that the API answered (KERNEL-231).
    expect(t.reached.count).toBe(1)
    // Stopped and sent again, it resumes the thread rather than starting another.
    t.sessions.stop('chat')
    await t.sessions.send('chat', [{ type: 'text', text: 'again' }])
    await until(async () => (await t.sent('thread/resume')).length === 1)
    expect((await t.sent('thread/resume'))[0].params).toMatchObject({ threadId: 'thread-1', developerInstructions: expect.stringContaining('You are Noor.') })
  })

  it('shows thinking, commands, edits, tools and replies as the rows Claude chats have', async () => {
    const t = track(await setup())
    await t.sessions.send('chat', [{ type: 'text', text: script(
      { notify: 'item/completed', params: { item: { type: 'reasoning', id: 'r1', summary: ['**Reading the schema**'], content: [] } } },
      { notify: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: '/bin/zsh -lc "pnpm test"', cwd: '/x', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null } } },
      { notify: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', command: '/bin/zsh -lc "pnpm test"', cwd: '/x', status: 'completed', commandActions: [], aggregatedOutput: '12 passed', exitCode: 0 } } },
      ...item({ type: 'fileChange', id: 'f1', changes: [{ path: 'src/db/schema.ts', kind: { type: 'update', move_path: null }, diff: '+pdf_url' }], status: 'completed' }),
      ...item({ type: 'mcpToolCall', id: 'm1', server: 'linear', tool: 'get_issue', status: 'completed', arguments: { id: 'KERNEL-1' }, result: { content: [{ type: 'text', text: 'Issue' }] }, error: null }),
      { notify: 'item/started', params: { item: { type: 'dynamicToolCall', id: 'd1', namespace: null, tool: 'kernel_ping', arguments: { text: 'hi' }, status: 'inProgress' } } },
      { request: 'item/tool/call', params: { threadId: '$thread', turnId: '$turn', callId: 'd1', namespace: null, tool: 'kernel_ping', arguments: { text: 'hi' } } },
      { notify: 'item/completed', params: { item: { type: 'dynamicToolCall', id: 'd1', namespace: null, tool: 'kernel_ping', arguments: { text: 'hi' }, status: 'completed', contentItems: [{ type: 'inputText', text: 'pong hi' }], success: true } } },
      { notify: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'Added the column.', phase: 'final_answer' } } }
    ) }])
    await t.idle()
    expect(t.of('thinking').map((i) => i.text)).toEqual(['**Reading the schema**'])
    expect(t.of('tool').map((i) => [i.name, i.label, i.status, i.output])).toEqual([
      ['Bash', 'Run pnpm test', 'done', '12 passed'],
      ['Edit', 'Edit src/db/schema.ts', 'done', '+pdf_url'],
      ['mcp__linear__get_issue', 'linear · get_issue', 'done', 'Issue'],
      ['mcp__kernel__ping', 'kernel · ping', 'done', 'pong hi']
    ])
    expect(t.pings).toEqual(['hi'])
    expect(await t.answers('item/tool/call')).toEqual([{ contentItems: [{ type: 'inputText', text: 'pong hi' }], success: true }])
    expect(t.of('text').map((i) => i.text)).toEqual(['Added the column.'])
  })

  it('declines Never allow without asking, accepts a room rule, and accepts typing into a running terminal in Accept edits', async () => {
    const t = track(await setup())
    t.allow.push('pnpm test')
    const ask = (id: string, command: string, kind = 'command') => ({ request: 'item/commandExecution/requestApproval', params: { kind, threadId: '$thread', turnId: '$turn', itemId: id, startedAtMs: 1, environmentId: 'local', command } })
    await t.sessions.send('chat', [{ type: 'text', text: script(ask('c1', '/bin/zsh -lc "git push origin main"'), ask('c2', 'pnpm test'), ask('c3', 'y', 'writeStdin')) }])
    await t.idle()
    expect(await t.answers('item/commandExecution/requestApproval')).toEqual([{ decision: 'decline' }, { decision: 'accept' }, { decision: 'accept' }])
    expect(t.store.approvals({})).toEqual([])
    expect(t.of('note').map((n) => n.text)).toEqual(['Kernel blocks "git push origin main" in every room.'])
  })

  it.each(['acceptEdits', 'bypassPermissions'] as const)('asks in %s before any command Codex asks about, which it would run outside its sandbox, the retry after a sandbox failure included', async (mode) => {
    const t = track(await setup({ mode }))
    const ask = (id: string, command: string, reason?: string) => ({ request: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: '$thread', turnId: '$turn', itemId: id, startedAtMs: 1, environmentId: 'local', command, ...(reason ? { reason } : {}) } })
    await t.sessions.send('chat', [{ type: 'text', text: script(ask('c1', "/bin/zsh -lc 'touch ../outside.txt'"), ask('c1', "/bin/zsh -lc 'pnpm build'", 'command failed; retry without sandbox?')) }])
    const first = await t.pending()
    expect(first).toMatchObject({ kind: 'tool', toolName: 'Bash', title: 'Run touch ../outside.txt', detail: 'Codex runs it outside its sandbox' })
    t.approvals.decide(first.id, { behavior: 'deny' })
    const retry = await until(() => t.store.approvals({ pendingOnly: true }).find((a) => a.id !== first.id))
    expect(retry).toMatchObject({ title: 'Run pnpm build', detail: 'command failed; retry without sandbox?. Codex runs it outside its sandbox' })
    t.approvals.decide(retry.id, { behavior: 'allow' })
    await t.idle()
    expect(await t.answers('item/commandExecution/requestApproval')).toEqual([{ decision: 'decline' }, { decision: 'accept' }])
  })

  it('asks the user for Always ask commands and for every command in Ask, and saves "Always allow in this room"', async () => {
    const t = track(await setup({ mode: 'default' }))
    await t.sessions.send('chat', [{ type: 'text', text: script({ request: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: '$thread', turnId: '$turn', itemId: 'c1', startedAtMs: 1, environmentId: 'local', command: '/bin/zsh -lc "pnpm build"' } }) }])
    const card = await t.pending()
    expect(card).toMatchObject({ kind: 'tool', toolName: 'Bash', title: 'Run pnpm build', chatId: 'chat' })
    expect(t.of('approval')).toHaveLength(1)
    t.approvals.decide(card.id, { behavior: 'allow', always: true })
    await t.idle()
    expect(await t.answers('item/commandExecution/requestApproval')).toEqual([{ decision: 'accept' }])
    expect(t.allow).toEqual(['pnpm build'])
  })

  it('asks before an Always ask command and before leaving the sandbox in Accept edits, and declines network use with Network off', async () => {
    const t = track(await setup())
    await t.sessions.send('chat', [{ type: 'text', text: script({ request: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: '$thread', turnId: '$turn', itemId: 'c1', startedAtMs: 1, environmentId: 'local', command: 'pnpm drizzle-kit push' } }, { request: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: '$thread', turnId: '$turn', itemId: 'c2', startedAtMs: 1, environmentId: 'local', command: 'npm view zod', networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' } } }) }])
    const first = await t.pending()
    expect(first.title).toBe('Run pnpm drizzle-kit push')
    t.approvals.decide(first.id, { behavior: 'deny' })
    const second = await until(() => t.store.approvals({ pendingOnly: true }).find((a) => a.id !== first.id))
    t.approvals.decide(second.id, { behavior: 'allow' })
    await t.idle()
    expect(await t.answers('item/commandExecution/requestApproval')).toEqual([{ decision: 'decline' }, { decision: 'accept' }])

    const off = track(await setup({ network: false }))
    await off.sessions.send('chat', [{ type: 'text', text: script({ request: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: '$thread', turnId: '$turn', itemId: 'c1', startedAtMs: 1, environmentId: 'local', command: '/bin/zsh -lc "curl https://example.com"' } }) }])
    await off.idle()
    expect(await off.answers('item/commandExecution/requestApproval')).toEqual([{ decision: 'decline' }])
    expect(off.of('note').map((n) => n.text)).toEqual(['Network access is off in Kernel (Settings, Permissions).'])
    expect((await off.sent('turn/start'))[0].params.sandboxPolicy.networkAccess).toBe(false)
  })

  it('accepts file edits in Accept edits and asks for them in Ask', async () => {
    const files = (t: Awaited<ReturnType<typeof setup>>) => t.sessions.send('chat', [{ type: 'text', text: script({ notify: 'item/started', params: { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'notes.md', kind: { type: 'add' }, diff: '+hi' }], status: 'inProgress' } } }, { request: 'item/fileChange/requestApproval', params: { threadId: '$thread', turnId: '$turn', itemId: 'f1', startedAtMs: 1 } }) }])
    const edits = track(await setup())
    await files(edits)
    await edits.idle()
    expect(await edits.answers('item/fileChange/requestApproval')).toEqual([{ decision: 'accept' }])
    const ask = track(await setup({ mode: 'default' }))
    await files(ask)
    const card = await ask.pending()
    expect(card).toMatchObject({ toolName: 'Write', title: 'Write notes.md' })
    ask.approvals.decide(card.id, { behavior: 'deny' })
    await ask.idle()
    expect(await ask.answers('item/fileChange/requestApproval')).toEqual([{ decision: 'decline' }])
  })

  it("puts Codex's questions on a question card and sends the answers back by question id, with (Recommended) as the card's tag (KERNEL-415)", async () => {
    const t = track(await setup())
    await t.sessions.send('chat', [{ type: 'text', text: script({ request: 'item/tool/requestUserInput', params: { threadId: '$thread', turnId: '$turn', itemId: 'q', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'db', header: 'Database', question: 'Which database?', isOther: false, isSecret: false, options: [{ label: 'Postgres (Recommended)', description: 'The one in prod' }, { label: 'SQLite', description: '' }] }] } }) }])
    const card = await t.pending()
    expect(card).toMatchObject({ kind: 'question', title: 'Which database?', options: ['Postgres', 'SQLite'], questions: [{ question: 'Which database?', header: 'Database', options: [{ label: 'Postgres', description: 'The one in prod', recommended: true }, { label: 'SQLite' }] }] })
    t.approvals.decide(card.id, { behavior: 'answer', text: 'Postgres', answers: { 'Which database?': 'Postgres' } })
    await t.idle()
    expect(await t.answers('item/tool/requestUserInput')).toEqual([{ answers: { db: { answers: ['Postgres'] } } }])
  })

  it('keeps the usage windows as Codex reports them, apart from Claude, and the context meter from its token counts', async () => {
    const t = track(await setup())
    const usage: RateLimit[][] = []
    bus.on('push', (e: PushEvent) => { if (e.type === 'usage') usage.push(e.limits) })
    await t.sessions.send('chat', [{ type: 'text', text: script(
      { notify: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: 1791734191 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1792320991 }, rateLimitReachedType: null } } },
      { notify: 'thread/tokenUsage/updated', params: { threadId: '$thread', turnId: '$turn', tokenUsage: { total: { totalTokens: 90000 }, last: { totalTokens: 45000 }, modelContextWindow: 180000 } } }
    ) }])
    await t.idle()
    expect(usage.at(-1)).toEqual([
      { type: 'five_hour', provider: 'codex', status: 'allowed', utilization: 0.62, resetsAt: 1791734191, readAt: expect.any(Number) },
      { type: 'seven_day', provider: 'codex', status: 'allowed', utilization: 0.12, resetsAt: 1792320991, readAt: expect.any(Number) }
    ])
    expect(t.store.chat('chat')).toMatchObject({ context: 25, contextUsage: { used: 45000, max: 180000, rows: [] } })
    expect(await t.sessions.usage()).toContainEqual({ type: 'five_hour', provider: 'codex', status: 'allowed', utilization: 0.4, resetsAt: 1791734191, readAt: expect.any(Number) })
  })

  it('stops the running turn with Stop', async () => {
    const t = track(await setup())
    await t.sessions.send('chat', [{ type: 'text', text: script({ wait: 'interrupt' }) }])
    await until(async () => (await t.sent('turn/start')).length === 1)
    await t.sessions.interrupt('chat')
    await t.idle()
    expect((await t.sent('turn/interrupt'))[0].params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
    expect(t.of('interrupted')).toHaveLength(1)
    // The interrupted row says what happened, so the turn's end adds no error card.
    expect(t.of('result')).toEqual([])
  })

  it('starts a fresh thread when the one the chat resumes is gone', async () => {
    const t = track(await setup({ chat: { sessionId: 'gone' } }))
    await t.sessions.send('chat', [{ type: 'text', text: 'carry on' }])
    await t.idle()
    expect((await t.sent('thread/start'))).toHaveLength(1)
    expect(t.store.chat('chat')?.sessionId).toBe('thread-1')
    expect(t.of('note').map((n) => n.text)).toContain(SESSION_GONE_NOTE)
    expect((await t.sent('turn/start'))[0].params.input[0].text).toBe('carry on')
  })

  it('compacts the thread for /compact', async () => {
    const t = track(await setup())
    await t.sessions.send('chat', [{ type: 'text', text: 'hi' }])
    await t.idle()
    await t.sessions.compact('chat')
    expect((await t.sent('thread/compact/start'))[0].params).toEqual({ threadId: 'thread-1' })
  })
})

describe("an agent file's tools on Codex (KERNEL-451)", () => {
  const servers = {
    linear: { command: 'linear-mcp', args: [], enabled: true },
    github: { url: 'https://api.githubcopilot.com/mcp/', enabled: true, disabled_tools: ['delete_repo'] },
    sentry: { command: 'sentry-mcp', enabled: true },
    old: { command: 'old-mcp', enabled: false }
  }
  const scoped = { ...noor, tools: ['Read', 'Edit', 'Bash', 'mcp__linear__get_issue', 'mcp__github'], disallowedTools: ['mcp__github__merge_pull_request'] } as AgentDef

  it("starts and resumes the thread without the MCP servers and tools the agent file doesn't reach", async () => {
    const t = track(await setup({ agent: scoped, mcp: JSON.stringify(servers) }))
    await t.sessions.send('chat', [{ type: 'text', text: 'hello' }])
    await t.idle()
    expect((await t.sent('config/read')).map((m) => m.params)).toEqual([{ cwd: t.repo }])
    const config = { 'mcp_servers.linear.enabled_tools': ['get_issue'], 'mcp_servers.github.disabled_tools': ['delete_repo', 'merge_pull_request'], 'mcp_servers.sentry.enabled': false }
    expect((await t.sent('thread/start'))[0].params.config).toEqual(config)
    t.sessions.stop('chat')
    await t.sessions.send('chat', [{ type: 'text', text: 'again' }])
    await until(async () => (await t.sent('thread/resume')).length === 1)
    expect((await t.sent('thread/resume'))[0].params.config).toEqual(config)
  })

  it("leaves Codex's servers alone for an agent with no tools line, and says so when Codex can't list them", async () => {
    const open = track(await setup({ mcp: JSON.stringify(servers) }))
    await open.sessions.send('chat', [{ type: 'text', text: 'hello' }])
    await open.idle()
    expect(await open.sent('config/read')).toEqual([])
    expect((await open.sent('thread/start'))[0].params).not.toHaveProperty('config')
    const t = track(await setup({ agent: scoped, mcp: 'error' }))
    await t.sessions.send('chat', [{ type: 'text', text: 'hello' }])
    await t.idle()
    expect((await t.sent('thread/start'))[0].params).not.toHaveProperty('config')
    expect(t.of('note').map((n) => n.text)).toContain("Kernel couldn't read Codex's MCP servers, so Noor's file doesn't limit them in this chat.")
  })

  it('narrows the lists the user set for a server, and skips a name a config key can\'t hold', () => {
    const policy = toolPolicy(['mcp__linear__get_issue', 'mcp__linear__list_issues', 'mcp__figma__get_code', 'mcp__my.server'])!
    const user = { linear: { enabled_tools: ['list_issues', 'save_issue'] }, figma: { enabled_tools: ['get_image'] }, 'my.server': {}, notion: {} }
    expect(mcpOverrides(policy, user)).toEqual({ 'mcp_servers.linear.enabled_tools': ['list_issues'], 'mcp_servers.figma.enabled': false, 'mcp_servers.notion.enabled': false })
    expect(mcpOverrides(undefined, user)).toEqual({})
  })
})

describe('plan mode on Codex (KERNEL-406)', () => {
  const planTurn = script({ notify: 'item/completed', params: { item: { type: 'plan', id: 'p1', text: '1. Add the column\n2. Backfill it' } } }, { notify: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'Here is the plan.', phase: 'final_answer' } } })

  it('plans read-only, puts the plan on the approval card when the turn ends, and goes on in default mode once approved', async () => {
    const t = track(await setup({ chat: { plan: true } }))
    await t.sessions.send('chat', [{ type: 'text', text: planTurn }])
    const [turn] = await until(() => t.sent('turn/start').then((m) => (m.length ? m : undefined)))
    expect(turn.params.collaborationMode).toEqual({ mode: 'plan', settings: { model: 'gpt-6-astra', reasoning_effort: 'medium', developer_instructions: null } })
    expect(turn.params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: true })
    const card = await t.pending()
    expect(card).toMatchObject({ kind: 'plan', title: 'Plan for invoice-schema', detail: '1. Add the column\n2. Backfill it' })
    expect(t.sessions.isRunning('chat')).toBe(false)
    t.approvals.decide(card.id, { behavior: 'allow' })
    await until(async () => (await t.sent('turn/start')).length === 2)
    await t.idle()
    expect(t.store.chat('chat')?.plan).toBe(false)
    const [, next] = await t.sent('turn/start')
    expect(next.params).toMatchObject({ input: [{ type: 'text', text: PLAN_APPROVED }], collaborationMode: { mode: 'default' }, sandboxPolicy: { type: 'workspaceWrite' } })
    expect(t.of('user').at(-1)).toMatchObject({ from: 'kernel', parts: [{ type: 'text', text: PLAN_APPROVED }] })
  })

  it("asks once when the Lead already asked with request_plan_approval in the same turn", async () => {
    const t = track(await setup({ agent: rowan, chat: { plan: true } }))
    await t.sessions.send('chat', [{ type: 'text', text: script(
      ...item({ type: 'dynamicToolCall', id: 'd1', namespace: null, tool: 'kernel_request_plan_approval', arguments: {}, status: 'completed', contentItems: [{ type: 'inputText', text: 'approved' }], success: true }),
      { notify: 'item/completed', params: { item: { type: 'plan', id: 'p1', text: '1. Hand off' } } }
    ) }])
    await t.idle()
    await new Promise((r) => setTimeout(r, 100))
    expect(t.store.approvals({})).toEqual([])
  })

  it('sends requested changes back as the next plan-mode turn', async () => {
    const t = track(await setup({ chat: { plan: true } }))
    await t.sessions.send('chat', [{ type: 'text', text: planTurn }])
    const card = await t.pending()
    t.approvals.decide(card.id, { behavior: 'deny', message: 'Backfill in batches' })
    await until(async () => (await t.sent('turn/start')).length === 2)
    const [, next] = await t.sent('turn/start')
    expect(next.params).toMatchObject({ input: [{ type: 'text', text: planChanges('Backfill in batches') }], collaborationMode: { mode: 'plan' } })
    expect(t.store.chat('chat')?.plan).toBe(true)
  })

  it("has the Lead hand off after Approve, and reminds it once when a turn ends with nothing handed off", async () => {
    const t = track(await setup({ agent: rowan, chat: { plan: true } }))
    await t.sessions.send('chat', [{ type: 'text', text: planTurn }])
    const card = await t.pending()
    t.approvals.decide(card.id, { behavior: 'allow' })
    // The approval reaches the Lead as "hand it off now". That turn ends without a workspace, so the reminder follows, once.
    await until(async () => (await t.sent('turn/start')).length === 3)
    await t.idle()
    const inputs = (await t.sent('turn/start')).map((m) => m.params.input[0].text)
    expect(inputs.slice(1)).toEqual([forProvider(HANDOFF_NOW, 'codex'), forProvider(HANDOFF_REMINDER, 'codex')])
    expect(inputs[1]).toContain('kernel_create_workspace')
    await new Promise((r) => setTimeout(r, 100))
    expect(await t.sent('turn/start')).toHaveLength(3)
    // The Lead's tool instructions ride in the thread's developer instructions, and Kernel's rules name its tools as Codex does.
    const instructions = (await t.sent('thread/start'))[0].params.developerInstructions as string
    expect(instructions).toContain('Lead tools.')
    expect(instructions).toContain(forProvider(LEAD_RULE, 'codex'))
    expect(instructions).toContain('kernel_request_plan_approval')
    expect(instructions).not.toContain('mcp__kernel__')
  })
})

describe('Codex helpers (KERNEL-406)', () => {
  it("names Kernel's tools the way each provider calls them, in rules and in tool results", async () => {
    expect(kernelTool('claude', 'wait_for_merge')).toBe('mcp__kernel__wait_for_merge')
    expect(kernelTool('codex', 'wait_for_merge')).toBe('kernel_wait_for_merge')
    expect(forProvider(TEAMMATE_RULE, 'claude')).toBe(TEAMMATE_RULE)
    expect(forProvider(TEAMMATE_RULE, 'codex')).toContain('call kernel_wait_for_merge and end your turn')
    const tools = [tool('request_plan_approval', 'Ask, then call mcp__kernel__create_workspace.', {}, async () => ({ content: [{ type: 'text' as const, text: `approved. ${HANDOFF_NOW}` }] }))]
    expect(toolSpecs(tools)[0].description).toBe('Ask, then call kernel_create_workspace.')
    expect((await callTool(tools, 'kernel_request_plan_approval', {})).contentItems).toEqual([{ type: 'inputText', text: `approved. ${forProvider(HANDOFF_NOW, 'codex')}` }])
  })

  it("takes Codex's shell wrapper off a command, so Kernel's rules see what the agent ran", () => {
    expect(unwrapShell('/bin/zsh -lc "git push origin main"')).toBe('git push origin main')
    expect(unwrapShell(`/bin/bash -lc 'echo '"'"'hi'"'"''`)).toBe("echo 'hi'")
    expect(unwrapShell('/bin/zsh -lc "echo \\"a\\""')).toBe('echo "a"')
    expect(unwrapShell('pnpm test')).toBe('pnpm test')
  })

  it("reads Codex's windows by length, and marks the fuller one when Codex says a limit was reached", () => {
    expect(codexLimits({ limitId: 'codex', limitName: null, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 10 }, secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 20 }, credits: null, individualLimit: null, spendControlReached: null, planType: 'plus', rateLimitReachedType: null }, 'acct'))
      .toEqual([{ type: 'five_hour', provider: 'codex', accountId: 'acct', utilization: 1, resetsAt: 10, status: 'rejected' }, { type: 'seven_day', provider: 'codex', accountId: 'acct', utilization: 0.3, resetsAt: 20 }])
    expect(codexLimits({ limitId: 'codex', limitName: null, primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 10 }, secondary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: 20 }, credits: null, individualLimit: null, spendControlReached: null, planType: 'plus', rateLimitReachedType: 'rate_limit_reached' })[1].status).toBe('rejected')
    expect(codexLimits(null)).toEqual([])
  })

  it('turns composer parts into Codex input', () => {
    expect(toCodexInput([{ type: 'skill', name: 'verify' }, { type: 'text', text: 'the checkout' }, { type: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }]))
      .toEqual([{ type: 'text', text: '$verify the checkout', text_elements: [] }, { type: 'image', url: 'data:image/png;base64,AAAA' }])
  })

  it("offers Kernel's tools to Codex with their schema, and refuses arguments the schema doesn't take", async () => {
    const tools = [tool('create_workspace', 'Hand off a task.', { title: z.string(), agent: z.string().optional() }, async ({ title }) => ({ content: [{ type: 'text' as const, text: `made ${title}` }] }))]
    expect(toolSpecs(tools)).toEqual([{ type: 'function', name: 'kernel_create_workspace', description: 'Hand off a task.', inputSchema: expect.objectContaining({ type: 'object', properties: { title: { type: 'string' }, agent: { type: 'string' } }, required: ['title'] }) }])
    expect(await callTool(tools, 'kernel_create_workspace', { title: 'Invoices' })).toEqual({ contentItems: [{ type: 'inputText', text: 'made Invoices' }], success: true })
    expect((await callTool(tools, 'kernel_create_workspace', { title: 3 })).success).toBe(false)
    expect(await callTool(tools, 'kernel_nope', {})).toEqual({ contentItems: [{ type: 'inputText', text: 'Kernel has no tool called kernel_nope.' }], success: false })
  })
})
