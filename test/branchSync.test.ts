import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrInfo, PrState } from '@shared/types'
import { tempRepo } from './helpers'
import { run } from '../src/main/services/exec'
import { kernelTools, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { LEAD_RULE } from '../src/main/services/handoff'
import { Kernel } from '../src/main/kernel'

// KERNEL-68: the Lead can name a workspace's branch, and Kernel follows an agent that switches branches in its worktree.

const KAI = '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
const LINEAR = 'cjjutbaofficial/kernel-53-symlink-node_modules-into-new-worktrees'
const prInfo = (state: PrState, number = 54): PrInfo => ({ workspaceId: '', number, url: `https://github.com/x/y/pull/${number}`, title: 'Symlink node_modules', state, baseRef: 'main', checks: [], comments: [], conflicts: [] })

async function setup() {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/kai.md': KAI })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { requireGreen: false } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  // GitHub knows PRs by branch, like `gh pr view <branch>`. Every call records the branch it was asked about.
  const gh = { prs: new Map<string, PrInfo>(), asked: [] as string[], merged: [] as string[] }
  k.github = {
    info: async (_cwd, ref, workspaceId) => { gh.asked.push(ref); const pr = gh.prs.get(ref); return pr ? { ...pr, workspaceId } : null },
    merge: async (_cwd, ref) => { gh.merged.push(ref); const pr = gh.prs.get(ref); if (pr) gh.prs.set(ref, { ...pr, state: 'merged' }) },
    ready: async (_cwd, ref) => { gh.asked.push(ref) },
    reopen: async (_cwd, ref) => { gh.asked.push(ref) }
  }
  const room = await k.addRoom(repo)
  return { k, room, gh }
}

const head = async (path: string) => (await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
const branchList = async (repo: string, name: string) => (await run('git', ['-C', repo, 'branch', '--list', name])).trim()
async function commit(path: string, file: string) {
  await writeFile(join(path, file), `${file}\n`)
  await run('git', ['-C', path, 'add', '-A'])
  await run('git', ['-C', path, 'commit', '-q', '-m', file])
}

describe('the Lead names the branch', () => {
  it('creates the workspace on the given branch, with a suffix when the name is taken', async () => {
    const { k, room } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Symlink node_modules', branch: LINEAR })
    expect(ws.branch).toBe(LINEAR)
    expect(await head(ws.path)).toBe(LINEAR)
    const again = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Again', branch: LINEAR })
    expect(again.branch).toBe(`${LINEAR}-2`)
    await expect(k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Bad', branch: 'bad..name' })).rejects.toThrow('not a valid branch name')
    await k.stop()
  })

  it('passes branch from create_workspace through to the workspace', async () => {
    const asked: Parameters<KernelToolDeps['createWorkspace']>[0][] = []
    const deps: KernelToolDeps = {
      roomId: 'room', lead: undefined, agents: async () => [], workspaces: () => [],
      createWorkspace: async (o) => { asked.push(o); return { id: 'ws-1', branch: o.branch ?? 'feat/x', agentId: o.agentId } as never },
      messageWorkspace: async () => {}, askUser: async () => null, hireAgent: async () => '',
      archiveWorkspace: async () => {}, isRunning: () => false
    }
    const tool = kernelTools(deps).find((t) => t.name === 'create_workspace')!
    const out = await tool.handler({ agent: 'noor', title: 'Symlink node_modules', brief: 'Goal', branch: LINEAR } as never, {})
    expect(asked[0]).toMatchObject({ agentId: 'noor', branch: LINEAR })
    expect((out.content[0] as { text: string }).text).toBe(`Created ws-1 on ${LINEAR} for noor.`)
    expect(LEAD_RULE).toContain('pass that name as branch')
  })
})

describe('an agent switches branches in its worktree', () => {
  it('finds the PR, merges and archives on the branch the work is on', async () => {
    const { k, room, gh } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Symlink node_modules' })
    // What Noor did on KERNEL-53: a new branch in the same worktree, a commit, and a PR from it.
    await run('git', ['-C', ws.path, 'checkout', '-q', '-b', LINEAR])
    await commit(ws.path, 'link.ts')
    gh.prs.set(LINEAR, prInfo('ready'))
    const seen = await k.refreshPr(ws.id)
    expect(seen).toMatchObject({ branch: LINEAR, prState: 'ready', prNumber: 54 })
    expect(gh.asked.at(-1)).toBe(LINEAR)
    expect(k.store.activity(room.id).some((a) => a.kind === 'note' && a.object === LINEAR)).toBe(true)
    expect((await k.mergePr(ws.id)).prState).toBe('merged')
    expect(gh.merged).toEqual([LINEAR])
    await k.stop()
  })

  it("archives the branch the workspace is on, and leaves the one it left", async () => {
    const { k, room } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Moved' })
    await run('git', ['-C', ws.path, 'checkout', '-q', '-b', 'moved-here'])
    await k.archiveWorkspace(ws.id, true)
    // Nothing unpushed on the new branch, so it goes as asked. The old one isn't the workspace's anymore.
    expect(await branchList(room.path, 'moved-here')).toBe('')
    expect(await branchList(room.path, ws.branch)).toContain(ws.branch)
    expect(k.store.workspace(ws.id)?.branch).toBe('moved-here')
    await k.stop()
  })

  it('restores on the branch the work was on', async () => {
    const { k, room } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Come back' })
    await run('git', ['-C', ws.path, 'checkout', '-q', '-b', 'kept-work'])
    await commit(ws.path, 'work.ts')
    await k.archiveWorkspace(ws.id, false)
    const back = await k.restoreWorkspace(ws.id)
    expect(back.branch).toBe('kept-work')
    expect(await head(back.path)).toBe('kept-work')
    await k.stop()
  })

  it("drops the old branch's PR, and ignores a detached HEAD", async () => {
    const { k, room, gh } = await setup()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Two branches' })
    gh.prs.set(ws.branch, prInfo('ready', 12))
    expect((await k.refreshPr(ws.id)).prNumber).toBe(12)
    await run('git', ['-C', ws.path, 'checkout', '-q', '--detach'])
    expect((await k.syncBranch(ws.id)).branch).toBe(ws.branch)
    await run('git', ['-C', ws.path, 'checkout', '-q', '-b', 'fresh'])
    const moved = await k.refreshPr(ws.id)
    expect(moved).toMatchObject({ branch: 'fresh', prState: 'none' })
    expect(moved.prNumber).toBeUndefined()
    await k.stop()
  })
})
