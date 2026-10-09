import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import type { ActivityEvent } from '../src/shared/types'

describe('Kernel orchestration (Claude session stubbed)', () => {
  it('adds a room, reads its team, creates and archives a worktree workspace', async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.gitignore': '.env.local\nnode_modules\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead. Plans and hands out tasks.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer. Builds UI.\n---\nYou are Kai.',
      '.kernel/settings.toml': '[scripts]\nsetup = "echo setting up && test -f .env.local"\n\n[files]\ncopy = [".env.local"]\n'
    })
    await writeFile(join(repo, '.env.local'), 'SECRET=1\n')
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const sent: string[] = []
    k.sessions.send = async (_chatId, parts) => { sent.push(parts.map((p) => (p.type === 'text' ? p.text : '')).join('')); return { queued: false } }

    const room = await k.addRoom(repo)
    const agents = await k.agents(room.id)
    expect(agents.map((a) => [a.id, a.lead])).toEqual([['rowan', true], ['kai', false]])

    const ws = await k.createWorkspace(room.id, { prompt: 'Build the invoice table with empty states', agentId: 'kai', title: 'Invoice table' })
    expect(ws).toMatchObject({ status: 'ready', branch: 'feat/invoice-table', mode: 'worktree', agentId: 'kai' })
    expect(await readFile(join(ws.path, '.env.local'), 'utf8')).toBe('SECRET=1\n')
    expect(sent).toEqual(['Build the invoice table with empty states'])
    expect(k.store.chats(ws.id)).toHaveLength(1)

    await writeFile(join(ws.path, 'table.tsx'), 'export {}\n')
    expect((await k.changes(ws.id)).map((f) => f.path)).toEqual(['table.tsx'])

    const second = await k.createWorkspace(room.id, { prompt: 'Another pass', agentId: 'kai', title: 'Invoice table' })
    expect(second.branch).toBe('feat/invoice-table-2')
    expect(second.port).not.toBe(ws.port)

    await k.archiveWorkspace(ws.id, true)
    expect(k.store.workspace(ws.id)?.status).toBe('archived')
    await expect(stat(ws.path)).rejects.toThrow()

    // The sidebar row, Cmd+K and Cmd+Shift+L open the Lead before anyone briefs it. lead.open makes the workspace once and sends nothing.
    const quiet = sent.length
    const opened = await k.handlers()['lead.open']({ roomId: room.id })
    expect(opened).toMatchObject({ name: 'lead', agentId: 'rowan', mode: 'current', path: repo, status: 'ready' })
    expect(k.store.chats(opened.id).filter((c) => c.kind !== 'terminal')).toHaveLength(1)
    expect((await k.handlers()['lead.open']({ roomId: room.id })).id).toBe(opened.id)
    expect(sent).toHaveLength(quiet)

    const lead = await k.leadChat(room.id)
    expect(lead.workspaceId).toBe(opened.id)
    expect(k.store.workspace(lead.workspaceId)).toMatchObject({ agentId: 'rowan', mode: 'current', path: repo })
    expect(k.statusOf(room.id)).toEqual({ rowan: 'idle', kai: 'idle' })

    // A brief logs the line the floor's briefing sequence starts from (FloorSent.png).
    const logged: ActivityEvent[] = []
    const onActivity = (e: ActivityEvent) => logged.push(e)
    bus.on('activity', onActivity)
    await k.handlers()['rooms.brief']({ roomId: room.id, text: 'Add PDF export to invoices. Spec first.' })
    bus.off('activity', onActivity)
    expect(logged.find((e) => e.kind === 'brief')).toMatchObject({ roomId: room.id, actor: 'you', agentId: 'rowan', workspaceId: lead.workspaceId, text: 'briefed Rowan', quote: 'Add PDF export to invoices. Spec first.' })
    expect(sent[sent.length - 1]).toBe('Add PDF export to invoices. Spec first.')
    await k.stop()
  })

  it('lead.start sends the new workspace prompt to the Lead in a chat of its own (KERNEL-148)', async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead. Plans and hands out tasks.\nlead: true\neffort: medium\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer. Builds UI.\n---\nYou are Kai.'
    })
    const leadless = await tempRepo({ 'README.md': '# solo\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    // A real send writes the user's message into the chat, which is what makes the chat used.
    const sent: { chatId: string; text: string }[] = []
    k.sessions.send = async (chatId, parts) => {
      sent.push({ chatId, text: parts.map((p) => (p.type === 'text' ? p.text : '')).join('') })
      k.store.saveItem(chatId, { kind: 'user', id: `u${sent.length}`, ts: Date.now(), parts })
      return { queued: false }
    }
    const pushed: string[] = []
    const onPush = (e: { type: string; chat?: { id: string } }) => { if (e.type === 'chat' && e.chat) pushed.push(e.chat.id) }
    bus.on('push', onPush)
    const start = k.handlers()['lead.start']

    const solo = await k.addRoom(leadless)
    await expect(start({ roomId: solo.id, prompt: 'Hello' })).rejects.toThrow('No lead agent. Mark one agent with "lead: true".')

    const room = await k.addRoom(repo)
    const chats = (wsId: string) => k.store.chats(wsId).filter((c) => c.kind !== 'terminal')

    // The first call makes the Lead's workspace and one chat with the Lead's defaults, and sends the prompt.
    const first = await start({ roomId: room.id, prompt: 'Add PDF export to invoices' })
    const ws = k.store.workspace(first.workspaceId)!
    expect(ws).toMatchObject({ name: 'lead', agentId: 'rowan', mode: 'current', path: repo })
    expect(chats(ws.id)).toHaveLength(1)
    expect(first).toMatchObject({ title: 'New chat', kind: 'chat', model: 'claude-opus-5-5', effort: 'medium', plan: true })
    expect(sent).toEqual([{ chatId: first.id, text: 'Add PDF export to invoices' }])
    expect(pushed).toContain(first.id)

    // A second call adds a second chat to the same workspace, and the request's model, effort and plan win.
    const second = await start({ roomId: room.id, prompt: 'Look at the', parts: [{ type: 'text', text: 'Look at the flaky test' }], model: 'claude-sonnet-5-5', effort: 'low', plan: false })
    expect(second.workspaceId).toBe(ws.id)
    expect(second.id).not.toBe(first.id)
    expect(chats(ws.id)).toHaveLength(2)
    expect(k.store.chat(second.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low', plan: false })
    expect(sent[1]).toEqual({ chatId: second.id, text: 'Look at the flaky test' })

    // A chat nobody used yet is taken, not duplicated, and takes the request's settings.
    const blank = await k.handlers()['chats.create']({ workspaceId: ws.id })
    const third = await start({ roomId: room.id, prompt: 'Plan the export', effort: 'xhigh' })
    expect(third.id).toBe(blank.id)
    expect(chats(ws.id)).toHaveLength(3)
    expect(k.store.chat(blank.id)).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', plan: true })
    expect(sent[2]).toEqual({ chatId: blank.id, text: 'Plan the export' })
    bus.off('push', onPush)
    await k.stop()
  })

  it('lead.start takes the empty "Lead" chat lead.open made, and the first message names it (KERNEL-148)', async () => {
    const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const room = await k.addRoom(repo)

    const ws = await k.handlers()['lead.open']({ roomId: room.id })
    const [opened] = k.store.chats(ws.id)
    expect(opened.title).toBe('Lead')
    const chat = await k.handlers()['lead.start']({ roomId: room.id, prompt: 'Add PDF export' })
    expect(chat.id).toBe(opened.id)
    expect(k.store.chats(ws.id)).toHaveLength(1)
    expect(chat).toMatchObject({ title: 'New chat', model: 'claude-opus-5-5', effort: 'high', plan: true })
    await k.stop()
  })
})
