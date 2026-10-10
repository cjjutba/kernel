import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { exec, git } from '../src/main/services/exec'
import { defaultBranch, fetchOrigin, listBranches, resolveBaseRef, taskBranch } from '../src/main/services/worktrees'
import { parseIssueList, parsePrList } from '../src/main/services/github'
import { NO_LINEAR_TOKEN, searchIssues } from '../src/main/services/linear'
import { fetchedAt, Kernel } from '../src/main/kernel'
import { kernelTools } from '../src/main/services/kernelMcp'
import { briefParts, leadMessage, pickedLines } from '../src/renderer/src/screens/new-workspace/brief'
import type { AgentDef, ChatPart } from '../src/shared/types'

/** While `on`, every `git fetch` times out, the way exec reports it when its timer kills git (KERNEL-179). */
const fetchTimesOut = vi.hoisted(() => ({ on: false }))
vi.mock('../src/main/services/exec', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/services/exec')>()
  return {
    ...real,
    exec: (cmd: string, args: string[], opts?: Parameters<typeof real.exec>[2]) =>
      fetchTimesOut.on && args.includes('fetch') ? Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: true }) : real.exec(cmd, args, opts)
  }
})

describe('branch naming', () => {
  it('uses feat/{task}-{slug} when a Linear issue is linked', () => {
    expect(taskBranch('feat/{slug}', 'Client portal login', 'KERNEL-16')).toBe('feat/kernel-16-client-portal-login')
    expect(taskBranch('feat/{task}-{slug}', 'Client portal login', 'T-16')).toBe('feat/t-16-client-portal-login')
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
    const repo = await tempRepo({ '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.' })
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

describe('the base a workspace starts from', () => {
  const lead = { '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.' }
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
      expect(await fetchOrigin(repo)).toEqual({ ok: true })
      const k = await kernel()
      const room = await k.addRoom(repo)
      const ws = await k.createWorkspace(room.id, { prompt: 'Build it' })
      expect(ws.fetchFailed).toBeUndefined()
      expect(await git(ws.path, 'rev-parse', 'HEAD')).toBe(await git(remote, 'rev-parse', 'main'))
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
    const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const sent: ChatPart[][] = []
    k.sessions.send = async (_chatId, parts) => { sent.push(parts); return { queued: false } }
    const room = await k.addRoom(repo)
    const start = k.handlers()['lead.start']

    await start({ roomId: room.id, ...leadMessage([file]) })
    await start({ roomId: room.id, ...leadMessage([issue]) })
    const typed: ChatPart[] = [issue, { type: 'text', text: 'Take this one' }]
    await start({ roomId: room.id, ...leadMessage(typed) })
    expect(sent).toEqual([[file], [issue], typed])
    await k.stop()
  })
})
