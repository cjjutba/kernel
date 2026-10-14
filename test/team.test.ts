import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { git } from '../src/main/services/exec'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import type { PushEvent } from '../src/shared/ipc'

describe('team handlers (KERNEL-19)', () => {
  it('edits, hires and retires an agent, and sees a file added outside Kernel', async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead. Plans and hands out tasks.\nlead: true\n---\nYou are Kernel.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer. Builds UI.\nmodel: sonnet\n---\nYou are Kai.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const h = k.handlers()
    const pushed: PushEvent[] = []
    const onPush = (e: PushEvent) => pushed.push(e)
    bus.on('push', onPush)
    try {
      const room = await k.addRoom(repo)
      await k.agents(room.id)

      // Save, just for the user by default (KERNEL-466), pushes the reloaded team and leaves the repo's file as it is.
      const kaiFile = await readFile(join(repo, '.claude', 'agents', 'kai.md'), 'utf8')
      const saved = await h['agents.save']({ roomId: room.id, agentId: 'kai', patch: { effort: 'high', tools: ['Read', 'Edit'] } })
      expect(saved).toMatchObject({ id: 'kai', effort: 'high', tools: ['Read', 'Edit'], model: 'sonnet' })
      expect(pushed.find((e) => e.type === 'agents')).toBeTruthy()
      expect(await readFile(join(repo, '.claude', 'agents', 'kai.md'), 'utf8')).toBe(kaiFile)

      // Hire from a draft: the file lands in ~/.claude/agents and the agent takes a desk at the end of room.desks.
      await k.updateRoom(room.id, { desks: ['kernel-lead', 'kai'] })
      const draft = await h['agents.draft']({ roomId: room.id, description: 'A designer who checks screens against DESIGN.md', name: 'Wren' })
      const wren = await h['agents.create']({ roomId: room.id, draft })
      expect(wren).toMatchObject({ id: 'wren', origin: 'personal', file: join(home, '.claude', 'agents', 'wren.md') })
      expect(await readdir(join(home, '.claude', 'agents'))).toEqual(['wren.md'])
      expect((await readdir(join(repo, '.claude', 'agents'))).sort()).toEqual(['kai.md', 'kernel.md'])
      expect(k.store.room(room.id)?.desks).toEqual(['kernel-lead', 'kai', 'wren'])

      // The profile's model and effort reach the chat a new workspace starts with.
      await h['agents.save']({ roomId: room.id, agentId: 'kai', patch: { model: 'fable', effort: 'xhigh' } })
      const fable = await k.createWorkspace(room.id, { prompt: 'One', agentId: 'kai', title: 'Model one' })
      expect(k.store.chats(fable.id)[0]).toMatchObject({ model: 'claude-fable-5-1', effort: 'xhigh' })
      await h['agents.save']({ roomId: room.id, agentId: 'kai', patch: { model: 'sonnet' } })
      const sonnet = await k.createWorkspace(room.id, { prompt: 'Two', agentId: 'kai', title: 'Model two' })
      expect(k.store.chats(sonnet.id)[0].model).toBe('claude-sonnet-5-5')

      // Retire hands the open workspace to the Lead and frees the desk, and the file stays. The Lead cannot be retired.
      const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Table' })
      await expect(h['agents.retire']({ roomId: room.id, agentId: 'kernel-lead' })).rejects.toThrow(/leads this room/)
      await h['agents.retire']({ roomId: room.id, agentId: 'kai' })
      expect(k.store.workspace(ws.id)?.agentId).toBe('kernel-lead')
      expect(k.store.room(room.id)?.desks).toEqual(['kernel-lead', 'wren'])
      expect((await h['agents.list']({ roomId: room.id })).map((a) => a.id)).toEqual(['kernel-lead', 'wren'])
      expect((await h['agents.list']({ roomId: room.id, retired: true })).map((a) => a.id)).toEqual(['kai'])
      expect((await h['agents.restore']({ roomId: room.id, agentId: 'kai' })).id).toBe('kai')
      // None of it touched the checkout.
      expect(await git(repo, 'status', '--porcelain')).toBe('')

      // A file added by hand shows up through the folder watcher.
      pushed.length = 0
      await writeFile(join(repo, '.claude', 'agents', 'ivy.md'), '---\nname: ivy\ndescription: QA. Runs tests.\n---\nYou are Ivy.')
      for (let i = 0; i < 40 && !pushed.some((e) => e.type === 'agents'); i++) await new Promise((r) => setTimeout(r, 50))
      const team = pushed.find((e) => e.type === 'agents')
      expect(team && team.type === 'agents' && team.agents.map((a) => a.id)).toContain('ivy')
    } finally {
      bus.off('push', onPush)
      await k.stop()
    }
  })
})
