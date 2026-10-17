import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, Workspace } from '@shared/types'
import { CHAT_HEADER } from '@shared/hookEntry'
import { Kernel } from '../src/main/kernel'
import { hookToken } from '../src/main/services/hookToken'
import { seatDir } from '../src/main/services/seatLaunch'
import { pastable } from '../src/main/features/teammateSeats'
import { setUp, tempRepo, freePort } from './helpers'

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// KERNEL-1004: a teammate can run in a terminal tab. The seat starts with the brief, hears messages between turns and reports
// its finished turns the way a teammate in Kernel does.

const REPO = {
  'README.md': '# shop\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\nrole: Engine\n---\nYou are Kai. Open a PR for each task.',
  '.claude/agents/cody.md': '---\nname: cody\ndescription: Codex engineer.\nrole: Engine\nmodel: gpt-6-astra\nprovider: codex\n---\nYou are Cody. Open a PR for each task.'
}

let k: Kernel
let dataDir: string
let port: number
let projectId: string
let leadWs: Workspace
let termLead: Chat
let chatLead: Chat
let session = 0
const writes: { id: string; data: string }[] = []
const started: string[] = []
const live = new Set<string>()
const sent: { chatId: string; parts: unknown }[] = []

const hook = (chat: Chat | string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/hooks`, {
  method: 'POST',
  body: JSON.stringify({ session_id: 's1', transcript_path: '/t/s1.jsonl', cwd: '/elsewhere', ...body }),
  headers: { 'content-type': 'application/json', 'x-kernel-token': hookToken(dataDir), [CHAT_HEADER.toLowerCase()]: typeof chat === 'string' ? chat : chat.id }
}).then((r) => r.json())
const prompt = (chat: Chat, text: string) => hook(chat, { hook_event_name: 'UserPromptSubmit', prompt: text })
const stop = (chat: Chat) => hook(chat, { hook_event_name: 'Stop' })

const seatOf = (wsId: string) => k.store.chats(wsId).find((c) => c.terminal?.handoff)

/** A hand-off through the Lead's create_workspace, from a terminal Lead (after the user's prompt) or from a chat Lead. */
async function handOff(from: 'terminal' | 'chat', args: Record<string, unknown> = {}) {
  const chat = from === 'terminal' ? termLead : chatLead
  const ws = k.store.workspace(chat.workspaceId)!
  if (from === 'terminal') await prompt(termLead, 'hand it to Kai')
  const tools = from === 'terminal'
    ? k.seats.serve({ chatId: chat.id, workspaceId: ws.id, role: k.seats.roleOf(chat.id) })!.tools
    : k.tools.toolsFor(ws, k.team.agentOf(projectId, ws.agentId), chat)
  const out = await tools.find((t) => t.name === 'create_workspace')!.handler({ agent: 'kai', title: `Cart ${++session}`, brief: 'Build the cart.', go_ahead: 'hand it to Kai', ...args } as never, {})
  const text = out.content.map((c: any) => c.text).join('\n')
  const id = /^Created (\S+) on/.exec(text)?.[1]
  return { text, isError: !!out.isError, ws: id ? k.store.workspace(id)! : undefined }
}

const setSettings = (patch: (s: Kernel['settings']) => void) => { patch(k.settings) }

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  port = await freePort()
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: port, worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  k = new Kernel({ dataDir, home, claudeSettingsFile: join(home, 'claude-settings.json') })
  await k.start()
  await k.hooks.writeHooks(port)
  const realSend = k.sessions.send.bind(k.sessions)
  k.sessions.send = async (chatId, parts, o) => { sent.push({ chatId, parts }); return { queued: false } }
  void realSend
  k.sessions.sendAll = async (chatId, msgs) => { for (const m of msgs) sent.push({ chatId, parts: m.parts }); return { queued: false } }
  k.ptys.start = (id: string) => { live.add(id); started.push(id) }
  k.ptys.has = (id: string) => live.has(id)
  k.ptys.write = (id: string, data: string) => { writes.push({ id, data }) }
  const project = await k.addProject(await tempRepo(REPO))
  k.store.saveProject({ ...project, host: 'local' })
  projectId = project.id
  const c = await k.lead.newLeadChat(project.id, { prompt: '' })
  leadWs = await setUp(k, c.id, 'settled')
  chatLead = k.store.chats(leadWs.id).find((x) => x.kind === 'chat')!
  const h = k.handlers()
  const t = await h['chats.create']({ workspaceId: leadWs.id, kind: 'terminal', preset: 'lead' })
  await h['terminal.write']({ chatId: t.id, data: '' })
  termLead = k.store.chat(t.id)!
}, 60_000)

beforeEach(() => {
  writes.length = 0
  sent.length = 0
  // Seats the earlier tests left mid-turn would take the slots of the limit test.
  for (const c of k.store.workspaces(projectId).flatMap((w) => k.store.chats(w.id))) if (c.terminal?.handoff) k.teammateSeats.gone(c.id)
  setSettings((s) => { s.terminal.teammatesRunIn = 'kernel'; s.models.agentLimit = 0 })
})

afterAll(async () => { await k?.stop({ budgetMs: 0 }) })

describe('where a teammate runs', () => {
  it('runs in Kernel by default, from a terminal Lead too', async () => {
    const r = await handOff('terminal')
    expect(r.ws).toBeTruthy()
    expect(seatOf(r.ws!.id)).toBeUndefined()
    expect(sent.length).toBeGreaterThan(0)
  })

  it('runs in a terminal when runs_in says so, whatever the settings are', async () => {
    const r = await handOff('chat', { runs_in: 'terminal' })
    await setUp(k, r.ws!.id)
    const seat = seatOf(r.ws!.id)!
    expect(seat).toMatchObject({ kind: 'terminal', terminal: { preset: 'claude', role: 'teammate', handoff: true } })
    expect(r.text).toContain('runs in a terminal tab')
    expect(sent).toEqual([])
  })

  it('lets runs_in kernel win over a setting of terminal', async () => {
    setSettings((s) => { s.terminal.teammatesRunIn = 'terminal' })
    const r = await handOff('chat', { runs_in: 'kernel' })
    await setUp(k, r.ws!.id)
    expect(seatOf(r.ws!.id)).toBeUndefined()
  })

  it('follows the Lead for lead: a terminal Lead hands off to a terminal, a chat Lead to Kernel', async () => {
    setSettings((s) => { s.terminal.teammatesRunIn = 'lead' })
    const fromTerminal = await handOff('terminal')
    await setUp(k, fromTerminal.ws!.id)
    expect(seatOf(fromTerminal.ws!.id)).toBeTruthy()
    const fromChat = await handOff('chat')
    await setUp(k, fromChat.ws!.id)
    expect(seatOf(fromChat.ws!.id)).toBeUndefined()
  })

  it('takes the project setting over the app setting', async () => {
    setSettings((s) => { s.terminal.teammatesRunIn = 'kernel' })
    const project = k.store.project(projectId)!
    await writeFile(join(project.path, '.kernel', 'settings.local.toml'), '[terminal]\nteammates_run_in = "terminal"\n').catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(project.path, '.kernel'), { recursive: true })
      await writeFile(join(project.path, '.kernel', 'settings.local.toml'), '[terminal]\nteammates_run_in = "terminal"\n')
    })
    const r = await handOff('chat')
    await setUp(k, r.ws!.id)
    expect(seatOf(r.ws!.id)).toBeTruthy()
    await writeFile(join(project.path, '.kernel', 'settings.local.toml'), '')
  })

  it('runs a Codex agent in Kernel and says so', async () => {
    const r = await handOff('chat', { agent: 'cody', runs_in: 'terminal' })
    await setUp(k, r.ws!.id)
    expect(seatOf(r.ws!.id)).toBeUndefined()
    expect(r.text).toContain('because it is a Codex agent')
  })

  it('runs a hand-off that waits for a merge in Kernel and says so', async () => {
    const first = await handOff('chat')
    await setUp(k, first.ws!.id)
    const r = await handOff('chat', { runs_in: 'terminal', wait_for: [first.ws!.id] })
    expect(r.ws && seatOf(r.ws.id)).toBeFalsy()
    expect(r.text).toContain('waits for a merge')
  })

  it('refuses runs_in terminal on a review', async () => {
    const built = await handOff('chat')
    await setUp(k, built.ws!.id)
    const r = await handOff('chat', { agent: 'kai', review_of: built.ws!.id, runs_in: 'terminal' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('runs in Kernel')
  })
})

describe('a terminal teammate', () => {
  it('starts claude with the brief from a file, and goes back to plain claude after its first prompt', async () => {
    const r = await handOff('chat', { runs_in: 'terminal', brief: 'Build the cart with "quotes" and $(dollars).' })
    await setUp(k, r.ws!.id)
    const seat = seatOf(r.ws!.id)!
    expect(started).toContain(seat.id)
    const file = join(seatDir(dataDir, seat.id), 'brief.txt')
    expect(await readFile(file, 'utf8')).toContain('Build the cart with "quotes" and $(dollars).')
    expect(seat.terminal!.command).toContain(`claude "$(cat '${file}')"`)
    await prompt(seat, 'Build the cart')
    expect(k.store.chat(seat.id)!.terminal!.command).toBe('claude')
  })

  it('reports a finished turn to the Lead the way a teammate in Kernel does', async () => {
    const r = await handOff('chat', { runs_in: 'terminal' })
    await setUp(k, r.ws!.id)
    const seat = seatOf(r.ws!.id)!
    const turn = vi.spyOn(k.leadUpdates, 'turnDone')
    await prompt(seat, 'Build the cart')
    await stop(seat)
    await vi.waitFor(() => expect(turn).toHaveBeenCalled())
    const [ws, chat, done] = turn.mock.calls.at(-1)!
    expect(ws.id).toBe(r.ws!.id)
    expect(chat.id).toBe(seat.id)
    expect(done).toMatchObject({ ok: true, interrupted: false, lead: false, by: 'lead' })
    turn.mockRestore()
  })

  it('counts a turn the user typed as theirs', async () => {
    const r = await handOff('chat', { runs_in: 'terminal' })
    await setUp(k, r.ws!.id)
    const seat = seatOf(r.ws!.id)!
    const turn = vi.spyOn(k.leadUpdates, 'turnDone')
    await prompt(seat, 'first')
    await stop(seat)
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1))
    await prompt(seat, 'second, typed by the user')
    await stop(seat)
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(2))
    expect(turn.mock.calls[0][2]).toMatchObject({ by: 'lead' })
    expect(turn.mock.calls[1][2]).toMatchObject({ by: 'user' })
    turn.mockRestore()
  })
})

describe('messages to a terminal teammate', () => {
  const message = async (ws: Workspace, text: string) => {
    const tools = k.tools.toolsFor(leadWs, k.team.agentOf(projectId, leadWs.agentId), chatLead)
    const out = await tools.find((t) => t.name === 'message_agent')!.handler({ workspace_id: ws.id, text } as never, {})
    return { text: out.content.map((c: any) => c.text).join('\n'), isError: !!out.isError }
  }
  const pasted = () => writes.filter((w) => w.data.startsWith('\x1b[200~'))

  it('waits for Stop, pastes once, then presses Enter', async () => {
    const r = await handOff('chat', { runs_in: 'terminal' })
    await setUp(k, r.ws!.id)
    const seat = seatOf(r.ws!.id)!
    await prompt(seat, 'Build the cart')
    const said = await message(r.ws!, 'Use the shared button.\nAnd add a test.')
    expect(said.text).toContain('mid-turn')
    expect(pasted()).toEqual([])
    await stop(seat)
    await vi.waitFor(() => expect(pasted()).toHaveLength(1))
    expect(pasted()[0].data).toBe('\x1b[200~Use the shared button.\nAnd add a test.\x1b[201~')
    await vi.waitFor(() => expect(writes.at(-1)!.data).toBe('\r'))
    // The next Stop sends nothing more.
    await prompt(seat, 'Use the shared button.\nAnd add a test.')
    await stop(seat)
    await new Promise((res) => setTimeout(res, 50))
    expect(pasted()).toHaveLength(1)
  })

  it('goes in at once when the seat is between turns', async () => {
    const r = await handOff('chat', { runs_in: 'terminal' })
    await setUp(k, r.ws!.id)
    const seat = seatOf(r.ws!.id)!
    await prompt(seat, 'Build the cart')
    await stop(seat)
    const said = await message(r.ws!, 'One more thing.')
    expect(said.text).toBe('Pasted into the terminal.')
    expect(pasted()).toHaveLength(1)
  })

  it('holds a message back after a keystroke, until a Stop with nothing typed since', async () => {
    const r = await handOff('chat', { runs_in: 'terminal' })
    await setUp(k, r.ws!.id)
    const seat = seatOf(r.ws!.id)!
    await prompt(seat, 'Build the cart')
    await message(r.ws!, 'Wait for me.')
    await k.handlers()['terminal.write']({ chatId: seat.id, data: 'h' })
    await stop(seat)
    await new Promise((res) => setTimeout(res, 50))
    expect(pasted()).toEqual([])
    // The user sent what they typed; the next turn ends with nothing typed since.
    await prompt(seat, 'h')
    await stop(seat)
    await vi.waitFor(() => expect(pasted()).toHaveLength(1))
  })

  it('does not take the terminal\'s own replies for typing', async () => {
    const r = await handOff('chat', { runs_in: 'terminal' })
    await setUp(k, r.ws!.id)
    const seat = seatOf(r.ws!.id)!
    await prompt(seat, 'Build the cart')
    await message(r.ws!, 'Still goes.')
    await k.handlers()['terminal.write']({ chatId: seat.id, data: '\x1b[I' })
    await stop(seat)
    await vi.waitFor(() => expect(pasted()).toHaveLength(1))
  })

  it('only pastes text and files that carry their text', () => {
    expect(pastable([{ type: 'text', text: 'hi' }, { type: 'file', name: 'issue', text: 'body' }])).toBe(true)
    expect(pastable([{ type: 'file', name: 'shot.png', path: '.kernel/attachments/shot.png' }])).toBe(false)
    expect(pastable([{ type: 'file', name: 'src/', path: 'src/', dir: true }])).toBe(false)
  })
})

describe('the agent limit', () => {
  it('counts terminal teammates, and starts a waiting one when a seat\'s turn ends', async () => {
    setSettings((s) => { s.models.agentLimit = 1 })
    const a = await handOff('chat', { runs_in: 'terminal', user_asked: true })
    await setUp(k, a.ws!.id)
    const first = seatOf(a.ws!.id)!
    await prompt(first, 'Build the cart')
    const b = await handOff('chat', { runs_in: 'terminal', user_asked: true })
    await setUp(k, b.ws!.id)
    const second = seatOf(b.ws!.id)!
    expect(started).not.toContain(second.id)
    expect(b.text).toContain('slot')
    await stop(first)
    await vi.waitFor(() => expect(started).toContain(second.id))
  })
})
