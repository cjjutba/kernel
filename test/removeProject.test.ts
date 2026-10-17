import { describe, expect, it, onTestFinished } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, freePort } from './helpers'
import { bus } from '../src/main/bus'
import { run } from '../src/main/services/exec'
import { Kernel } from '../src/main/kernel'

// KERNEL-75: removing a project archives its workspaces for real (ConfirmRemoveProject.png), then forgets the project.

const CHRISTIAN = '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.'

async function setup(files: Record<string, string> = {}) {
  const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/christian.md': CHRISTIAN, ...files })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', deleteBranchOnArchive: true } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  const project = await k.addProject(repo)
  const done = await k.createWorkspace(project.id, { prompt: 'Go', agentId: 'christian', title: 'Nothing unpushed' })
  const busy = await k.createWorkspace(project.id, { prompt: 'Go', agentId: 'christian', title: 'Unpushed work' })
  await writeFile(join(busy.path, 'work.ts'), 'work\n')
  await run('git', ['-C', busy.path, 'add', '-A'])
  await run('git', ['-C', busy.path, 'commit', '-q', '-m', 'only here'])
  const branch = async (name: string) => (await run('git', ['-C', repo, 'branch', '--list', name])).trim()
  return { k, project, repo, done, busy, branch }
}

describe('removing a project', () => {
  it('archives each workspace, deletes the worktrees when asked, keeps branches with unpushed commits, and forgets the project', async () => {
    const { k, project, done, busy, branch } = await setup()
    await k.removeProject(project.id, true)
    expect(existsSync(done.path)).toBe(false)
    expect(existsSync(busy.path)).toBe(false)
    // "Delete branch on archive" is on: the empty branch goes, the one with unpushed work stays.
    expect(await branch(done.branch)).toBe('')
    expect(await branch(busy.branch)).toContain(busy.branch)
    expect(k.store.project(project.id)).toBeUndefined()
    expect(k.store.workspaces(project.id)).toEqual([])
    await k.stop()
  })

  it('leaves the worktree folders, and their branches, when the box is not ticked', async () => {
    const { k, project, done, busy, branch } = await setup()
    await k.removeProject(project.id, false)
    expect(existsSync(done.path)).toBe(true)
    expect(existsSync(busy.path)).toBe(true)
    expect(await branch(done.branch)).toContain(done.branch)
    expect(k.store.project(project.id)).toBeUndefined()
    await k.stop()
  })

  it('keeps the project and names the workspace when one fails to archive', async () => {
    const { k, project, done } = await setup()
    const sync = k.prs.syncBranch.bind(k.prs)
    k.prs.syncBranch = async (id) => { if (id === done.id) throw new Error('git is locked'); return sync(id) }
    await expect(k.removeProject(project.id, true)).rejects.toThrow(`Could not archive a workspace, so ${project.name} stays. ${done.name}: git is locked`)
    expect(k.store.project(project.id)).toBeDefined()
    await k.stop()
  })

  it("removes the project and leaves a folder that isn't a worktree alone, with a warning (KERNEL-702)", async () => {
    const { k, project, repo, done } = await setup()
    // The worktree is gone from git, but a folder is back at its path. It may hold the user's files, so it stays (D-105).
    await run('git', ['-C', repo, 'worktree', 'remove', '--force', done.path])
    await mkdir(done.path)
    await writeFile(join(done.path, 'mine.txt'), 'mine\n')
    const notes: string[] = []
    const on = (e: { kind: string; workspaceId?: string; warn?: boolean; text: string }) => { if (e.kind === 'note' && e.warn && e.workspaceId === done.id) notes.push(e.text) }
    bus.on('activity', on)
    onTestFinished(() => { bus.off('activity', on) })
    await k.removeProject(project.id, true)
    expect(notes).toEqual(["couldn't finish cleaning up after archiving"])
    expect(existsSync(join(done.path, 'mine.txt'))).toBe(true)
    expect(k.store.project(project.id)).toBeUndefined()
    await k.stop()
  })

  it('waits for every cleanup, one from an earlier archive included, before it forgets the project (KERNEL-702)', async () => {
    const log = join(await mkdtemp(join(tmpdir(), 'kernel-log-')), 'archived.txt')
    const { k, project, done, busy } = await setup({ '.kernel/settings.toml': `[scripts]\narchive = "sleep 0.3; echo $KERNEL_WORKSPACE_NAME >> ${log}"\n` })
    await k.archiveWorkspace(done.id)
    // The archive returned while its script still runs.
    expect(existsSync(done.path)).toBe(true)
    await k.removeProject(project.id, true)
    expect((await readFile(log, 'utf8')).trim().split('\n').sort()).toEqual([busy.name, done.name].sort())
    expect(existsSync(done.path)).toBe(false)
    expect(existsSync(busy.path)).toBe(false)
    expect(k.store.project(project.id)).toBeUndefined()
    await k.stop()
  })
})
