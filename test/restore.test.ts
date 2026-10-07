import { describe, expect, it } from 'vitest'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'

describe('restore and Ask Rowan', () => {
  it('recreates the worktree from the branch and keeps the chats', async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const sent: string[] = []
    k.sessions.send = async (_chatId, parts) => { sent.push(parts.map((p) => (p.type === 'text' ? p.text : '')).join('')); return { queued: false } }

    const room = await k.addRoom(repo)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    const chats = k.store.chats(ws.id).map((c) => c.id)
    // Archive keeps the branch, so Restore can find it again.
    await k.archiveWorkspace(ws.id, false)
    expect(k.store.workspace(ws.id)).toMatchObject({ status: 'archived' })
    expect(k.store.workspace(ws.id)?.archivedAt).toBeGreaterThan(0)
    await expect(stat(ws.path)).rejects.toThrow()

    const back = await k.handlers()['workspaces.restore']({ workspaceId: ws.id })
    expect(back).toMatchObject({ id: ws.id, status: 'ready', branch: ws.branch })
    expect(back.archivedAt).toBeUndefined()
    expect((await stat(ws.path)).isDirectory()).toBe(true)
    expect(k.store.chats(ws.id).map((c) => c.id)).toEqual(chats)

    // A workspace made while this one was archived may take its port. Restore picks another.
    const other = await k.createWorkspace(room.id, { prompt: 'Another', agentId: 'kai', title: 'Other' })
    k.store.saveWorkspace({ ...other, port: ws.port })
    await k.archiveWorkspace(ws.id, false)
    expect((await k.restoreWorkspace(ws.id)).port).not.toBe(ws.port)

    // A branch deleted on archive cannot come back, and the message says so.
    await k.archiveWorkspace(ws.id, true)
    await expect(k.restoreWorkspace(ws.id)).rejects.toThrow(/no longer exists/)
    expect(k.store.workspace(ws.id)?.status).toBe('archived')

    const { chatId } = await k.handlers()['lead.ask']({ roomId: room.id, text: 'Who is blocked?' })
    expect(sent[sent.length - 1]).toBe('Who is blocked?')
    expect(k.store.chat(chatId)?.workspaceId).toBe((await k.leadChat(room.id)).workspaceId)
  }, 30000)
})
