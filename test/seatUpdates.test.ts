import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Approval, Chat, Workspace } from '@shared/types'
import { CHAT_HEADER, hookCommand } from '@shared/hookEntry'
import { bus } from '../src/main/bus'
import type { PushEvent } from '../src/shared/ipc'
import { Kernel } from '../src/main/kernel'
import { hookToken } from '../src/main/services/hookToken'
import { seatDir } from '../src/main/services/seatLaunch'
import { NOTHING_NEW } from '../src/main/services/checkTeamMcp'
import { askId, seatId } from '../src/main/services/leadUpdates'
import { setUp, tempRepo, freePort } from './helpers'

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// KERNEL-1000: a terminal Lead hears what its teammates did, by hook and by tool, and Kernel never types into the terminal.

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


const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms))

/** A teammate's question, once its turn has ended, as the Lead hears it. */
async function ask(ws: Workspace, text: string) {
  k.leadUpdates.asked(k.store.workspace(ws.id)!, text)
  bus.push({ type: 'chat.running', chatId: k.store.chats(ws.id).find((c) => c.kind === 'chat')!.id, running: false })
  await vi.waitFor(() => expect(k.leadUpdates.seatPending(lead.id)).toBeGreaterThan(0), { timeout: 3000, interval: 20 })
}

/** What a hook answers with when it carries context, empty otherwise. */
const context = (out: any): string | undefined => out?.hookSpecificOutput?.additionalContext

beforeAll(() => {
  const d = (k.leadUpdates as unknown as { d: { delayMs: number; maxDelayMs: number } }).d
  d.delayMs = 1
  d.maxDelayMs = 1
  k.store.saveWorkspace({ ...mateWs, leadChatId: lead.id })
})

describe('updates for a terminal Lead', () => {
  it('queues a teammate\'s question and starts no turn', async () => {
    const sent = vi.spyOn(k.sessions, 'send')
    const posted = vi.spyOn(k.sessions, 'post')
    const pushes: PushEvent[] = []
    const on = (e: PushEvent) => { if (e.type === 'seat.updates') pushes.push(e) }
    bus.on('push', on)
    await ask(mateWs, 'Which colour for the cart badge?')
    bus.off('push', on)
    expect(k.leadUpdates.seatPending(lead.id)).toBe(1)
    expect(pushes).toEqual([{ type: 'seat.updates', chatId: lead.id, count: 1 }])
    expect(sent).not.toHaveBeenCalled()
    expect(posted).not.toHaveBeenCalled()
    sent.mockRestore(); posted.mockRestore()
  })

  it('raises an inbox row that names the tab and carries the question', async () => {
    const row = k.store.notification(askId(lead.id, mateWs.id))!
    expect(row).toMatchObject({ needsYou: true, chatId: lead.id, ask: { workspaceId: mateWs.id, question: 'Which colour for the cart badge?' } })
    expect(row.heading).toContain(lead.title)
    expect(k.store.notification(seatId(lead.id))).toMatchObject({ needsYou: true, chatId: lead.id })
  })

  it('hands it to the next prompt as additionalContext, once', async () => {
    const out = await prompt(lead, 'What did Christian ask?')
    expect(context(out)).toContain('Team update, not from the user.')
    expect(context(out)).toContain('Which colour for the cart badge?')
    expect(k.leadUpdates.seatPending(lead.id)).toBe(0)
    expect(k.store.notification(seatId(lead.id))).toMatchObject({ needsYou: false })
    expect(context(await prompt(lead, 'Again'))).toBeUndefined()
    await stop(lead)
  })

  it('gives check_team the update without a prompt, and clears it', async () => {
    expect((await call(lead, 'check_team', {})).text).toBe(NOTHING_NEW)
    await ask(mateWs, 'Square or round?')
    expect(k.leadUpdates.seatPending(lead.id)).toBe(1)
    const first = await call(lead, 'check_team', {})
    expect(first.text).toContain('Square or round?')
    expect(k.leadUpdates.seatPending(lead.id)).toBe(0)
    expect((await call(lead, 'check_team', {})).text).toBe(NOTHING_NEW)
    expect(context(await prompt(lead, 'Anything new?'))).toBeUndefined()
    await stop(lead)
  })

  it('keeps the tool for a terminal Lead only', async () => {
    const chat = k.store.chats(leadWs.id).find((c) => c.kind === 'chat')!
    const names = (c: Chat) => k.tools.toolsFor(k.store.workspace(c.workspaceId)!, k.team.agentOf(leadWs.projectId, k.store.workspace(c.workspaceId)!.agentId), c).map((t) => t.name)
    expect(names(lead)).toContain('check_team')
    expect(names(chat)).not.toContain('check_team')
    expect(names(mate)).not.toContain('check_team')
  })

  it('does not hand a seat the updates of another', async () => {
    await ask(mateWs, 'Third question?')
    expect(context(await prompt(mate, 'hello'))).toBeUndefined()
    expect(k.leadUpdates.seatPending(lead.id)).toBe(1)
    await call(lead, 'check_team', {})
  })

  it('sends the inbox answer to the teammate and tells a Lead that still waits not to answer again', async () => {
    await ask(mateWs, 'Pick a size?')
    const send = vi.spyOn(k.lead, 'answerTeammate').mockResolvedValue({ ok: true, sent: true, note: 'Sent.' })
    const id = askId(lead.id, mateWs.id)
    const done = await k.handlers()['notifications.answer']({ id, text: 'Small' })
    expect(send).toHaveBeenCalledWith(mateWs.projectId, mateWs.id, 'Small')
    expect(done).toMatchObject({ needsYou: false, read: true, resolved: 'You answered: Small' })
    await expect(k.handlers()['notifications.answer']({ id, text: 'Large' })).rejects.toThrow('already answered')
    expect(context(await prompt(lead, 'go'))).toContain('already answered this question in Kernel\'s inbox: "Small"')
    send.mockRestore()
    await stop(lead)
  })

  it('goes to the tab that handed the work off when a chat Lead tab exists too', async () => {
    const chat = k.store.chats(leadWs.id).find((c) => c.kind === 'chat')!
    const mine = await k.workspaces.createWorkspace(leadWs.projectId, { prompt: 'Footer', agentId: 'christian', title: 'Footer', leadChatId: chat.id })
    const sent = vi.spyOn(k.sessions, 'post').mockReturnValue(true)
    k.leadUpdates.asked(k.store.workspace(mine.id)!, 'Footer links?')
    bus.push({ type: 'chat.running', chatId: k.store.chats(mine.id)[0].id, running: false })
    await wait()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0][0]).toBe(chat.id)
    expect(k.leadUpdates.seatPending(lead.id)).toBe(0)
    sent.mockRestore()
  })

  it('answers seat.pending with the count waiting per tab (KERNEL-1029)', async () => {
    expect(await k.handlers()['seat.pending']()).toEqual({})
    await ask(mateWs, 'Counted?')
    expect(await k.handlers()['seat.pending']()).toEqual({ [lead.id]: 1 })
    await call(lead, 'check_team', {})
    expect(await k.handlers()['seat.pending']()).toEqual({})
  })

  it('hands a closed tab\'s queue to the chat Lead for that work (KERNEL-1029)', async () => {
    await ask(mateWs, 'Last one?')
    expect(k.leadUpdates.seatPending(lead.id)).toBe(1)
    const chat = k.store.chats(leadWs.id).find((c) => c.kind === 'chat')!
    const post = vi.spyOn(k.sessions, 'post').mockReturnValue(true)
    await k.chats.closeChat(lead.id)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toBe(chat.id)
    const said = (post.mock.calls[0][1][0] as { text: string }).text
    expect(said).toContain('Last one?')
    expect(said).toContain('a tab you closed')
    post.mockRestore()
    expect(k.leadUpdates.seatPending(lead.id)).toBe(0)
    expect(k.store.notification(seatId(lead.id))).toMatchObject({ needsYou: false })
  })

  it('keeps a closed tab\'s queue until a Lead chat can take it', async () => {
    const tab = await open(leadWs, 'lead')
    k.store.saveWorkspace({ ...mateWs, leadChatId: tab.id })
    k.leadUpdates.asked(k.store.workspace(mateWs.id)!, 'Still there?')
    bus.push({ type: 'chat.running', chatId: k.store.chats(mateWs.id).find((c) => c.kind === 'chat')!.id, running: false })
    await vi.waitFor(() => expect(k.leadUpdates.seatPending(tab.id)).toBe(1), { timeout: 3000, interval: 20 })
    const post = vi.spyOn(k.sessions, 'post').mockReturnValue(false)
    await k.chats.closeChat(tab.id)
    expect(k.leadUpdates.seatPending(tab.id)).toBe(1)
    post.mockReturnValue(true)
    k.leadUpdates.flush(k.store.workspace(leadWs.id)!.projectId)
    expect(post).toHaveBeenCalledTimes(2)
    expect(k.leadUpdates.seatPending(tab.id)).toBe(0)
    post.mockRestore()
  })

  it('keeps the queue through an archive and offers it again on restore', async () => {
    const tab = await open(leadWs, 'lead')
    k.store.saveWorkspace({ ...mateWs, leadChatId: tab.id })
    k.leadUpdates.asked(k.store.workspace(mateWs.id)!, 'After the archive?')
    bus.push({ type: 'chat.running', chatId: k.store.chats(mateWs.id).find((c) => c.kind === 'chat')!.id, running: false })
    await vi.waitFor(() => expect(k.leadUpdates.seatPending(tab.id)).toBe(1), { timeout: 3000, interval: 20 })
    k.seats.closeWorkspace(leadWs.id, [tab.id])
    expect(k.leadUpdates.seatPending(tab.id)).toBe(1)
    expect(k.store.notification(seatId(tab.id))).toMatchObject({ needsYou: false })
    k.leadUpdates.seatRestored(tab)
    expect(k.store.notification(seatId(tab.id))).toMatchObject({ needsYou: true })
    expect(context(await prompt(tab, 'Back'))).toContain('After the archive?')
    expect(k.leadUpdates.seatPending(tab.id)).toBe(0)
  })
})
