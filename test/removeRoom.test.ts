import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { run } from '../src/main/services/exec'
import { Kernel } from '../src/main/kernel'

// KERNEL-75: removing a room archives its workspaces for real (ConfirmRemoveRoom.png), then forgets the room.

const KAI = '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'

async function setup() {
  const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/kai.md': KAI })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', deleteBranchOnArchive: true } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  const room = await k.addRoom(repo)
  const done = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Nothing unpushed' })
  const busy = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Unpushed work' })
  await writeFile(join(busy.path, 'work.ts'), 'work\n')
  await run('git', ['-C', busy.path, 'add', '-A'])
  await run('git', ['-C', busy.path, 'commit', '-q', '-m', 'only here'])
  const branch = async (name: string) => (await run('git', ['-C', repo, 'branch', '--list', name])).trim()
  return { k, room, repo, done, busy, branch }
}

describe('removing a room', () => {
  it('archives each workspace, deletes the worktrees when asked, keeps branches with unpushed commits, and forgets the room', async () => {
    const { k, room, done, busy, branch } = await setup()
    await k.removeRoom(room.id, true)
    expect(existsSync(done.path)).toBe(false)
    expect(existsSync(busy.path)).toBe(false)
    // "Delete branch on archive" is on: the empty branch goes, the one with unpushed work stays.
    expect(await branch(done.branch)).toBe('')
    expect(await branch(busy.branch)).toContain(busy.branch)
    expect(k.store.room(room.id)).toBeUndefined()
    expect(k.store.workspaces(room.id)).toEqual([])
    await k.stop()
  })

  it('leaves the worktree folders, and their branches, when the box is not ticked', async () => {
    const { k, room, done, busy, branch } = await setup()
    await k.removeRoom(room.id, false)
    expect(existsSync(done.path)).toBe(true)
    expect(existsSync(busy.path)).toBe(true)
    expect(await branch(done.branch)).toContain(done.branch)
    expect(k.store.room(room.id)).toBeUndefined()
    await k.stop()
  })

  it('keeps the room and names the workspace when one fails to archive', async () => {
    const { k, room, repo, done } = await setup()
    // The worktree is already gone from git, so archiving it fails.
    await run('git', ['-C', repo, 'worktree', 'remove', '--force', done.path])
    await expect(k.removeRoom(room.id, true)).rejects.toThrow(`Could not archive a workspace, so ${room.name} stays. ${done.name}:`)
    expect(k.store.room(room.id)).toBeDefined()
    await k.stop()
  })
})
