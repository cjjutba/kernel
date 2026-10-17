import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { setUp, tempRepo, freePort } from './helpers'

// KERNEL-291: a worktree workspace whose folder was deleted outside Kernel says so, and archives and restores.

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.'
}

async function dirs() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  return { dataDir, home }
}

async function boot(where: { dataDir: string; home: string }) {
  const k = new Kernel(where)
  k.signedInReader = async () => true
  await k.start()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  return k
}

describe('a workspace whose folder was deleted outside Kernel (KERNEL-291)', () => {
  it('is flagged when it is opened, with a push, refuses a turn, and archives', async () => {
    const k = await boot(await dirs())
    const project = await k.addProject(await tempRepo(REPO))
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(project.id, { prompt: 'Go', agentId: 'christian', title: 'Invoice table' })
    delete (k.sessions as { send?: unknown }).send
    const chat = k.chatTabs(ws.id)[0]
    const pushed: boolean[] = []
    const on = (e: PushEvent) => { if (e.type === 'workspace' && e.workspace.id === ws.id) pushed.push(!!e.workspace.folderGone) }
    bus.on('push', on)
    onTestFinished(() => { bus.off('push', on) })
    await rm(ws.path, { recursive: true, force: true })
    expect(await k.handlers()['workspaces.changes']({ workspaceId: ws.id })).toEqual([])
    expect(k.store.workspace(ws.id)?.folderGone).toBe(true)
    expect(pushed).toEqual([true])
    // Asking again changes nothing, so nothing is pushed again.
    await k.handlers()['workspaces.changes']({ workspaceId: ws.id })
    expect(pushed).toEqual([true])
    await expect(k.sessions.send(chat.id, [{ type: 'text', text: 'Carry on' }])).rejects.toThrow(`${ws.name}'s folder is gone`)
    expect(k.sessions.queued(chat.id)).toEqual([])
    expect(k.sessions.post(chat.id, [{ type: 'text', text: 'Update' }])).toBe(false)
    await k.archiveWorkspace(ws.id)
    expect(k.store.workspace(ws.id)).toMatchObject({ status: 'archived' })
    expect(k.store.workspace(ws.id)?.folderGone).toBeUndefined()
  })

  it('is flagged at launch, and Restore makes the folder again, sets it up and clears the flag', async () => {
    const where = await dirs()
    let k = await boot(where)
    const project = await k.addProject(await tempRepo(REPO))
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(project.id, { prompt: 'Go', agentId: 'christian', title: 'Invoice table' })
    await k.stop({ budgetMs: 0 })
    await rm(ws.path, { recursive: true, force: true })
    k = await boot(where)
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.folderGone).toBe(true))
    await k.archiveWorkspace(ws.id)
    const back = await k.restoreWorkspace(ws.id)
    expect(back.status).toBe('setup')
    expect(back.folderGone).toBeUndefined()
    await setUp(k, ws.id)
    expect(existsSync(join(ws.path, 'README.md'))).toBe(true)
    await k.handlers()['workspaces.changes']({ workspaceId: ws.id })
    expect(k.store.workspace(ws.id)?.folderGone).toBeUndefined()
  })

  it('clears the flag when the folder is back, and never flags a current-branch workspace', async () => {
    const k = await boot(await dirs())
    const repo = await tempRepo(REPO)
    const project = await k.addProject(repo)
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(project.id, { prompt: 'Go', agentId: 'christian', title: 'Invoice table' })
    k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, folderGone: true })
    expect(await k.workspaces.checkFolder(ws.id)).toBe(false)
    expect(k.store.workspace(ws.id)?.folderGone).toBeUndefined()
    const current = await k.createWorkspace(project.id, { prompt: 'Go', agentId: 'christian', title: 'Here', mode: 'current' })
    k.store.saveWorkspace({ ...current, path: join(repo, 'not-there') })
    expect(await k.workspaces.checkFolder(current.id)).toBe(false)
    expect(k.store.workspace(current.id)?.folderGone).toBeUndefined()
  })
})
