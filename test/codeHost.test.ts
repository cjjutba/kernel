import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrInfo, Room } from '@shared/types'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { exec } from '../src/main/services/exec'
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

/** A room with one workspace whose PR #42 reads ready, on the host given. A local one has no number. */
async function roomWithPr(k: Kernel, host?: Room['host']) {
  const room = await k.addRoom(await tempRepo({ 'README.md': '# client\n', '.claude/agents/kai.md': KAI }))
  if (host) k.store.saveRoom({ ...room, host })
  const ws = await k.workspaces.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
  k.store.saveWorkspace({ ...ws, prState: 'ready', ...(host === 'local' ? {} : { prNumber: 42 }) })
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
    expect(k.codeHost.hostFor({ path: '/repo' })).toBe(gh)
    expect(k.codeHost.hostFor({ host: 'github', path: '/repo' })).toBe(gh)
    const { host } = stub(k)
    expect(k.codeHost.hostFor({ path: '/repo' })).toBe(host)
    expect(k.codeHost.hostFor({ host: 'github', path: '/repo' })).toBe(host)
  })

  it('gives a room that merges locally its own host, never GitHub (KERNEL-467)', async () => {
    const k = await kernel()
    const { host } = stub(k)
    const local = k.codeHost.hostFor({ host: 'local', path: '/repo' })
    expect(local).not.toBe(host)
    expect(local).not.toBe(gh)
    await expect(local.ready('/repo', 'feat/x')).rejects.toThrow('This room merges on this Mac, so it has no pull request.')
  })
})

describe('the host a room gets at setup (KERNEL-477)', () => {
  /** A real checkout with origin at `url`, or no remote. */
  const checkout = async (url?: string) => {
    const repo = await tempRepo()
    if (url) await exec('git', ['-C', repo, 'remote', 'add', 'origin', url])
    return repo
  }

  it('is GitHub for a github.com remote over HTTPS or SSH, and local for a remote elsewhere or none', async () => {
    const k = await kernel()
    const github = { host: 'github', repo: 'samrivera/client-c' }
    expect(await k.codeHost.detect(await checkout('https://github.com/samrivera/client-c.git'))).toEqual(github)
    expect(await k.codeHost.detect(await checkout('git@github.com:samrivera/client-c.git'))).toEqual(github)
    expect(await k.codeHost.detect(await checkout('ssh://git@github.com/samrivera/client-c'))).toEqual(github)
    expect(await k.codeHost.detect(await checkout('https://gitlab.com/samrivera/client-c.git'))).toEqual({ host: 'local' })
    expect(await k.codeHost.detect(await checkout(await mkdtemp(join(tmpdir(), 'kernel-remote-'))))).toEqual({ host: 'local' })
    expect(await k.codeHost.detect(await checkout())).toEqual({ host: 'local' })
  })

  it("reads the remote the room's settings name, not origin", async () => {
    const k = await kernel()
    const repo = await checkout('https://gitlab.com/samrivera/client-c.git')
    await exec('git', ['-C', repo, 'remote', 'add', 'upstream', 'git@github.com:samrivera/client-c.git'])
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[workspace]\nremote = "upstream"\n')
    expect(await k.codeHost.detect(repo)).toEqual({ host: 'github', repo: 'samrivera/client-c' })
  })

  it('says which in the Code host row', async () => {
    const k = await kernel()
    expect(k.codeHost.line({ host: 'github', repo: 'samrivera/client-c' })).toBe('GitHub, samrivera/client-c')
    expect(k.codeHost.line({ host: 'local' })).toBe('Local, no GitHub remote. Kernel merges branches on this Mac.')
  })
})

describe('gh in preflight (KERNEL-477)', () => {
  it('is checked with no room yet, or while an open room is on GitHub or older than hosts, and not when every open room merges locally', async () => {
    const k = await kernel()
    expect(k.codeHost.usesGitHub()).toBe(true)
    // A room from before KERNEL-477 has no host, keeps none, and stays a GitHub room.
    const old = await k.addRoom(await tempRepo())
    expect(k.store.room(old.id)?.host).toBeUndefined()
    expect(k.codeHost.usesGitHub()).toBe(true)
    k.store.saveRoom({ ...old, host: 'local' })
    expect(k.codeHost.usesGitHub()).toBe(false)
    const github = await k.addRoom(await tempRepo())
    k.store.saveRoom({ ...github, host: 'github' })
    expect(k.codeHost.usesGitHub()).toBe(true)
    k.store.saveRoom({ ...k.store.room(github.id)!, archived: true })
    expect(k.codeHost.usesGitHub()).toBe(false)
  })
})

describe('the PR feature through hostFor', () => {
  it('merges a GitHub room on GitHub, and never sends a local room to it', async () => {
    const k = await kernel()
    const { calls } = stub(k)
    const github = await roomWithPr(k)
    const local = await roomWithPr(k, 'local')

    // The local branch has no commits of its own, so git finds nothing to merge.
    await expect(k.prs.mergePr(local.id)).rejects.toThrow('so there is nothing to merge')
    expect(calls).toEqual([])

    await k.prs.mergePr(github.id)
    expect(calls.filter((c) => c.startsWith('merge'))).toEqual([`merge ${github.branch}`])
    expect(calls).not.toContain(`info ${local.id}`)
  })

  it('reads a local room with git and the GitHub room on GitHub in the same poll', async () => {
    const k = await kernel()
    const { calls } = stub(k)
    const local = await roomWithPr(k, 'local')
    const github = await roomWithPr(k)

    await k.prs.pollPrs({ chores: false })
    expect(calls).toEqual([`info ${github.id}`])
    // A branch with nothing its base lacks has no PR on the Mac.
    expect(k.store.workspace(local.id)?.prState).toBe('none')
  })
})
