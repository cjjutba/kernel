import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityEvent } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { git } from '../src/main/services/exec'
import { TOOL_STOPPED } from '../src/main/services/sessions'
import { tempRepo, freePort } from './helpers'

// What a restart finds after a crash (docs/decisions/durable-tool-calls.md): the gaps the start left, and the ones it already closed.

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

const tool = (id: string) => ({ kind: 'tool' as const, id, ts: 1, toolUseId: id, name: 'Bash', label: 'Bash', detail: 'sleep 100', status: 'running' as const })

describe('a tool row left running by a crash', () => {
  it('fails at the next start, in a chat the journal no longer lists, open or closed', async () => {
    const where = await dirs()
    let k = await boot(where)
    const project = await k.addProject(await tempRepo(REPO))
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(project.id, { prompt: 'Go', agentId: 'christian', title: 'Invoice table' })
    const chat = k.chatTabs(ws.id)[0]
    // A Stop just before the quit takes the chat out of the journal, and the force quit comes before its rows end.
    k.store.saveItem(chat.id, tool('stopped'))
    const closed = { ...chat, id: 'closed-chat', closed: true, closedAt: 2 }
    k.store.saveChat(closed as never)
    k.store.saveItem(closed.id, tool('closed'))
    await k.stop({ budgetMs: 0 })
    k = await boot(where)
    for (const [id, tab] of [['stopped', chat.id], ['closed', closed.id]] as const) {
      expect(k.store.items(tab).find((i) => i.id === id)).toMatchObject({ status: 'failed', output: TOOL_STOPPED })
    }
  })
})

describe('a worktree under the project worktree root that no workspace has', () => {
  it('is reported with a note and a toast, once, and never removed, even with uncommitted work', async () => {
    const where = await dirs()
    let k = await boot(where)
    const repo = await tempRepo(REPO)
    const project = await k.addProject(repo)
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(project.id, { prompt: 'Go', agentId: 'christian', title: 'Invoice table' })
    // A crash between `git worktree add` and the saved record leaves one of these.
    const stray = join(ws.path, '..', 'stray-one')
    await git(repo, 'worktree', 'add', '-b', 'stray/one', stray, 'main')
    await writeFile(join(stray, 'unsaved.txt'), 'work in progress')
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(join(stray, '.git'), old, old)
    await k.stop({ budgetMs: 0 })

    const notes: ActivityEvent[] = []
    const toasts: string[] = []
    const onActivity = (e: ActivityEvent) => notes.push(e)
    const onPush = (e: PushEvent) => { if (e.type === 'toast') toasts.push(e.toast.title) }
    bus.on('activity', onActivity)
    bus.on('push', onPush)
    onTestFinished(() => { bus.off('activity', onActivity); bus.off('push', onPush) })
    k = await boot(where)
    await vi.waitFor(() => expect(toasts.filter((t) => t.includes('no chat uses'))).toHaveLength(1))
    const note = notes.find((e) => e.object?.includes('stray-one'))
    expect(note).toMatchObject({ projectId: project.id, warn: true })
    expect(note?.text).toContain('uncommitted')
    // Nothing of the user's is touched, and the open workspace isn't taken for a stray.
    expect(existsSync(join(stray, 'unsaved.txt'))).toBe(true)
    expect(existsSync(ws.path)).toBe(true)
    expect(notes.filter((e) => e.object?.includes(ws.path))).toHaveLength(0)

    // The same folder isn't reported at every start.
    await k.stop({ budgetMs: 0 })
    toasts.length = 0
    k = await boot(where)
    await k.workspaces.sweepAllSpares()
    expect(toasts.filter((t) => t.includes('no chat uses'))).toHaveLength(0)
  })

  it('is left alone while it is new, as a workspace being made is', async () => {
    const where = await dirs()
    let k = await boot(where)
    const repo = await tempRepo(REPO)
    const project = await k.addProject(repo)
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(project.id, { prompt: 'Go', agentId: 'christian', title: 'Invoice table' })
    await git(repo, 'worktree', 'add', '-b', 'fresh/one', join(ws.path, '..', 'fresh-one'), 'main')
    expect(await k.workspaces.reportStrays()).toEqual([])
    await k.stop({ budgetMs: 0 })
    k = await boot(where)
    expect(await k.workspaces.reportStrays()).toEqual([])
  })
})
