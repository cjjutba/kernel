import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrInfo, Room } from '@shared/types'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { gh, type CodeHost } from '../src/main/services/github'

// KERNEL-453: the PR feature asks each room's code host, and a room that merges locally never reaches GitHub.

const KAI = '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'

const kernels: Kernel[] = []
afterEach(async () => { for (const k of kernels.splice(0)) await k.stop() })

async function kernel() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { requireGreen: false } }))
  const k = new Kernel({ dataDir, home })
  kernels.push(k)
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  return k
}

/** A room with one workspace whose PR #42 reads ready, on the host given. */
async function roomWithPr(k: Kernel, host?: Room['host']) {
  const room = await k.addRoom(await tempRepo({ 'README.md': '# client\n', '.claude/agents/kai.md': KAI }))
  if (host) k.store.saveRoom({ ...room, host })
  const ws = await k.workspaces.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
  k.store.saveWorkspace({ ...ws, prState: 'ready', prNumber: 42 })
  return k.store.workspace(ws.id)!
}

/** A GitHub stub that records each call by workspace or branch. */
function stub(k: Kernel) {
  const calls: string[] = []
  const pr = (workspaceId: string): PrInfo => ({ workspaceId, number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state: 'ready', baseRef: 'main', checks: [], comments: [], conflicts: [] })
  const host: CodeHost = {
    info: async (_cwd, _ref, workspaceId) => { calls.push(`info ${workspaceId}`); return pr(workspaceId) },
    merge: async (_cwd, ref) => { calls.push(`merge ${ref}`) },
    ready: async (_cwd, ref) => { calls.push(`ready ${ref}`) },
    reopen: async (_cwd, ref) => { calls.push(`reopen ${ref}`) }
  }
  k.github = host
  return { host, calls }
}

describe('hostFor', () => {
  it('sends a room with no host, or GitHub, to k.github, read when asked so a swapped stub is the one used', async () => {
    const k = await kernel()
    expect(k.codeHost.hostFor({})).toBe(gh)
    expect(k.codeHost.hostFor({ host: 'github' })).toBe(gh)
    const { host } = stub(k)
    expect(k.codeHost.hostFor({})).toBe(host)
    expect(k.codeHost.hostFor({ host: 'github' })).toBe(host)
  })

  it('refuses a room that merges locally, which has no host yet', async () => {
    const k = await kernel()
    expect(() => k.codeHost.hostFor({ host: 'local' })).toThrow("This room merges locally, which Kernel can't do yet.")
  })
})

describe('the PR feature through hostFor', () => {
  it('merges a GitHub room on GitHub, and never sends a local room to it', async () => {
    const k = await kernel()
    const { calls } = stub(k)
    const github = await roomWithPr(k)
    const local = await roomWithPr(k, 'local')

    await expect(k.prs.mergePr(local.id)).rejects.toThrow("This room merges locally, which Kernel can't do yet.")
    expect(calls).toEqual([])

    await k.prs.mergePr(github.id)
    expect(calls.filter((c) => c.startsWith('merge'))).toEqual([`merge ${github.branch}`])
    expect(calls).not.toContain(`info ${local.id}`)
  })

  it("reads the other rooms' PRs when one room's host can't be reached", async () => {
    const k = await kernel()
    const { calls } = stub(k)
    const local = await roomWithPr(k, 'local')
    const github = await roomWithPr(k)

    await k.prs.pollPrs({ chores: false })
    expect(calls).toEqual([`info ${github.id}`])
    expect(k.store.workspace(local.id)?.prState).toBe('ready')
  })
})
