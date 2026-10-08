import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrInfo, PrState } from '@shared/types'
import { tempRepo } from './helpers'
import { run } from '../src/main/services/exec'
import { unpushedCommits } from '../src/main/services/archive'
import { Kernel } from '../src/main/kernel'

// KERNEL-70: workspace saves re-read the store, and archive never deletes a branch it couldn't count.

const KAI = '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
const prInfo = (state: PrState): PrInfo => ({ workspaceId: '', number: 7, url: 'https://github.com/x/y/pull/7', title: 'Invoice table', state, baseRef: 'main', checks: [], comments: [], conflicts: [] })

async function setup(o: { files?: Record<string, string>; settings?: object } = {}) {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/kai.md': KAI, ...o.files })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...o.settings }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  // GitHub answers at once, or waits until the test lets it go, the way gh does when it is slow.
  const gh = { pr: null as PrInfo | null, slow: false, release: () => {}, mergeRelease: () => {} }
  const wait = (set: (r: () => void) => void) => new Promise<void>((r) => set(r))
  k.github = {
    info: async (_cwd, _ref, workspaceId) => {
      if (gh.slow) await wait((r) => { gh.release = r })
      return gh.pr ? { ...gh.pr, workspaceId } : null
    },
    merge: async () => { await wait((r) => { gh.mergeRelease = r }); if (gh.pr) gh.pr = { ...gh.pr, state: 'merged' } },
    ready: async () => undefined,
    reopen: async () => undefined
  }
  const room = await k.addRoom(repo)
  return { k, room, gh }
}

const tick = () => new Promise((r) => setTimeout(r, 20))
const branches = async (repo: string, name: string) => (await run('git', ['-C', repo, 'branch', '--list', name])).trim()

describe('workspace saves read the store, not a stale copy', () => {
  it('leaves a workspace archived when a PR refresh was waiting on GitHub', async () => {
    const { k, room, gh } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    gh.pr = prInfo('ready'); gh.slow = true
    const refresh = k.refreshPr(ws.id)
    await tick()
    await k.archiveWorkspace(ws.id)
    gh.release()
    await refresh
    expect(k.store.workspace(ws.id)).toMatchObject({ status: 'archived', prState: 'none' })
    expect(k.store.workspace(ws.id)?.archivedAt).toBeTypeOf('number')
    await k.stop()
  })

  it("doesn't undo a merge that started while a refresh was waiting", async () => {
    const { k, room, gh } = await setup({ settings: { pr: { requireGreen: false } } })
    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    gh.pr = prInfo('ready')
    await k.refreshPr(ws.id)
    gh.slow = true
    const refresh = k.refreshPr(ws.id)
    await tick()
    const merge = k.mergePr(ws.id)
    await tick()
    expect(k.store.workspace(ws.id)?.prState).toBe('merging')
    gh.release()
    await refresh
    expect(k.store.workspace(ws.id)?.prState).toBe('merging')
    gh.slow = false
    gh.mergeRelease()
    expect((await merge).prState).toBe('merged')
    await k.stop()
  })

  it('stays archived when setup finishes after the archive', async () => {
    const { k, room } = await setup({ files: { '.kernel/settings.toml': '[scripts]\nsetup = "sleep 5"\n' } })
    const creating = k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Slow setup' })
    let id: string | undefined
    for (let i = 0; i < 100 && !id; i++) { await tick(); id = k.store.workspaces(room.id).find((w) => w.status === 'setup')?.id }
    expect(id).toBeDefined()
    await k.archiveWorkspace(id!)
    await creating
    expect(k.store.workspace(id!)?.status).toBe('archived')
    await k.stop()
  })

  it('restores an archived workspace and clears archivedAt', async () => {
    const { k, room } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Come back' })
    await k.archiveWorkspace(ws.id)
    const back = await k.restoreWorkspace(ws.id)
    expect(back.status).toBe('ready')
    expect(back.archivedAt).toBeUndefined()
    expect(k.store.workspace(ws.id)?.archivedAt).toBeUndefined()
    await k.stop()
  })
})

describe('the archive branch guard', () => {
  it('counts commits on the branch it deletes, not on the worktree HEAD', async () => {
    const { k, room } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Keep me' })
    await writeFile(join(ws.path, 'c.ts'), 'c\n')
    await run('git', ['-C', ws.path, 'add', '-A'])
    await run('git', ['-C', ws.path, 'commit', '-q', '-m', 'only here'])
    // The agent moved HEAD off the branch: HEAD has nothing unpushed, the branch has one commit.
    await run('git', ['-C', ws.path, 'checkout', '-q', '--detach', 'main'])
    expect(await unpushedCommits(room.path, ws.branch, ws.baseRef)).toBe(1)
    await k.archiveWorkspace(ws.id, true)
    expect(await branches(room.path, ws.branch)).toContain(ws.branch)
    await k.stop()
  })

  it("keeps the branch when its commits can't be counted, and says so", async () => {
    const { k, room } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Unknown' })
    // Nothing to compare the branch against: no upstream, no origin, and a base that doesn't exist.
    k.store.saveWorkspace({ ...ws, baseRef: 'origin/nowhere' })
    expect(await unpushedCommits(room.path, ws.branch, 'origin/nowhere')).toBeNull()
    await k.archiveWorkspace(ws.id, true)
    expect(await branches(room.path, ws.branch)).toContain(ws.branch)
    expect(k.store.activity(room.id).some((a) => a.kind === 'note' && a.object === ws.branch && a.text.includes('could not be counted'))).toBe(true)
    await k.stop()
  })

  it('still deletes a branch with nothing unpushed when asked', async () => {
    const { k, room } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Drop me' })
    expect(await unpushedCommits(room.path, ws.branch, ws.baseRef)).toBe(0)
    await k.archiveWorkspace(ws.id, true)
    expect(await branches(room.path, ws.branch)).toBe('')
    await k.stop()
  })
})
