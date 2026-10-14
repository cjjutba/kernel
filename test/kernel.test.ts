import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setUp, tempRepo, trustRoom } from './helpers'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { PORT_BLOCK, type ActivityEvent, type ChatPart } from '../src/shared/types'

// A chat with Rowan's first message waits for setup, and goes out through the real send when setup passes (KERNEL-405), so no
// Claude Code process may start here.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}), tool: () => ({}),
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 0 })
  })
}))

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
    await trustRoom(k, room.id)
    const agents = await k.agents(room.id)
    expect(agents.map((a) => [a.id, a.lead])).toEqual([['rowan', true], ['kai', false]])
    // The preview reads the room's saved list, or the patterns the user is typing (KERNEL-245).
    expect(await k.handlers()['files.preview']({ roomId: room.id })).toEqual([{ path: '.env.local', size: 9 }])
    expect(await k.handlers()['files.preview']({ roomId: room.id, patterns: ['*.md', '.env*'] })).toEqual([{ path: '.env.local', size: 9 }])

    const ws = await k.createWorkspace(room.id, { prompt: 'Build the invoice table with empty states', agentId: 'kai', title: 'Invoice table' })
    expect(ws).toMatchObject({ status: 'ready', branch: 'feat/invoice-table', mode: 'worktree', agentId: 'kai' })
    expect(await readFile(join(ws.path, '.env.local'), 'utf8')).toBe('SECRET=1\n')
    expect(sent).toEqual(['Build the invoice table with empty states'])
    expect(k.store.chats(ws.id)).toHaveLength(1)

    await writeFile(join(ws.path, 'table.tsx'), 'export {}\n')
    expect((await k.changes(ws.id)).map((f) => f.path)).toEqual(['table.tsx'])

    const second = await k.createWorkspace(room.id, { prompt: 'Another pass', agentId: 'kai', title: 'Invoice table' })
    expect(second.branch).toBe('feat/invoice-table-2')
    // Each workspace gets its own block of ports, $KERNEL_PORT to $KERNEL_PORT + 9 (KERNEL-244).
    expect(second.port % PORT_BLOCK).toBe(0)
    expect(Math.abs(second.port - ws.port)).toBeGreaterThanOrEqual(PORT_BLOCK)

    await k.archiveWorkspace(ws.id, true)
    expect(k.store.workspace(ws.id)?.status).toBe('archived')
    await expect(stat(ws.path)).rejects.toThrow()

    // The sidebar row, Cmd+K and Cmd+Shift+L open the Lead before anyone briefs it. With no chat open, lead.open finds
    // nothing, makes nothing and sends nothing (KERNEL-365, KERNEL-405).
    const quiet = sent.length
    expect(await k.handlers()['lead.open']({ roomId: room.id })).toBeNull()
    expect(k.store.workspaces(room.id).filter((w) => w.lead)).toEqual([])
    expect(sent).toHaveLength(quiet)

    // Kernel's own send starts a chat in its own worktree, on its own branch from the default branch, not the main checkout,
    // with files.copy and setup run like a teammate's (KERNEL-405).
    const lead = await k.leadChat(room.id)
    const opened = await setUp(k, lead.id)
    expect(opened).toMatchObject({ agentId: 'rowan', mode: 'worktree', branch: 'rowan/chat', baseRef: 'main', lead: true, threadId: lead.threadId })
    expect(opened.path).not.toBe(repo)
    expect(await readFile(join(opened.path, '.env.local'), 'utf8')).toBe('SECRET=1\n')
    expect((await k.handlers()['lead.open']({ roomId: room.id }))?.id).toBe(opened.id)
    expect((await k.leadChat(room.id)).id).toBe(lead.id)
    expect(k.statusOf(room.id)).toEqual({ rowan: 'idle', kai: 'idle' })

    // A brief logs an activity line with the brief quoted.
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
    // The first message goes once the chat's worktree exists, while setup runs (KERNEL-405, KERNEL-542).
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', leadWaitForSetup: false } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    // What waits in a chat's queue, and what it sent, as text.
    const text = (parts: ChatPart[]) => parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    const waiting = (chatId: string) => k.sessions.queued(chatId).map((q) => text(q.parts))
    const said = (chatId: string) => k.store.items(chatId).flatMap((i) => (i.kind === 'user' ? [text(i.parts)] : []))
    const pushed: string[] = []
    const onPush = (e: { type: string; chat?: { id: string } }) => { if (e.type === 'chat' && e.chat) pushed.push(e.chat.id) }
    bus.on('push', onPush)
    const start = k.handlers()['lead.start']

    const solo = await k.addRoom(leadless)
    await expect(start({ roomId: solo.id, prompt: 'Hello' })).rejects.toThrow('No Lead in this room. Mark one agent with "lead: true", or pick one on this room\'s Agents page in Settings.')

    const room = await k.addRoom(repo)
    const chats = (wsId: string) => k.store.chats(wsId).filter((c) => c.kind !== 'terminal')

    // The first call makes a chat with its own workspace, on a branch named from the prompt, with the Lead's defaults, and sends
    // the prompt (KERNEL-405).
    const first = await start({ roomId: room.id, prompt: 'Add PDF export to invoices' })
    const ws = k.store.workspace(first.workspaceId)!
    expect(ws).toMatchObject({ agentId: 'rowan', mode: 'worktree', branch: 'rowan/add-pdf-export-to-invoices', lead: true, threadId: first.threadId })
    expect(chats(ws.id)).toHaveLength(1)
    expect(first).toMatchObject({ title: 'New tab', kind: 'chat', model: 'claude-opus-5-5', effort: 'medium', plan: true })
    expect(waiting(first.id)).toEqual(['Add PDF export to invoices'])
    expect(pushed).toContain(first.id)

    // A second call is a second chat, with its own workspace, branch and ports, and the request's model, effort and plan win.
    const second = await start({ roomId: room.id, prompt: 'Look at the', parts: [{ type: 'text', text: 'Look at the flaky test' }], model: 'claude-sonnet-5-5', effort: 'low', plan: false })
    const other = k.store.workspace(second.workspaceId)!
    expect(other.id).not.toBe(ws.id)
    expect(other.branch).not.toBe(ws.branch)
    expect(Math.abs(other.port - ws.port)).toBeGreaterThanOrEqual(PORT_BLOCK)
    expect(second.threadId).not.toBe(first.threadId)
    expect(k.store.chat(second.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low', plan: false })
    expect(waiting(second.id)).toEqual(['Look at the flaky test'])

    // A tab nobody used yet is left alone, since its composer may hold a draft. The brief starts a chat of its own (KERNEL-242).
    const blank = await k.handlers()['chats.create']({ workspaceId: ws.id })
    expect(blank.threadId).toBe(first.threadId)
    const third = await start({ roomId: room.id, prompt: 'Plan the export', effort: 'xhigh' })
    expect(third.workspaceId).not.toBe(ws.id)
    expect(chats(ws.id).map((c) => c.id)).toEqual([first.id, blank.id])
    expect(k.store.chat(third.id)).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', plan: true })
    expect(k.store.chat(blank.id)).toEqual(blank)
    expect(waiting(third.id)).toEqual(['Plan the export'])
    for (const id of [ws.id, other.id, third.workspaceId]) await setUp(k, id)
    expect([first, second, third].map((c) => said(c.id))).toEqual([['Add PDF export to invoices'], ['Look at the flaky test'], ['Plan the export']])
    expect(said(blank.id)).toEqual([])
    bus.off('push', onPush)
    await k.stop()
  })

  it('lead.open makes no chat or workspace, and lead.start opens its own (KERNEL-242, KERNEL-365, KERNEL-405)', async () => {
    const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const room = await k.addRoom(repo)

    // Opening the room finds no chat, and makes neither a chat nor a workspace.
    expect(await k.handlers()['lead.open']({ roomId: room.id })).toBeNull()
    expect(k.store.workspaces(room.id)).toEqual([])
    expect(k.store.threads(room.id)).toEqual([])
    const chat = await k.handlers()['lead.start']({ roomId: room.id, prompt: 'Add PDF export' })
    const ws = await setUp(k, chat.id)
    expect(k.store.chats(ws.id).map((c) => c.id)).toEqual([chat.id])
    expect(chat).toMatchObject({ workspaceId: ws.id, title: 'New tab', model: 'claude-opus-5-5', effort: 'high', plan: true })
    await k.stop()
  })

  it('lead.start in a room with no Lead workspace leaves exactly one Lead tab, with the brief (KERNEL-242)', async () => {
    const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const room = await k.addRoom(repo)
    expect(k.store.workspaces(room.id)).toEqual([])

    const chat = await k.handlers()['lead.start']({ roomId: room.id, prompt: 'Add PDF export' })
    // The brief waits for the chat's worktree, then goes while setup runs (KERNEL-490, KERNEL-542).
    expect(k.sessions.queued(chat.id).map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Add PDF export' }]])
    await vi.waitFor(() => expect(k.store.items(chat.id).map((i) => i.kind === 'user' && i.parts)).toEqual([[{ type: 'text', text: 'Add PDF export' }]]))
    // The modal then lands on the chat through lead.open, which must find the brief's tab rather than add a "Lead" one.
    const ws = (await k.handlers()['lead.open']({ roomId: room.id }))!
    expect(ws.id).toBe(chat.workspaceId)
    expect(k.store.chats(ws.id).map((c) => c.id)).toEqual([chat.id])
    await setUp(k, ws.id)
    await k.stop()
  })
})
