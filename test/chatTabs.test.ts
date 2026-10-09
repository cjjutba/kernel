import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { Ptys } from '../src/main/services/pty'
import { appended } from '../src/renderer/src/screens/workspace/terminal/buffer'
import type { ChatItem } from '../src/shared/types'

const until = async (ok: () => boolean, ms = 8000) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) } }

describe('ptys', () => {
  it('runs a real shell in the folder, takes input, and ends when killed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-pty-'))
    const ptys = new Ptys()
    let out = ''
    const on = (e: { type: string; chatId?: string; data?: string }) => { if (e.type === 'terminal.data' && e.chatId === 't1') out += e.data }
    bus.on('push', on)
    ptys.start('t1', { cwd: dir, env: { ...process.env, KERNEL_PORT: '4777' } as Record<string, string> })
    expect(ptys.has('t1')).toBe(true)
    ptys.write('t1', 'echo port=$KERNEL_PORT && pwd -P\r')
    await until(() => out.includes('port=4777'))
    ptys.resize('t1', 120, 40)
    ptys.kill('t1')
    expect(ptys.has('t1')).toBe(false)
    bus.off('push', on)
  })
})

describe('terminal output replay', () => {
  it('finds the new output when the store trimmed the front of the buffer', () => {
    expect(appended('abc', 'abcdef')).toBe('def')
    const prev = 'x'.repeat(100) + 'tail-of-the-old-buffer-that-is-long-enough-to-match-the-64-char-window!'
    expect(appended(prev, prev.slice(10) + 'NEW')).toBe('NEW')
  })
})

describe('chat tabs', () => {
  it('renames, forks with the SDK, closes, and replaces the last tab', async () => {
    const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    const hookPort = 18000 + Math.floor(Math.random() * 900)
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort, worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const forks: unknown[] = []
    k.forkSession = (async (id: string, o: unknown) => { forks.push([id, o]); return { sessionId: 'forked-session' } }) as typeof k.forkSession
    const room = await k.addRoom(repo)
    const ws = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Tabs' })
    const h = k.handlers()
    const first = k.store.chats(ws.id)[0]
    k.store.saveChat({ ...first, sessionId: 'src-session' })
    const items: ChatItem[] = [
      { kind: 'user', id: 'u1', ts: 1, parts: [{ type: 'text', text: 'hi' }] },
      { kind: 'text', id: 'm1:0', ts: 2, text: 'hello' },
      { kind: 'user', id: 'u2', ts: 3, parts: [{ type: 'text', text: 'again' }] },
      { kind: 'text', id: 'm2:0', ts: 4, text: 'hello again' }
    ]
    for (const i of items) k.store.saveItem(first.id, i)

    expect((await h['chats.rename']({ chatId: first.id, title: '  Docs pass  ' })).title).toBe('Docs pass')
    await expect(h['chats.rename']({ chatId: first.id, title: ' ' })).rejects.toThrow('Give the chat a name')

    const whole = await h['chats.fork']({ chatId: first.id })
    expect(whole).toMatchObject({ title: 'Fork of Docs pass', sessionId: 'forked-session', kind: 'chat' })
    expect(forks[0]).toEqual(['src-session', { dir: ws.path, upToMessageId: undefined, title: 'Fork of Docs pass' }])
    expect(k.store.items(whole.id)).toHaveLength(4)
    expect(k.store.items(first.id).map((i) => i.id)).toEqual(['u1', 'm1:0', 'u2', 'm2:0'])

    // Forking after a user message ends at the assistant message before it.
    const part = await h['chats.fork']({ chatId: first.id, itemId: 'u2' })
    expect(forks[1]).toEqual(['src-session', { dir: ws.path, upToMessageId: 'm1', title: 'Fork of Docs pass' }])
    expect(k.store.items(part.id)).toHaveLength(2)
    await expect(h['chats.fork']({ chatId: part.id, itemId: k.store.items(part.id)[1].id })).rejects.toThrow('Fork the original chat')

    const term = await h['chats.create']({ workspaceId: ws.id, kind: 'terminal' })
    await expect(h['chats.fork']({ chatId: term.id })).rejects.toThrow('cannot be forked')
    await h['terminal.resize']({ chatId: term.id, cols: 100, rows: 30 })
    expect(k.ptys.has(term.id)).toBe(true)
    await h['chats.close']({ chatId: term.id })
    expect(k.ptys.has(term.id)).toBe(false)
    await expect(h['terminal.write']({ chatId: first.id, data: 'x' })).rejects.toThrow('not a terminal')

    // With a big terminal still open, closing the last chat must still leave a chat to talk to.
    const term2 = await h['chats.create']({ workspaceId: ws.id, kind: 'terminal' })
    for (const c of (await h['chats.list']({ workspaceId: ws.id })).filter((c) => c.kind === 'chat')) await h['chats.close']({ chatId: c.id })
    const withTerm = await h['chats.list']({ workspaceId: ws.id })
    expect(withTerm.map((c) => c.kind).sort()).toEqual(['chat', 'terminal'])
    await h['chats.close']({ chatId: term2.id })

    // Hooks from the big terminal move the agent on the floor.
    const statuses: string[] = []
    const onPush = (e: any) => { if (e.type === 'agent.status' && e.agentId === 'kai') statuses.push(e.status) }
    bus.on('push', onPush)
    const hook = (name: string, extra: object = {}) => fetch(`http://127.0.0.1:${hookPort}/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'big-terminal', transcript_path: '/t', cwd: ws.path, hook_event_name: name, ...extra }) })
    await hook('UserPromptSubmit', { prompt: 'go' })
    await hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' })
    await hook('Stop')
    bus.off('push', onPush)
    expect(statuses).toEqual(['working', 'working', 'idle'])

    // Closed tabs leave the list but keep their transcript.
    for (const c of await h['chats.list']({ workspaceId: ws.id })) await h['chats.close']({ chatId: c.id })
    const left = await h['chats.list']({ workspaceId: ws.id })
    expect(left).toHaveLength(1)
    expect(left[0].title).toBe('New chat')
    expect(k.store.items(first.id)).toHaveLength(4)

    await h['terminal.resize']({ chatId: `shell:${ws.id}`, cols: 80, rows: 24 })
    expect(k.ptys.has(`shell:${ws.id}`)).toBe(true)
    await k.stop()
    expect(k.ptys.has(`shell:${ws.id}`)).toBe(false)
  }, 60_000)

  it('starts a chat you open at the effort you last picked for its model, and hand-offs at the agent effort (KERNEL-141)', async () => {
    const repo = await tempRepo({
      'README.md': '# x\n',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
      '.claude/agents/noor.md': '---\nname: noor\ndescription: Engine engineer.\neffort: low\n---\nYou are Noor.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    const hookPort = 18000 + Math.floor(Math.random() * 900)
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort, worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, models: { effort: 'medium' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const room = await k.addRoom(repo)
    const kai = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Kai' })
    const noor = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'noor', title: 'Noor' })
    const h = k.handlers()
    const sonnet = 'claude-sonnet-5-5'
    expect(k.store.chats(kai.id)[0]).toMatchObject({ model: sonnet, effort: 'medium' })

    // Nothing remembered: the agent's effort, else Settings, Models. Never the first chat's effort.
    k.store.saveChat({ ...k.store.chats(kai.id)[0], effort: 'low' })
    expect(await h['chats.create']({ workspaceId: kai.id })).toMatchObject({ model: sonnet, effort: 'medium' })
    expect(await h['chats.create']({ workspaceId: noor.id })).toMatchObject({ model: sonnet, effort: 'low' })

    // Remembered for the model: every chat you open on it starts there.
    await h['settings.set']({ patch: { models: { effortByModel: { [sonnet]: 'xhigh' } } } })
    expect(await h['chats.create']({ workspaceId: kai.id })).toMatchObject({ model: sonnet, effort: 'xhigh' })
    expect(await h['chats.create']({ workspaceId: noor.id })).toMatchObject({ model: sonnet, effort: 'xhigh' })

    // Closing the last chat tab opens a replacement by the same rule.
    for (const c of await h['chats.list']({ workspaceId: kai.id })) await h['chats.close']({ chatId: c.id })
    const left = await h['chats.list']({ workspaceId: kai.id })
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ model: sonnet, effort: 'xhigh' })

    // The Lead's hand-offs follow the agent file, not the last effort picked by hand.
    const handoff = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Kai again' })
    expect(k.store.chats(handoff.id)[0]).toMatchObject({ model: sonnet, effort: 'medium' })
    await k.stop()

    // The memory survives a restart, before anything has read the team.
    const again = new Kernel({ dataDir, home })
    await again.start()
    expect(again.settings.models.effortByModel).toEqual({ [sonnet]: 'xhigh' })
    await again.handlers()['settings.set']({ patch: { models: { effortByModel: { [sonnet]: undefined } } } })
    expect(await again.handlers()['chats.create']({ workspaceId: noor.id })).toMatchObject({ model: sonnet, effort: 'low' })
    await again.stop()
  }, 60_000)
})
