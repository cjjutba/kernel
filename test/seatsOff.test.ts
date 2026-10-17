import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { seatDir } from '../src/main/services/seatLaunch'
import { SEATS_ENABLED } from '../src/main/services/seatsFlag'
import { setUp, tempRepo, freePort } from './helpers'

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// KERNEL-1034: terminal seats are off in v1. Saved settings that turned them on are ignored, a big terminal tab is a plain
// terminal and every hand-off runs in Kernel. A teammate seat a hand-off made before keeps running as one.

const REPO = {
  'README.md': '# shop\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\nrole: Engine\n---\nYou are Christian. Open a PR for each task.'
}

const SEAT_ENV = ['KERNEL_SEAT_TOKEN', 'KERNEL_CHAT_ID', 'KERNEL_MCP_URL']

let k: Kernel
let dataDir: string
let projectId: string
let leadWs: Workspace
let mateWs: Workspace
const started = new Map<string, { env: Record<string, string>; command?: string }>()
// A run from inside a seat has these set, and a plain terminal passes them on.
const was = Object.fromEntries(SEAT_ENV.map((n) => [n, process.env[n]]))

beforeAll(async () => {
  for (const n of SEAT_ENV) delete process.env[n]
  dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, terminal: { connect: true, teammatesRunIn: 'terminal' } }))
  k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  k.ptys.start = (id, o) => { started.set(id, { env: o.env, command: o.command }) }
  const project = await k.addProject(await tempRepo(REPO))
  k.store.saveProject({ ...project, host: 'local' })
  projectId = project.id
  const c = await k.lead.newLeadChat(projectId, { prompt: '' })
  leadWs = await setUp(k, c.id, 'settled')
  mateWs = await setUp(k, (await k.workspaces.createWorkspace(projectId, { prompt: 'Build the cart', agentId: 'christian', title: 'Cart' })).id)
}, 60_000)

afterAll(async () => {
  await k?.stop({ budgetMs: 0 })
  for (const n of SEAT_ENV) if (was[n] !== undefined) process.env[n] = was[n]
})

describe('terminal seats off', () => {
  it('is off', () => {
    expect(SEATS_ENABLED).toBe(false)
    expect(k.settings.terminal).toMatchObject({ connect: true, teammatesRunIn: 'terminal' })
  })

  it('opens a big terminal tab as a plain terminal, with no seat and no endpoint, though connect is saved on', async () => {
    const h = k.handlers()
    const chat = await h['chats.create']({ workspaceId: mateWs.id, kind: 'terminal' })
    await h['terminal.write']({ chatId: chat.id, data: '' })
    const pty = started.get(chat.id)!
    expect(pty.command).toBe('claude')
    for (const n of SEAT_ENV) expect(pty.env[n]).toBeUndefined()
    expect(pty.env.PATH.split(delimiter)).not.toContain(seatDir(dataDir, chat.id))
    expect(existsSync(seatDir(dataDir, chat.id))).toBe(false)
    expect(k.store.chat(chat.id)!.terminal?.role).toBeUndefined()
    expect(k.seats.url).toBeUndefined()
  })

  it('lists no Lead preset in a Lead workspace, and refuses one asked for', async () => {
    const h = k.handlers()
    expect((await h['terminal.presets']({ workspaceId: leadWs.id })).map((p) => p.id)).not.toContain('lead')
    await expect(h['chats.create']({ workspaceId: leadWs.id, kind: 'terminal', preset: 'lead' })).rejects.toThrow(/preset is gone/)
  })

  it('offers no runs_in on create_workspace, and hands off to Kernel though the app and the project say terminal', async () => {
    const repo = k.store.project(projectId)!.path
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[terminal]\nteammates_run_in = "terminal"\n')
    const lead = k.store.chats(leadWs.id).find((c) => c.kind === 'chat')!
    const tool = k.tools.toolsFor(leadWs, k.team.agentOf(projectId, leadWs.agentId), lead).find((t) => t.name === 'create_workspace')!
    expect(Object.keys(tool.inputSchema)).not.toContain('runs_in')
    expect(tool.description + JSON.stringify(tool.inputSchema)).not.toMatch(/terminal/i)
    const out = await tool.handler({ agent: 'christian', title: 'Checkout', brief: 'Build checkout.', go_ahead: 'hand it to Christian' } as never, {})
    const text = out.content.map((c: any) => c.text).join('\n')
    expect(text).not.toMatch(/terminal/i)
    const ws = k.store.workspace(/^Created (\S+) on/.exec(text)![1])!
    await setUp(k, ws.id)
    expect(k.store.chats(ws.id).some((c) => c.kind === 'terminal')).toBe(false)
    expect(k.teammateSeats.seatOf(ws.id)).toBeUndefined()
  })

  it('keeps a teammate seat a hand-off made before running as a seat', async () => {
    const h = k.handlers()
    const tab = await h['chats.create']({ workspaceId: mateWs.id, kind: 'terminal' })
    k.store.saveChat({ ...k.store.chat(tab.id)!, terminal: { preset: 'claude', command: 'claude', role: 'teammate', handoff: true } })
    await h['terminal.write']({ chatId: tab.id, data: '' })
    const pty = started.get(tab.id)!
    expect(k.seats.url).toBeTruthy()
    expect(pty.env.KERNEL_CHAT_ID).toBe(tab.id)
    expect(k.seats.registry.seatOf(pty.env.KERNEL_SEAT_TOKEN)).toMatchObject({ chatId: tab.id, workspaceId: mateWs.id, role: 'teammate' })
    expect(pty.env.PATH.split(delimiter)[0]).toBe(seatDir(dataDir, tab.id))
  })
})
