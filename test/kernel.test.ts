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

    const lead = await k.leadChat(room.id)
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
})
