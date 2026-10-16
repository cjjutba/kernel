import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { seatDir } from '../src/main/services/seatLaunch'
import { setUp, tempRepo, freePort } from './helpers'

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// KERNEL-998: a seat's terminal runs claude wired into Kernel, resumes its session and can be turned off.

const REPO = {
  'README.md': '# shop\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
}

let k: Kernel
let dataDir: string
let projectId: string
let leadWs: Workspace
let mateWs: Workspace
const started = new Map<string, { env: Record<string, string>; command?: string }>()

const open = async (ws: Workspace, preset?: string) => {
  const h = k.handlers()
  const chat = await h['chats.create']({ workspaceId: ws.id, kind: 'terminal', preset })
  await h['terminal.write']({ chatId: chat.id, data: '' })
  return { chat, seat: started.get(chat.id)! }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  k.ptys.start = (id, o) => { started.set(id, { env: o.env, command: o.command }) }
  const project = await k.addProject(await tempRepo(REPO))
  k.store.saveProject({ ...project, host: 'local' })
  projectId = project.id
  const c = await k.lead.newLeadChat(projectId, { prompt: '' })
  leadWs = await setUp(k, c.id, 'settled')
  mateWs = await setUp(k, (await k.workspaces.createWorkspace(projectId, { prompt: 'Build the cart', agentId: 'kai', title: 'Cart' })).id)
}, 60_000)

afterAll(async () => { await k?.stop({ budgetMs: 0 }) })

/** A PATH folder whose `claude` prints its arguments separated by NUL. */
async function fakeClaude() {
  const bin = await mkdtemp(join(tmpdir(), 'kernel-bin-'))
  await writeFile(join(bin, 'claude'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\0" "$a"; done\n')
  await chmod(join(bin, 'claude'), 0o755)
  return bin
}

const ids = (l: { id: string }[]) => l.map((p) => p.id).filter((id) => ['claude', 'claude-skip', 'lead', 'shell'].includes(id))
const runScript = (dir: string, path: string, ...args: string[]) => spawnSync(join(dir, 'claude'), args, { env: { PATH: `${path}${delimiter}/usr/bin${delimiter}/bin` }, encoding: 'utf8' })

describe('terminal seats, launch wiring', () => {
  it('gives a connected tab its chat, a token the registry knows and the endpoint, with its folder first on the PATH', async () => {
    const { chat, seat } = await open(mateWs)
    const dir = seatDir(dataDir, chat.id)
    expect(seat.env.KERNEL_CHAT_ID).toBe(chat.id)
    expect(seat.env.KERNEL_MCP_URL).toBe(k.seats.url)
    expect(k.seats.registry.seatOf(seat.env.KERNEL_SEAT_TOKEN)).toMatchObject({ chatId: chat.id, workspaceId: mateWs.id, role: 'teammate' })
    expect(seat.env.PATH.split(delimiter)[0]).toBe(dir)
    expect(seat.command).toBe(`'${join(dir, 'claude')}'`)
  })

  it('keeps the token out of argv and in a 0600 file, and passes the chat its prompt and the endpoint', async () => {
    const { chat, seat } = await open(mateWs)
    const dir = seatDir(dataDir, chat.id)
    expect((await stat(join(dir, 'mcp.json'))).mode & 0o777).toBe(0o600)
    const config = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
    expect(config.mcpServers.kernel).toEqual({ type: 'http', url: k.seats.url, headers: { Authorization: `Bearer ${seat.env.KERNEL_SEAT_TOKEN}` } })
    const out = runScript(dir, await fakeClaude() + delimiter + seat.env.PATH, '--model', 'opus')
    expect(out.status).toBe(0)
    const argv = out.stdout.split('\0')
    expect(argv.slice(0, 2)).toEqual(['--mcp-config', join(dir, 'mcp.json')])
    expect(argv[2]).toBe('--append-system-prompt')
    expect(argv[3]).toContain('You are Kai.')
    expect(argv[3]).toContain(mateWs.path)
    expect(argv.slice(4, 6)).toEqual(['--model', 'opus'])
    expect(out.stdout).not.toContain(seat.env.KERNEL_SEAT_TOKEN)
    expect(argv).not.toContain('--resume')
  })

  it('finds the real claude past its own folder, and says so when there is none', async () => {
    const { chat } = await open(mateWs)
    const dir = seatDir(dataDir, chat.id)
    const bin = await fakeClaude()
    expect(runScript(dir, `${dir}${delimiter}${bin}`).status).toBe(0)
    const none = runScript(dir, `${dir}${delimiter}/usr/nowhere`)
    expect(none.status).toBe(127)
    expect(none.stderr).toContain('not found')
  })

  it('resumes the chat\'s session after a restart, on the relaunch a folder move makes, and leaves a command line that names its own', async () => {
    const { chat } = await open(mateWs)
    const dir = seatDir(dataDir, chat.id)
    const path = `${dir}${delimiter}${await fakeClaude()}`
    expect(runScript(dir, path).stdout).not.toContain('--resume')
    k.store.saveChat({ ...k.store.chat(chat.id)!, sessionId: 'sess-1' })
    k.ptys.kill(chat.id)
    const again = started.get(chat.id)!.env.KERNEL_SEAT_TOKEN
    await k.handlers()['terminal.write']({ chatId: chat.id, data: '' })
    expect(started.get(chat.id)!.env.KERNEL_SEAT_TOKEN).not.toBe(again)
    expect(k.seats.registry.seatOf(again)).toBeUndefined()
    const argv = runScript(dir, path, '--verbose').stdout.split('\0')
    expect(argv.slice(4, 7)).toEqual(['--resume', 'sess-1', '--verbose'])
    expect(runScript(dir, path, '--continue').stdout.split('\0')).not.toContain('sess-1')
    k.store.saveChat({ ...k.store.chat(chat.id)!, sessionId: 'sess-2' })
    k.seats.sessionChanged(chat.id)
    expect(runScript(dir, path).stdout.split('\0')).toContain('sess-2')
  })

  it('starts a plain claude when connect is off, and leaves the plain shell alone', async () => {
    const was = k.settings.terminal.connect
    k.settings.terminal.connect = false
    try {
      const { chat, seat } = await open(mateWs)
      expect(seat.command).toBe('claude')
      expect(seat.env.KERNEL_SEAT_TOKEN).toBeUndefined()
      expect(seat.env.KERNEL_CHAT_ID).toBeUndefined()
      expect(seat.env.PATH.split(delimiter)).not.toContain(seatDir(dataDir, chat.id))
    } finally { k.settings.terminal.connect = was }
    await k.handlers()['terminal.write']({ chatId: `shell:${mateWs.id}`, data: '' })
    const shell = started.get(`shell:${mateWs.id}`)!
    expect(shell.env.KERNEL_SEAT_TOKEN).toBeUndefined()
    expect(shell.command).toBeUndefined()
  })

  it('keeps the skip flag after the script path', async () => {
    const { chat, seat } = await open(mateWs, 'claude-skip')
    expect(seat.command).toBe(`'${join(seatDir(dataDir, chat.id), 'claude')}' --dangerously-skip-permissions`)
  })

  it('revokes the token and removes the folder when the tab closes', async () => {
    const { chat, seat } = await open(mateWs)
    await k.closeChat(chat.id)
    expect(k.seats.registry.seatOf(seat.env.KERNEL_SEAT_TOKEN)).toBeUndefined()
    await expect(stat(seatDir(dataDir, chat.id))).rejects.toThrow()
  })
})

describe('the Lead preset', () => {
  it('is offered in a Lead workspace only', async () => {
    const h = k.handlers()
    expect(ids(await h['terminal.presets']({ workspaceId: leadWs.id }))).toEqual(['claude', 'claude-skip', 'lead', 'shell'])
    expect(ids(await h['terminal.presets']({ workspaceId: mateWs.id }))).toEqual(['claude', 'claude-skip', 'shell'])
    expect(ids(await h['terminal.presets']())).toEqual(['claude', 'claude-skip', 'shell'])
    await expect(h['chats.create']({ workspaceId: mateWs.id, kind: 'terminal', preset: 'lead' })).rejects.toThrow('gone')
  })

  it('opens a seat in its Lead chat\'s thread with the Lead\'s tools and rules, and leaves the plain presets without a thread', async () => {
    const { chat, seat } = await open(leadWs, 'lead')
    expect(chat.threadId).toBe(leadWs.threadId)
    expect(chat.terminal).toEqual({ preset: 'lead', command: 'claude' })
    expect(k.seats.registry.seatOf(seat.env.KERNEL_SEAT_TOKEN)).toMatchObject({ chatId: chat.id, workspaceId: leadWs.id, role: 'lead' })
    expect(k.store.threadTabs(k.store.chats(leadWs.id).find((c) => c.kind === 'chat')!.id).map((c) => c.id)).toContain(chat.id)
    const plain = await open(leadWs, 'claude')
    expect(plain.chat.threadId).toBeUndefined()
    const prompt = await readFile(join(seatDir(dataDir, chat.id), 'prompt.txt'), 'utf8')
    expect(prompt).toContain('You are Kernel.')
    expect(prompt).toContain(leadWs.path)
  })
})
