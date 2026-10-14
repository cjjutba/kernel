import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeGh, tempRepo } from './helpers'
import { exec, git } from '../src/main/services/exec'
import { defaultBranch, FETCH_REUSE_MS, fetchOrigin, listBranches, resolveBaseRef, taskBranch } from '../src/main/services/worktrees'
import { parseIssueList, parsePrList } from '../src/main/services/github'
import { NO_LINEAR_TOKEN, searchIssues } from '../src/main/services/trackers/linear'
import { Kernel } from '../src/main/kernel'
import { fetchedAt } from '../src/main/features/workspaces'
import { kernelTools, takenWarning } from '../src/main/services/kernelMcp'
import { issueTaken, keyInBranch, keyInText } from '../src/main/services/issueTaken'
import { briefParts, leadMessage, pickedLines } from '../src/renderer/src/screens/new-workspace/brief'
import type { AgentDef, ChatPart, IssueTaken } from '../src/shared/types'

// A chat with Kernel's held first message goes out through the real send once its setup passes (KERNEL-405).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

/** While `on`, every `git fetch` times out, the way exec reports it when its timer kills git (KERNEL-179). */
const fetchTimesOut = vi.hoisted(() => ({ on: false, fetches: 0, lsRemotes: 0 }))
vi.mock('../src/main/services/exec', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/services/exec')>()
  return {
    ...real,
    exec: (cmd: string, args: string[], opts?: Parameters<typeof real.exec>[2]) => {
      if (args.includes('fetch')) fetchTimesOut.fetches++
      if (args.includes('ls-remote')) fetchTimesOut.lsRemotes++
      return fetchTimesOut.on && args.includes('fetch') ? Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: true }) : real.exec(cmd, args, opts)
    }
  }
})

describe('branch naming', () => {
  it('uses feat/{task}-{slug} when a Linear issue is linked', () => {
    expect(taskBranch('feat/{slug}', 'Client portal login', 'KERNEL-16')).toBe('feat/kernel-16-client-portal-login')
    expect(taskBranch('feat/{task}-{slug}', 'Client portal login', 'T-16')).toBe('feat/t-16-client-portal-login')
    expect(taskBranch('{type}/{task}-{slug}', "A review can't start when the reviewed branch name is long", 'KERNEL-267', 'fix')).toBe('fix/kernel-267-review-cant-start-reviewed-branch')
    expect(taskBranch('{type}/{task}-{slug}', 'Create in the New chat modal puts the brief in an empty Lead', 'KERNEL-242')).toBe('feat/kernel-242-create-in-new-chat-modal-puts-brief')
    expect(taskBranch('{type}/{slug}', 'Sidebar rows', '#41')).toBe('feat/41-sidebar-rows')
  })
  it('uses the plain pattern without a task', () => {
    expect(taskBranch('feat/{slug}', 'Export invoices as PDF')).toBe('feat/export-invoices-as-pdf')
  })
})

describe('listBranches', () => {
  it('lists local and remote branches without origin/HEAD', async () => {
    const repo = await tempRepo()
    await git(repo, 'branch', 'feat/one')
    const remote = await tempRepo()
    await git(repo, 'remote', 'add', 'origin', remote)
    await git(repo, 'fetch', '-q', 'origin')
    await git(repo, 'remote', 'set-head', 'origin', 'main')
    const names = await listBranches(repo)
    expect(names).toEqual(expect.arrayContaining(['main', 'feat/one', 'origin/main']))
    expect(names.some((n) => n.endsWith('/HEAD') || n === 'origin')).toBe(false)
  })
})

describe('parseIssueList', () => {
  it('reads gh issue list output as GitHub issues', () => {
    expect(parseIssueList(JSON.stringify([{ number: 41, title: 'Export fails', url: 'https://github.com/a/b/issues/41' }])))
      .toEqual([{ id: '#41', title: 'Export fails', url: 'https://github.com/a/b/issues/41', source: 'github' }])
    expect(parseIssueList('not json')).toEqual([])
  })
})

describe('parsePrList', () => {
  it('maps gh pr list json', () => {
    const json = JSON.stringify([{ number: 44, title: 'feat(invoices): PDF renderer', headRefName: 'feat/pdf', author: { login: 'samrivera' } }, { number: 43, title: 'fix(auth)', headRefName: 'fix/auth' }])
    expect(parsePrList(json)).toEqual([
      { number: 44, title: 'feat(invoices): PDF renderer', branch: 'feat/pdf', author: 'samrivera' },
      { number: 43, title: 'fix(auth)', branch: 'fix/auth', author: undefined }
    ])
  })
  it('returns nothing for bad output', () => { expect(parsePrList('not json')).toEqual([]) })
})

describe('searchIssues', () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  it('asks for a token', async () => { await expect(searchIssues(undefined)).rejects.toThrow(NO_LINEAR_TOKEN) })
  it('maps issues and sends the token raw', async () => {
    let seen: { headers: Record<string, string>; body: string } | undefined
    const f = (async (_u: string, init: { headers: Record<string, string>; body: string }) => { seen = init; return new Response(JSON.stringify({ data: { issues: { nodes: [{ identifier: 'KERNEL-16', title: 'New workspace modal', url: 'https://linear.app/x' }] } } })) }) as unknown as typeof fetch
    expect(await searchIssues('lin_key', 'kernel-16', f)).toEqual([{ id: 'KERNEL-16', title: 'New workspace modal', url: 'https://linear.app/x', source: 'linear' }])
    expect(seen?.headers.authorization).toBe('lin_key')
    expect(JSON.parse(seen!.body).variables.filter.and[1].or).toContainEqual({ number: { eq: 16 } })
  })
  it('explains a rejected token', async () => { await expect(searchIssues('bad', '', reply(401, {}))).rejects.toThrow(/rejected the token/) })
  it('surfaces GraphQL errors', async () => { await expect(searchIssues('k', '', reply(200, { errors: [{ message: 'Bad filter' }] }))).rejects.toThrow('Bad filter') })
})

describe('createWorkspace from a source', () => {
  it('names the branch from the Linear id, stores the source and sends attachments', async () => {
    const repo = await tempRepo({ '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    // An issue source moves the issue in Linear (D-140). The stub keeps a LINEAR_API_KEY in the environment from touching a real one.
    const k = new Kernel({ dataDir, home, fetch: async () => { throw new Error('offline') } })
    await k.start()
    const sent: string[][] = []
    k.sessions.send = async (_c, parts) => { sent.push(parts.map((p) => p.type)); return { queued: false } }
    const room = await k.addRoom(repo)
    const source = { kind: 'issue', id: 'KERNEL-16', title: 'New workspace modal' } as const
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it', source, parts: [{ type: 'file', name: 'spec.md', text: 'x' }] })
    expect(ws.branch).toBe('feat/kernel-16-new-workspace-modal')
    expect(ws.source).toEqual(source)
    expect(sent).toEqual([['text', 'file']])
    await k.stop()
  })
})

describe('a workspace from a GitHub issue (KERNEL-462)', () => {
  afterEach(() => { vi.unstubAllEnvs() })
  const team = {
    '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
    '.claude/agents/noor.md': '---\nname: noor\ndescription: Engine.\n---\nYou are Noor. Open a PR for each task.'
  }
  const crash = { number: 41, title: 'Crash on save', url: 'https://github.com/acme/app/issues/41', body: 'Steps', labels: [{ name: 'bug' }], comments: [] }

  /** A kernel with one room, on GitHub when `repo` is set. Linear is offline and LINEAR_API_KEY is empty. */
  async function kernel(repo?: string) {
    vi.stubEnv('LINEAR_API_KEY', '')
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home, fetch: async () => { throw new Error('offline') } })
    await k.start()
    onTestFinished(() => k.stop())
    k.sessions.send = async () => ({ queued: false })
    const added = await k.rooms.addRoom(await tempRepo(team))
    return { k, room: repo ? k.store.saveRoom({ ...added, repo }) : added }
  }

  it("names the branch from the issue's number and labels when Kernel hands it off, and records GitHub as its tracker", async () => {
    const gh = await fakeGh({ view: crash })
    const { k, room } = await kernel('acme/app')
    const lead = (await k.team.agents(room.id)).find((a) => a.lead) as AgentDef
    const deps = k.lead.leadToolDeps(room.id, lead, await k.lead.leadChat(room.id))
    await kernelTools(deps).find((t) => t.name === 'create_workspace')!.handler({ agent: 'noor', title: 'Fix saving', brief: 'Go', issue: '41' } as never, {})
    const ws = k.store.workspaces(room.id).find((w) => w.agentId === 'noor')!
    expect(ws.source).toEqual({ kind: 'issue', id: '#41', title: 'Crash on save', url: crash.url, tracker: 'github' })
    expect(ws.branch).toBe('fix/41-crash-on-save')
    // Once to see whether someone else is on it, once to link it (KERNEL-479).
    expect(await gh.calls()).toEqual(['issue view 41 --json number,title,url,body,labels,comments,assignees', 'issue view 41 --json number,title,url,body,labels,comments,assignees'])
  })

  it('names the branch from the labels of a GitHub issue picked in New workspace (KERNEL-470)', async () => {
    const gh = await fakeGh({ view: crash })
    const { k, room } = await kernel('acme/app')
    const ws = await k.workspaces.createWorkspace(room.id, { prompt: 'Fix it', source: { kind: 'issue', id: '#41', title: 'Crash on save' } })
    expect(ws.branch).toBe('fix/41-crash-on-save')
    expect(await gh.calls()).toEqual(['issue view 41 --json number,title,url,body,labels,comments,assignees'])
  })

  it('records the tracker of an issue picked in New workspace, and none in a room without one', async () => {
    await fakeGh({})
    const github = await kernel('acme/app')
    const picked = await github.k.workspaces.createWorkspace(github.room.id, { prompt: 'Fix it', source: { kind: 'issue', id: '#41', title: 'Crash on save' } })
    expect(picked.source).toEqual({ kind: 'issue', id: '#41', title: 'Crash on save', tracker: 'github' })
    const none = await kernel()
    const own = await none.k.workspaces.createWorkspace(none.room.id, { prompt: 'Build it', source: { kind: 'issue', id: 'APP-7', title: 'Settings page' } })
    expect(own.source).toEqual({ kind: 'issue', id: 'APP-7', title: 'Settings page' })
    expect(own.branch).toBe('feat/app-7-settings-page')
  })

  describe('someone else on the issue (KERNEL-479)', () => {
    const assigned = { ...crash, assignees: [{ login: 'mchen' }] }
    const prs = [
      { number: 52, title: 'Fix saving on slow disks', url: 'https://github.com/acme/app/pull/52', headRefName: 'mchen/save', body: 'Fixes #41' },
      { number: 53, title: 'Export rework', url: 'https://github.com/acme/app/pull/53', headRefName: 'feat/410-export', body: 'See #410' }
    ]
    /** A GitHub room whose origin is `remote`, fetched, and Kernel's create_workspace in it. */
    async function room(remote: string) {
      const { k, room } = await kernel('acme/app')
      await git(room.path, 'remote', 'add', 'origin', remote)
      await exec('git', ['-C', room.path, 'fetch', '-q', 'origin'])
      const lead = (await k.team.agents(room.id)).find((a) => a.lead) as AgentDef
      const tool = kernelTools(k.lead.leadToolDeps(room.id, lead, await k.lead.leadChat(room.id))).find((t) => t.name === 'create_workspace')!
      const create = async (args: object) => {
        const r = await tool.handler({ agent: 'noor', title: 'Fix saving', brief: 'Go', issue: '41', ...args } as never, {})
        return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
      }
      return { k, room, create }
    }

    it('finds a pushed branch, an open PR and another assignee, and create_workspace starts only once the user confirms', async () => {
      await fakeGh({ view: assigned, prs, login: 'cjjutba' })
      // Someone else pushed the branch Kernel would pick, and an unrelated one for #410.
      const remote = await tempRepo()
      await git(remote, 'branch', 'fix/41-crash-on-save')
      await git(remote, 'branch', 'feat/410-export')
      const { k, room: r, create } = await room(remote)
      const taken = { findings: [{ kind: 'branch', ref: 'origin/fix/41-crash-on-save' }, { kind: 'pr', number: 52, title: 'Fix saving on slow disks', url: prs[0].url }, { kind: 'assignee', name: 'mchen' }], notes: [] }
      // New workspace reads the same, for ConfirmIssueTaken.png.
      expect(await k.handlers()['issues.taken']({ roomId: r.id, issue: '41' })).toEqual(taken)
      // Named as Kernel passed it, as the refusal for a task already handed off does.
      expect(await create({})).toEqual({ isError: true, text: takenWarning('41', taken as IssueTaken) })
      expect(takenWarning('41', taken as IssueTaken)).toContain('Kernel found the branch origin/fix/41-crash-on-save, the open PR #52 (Fix saving on slow disks) and mchen assigned to it.')
      expect(k.store.workspaces(r.id).filter((w) => w.agentId === 'noor')).toEqual([])
      const started = await create({ confirm: true })
      expect(started.isError).toBe(false)
      // The name origin has is taken, so Kernel never pushes over someone else's branch.
      expect(k.store.workspaces(r.id).find((w) => w.agentId === 'noor')?.branch).toBe('fix/41-crash-on-save-2')
    })

    it("leaves out the user's own assignment and the room's own workspaces", async () => {
      await fakeGh({ view: { ...crash, assignees: [{ login: 'CJJutba' }] }, prs, login: 'cjjutba' })
      const remote = await tempRepo()
      const { k, room: r } = await room(remote)
      const ws = await k.workspaces.createWorkspace(r.id, { prompt: 'Fix it', source: { kind: 'issue', id: '#41', title: 'Crash on save' } })
      await git(remote, 'branch', ws.branch)
      k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prNumber: 52 })
      expect(await k.integrations.issueTaken(r.id, '41')).toEqual({ findings: [], notes: [] })
    })

    it("asks GitHub only about its own issues, so a Linear key adds no failed assignee check (KERNEL-504)", async () => {
      const gh = await fakeGh({ view: assigned, prs, login: 'cjjutba' })
      const { k, room: r } = await room(await tempRepo())
      expect(await k.integrations.issueTaken(r.id, 'KERNEL-31')).toEqual({ findings: [], notes: [] })
      expect((await gh.calls()).filter((c) => c.startsWith('issue view'))).toEqual([])
      expect((await k.integrations.issueTaken(r.id, '#41')).findings).toContainEqual({ kind: 'assignee', name: 'mchen' })
    })

    it('starts anyway when no check can answer, and says which ones it skipped', async () => {
      // gh can't list PRs and isn't signed in, and origin is gone.
      await fakeGh({ view: assigned })
      const { k, room: r, create } = await room(join(tmpdir(), 'kernel-no-such-remote'))
      const started = await create({})
      expect(started.isError).toBe(false)
      expect(started.text).toMatch(/^Created \S+ on fix\/41-crash-on-save for noor\./)
      expect(started.text).toContain("Couldn't check origin for a branch named after #41: fatal:")
      expect(started.text).toContain("Couldn't check for an open pull request that names #41: not stubbed.")
      expect(started.text).toContain("Couldn't tell whether mchen, assigned to #41, is you.")
      expect(k.store.workspaces(r.id).some((w) => w.agentId === 'noor')).toBe(true)
    })
  })
})

describe('what says someone else is on an issue (KERNEL-479)', () => {
  it('finds the key in branch names the way Kernel and the trackers name them', () => {
    expect(keyInBranch('KERNEL-31', 'feat/kernel-31-export-pdf')).toBe(true)
    expect(keyInBranch('KERNEL-31', 'mchen/KERNEL-31')).toBe(true)
    expect(keyInBranch('KERNEL-31', 'feat/kernel-310-export')).toBe(false)
    expect(keyInBranch('KERNEL-31', 'feat/xkernel-31')).toBe(false)
    expect(keyInBranch('#41', 'feat/41-crash-on-save')).toBe(true)
    expect(keyInBranch('#41', '41-crash-on-save')).toBe(true)
    expect(keyInBranch('#41', 'feat/v2-41-crash')).toBe(false)
    expect(keyInBranch('#41', 'feat/410-export')).toBe(false)
  })

  it('finds the key in a PR title or description', () => {
    expect(keyInText('KERNEL-31', 'feat(pdf): export invoices (kernel-31)')).toBe(true)
    expect(keyInText('KERNEL-31', 'Linear: KERNEL-310')).toBe(false)
    expect(keyInText('#41', 'Fixes #41')).toBe(true)
    expect(keyInText('41', 'Fixes #41.')).toBe(true)
    expect(keyInText('#41', 'Fixes #410, bumps to v41')).toBe(false)
  })

  it('notes a check that runs out of time and keeps what the others found', async () => {
    const own = { branches: new Set<string>(), prs: new Set<number>() }
    const taken = await issueTaken('KERNEL-31', {
      remote: 'origin', own, timeoutMs: 50,
      branches: () => new Promise(() => {}),
      prs: async () => [{ number: 7, title: 'Export PDF', branch: 'feat/kernel-31-export-pdf' }],
      assignees: async () => { throw new Error("Linear rejected the token. Reconnect it in Settings > Integrations.") },
      tracker: 'Linear'
    })
    expect(taken).toEqual({
      findings: [{ kind: 'pr', number: 7, title: 'Export PDF' }],
      notes: [
        "Couldn't check origin for a branch named after KERNEL-31: no answer in 1 second.",
        "Couldn't check who KERNEL-31 is assigned to in Linear: Linear rejected the token. Reconnect it in Settings > Integrations."
      ]
    })
  })

  it('reads no branches from a room without the remote, and says nothing about it', async () => {
    const taken = await issueTaken('KERNEL-31', { remote: 'origin', own: { branches: new Set(), prs: new Set() }, branches: async () => undefined })
    expect(taken).toEqual({ findings: [], notes: [] })
  })
})

describe('the base a workspace starts from', () => {
  const lead = { '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.' }
  const masterRepo = async () => { const repo = await tempRepo(lead); await git(repo, 'branch', '-m', 'main', 'master'); return repo }
  const cloneOf = async (remote: string) => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kernel-clone-')), 'repo')
    await git(remote, 'clone', '-q', remote, dir)
    return dir
  }
  /** A kernel on the settings default base (`origin/main`). */
  const kernel = async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt') }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    return k
  }

  it('finds the default branch without a remote: main, then master, then the current branch', async () => {
    expect(await defaultBranch(await tempRepo())).toBe('main')
    expect(await defaultBranch(await masterRepo())).toBe('master')
    const trunk = await tempRepo()
    await git(trunk, 'branch', '-m', 'main', 'trunk')
    expect(await defaultBranch(trunk)).toBe('trunk')
    expect(await defaultBranch(await cloneOf(await masterRepo()))).toBe('master')
  })

  it('keeps an origin ref the remote has, and falls back to the local branch or the default', async () => {
    const remote = await tempRepo()
    expect(await resolveBaseRef(await cloneOf(remote), 'origin/main', { fetch: true })).toBe('origin/main')
    const local = await masterRepo()
    expect(await resolveBaseRef(local, 'origin/master', { fetch: true })).toBe('master')
    expect(await resolveBaseRef(local, 'origin/nope', { fetch: true })).toBe('master')
    expect(await resolveBaseRef(await cloneOf(local), 'origin/main', { fetch: true })).toBe('origin/master')
  })

  it('refuses a picked PR or branch that does not exist instead of starting from the default', async () => {
    const repo = await masterRepo()
    await expect(resolveBaseRef(repo, 'origin/fork-branch', { fetch: true, strict: true })).rejects.toThrow('fork-branch is not on origin or in this repo')
    const k = await kernel()
    const room = await k.addRoom(repo)
    await expect(k.createWorkspace(room.id, { prompt: 'Continue', baseRef: 'origin/gone', source: { kind: 'pr', number: 7, title: 'Gone' } })).rejects.toThrow('gone is not on origin')
    expect(k.store.workspaces(room.id)).toEqual([])
    await k.stop()
  })

  it('starts a workspace from master in a master-only folder with no remote', async () => {
    const repo = await masterRepo()
    const k = await kernel()
    const room = await k.addRoom(repo)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it' })
    expect(ws.baseRef).toBe('master')
    expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'master'))
    await k.stop()
  })

  describe('when fetching origin fails (KERNEL-179)', () => {
    const team = { ...lead, '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' }
    const warnings = (k: Kernel, roomId: string) => k.store.activity(roomId).filter((a) => a.warn)
    const notes = (k: Kernel, wsId: string) => k.store.items(k.store.chats(wsId)[0].id).flatMap((i) => i.kind === 'note' ? [i.text] : [])

    it('says how a command that ran out of time ended', async () => {
      expect(await exec('sleep', ['5'], { timeoutMs: 50 })).toMatchObject({ timedOut: true })
      expect((await exec('true', [], { timeoutMs: 5000 })).timedOut).toBeUndefined()
    })

    it('reads the time origin was last fetched as a date and an age', () => {
      const now = new Date(2026, 9, 10, 17, 5).getTime()
      expect(fetchedAt(now - 3 * 3600000, now)).toBe('Oct 10, 2:05 PM (3 hours ago)')
      expect(fetchedAt(now - 60000, now)).toMatch(/\(1 minute ago\)$/)
      expect(fetchedAt(now - 3 * 86400000, now)).toMatch(/^Oct 7, .*\(3 days ago\)$/)
    })

    it('starts from origin as last fetched when origin is unreachable, and says so once in the log and in the chat', async () => {
      const repo = await cloneOf(await tempRepo(team))
      await git(repo, 'fetch', '-q', 'origin')
      const hoursAgo = new Date(Date.now() - 3 * 3600000)
      await utimes(join(repo, '.git', 'FETCH_HEAD'), hoursAgo, hoursAgo)
      await git(repo, 'remote', 'set-url', 'origin', join(tmpdir(), 'kernel-no-such-remote'))
      const k = await kernel()
      const room = await k.addRoom(repo)
      const ws = await k.createWorkspace(room.id, { prompt: 'Build it' })
      expect(ws.status).toBe('ready')
      expect(ws.baseRef).toBe('origin/main')
      expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'origin/main'))
      expect(ws.fetchFailed).toMatch(/^Fetching origin failed \(fatal: .*does not appear to be a git repository\), so it started from origin\/main as of .+ \(3 hours ago\)\.$/)
      const warned = warnings(k, room.id)
      expect(warned).toHaveLength(1)
      expect(warned[0]).toMatchObject({ kind: 'note', workspaceId: ws.id, object: expect.stringContaining('does not appear to be a git repository') })
      expect(warned[0].text).toMatch(new RegExp(`^started ${ws.name} from origin/main as last fetched .+ \\(3 hours ago\\), because fetching origin failed:$`))
      expect(notes(k, ws.id)).toEqual([expect.stringMatching(/^Couldn't fetch origin \(fatal: .*\), so this workspace started from origin\/main as of .+ \(3 hours ago\)\. It may be missing recent merges\.$/)])
      await k.stop()
      // The failed fetch emptied FETCH_HEAD, so the next failure can't say when origin was last fetched.
      expect(await fetchOrigin(repo)).toEqual({ ok: false, error: expect.stringContaining('does not appear to be a git repository') })
    })

    it('adds nothing to the log or the chat when the fetch succeeds', async () => {
      const remote = await tempRepo(team)
      const repo = await cloneOf(remote)
      await writeFile(join(remote, 'NEW.md'), 'merged\n')
      await git(remote, 'add', '-A')
      await git(remote, 'commit', '-q', '-m', 'merged')
      expect(await fetchOrigin(await cloneOf(remote))).toEqual({ ok: true })
      const k = await kernel()
      const room = await k.addRoom(repo)
      const ws = await k.createWorkspace(room.id, { prompt: 'Build it' })
      expect(ws.fetchFailed).toBeUndefined()
      // Create fetched: the commit merged after the clone is in the workspace.
      expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(await git(remote, 'rev-parse', 'main'))
      expect(warnings(k, room.id)).toEqual([])
      expect(notes(k, ws.id)).toEqual([])
      await k.stop()
    })

    it('shares one fetch between workspaces started together', async () => {
      const repo = await cloneOf(await tempRepo(team))
      const before = fetchTimesOut.fetches
      expect(await Promise.all([fetchOrigin(repo), fetchOrigin(repo)])).toEqual([{ ok: true }, { ok: true }])
      expect(fetchTimesOut.fetches - before).toBe(1)
      await fetchOrigin(repo, 'origin', { fresh: true })
      expect(fetchTimesOut.fetches - before).toBe(2)
    })

    // KERNEL-542: New chat fetches when it opens, and Create reuses that fetch.
    it('reuses a fetch that passed in the last minute, and a fresh one always fetches', async () => {
      const repo = await cloneOf(await tempRepo(team))
      const before = fetchTimesOut.fetches
      expect(await fetchOrigin(repo)).toEqual({ ok: true })
      expect(await fetchOrigin(repo)).toEqual({ ok: true })
      expect(fetchTimesOut.fetches - before).toBe(1)
      // After a merge, `syncLead` needs what merged a moment ago.
      await fetchOrigin(repo, 'origin', { fresh: true })
      expect(fetchTimesOut.fetches - before).toBe(2)
      vi.useFakeTimers({ toFake: ['Date'] })
      onTestFinished(() => { vi.useRealTimers() })
      vi.setSystemTime(Date.now() + FETCH_REUSE_MS + 1)
      await fetchOrigin(repo)
      expect(fetchTimesOut.fetches - before).toBe(3)
      // A failed fetch is never reused.
      fetchTimesOut.on = true
      onTestFinished(() => { fetchTimesOut.on = false })
      vi.setSystemTime(Date.now() + FETCH_REUSE_MS + 1)
      expect(await fetchOrigin(repo)).toMatchObject({ ok: false })
      expect(await fetchOrigin(repo)).toMatchObject({ ok: false })
      expect(fetchTimesOut.fetches - before).toBe(5)
    })

    // KERNEL-653: a workspace being made asks the remote before it reuses that fetch.
    describe('inside the minute a fetch is reused for', () => {
      /** A room cloned from a bare remote, and a second clone that pushes to it as a merge on GitHub would. */
      const remoteAndRoom = async () => {
        const bare = await mkdtemp(join(tmpdir(), 'kernel-remote-'))
        await git(bare, 'init', '-q', '--bare')
        const source = await tempRepo(team)
        await git(source, 'remote', 'add', 'origin', bare)
        await git(source, 'push', '-q', 'origin', 'main')
        await git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
        return { bare, source, repo: await cloneOf(bare) }
      }

      it('fetches when the remote moved, so a merge made a moment ago is in the new workspace', async () => {
        const { source, repo } = await remoteAndRoom()
        const k = await kernel()
        const room = await k.addRoom(repo)
        expect(await fetchOrigin(repo)).toEqual({ ok: true })
        await writeFile(join(source, 'MERGED.md'), 'merged\n')
        await git(source, 'add', '-A')
        await git(source, 'commit', '-q', '-m', 'merged')
        await git(source, 'push', '-q', 'origin', 'main')
        const before = { fetches: fetchTimesOut.fetches, lsRemotes: fetchTimesOut.lsRemotes }
        const ws = await k.createWorkspace(room.id, { prompt: 'Build it' })
        expect(fetchTimesOut.lsRemotes - before.lsRemotes).toBe(1)
        expect(fetchTimesOut.fetches - before.fetches).toBe(1)
        expect(ws.baseRef).toBe('origin/main')
        expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(await git(source, 'rev-parse', 'main'))
        await k.stop()
      })

      it('only asks the remote when it has not moved', async () => {
        const { source, repo } = await remoteAndRoom()
        const k = await kernel()
        const room = await k.addRoom(repo)
        expect(await fetchOrigin(repo)).toEqual({ ok: true })
        const before = { fetches: fetchTimesOut.fetches, lsRemotes: fetchTimesOut.lsRemotes }
        const ws = await k.createWorkspace(room.id, { prompt: 'Build it' })
        expect(fetchTimesOut.lsRemotes - before.lsRemotes).toBe(1)
        expect(fetchTimesOut.fetches - before.fetches).toBe(0)
        expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(await git(source, 'rev-parse', 'main'))
        // A caller that doesn't ask, such as New chat's fetch on open, reuses it without a word to the remote.
        await fetchOrigin(repo)
        expect(fetchTimesOut.lsRemotes - before.lsRemotes).toBe(1)
        await k.stop()
      })

      it('fetches when the remote can not be asked, and a fetch that failed is not reused after', async () => {
        const { repo } = await remoteAndRoom()
        expect(await fetchOrigin(repo)).toEqual({ ok: true })
        await git(repo, 'remote', 'set-url', 'origin', join(tmpdir(), 'kernel-no-such-remote'))
        const before = fetchTimesOut.fetches
        expect(await fetchOrigin(repo, 'origin', { check: 'main' })).toMatchObject({ ok: false })
        expect(fetchTimesOut.fetches - before).toBe(1)
        expect(await fetchOrigin(repo)).toMatchObject({ ok: false })
        expect(fetchTimesOut.fetches - before).toBe(2)
      })
    })

    it('says nothing when the base fell back to a local branch, which no fetch updates', async () => {
      const repo = await tempRepo(team)
      await git(repo, 'remote', 'add', 'origin', join(tmpdir(), 'kernel-no-such-remote'))
      const k = await kernel()
      const room = await k.addRoom(repo)
      const ws = await k.createWorkspace(room.id, { prompt: 'Build it' })
      expect(ws.baseRef).toBe('main')
      expect(ws.fetchFailed).toBeUndefined()
      expect(warnings(k, room.id)).toEqual([])
      expect(notes(k, ws.id)).toEqual([])
      await k.stop()
    })

    it('reads a timeout as a timeout, and the Lead hears it from create_workspace', async () => {
      const repo = await cloneOf(await tempRepo(team))
      fetchTimesOut.on = true
      onTestFinished(() => { fetchTimesOut.on = false })
      expect(await fetchOrigin(repo)).toEqual({ ok: false, error: 'timed out after 30 seconds' })
      const k = await kernel()
      const room = await k.addRoom(repo)
      const tool = kernelTools({
        roomId: room.id, lead: undefined, agents: async () => [{ id: 'kai', name: 'Kai', role: 'Frontend', lead: false } as AgentDef], workspaces: () => [],
        createWorkspace: (o) => k.createWorkspace(room.id, o), messageWorkspace: async () => ({ ok: true, sent: true, note: 'Sent.' }), askUser: async () => null,
        hireAgent: async () => '', archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false
      }).find((t) => t.name === 'create_workspace')!
      const r = await tool.handler({ agent: 'kai', title: 'Inbox actions', brief: 'Go' } as never, {})
      const ws = k.store.workspaces(room.id)[0]
      // A clone has no FETCH_HEAD, so the time is unknown.
      expect((r.content[0] as { text: string }).text).toBe(`Created ${ws.id} on ${ws.branch} for kai. Fetching origin failed (timed out after 30 seconds), so it started from origin/main as of its last fetch.`)
      expect(warnings(k, room.id).map((a) => [a.text, a.object])).toEqual([[`started ${ws.name} from origin/main as last fetched, because fetching origin failed:`, 'timed out after 30 seconds']])
      expect(notes(k, ws.id)).toEqual(["Couldn't fetch origin (timed out after 30 seconds), so this workspace started from origin/main as of its last fetch. It may be missing recent merges."])
      await k.stop()
    })
  })

  it('starts a workspace from origin/master when the remote default is master', async () => {
    const repo = await cloneOf(await masterRepo())
    const k = await kernel()
    const room = await k.addRoom(repo)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it' })
    expect(ws.baseRef).toBe('origin/master')
    expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'origin/master'))
    await k.stop()
  })
})

describe('plan mode for new workspaces (KERNEL-74)', () => {
  async function kernel(workspacePlanMode?: boolean) {
    const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...(workspacePlanMode === undefined ? {} : { models: { workspacePlanMode } }) }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const room = await k.addRoom(repo)
    const planOf = (id: string) => k.store.chats(id)[0].plan
    return { k, room, h: k.handlers(), planOf }
  }

  it('starts workspaces from New workspace in plan mode with the setting on, unless the modal says otherwise', async () => {
    const { k, room, h, planOf } = await kernel(true)
    expect(planOf((await h['workspaces.create']({ roomId: room.id, prompt: 'Go', agentId: 'kai' })).id)).toBe(true)
    expect(planOf((await h['workspaces.create']({ roomId: room.id, prompt: 'Go', agentId: 'kai', plan: false })).id)).toBe(false)
    // The Lead's hand-offs call createWorkspace directly and start without it.
    expect(planOf((await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Handed off' })).id)).toBe(false)
    await k.stop()
  })

  it('is off by default', async () => {
    const { k, room, h, planOf } = await kernel()
    expect(k.settings.models.workspacePlanMode).toBe(false)
    expect(planOf((await h['workspaces.create']({ roomId: room.id, prompt: 'Go', agentId: 'kai' })).id)).toBe(false)
    await k.stop()
  })
})

describe('New chat message (KERNEL-147)', () => {
  const file: ChatPart = { type: 'file', name: 'pasted_text_0.txt', lines: 12, text: 'Add PDF export.\nKeep the footer.\n' }
  const issue: ChatPart = { type: 'issue', name: 'KERNEL-12', title: 'PDF export', url: 'https://linear.app/x/KERNEL-12', source: 'linear' }

  it('sends the typed words as the prompt and nothing for chips alone', () => {
    expect(leadMessage([{ type: 'text', text: 'Add  PDF export ' }, file])).toEqual({ prompt: 'Add PDF export', parts: [{ type: 'text', text: 'Add  PDF export ' }, file] })
    expect(leadMessage([file]).prompt).toBe('')
    expect(leadMessage([issue, file]).prompt).toBe('')
  })

  it('adds the picked issue as a chip and the pickers as plain lines', () => {
    expect(pickedLines({ mode: 'worktree', target: 'origin/main', fallback: 'origin/main', picked: '' })).toEqual([])
    expect(pickedLines({ mode: 'worktree', target: 'origin/dev', fallback: 'origin/main', picked: '' })).toEqual(['Cut the branch from origin/dev.'])
    expect(pickedLines({ mode: 'worktree', target: 'origin/feat/x', fallback: 'origin/main', picked: 'origin/feat/x' })).toEqual([])
    expect(pickedLines({ mode: 'current', target: 'origin/dev', fallback: 'origin/main', picked: '' })).toEqual(['Work on the current branch, not a new worktree.'])
    const source = { kind: 'issue', id: 'KERNEL-12', title: 'PDF export', url: 'https://linear.app/x/KERNEL-12' } as const
    expect(briefParts([{ type: 'text', text: 'KERNEL-12: PDF export' }], source, ['Work on the current branch, not a new worktree.'])).toEqual([
      issue, { type: 'text', text: 'KERNEL-12: PDF export\n\nWork on the current branch, not a new worktree.' }
    ])
  })

  it('lead.start sends a chip-only message as exactly its parts, once', async () => {
    const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    // The message waits for the chat's worktree, then goes while setup runs (KERNEL-405, KERNEL-542).
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', leadWaitForSetup: false } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const room = await k.addRoom(repo)
    const start = k.handlers()['lead.start']

    // Each waits in its own chat's queue until that chat's worktree exists.
    const send = async (parts: ChatPart[]) => {
      const chat = await start({ roomId: room.id, ...leadMessage(parts) })
      expect(k.sessions.queued(chat.id).map((q) => q.parts)).toEqual([parts])
      return chat
    }
    const typed: ChatPart[] = [issue, { type: 'text', text: 'Take this one' }]
    const chats = [await send([file]), await send([issue]), await send(typed)]
    const said = (id: string) => k.store.items(id).flatMap((i) => (i.kind === 'user' ? [i.parts] : []))
    await vi.waitFor(() => expect(chats.map((c) => said(c.id))).toEqual([[[file]], [[issue]], [typed]]))
    await k.stop()
  })
})

describe('the New chat page starts a chat on its own picks (KERNEL-544, KERNEL-788)', () => {
  const words = (t: string): ChatPart[] => [{ type: 'text', text: t }]
  const chat = { id: 'c1', workspaceId: 'w1', threadId: 't1', title: 'Chat', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: true, createdAt: 1 }

  /** The renderer with a fake main process: `lead.start` answers with a chat, or fails while `fail` is set. */
  async function renderer() {
    vi.resetModules()
    vi.useFakeTimers()
    const calls: { channel: string; req: unknown }[] = []
    const state = { fail: false }
    vi.doMock('../src/renderer/src/api', () => ({
      cleanError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
      onPush: () => () => undefined,
      call: async (channel: string, req: unknown) => {
        calls.push({ channel, req })
        if (channel === 'lead.start') { if (state.fail) throw new Error('Kernel is busy'); return chat }
        if (channel === 'workspaces.list') return []
        return null
      }
    }))
    onTestFinished(() => { vi.doUnmock('../src/renderer/src/api'); vi.useRealTimers() })
    const drafts = await import('../src/renderer/src/screens/workspace/composer/draftStore')
    const { startChat } = await import('../src/renderer/src/screens/new-workspace/start')
    const send = () => startChat({ roomId: 'r1', parts: words('fix the login'), model: 'claude-sonnet-5-5', effort: 'low', plan: true, baseRef: '' })
    return { calls, state, drafts, send }
  }

  it("sends the box's picks, then clears the text and the picks so the next box starts from the Lead", async () => {
    const { calls, drafts, send } = await renderer()
    const room = drafts.newChatDraftOf('r1')
    drafts.saveDraft(room, words('fix the login'), '')
    drafts.savePicks(room, { model: 'claude-sonnet-5-5', effort: 'low', plan: true })
    expect(await send()).toBeUndefined()
    expect(calls.find((c) => c.channel === 'lead.start')?.req).toMatchObject({ roomId: 'r1', model: 'claude-sonnet-5-5', effort: 'low', plan: true })
    expect(drafts.loadDraft(room)).toBeUndefined()
    expect(drafts.loadPicks(room)).toBeUndefined()
  })

  it('opens the new chat with its right panel held closed, whatever the global setting says (KERNEL-788)', async () => {
    const { send } = await renderer()
    const { getState, panelShownIn } = await import('../src/renderer/src/store')
    getState().ui.rightPanel = true
    await send()
    expect(getState().ui.route).toEqual({ name: 'workspace', workspaceId: 'w1' })
    expect(getState().ui.panelHeld).toContain('w1')
    expect(panelShownIn(getState().ui, 'w1')).toBe(false)
  })

  it('shows the panel once the toggle is pressed in that chat, and never before (KERNEL-788)', async () => {
    const { send } = await renderer()
    const { actions, getState, panelShownIn } = await import('../src/renderer/src/store')
    actions.ui.setRightPanel(false)
    await send()
    expect(panelShownIn(getState().ui, 'w1')).toBe(false)
    actions.ui.setRightPanel(true)
    expect(getState().ui.panelHeld).not.toContain('w1')
    expect(panelShownIn(getState().ui, 'w1')).toBe(true)
  })

  it('opens the held panel with one press of the toggle while the global panel is on (KERNEL-788)', async () => {
    const { send } = await renderer()
    const { actions, getState, panelShownIn } = await import('../src/renderer/src/store')
    const { toggleRightPanel } = await import('../src/renderer/src/components/PanelToggles')
    actions.ui.setRightPanel(true)
    await send()
    expect(panelShownIn(getState().ui, 'w1')).toBe(false)
    toggleRightPanel()
    expect(getState().ui.rightPanel).toBe(true)
    expect(getState().ui.panelHeld).not.toContain('w1')
    expect(panelShownIn(getState().ui, 'w1')).toBe(true)
    toggleRightPanel()
    expect(panelShownIn(getState().ui, 'w1')).toBe(false)
  })

  it('keeps the text and the picks when the chat could not be sent', async () => {
    const { drafts, send, state } = await renderer()
    const room = drafts.newChatDraftOf('r1')
    drafts.saveDraft(room, words('fix the login'), '')
    drafts.savePicks(room, { model: 'claude-sonnet-5-5', effort: 'low', plan: true })
    state.fail = true
    expect(await send()).toBe('Kernel is busy')
    expect(drafts.loadDraft(room)).toEqual(words('fix the login'))
    expect(drafts.loadPicks(room)).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', plan: true })
  })

  it("leaves another room's New chat box alone when a chat starts", async () => {
    const { drafts, send } = await renderer()
    const other = drafts.newChatDraftOf('r2')
    drafts.saveDraft(other, words('in the other room'), '')
    drafts.savePicks(other, { plan: false })
    await send()
    expect([drafts.loadDraft(other), drafts.loadPicks(other)]).toEqual([words('in the other room'), { plan: false }])
  })

  it("sends the box's permission mode with the chat", async () => {
    const { calls } = await renderer()
    const { startChat } = await import('../src/renderer/src/screens/new-workspace/start')
    await startChat({ roomId: 'r1', parts: words('go'), model: 'claude-sonnet-5-5', effort: 'low', plan: false, mode: 'acceptEdits', baseRef: '' })
    expect(calls.find((c) => c.channel === 'lead.start')?.req).toMatchObject({ mode: 'acceptEdits' })
  })

  describe("the warning's way back", () => {
    const picks = { mode: 'worktree', model: 'claude-haiku-4-5-20251001', effort: 'medium', plan: true, baseRef: 'origin/dev' } as const
    const held = { roomId: 'r1', source: { kind: 'issue', id: 'KERNEL-1', title: 'x' }, parts: words('go'), picks } as const

    it('opens the New chat page with the source and picks when you have gone elsewhere', async () => {
      await renderer()
      const { backToNewChat } = await import('../src/renderer/src/screens/new-workspace/start')
      const { getState } = await import('../src/renderer/src/store')
      backToNewChat(held)
      expect(getState().ui.route).toMatchObject({ name: 'leadNew', roomId: 'r1', source: held.source, picks })
      expect(getState().ui.modal).toBeNull()
    })

    it('only closes the warning when the page is still under it', async () => {
      await renderer()
      const { backToNewChat } = await import('../src/renderer/src/screens/new-workspace/start')
      const { actions, getState } = await import('../src/renderer/src/store')
      actions.ui.go({ name: 'leadNew', roomId: 'r1' })
      actions.ui.openModal({ name: 'confirm', kind: 'issueTaken', issue: 'KERNEL-1', findings: [], held })
      backToNewChat(held)
      expect(getState().ui.modal).toBeNull()
      expect(getState().ui.route).toEqual({ name: 'leadNew', roomId: 'r1' })
    })

    it('hands the picks to the box it reopens, where they win over the Lead and stay until it sends', async () => {
      const { drafts } = await renderer()
      drafts.savePicks(drafts.newChatDraftOf('r1'), { model: picks.model, effort: picks.effort, plan: picks.plan })
      const { boxPick } = await import('../src/renderer/src/screens/workspace/composer/modelPrefs')
      expect(boxPick({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high', plan: false }, drafts.loadPicks(drafts.newChatDraftOf('r1')))).toEqual({ model: 'claude-haiku-4-5-20251001', effort: 'medium', plan: true })
    })
  })
})
