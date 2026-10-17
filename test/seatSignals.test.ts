import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Approval, Chat, Workspace } from '@shared/types'
import { CHAT_HEADER, hookCommand } from '@shared/hookEntry'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { hookToken } from '../src/main/services/hookToken'
import { seatDir } from '../src/main/services/seatLaunch'
import { LEAD_INSTRUCTIONS, TERMINAL_LEAD_INSTRUCTIONS } from '../src/main/services/kernelMcp'
import { ASK_IN_TERMINAL, NO_HOOKS_REFUSAL } from '../src/main/features/seatSignals'
import { setUp, tempRepo, freePort } from './helpers'

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// KERNEL-999: a terminal seat's hooks name its chat and give Kernel what the SDK transcript gives a chat.

const REPO = {
  'README.md': '# shop\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.'
}

let k: Kernel
let dataDir: string
let port: number
let leadWs: Workspace
let mateWs: Workspace
let lead: Chat
let mate: Chat
let session = 0

const open = async (ws: Workspace, preset?: string) => {
  const h = k.handlers()
  const chat = await h['chats.create']({ workspaceId: ws.id, kind: 'terminal', preset })
  await h['terminal.write']({ chatId: chat.id, data: '' })
  return k.store.chat(chat.id)!
}

const send = (chat: Chat | string, body: Record<string, unknown>, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/hooks`, {
  method: 'POST',
  body: JSON.stringify({ session_id: 's1', transcript_path: '/t/s1.jsonl', cwd: '/elsewhere', ...body }),
  headers: { 'content-type': 'application/json', 'x-kernel-token': hookToken(dataDir), [CHAT_HEADER.toLowerCase()]: typeof chat === 'string' ? chat : chat.id, ...headers }
}).then((r) => r.json())

const prompt = (chat: Chat, text: string, extra: Record<string, unknown> = {}) => send(chat, { hook_event_name: 'UserPromptSubmit', prompt: text, ...extra })
const stop = (chat: Chat) => send(chat, { hook_event_name: 'Stop' })

/** Calls a seat's tool the way its `claude` does, through the tools the endpoint serves. */
async function call(chat: Chat, name: string, args: Record<string, unknown>) {
  const tools = k.seats.serve({ chatId: chat.id, workspaceId: chat.workspaceId, role: k.seats.roleOf(chat.id) })!.tools
  const out = await tools.find((t) => t.name === name)!.handler(args, {})
  return { text: out.content.map((c: any) => c.text).join('\n'), isError: !!out.isError }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  port = await freePort()
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: port, worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  k = new Kernel({ dataDir, home, claudeSettingsFile: join(home, 'claude-settings.json') })
  await k.start()
  await k.hooks.writeHooks(port)
  k.sessions.send = async () => ({ queued: false })
  k.ptys.start = () => undefined
  const project = await k.addProject(await tempRepo(REPO))
  k.store.saveProject({ ...project, host: 'local' })
  const c = await k.lead.newLeadChat(project.id, { prompt: '' })
  leadWs = await setUp(k, c.id, 'settled')
  mateWs = await setUp(k, (await k.workspaces.createWorkspace(project.id, { prompt: 'Build the cart', agentId: 'christian', title: 'Cart' })).id)
  lead = await open(leadWs, 'lead')
  mate = await open(mateWs, 'claude')
}, 60_000)

afterAll(async () => { await k?.stop({ budgetMs: 0 }) })

describe('terminal seat identity', () => {
  it('sends the chat in the hook command, empty outside a seat', () => {
    expect(hookCommand(1, 5, 'tok')).toContain('-H "X-Kernel-Chat: ${KERNEL_CHAT_ID:-}"')
  })

  it('maps the header to the seat\'s chat, and ignores one that is no open terminal', async () => {
    const seen: any[] = []
    const on = (e: any, ctx: any) => seen.push({ event: e.hook_event_name, ctx })
    bus.on('hook', on)
    await send(lead, { hook_event_name: 'Notification', message: 'hi' })
    await send(lead.id.replace(/.$/, 'x'), { hook_event_name: 'Notification', message: 'hi' })
    await send(k.store.chats(leadWs.id).find((c) => c.kind === 'chat')!, { hook_event_name: 'Notification', message: 'hi' })
    bus.off('hook', on)
    expect(seen[0].ctx).toEqual({ projectId: leadWs.projectId, workspaceId: leadWs.id, agentId: leadWs.agentId, chatId: lead.id })
    expect(seen[1].ctx.chatId).toBeUndefined()
    expect(seen[2].ctx.chatId).toBeUndefined()
  })

  it('saves the role when the pty starts', () => {
    expect(lead.terminal).toMatchObject({ preset: 'lead', role: 'lead' })
    expect(mate.terminal).toMatchObject({ role: 'teammate' })
  })
})

describe('the user\'s words', () => {
  const overrule = (chat: Chat, go_ahead: string) => call(chat, 'overrule_blockers', { workspace_id: 'nope', go_ahead })

  it('refuses a quote before any prompt has been seen, and says why', async () => {
    expect(await overrule(lead, 'ship it')).toEqual({ text: NO_HOOKS_REFUSAL, isError: true })
  })

  it('passes a quote from the terminal prompt and refuses one that is not in it', async () => {
    await prompt(lead, 'Those blockers are fine, ship it')
    expect((await overrule(lead, 'blockers are fine')).text).toContain('not an open workspace')
    expect((await overrule(lead, 'merge everything')).text).toContain('Not overruled: only the user')
    await stop(lead)
  })

  it('refuses once the turn ended, so an old prompt can not be quoted', async () => {
    expect(await overrule(lead, 'blockers are fine')).toEqual({ text: NO_HOOKS_REFUSAL, isError: true })
  })

  it('refuses while hooks are off, even in a turn it saw begin', async () => {
    await prompt(lead, 'Those blockers are fine, ship it')
    await k.handlers()['hooks.uninstall']()
    expect(await overrule(lead, 'blockers are fine')).toEqual({ text: NO_HOOKS_REFUSAL, isError: true })
    await k.hooks.writeHooks(port)
    expect((await overrule(lead, 'blockers are fine')).text).toContain('not an open workspace')
    await stop(lead)
  })

  it('keeps one seat\'s words from another', async () => {
    await prompt(lead, 'ship it')
    expect(k.seatSignals.userSaid(mate.id)).toBeUndefined()
    expect(k.seatSignals.userTurn(mate.id)).toBe(false)
    expect(k.seatSignals.userSaid(lead.id)?.text).toBe('ship it')
    await stop(lead)
  })
})

describe('working, needs and idle', () => {
  it('pushes running from the prompt to the stop, and busyTerminals follows', async () => {
    const pushed: boolean[] = []
    const on = (e: any) => { if (e.type === 'chat.running' && e.chatId === mate.id) pushed.push(e.running) }
    bus.on('push', on)
    expect(k.chats.busyTerminals(mateWs.id)).toBe(false)
    await prompt(mate, 'Build the cart')
    expect(k.chats.busyTerminals(mateWs.id)).toBe(true)
    await send(mate, { hook_event_name: 'Notification', message: 'again' })
    await stop(mate)
    bus.off('push', on)
    expect(pushed).toEqual([true, false])
    expect(k.chats.busyTerminals(mateWs.id)).toBe(false)
  })

  it('puts a permission request on the seat\'s chat, where its tab shows it waits', async () => {
    let approval: Approval | undefined
    const on = (e: any) => { if (e.type === 'approval' && e.approval.status === 'pending') approval = e.approval }
    bus.on('push', on)
    const answer = send(mate, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm install' } })
    await vi.waitFor(() => expect(approval).toBeDefined())
    bus.off('push', on)
    expect(approval).toMatchObject({ chatId: mate.id, workspaceId: mateWs.id, agentId: mateWs.agentId })
    k.approvals.decide(approval!.id, { behavior: 'allow' })
    expect(await answer).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
  })

  it('lets go of a closed seat', async () => {
    const extra = await open(mateWs, 'claude')
    await prompt(extra, 'hi')
    expect(k.seatSignals.working(extra.id)).toBe(true)
    await k.closeChat(extra.id)
    expect(k.seatSignals.working(extra.id)).toBe(false)
  })
})

describe('plan mode', () => {
  it('follows permission_mode', async () => {
    await send(lead, { hook_event_name: 'Notification', message: 'x', permission_mode: 'plan' })
    expect(k.store.chat(lead.id)!.plan).toBe(true)
    await send(lead, { hook_event_name: 'Notification', message: 'x', permission_mode: 'default' })
    expect(k.store.chat(lead.id)!.plan).toBe(false)
    await send(lead, { hook_event_name: 'Notification', message: 'x' })
    expect(k.store.chat(lead.id)!.plan).toBe(false)
  })
})

describe('session and title', () => {
  it('saves the session and transcript, and the next claude resumes it', async () => {
    const chat = await open(mateWs, 'claude')
    await send(chat, { hook_event_name: 'Notification', message: 'x', session_id: 'abc', transcript_path: '/t/abc.jsonl' })
    expect(k.store.chat(chat.id)!.terminal).toMatchObject({ sessionId: 'abc', transcriptPath: '/t/abc.jsonl', role: 'teammate' })
    expect((await readFile(join(seatDir(dataDir, chat.id), 'session'), 'utf8')).trim()).toBe('abc')
    await send(chat, { hook_event_name: 'Notification', message: 'x', session_id: 'def', transcript_path: '/t/def.jsonl' })
    expect((await readFile(join(seatDir(dataDir, chat.id), 'session'), 'utf8')).trim()).toBe('def')
  })

  it('names the tab with the title Claude Code wrote for the session', async () => {
    const chat = await open(mateWs, 'claude')
    k.sessionInfo = (async (id: string) => (id === 'titled' ? { customTitle: 'Fix the cart total' } : undefined)) as any
    await prompt(chat, 'fix the total', { session_id: 'titled' })
    await vi.waitFor(() => expect(k.store.chat(chat.id)!.title).toBe('Fix the cart total'))
  })

  it('leaves a name the tab does not get from its preset', async () => {
    const chat = await open(mateWs, 'claude')
    k.store.saveChat({ ...k.store.chat(chat.id)!, title: 'My terminal' })
    k.sessionInfo = (async () => ({ customTitle: 'Other' })) as any
    await prompt(chat, 'hi', { session_id: 'kept' })
    await stop(chat)
    await new Promise((r) => setTimeout(r, 50))
    expect(k.store.chat(chat.id)!.title).toBe('My terminal')
  })
})

describe('plan approval', () => {
  const plan = '# Export invoices\n\n1. Add the button\n2. Write the CSV'

  it('gives a terminal Lead no request_plan_approval and plan-dialog instructions, and a chat Lead its own (KERNEL-1022)', async () => {
    const seat = k.seats.serve({ chatId: lead.id, workspaceId: lead.workspaceId, role: 'lead' })!
    expect(seat.tools.map((t) => t.name)).not.toContain('request_plan_approval')
    expect(seat.tools.map((t) => t.name)).toContain('create_workspace')
    expect(seat.instructions).toBe(TERMINAL_LEAD_INSTRUCTIONS)
    expect(seat.instructions).toMatch(/exit plan mode for approval/)
    expect(seat.instructions).toMatch(/Once the user approves, hand each task to one teammate with create_workspace/)
    const chat = await k.handlers()['chats.create']({ workspaceId: leadWs.id, kind: 'chat' } as never)
    const chatSeat = k.seats.serve({ chatId: chat.id, workspaceId: leadWs.id, role: 'lead' })!
    expect(chatSeat.tools.map((t) => t.name)).toContain('request_plan_approval')
    expect(chatSeat.instructions).toBe(LEAD_INSTRUCTIONS)
    const mateSeat = k.seats.serve({ chatId: mate.id, workspaceId: mate.workspaceId, role: 'teammate' })!
    expect(mateSeat.instructions).toBeUndefined()
  })

  it('saves the plan accepted in the TUI, so read_plans and the plan rules see it', async () => {
    expect((await call(lead, 'read_plans', {})).text).toContain('No plan has been approved')
    await prompt(lead, 'plan the export')
    await send(lead, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: { plan }, tool_response: {}, tool_use_id: 't1' })
    await stop(lead)
    const saved = k.store.approvals({ projectId: leadWs.projectId }).filter((a) => a.kind === 'plan' && a.chatId === lead.id)
    expect(saved).toMatchObject([{ status: 'allowed', title: 'Export invoices', detail: plan, source: 'hook' }])
    const read = await call(lead, 'read_plans', {})
    expect(read.text).toContain('Add the button')
  })

  it('saves nothing for an ExitPlanMode that carried no plan', async () => {
    const before = k.store.approvals({ projectId: leadWs.projectId }).length
    await send(lead, { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: {}, tool_response: {}, tool_use_id: 't2' })
    expect(k.store.approvals({ projectId: leadWs.projectId }).length).toBe(before)
  })
})

describe('asking the user', () => {
  it('tells the agent to ask with AskUserQuestion, and the answer settles what the question was about', async () => {
    const asked = vi.spyOn(k.openItems, 'asked')
    const out = await call(lead, 'ask_user', { question: 'Which design?', about: [mateWs.id] })
    expect(out).toEqual({ text: ASK_IN_TERMINAL, isError: false })
    expect(k.store.approvals({ projectId: leadWs.projectId }).filter((a) => a.kind === 'question')).toEqual([])
    expect(asked).not.toHaveBeenCalled()
    await send(lead, { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: {}, tool_use_id: 't3' })
    expect(asked).toHaveBeenCalledWith(lead.id, [mateWs.id])
    await send(lead, { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: {}, tool_use_id: 't4' })
    expect(asked).toHaveBeenLastCalledWith(lead.id, [])
    asked.mockRestore()
  })
})

describe('connected', () => {
  const connected = (chat: Chat) => k.store.chat(chat.id)!.seat?.connected
  const exit = (chat: Chat) => (k.ptys as unknown as { exits: ((id: string) => void)[] }).exits.forEach((fn) => fn(chat.id))

  it('is false at launch, true from the first hook, and false when the pty exits', async () => {
    const chat = await open(mateWs, 'claude')
    expect(connected(chat)).toBe(false)
    await send(chat, { hook_event_name: 'Notification', message: 'x' })
    expect(connected(chat)).toBe(true)
    await prompt(chat, 'hi')
    exit(chat)
    expect(connected(chat)).toBe(false)
    expect(k.seatSignals.working(chat.id)).toBe(false)
    expect(k.seatSignals.userTurn(chat.id)).toBe(false)
  })

  it('is true once the seat uses its token', async () => {
    const chat = await open(mateWs, 'claude')
    k.seats.serve({ chatId: chat.id, workspaceId: chat.workspaceId, role: k.seats.roleOf(chat.id) })
    expect(connected(chat)).toBe(true)
  })

  it('reconnect starts the pty again through the launch path, resuming the session', async () => {
    const chat = await open(mateWs, 'claude')
    await send(chat, { hook_event_name: 'Notification', message: 'x', session_id: 'resumed', transcript_path: '/t/r.jsonl' })
    exit(chat)
    const starts: { command?: string; env?: Record<string, string> }[] = []
    k.ptys.start = ((_id: string, o: { command?: string; env?: Record<string, string> }) => { starts.push(o) }) as never
    expect(await k.handlers()['terminal.reconnect']({ chatId: chat.id })).toEqual({ ok: true })
    expect(starts).toHaveLength(1)
    expect(starts[0].env?.KERNEL_CHAT_ID).toBe(chat.id)
    expect(starts[0].command).toContain(seatDir(dataDir, chat.id))
    expect((await readFile(join(seatDir(dataDir, chat.id), 'session'), 'utf8')).trim()).toBe('resumed')
    expect(connected(chat)).toBe(false)
    k.ptys.start = () => undefined
  })

  it('reconnect refuses a chat that is no terminal seat', async () => {
    const plain = k.store.chats(leadWs.id).find((c) => c.kind === 'chat')!
    await expect(k.handlers()['terminal.reconnect']({ chatId: plain.id })).rejects.toThrow('not a terminal seat')
  })
})

describe('the seat\'s transcript (KERNEL-1002)', () => {
  it('stores the session file\'s rows on the seat\'s chat from its hooks, and stops once the seat is forgotten', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'kernel-session-')), 's.jsonl')
    const row = (uuid: string, text: string) => JSON.stringify({ type: 'user', uuid, timestamp: '2026-10-17T05:00:00.000Z', message: { role: 'user', content: text } }) + '\n'
    await writeFile(path, row('a', 'first'))
    const pushed: string[] = []
    const on = (e: any) => { if (e.type === 'chat.item' && e.chatId === mate.id) pushed.push(e.item.id) }
    bus.on('push', on)
    await send(mate, { hook_event_name: 'Notification', message: 'hi', transcript_path: path })
    await expect.poll(() => k.store.items(mate.id).map((i) => i.id)).toEqual(['tt-a'])
    await appendFile(path, row('b', 'second'))
    await expect.poll(() => k.store.items(mate.id).map((i) => i.id)).toEqual(['tt-a', 'tt-b'])
    expect(pushed).toEqual(['tt-a', 'tt-b'])
    expect(k.store.items(mate.id)[0]).toMatchObject({ kind: 'user', source: 'terminal' })
    k.seatSignals.forget(mate.id)
    await appendFile(path, row('c', 'third'))
    await new Promise((r) => setTimeout(r, 1000))
    expect(k.store.items(mate.id).map((i) => i.id)).toEqual(['tt-a', 'tt-b'])
    bus.off('push', on)
  })
})
