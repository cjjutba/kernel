import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { kernelTools } from '../src/main/services/kernelMcp'
import { git } from '../src/main/services/exec'
import type { AgentDef } from '../src/shared/types'
import { tempRepo } from './helpers'

// A chat with Rowan's held first message goes out through the real send once its setup passes (KERNEL-405).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// KERNEL-400: a workspace nobody picked a base for starts from the repo's default branch, where its PR goes.

const TEAM = {
  'README.md': '# quarter\n',
  '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
  '.claude/agents/theo.md': '---\nname: theo\ndescription: Reviewer. Reviews PRs.\nrole: Reviewer\n---\nYou are Theo.'
}

/** A clone of a repo with `main` and `dev`, where `dev` holds a merged PR `main` lacks. `head` is the remote's default. Both are local branches too. */
async function clone(head: 'main' | 'dev') {
  const remote = await tempRepo(TEAM)
  await git(remote, 'checkout', '-qb', 'dev')
  await writeFile(join(remote, 'merged.txt'), 'another PR\n')
  await git(remote, 'add', '-A')
  await git(remote, 'commit', '-qm', 'another PR')
  await git(remote, 'checkout', '-q', head)
  const dir = join(await mkdtemp(join(tmpdir(), 'kernel-clone-')), 'quarter')
  await git(remote, 'clone', '-q', remote, dir)
  if (head === 'dev') await git(dir, 'branch', 'main', 'origin/main')
  return dir
}

/** A kernel whose settings file holds `workspace`, as every install's does after a launch (D-094). */
async function kernel(workspace: Record<string, string> = { baseRef: 'origin/main' }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop())
  k.sessions.send = async () => ({ queued: false })
  return k
}

const task = (k: Kernel, roomId: string, o: { baseRef?: string } = {}) => k.workspaces.createWorkspace(roomId, { prompt: 'Change one line', agentId: 'kai', ...o })

describe('the base of a new workspace (KERNEL-400)', () => {
  it('starts from origin/dev in a dev room when no base was set, as the Lead does, and counts only its own change', async () => {
    const repo = await clone('dev')
    const k = await kernel()
    const room = await k.rooms.addRoom(repo)
    expect(room.defaultBranch).toBe('dev')
    const ws = await task(k, room.id)
    expect(ws.baseRef).toBe('origin/dev')
    expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'origin/dev'))
    await k.lead.leadChat(room.id)
    expect(k.store.workspaces(room.id).find((w) => w.lead)?.baseRef).toBe('origin/dev')
    await writeFile(join(ws.path, 'one.txt'), 'one line\n')
    await git(ws.path, 'add', '-A')
    await git(ws.path, 'commit', '-qm', 'one line')
    await k.workspaces.changes(ws.id)
    expect(k.store.workspace(ws.id)?.stat).toEqual({ files: 1, added: 1, removed: 0 })
  })

  it('keeps origin/main in a room whose default is main', async () => {
    const k = await kernel()
    const room = await k.rooms.addRoom(await clone('main'))
    expect((await task(k, room.id)).baseRef).toBe('origin/main')
  })

  it('takes a base set in Settings, Git and worktrees', async () => {
    const k = await kernel({ baseRef: 'main' })
    const room = await k.rooms.addRoom(await clone('dev'))
    expect((await task(k, room.id)).baseRef).toBe('main')
  })

  it("takes a base set in the room's settings files, even the app's shipped one", async () => {
    const repo = await clone('dev')
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[workspace]\nbase_ref = "origin/main"\n')
    const k = await kernel()
    const room = await k.rooms.addRoom(repo)
    expect((await task(k, room.id)).baseRef).toBe('origin/main')
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[workspace]\nbase_ref = "main"\n')
    expect((await task(k, room.id)).baseRef).toBe('main')
  })

  it("takes the Lead's base_ref from create_workspace", async () => {
    const k = await kernel()
    const room = await k.rooms.addRoom(await clone('dev'))
    const tool = kernelTools({
      roomId: room.id, lead: undefined, agents: async () => [{ id: 'kai', name: 'Kai', role: 'Frontend', lead: false } as AgentDef], workspaces: () => [],
      createWorkspace: (o) => k.workspaces.createWorkspace(room.id, o), messageWorkspace: async () => ({ ok: true, sent: true, note: 'Sent.' }), askUser: async () => null,
      hireAgent: async () => '', archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false
    }).find((t) => t.name === 'create_workspace')!
    await tool.handler({ agent: 'kai', title: 'Inbox actions', brief: 'Go', base_ref: 'origin/main' } as never, {})
    expect(k.store.workspaces(room.id)[0].baseRef).toBe('origin/main')
  })

  it('starts a review from the work it reviews, not the default branch', async () => {
    const k = await kernel()
    const room = await k.rooms.addRoom(await clone('dev'))
    const author = await task(k, room.id)
    const review = await k.workspaces.createWorkspace(room.id, { prompt: 'Review it', agentId: 'theo', reviewOf: author.id })
    expect(review.baseRef).toBe(author.branch)
  })
})
