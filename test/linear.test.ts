import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import type { Cipher } from '../src/main/services/env'
import { kernelTools } from '../src/main/services/kernelMcp'
import { saveLinearToken, storedLinearToken } from '../src/main/services/integrations'
import { getIssue, getScope, issueFilter, listIssues, moveToStarted, NO_LINEAR_TOKEN, searchIssues } from '../src/main/services/trackers/linear'
import type { ActivityEvent, AgentDef, ChatPart } from '../src/shared/types'

// A chat with Rowan's held first message goes out through the real send once its setup passes (KERNEL-405).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

interface Call { query: string; variables: Record<string, unknown>; auth: string }

/** A Linear that answers each GraphQL call with `answer`, and keeps the calls. */
function linear(answer: (c: Call) => unknown) {
  const calls: Call[] = []
  const fetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }
    const call = { query, variables, auth: init.headers.authorization }
    calls.push(call)
    const out = answer(call)
    return out instanceof Response ? out : new Response(JSON.stringify({ data: out }))
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

const node = {
  id: 'uuid-83', identifier: 'KERNEL-83', title: 'Issues screen', url: 'https://linear.app/cj/issue/KERNEL-83', branchName: 'cj/kernel-83-issues-screen',
  priority: 2, updatedAt: '2026-10-09T10:00:00.000Z',
  state: { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 1 },
  assignee: { name: 'CJ Jutba', isMe: true },
  labels: { nodes: [{ name: 'Engine' }, { name: 'Bug' }] },
  team: { id: 'team-1', key: 'KERNEL', name: 'Kernel' },
  project: { id: 'proj-1', name: 'Kernel v1' },
  cycle: { id: 'cyc-1', number: 4, name: null }
}

const mapped = {
  id: 'KERNEL-83', uuid: 'uuid-83', title: 'Issues screen', url: 'https://linear.app/cj/issue/KERNEL-83', branchName: 'cj/kernel-83-issues-screen',
  state: { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 1 }, priority: 2,
  assignee: { name: 'CJ Jutba', me: true }, labels: ['Engine', 'Bug'],
  team: { id: 'team-1', key: 'KERNEL', name: 'Kernel' }, project: { id: 'proj-1', name: 'Kernel v1' }, cycle: { id: 'cyc-1', number: 4 },
  updatedAt: '2026-10-09T10:00:00.000Z'
}

const detail = {
  ...node, description: 'Build the Issues screen.\n\n## Acceptance\n\n* It lists issues.',
  comments: { nodes: [
    { id: 'c2', body: 'Second', createdAt: '2026-10-09T12:00:00.000Z', user: null },
    { id: 'c1', body: 'First', createdAt: '2026-10-09T11:00:00.000Z', user: { name: 'Rowan' } }
  ] }
}

const OPEN = { state: { type: { in: ['triage', 'backlog', 'unstarted', 'started'] } } }

describe('the Issues screen filter', () => {
  it('lists open issues with nothing set', () => {
    expect(issueFilter({ mine: false })).toEqual({ and: [OPEN] })
  })
  it('narrows by Mine, team, project and cycle', () => {
    expect(issueFilter({ mine: true }).and).toEqual([OPEN, { assignee: { isMe: { eq: true } } }])
    expect(issueFilter({ mine: false, teamId: 'team-1' }).and).toEqual([OPEN, { team: { id: { eq: 'team-1' } } }])
    expect(issueFilter({ mine: false, projectId: 'proj-1' }).and).toEqual([OPEN, { project: { id: { eq: 'proj-1' } } }])
    expect(issueFilter({ mine: false, cycleId: 'cyc-1' }).and).toEqual([OPEN, { cycle: { id: { eq: 'cyc-1' } } }])
  })
  it('matches the title, and the number when the query ends in one', () => {
    expect(issueFilter({ mine: false, query: ' screen ' }).and).toEqual([OPEN, { or: [{ title: { containsIgnoreCase: 'screen' } }] }])
    expect(issueFilter({ mine: false, query: 'KERNEL-83' }).and).toEqual([OPEN, { or: [{ title: { containsIgnoreCase: 'KERNEL-83' } }, { number: { eq: 83 } }] }])
    expect(issueFilter({ mine: false, query: '   ' })).toEqual({ and: [OPEN] })
  })
  it('combines every field that is set', () => {
    expect(issueFilter({ mine: true, teamId: 't', projectId: 'p', cycleId: 'c', query: '7' }).and).toHaveLength(6)
  })
})

describe('Linear queries', () => {
  it('lists the first 100 open issues by last update, mapped', async () => {
    const l = linear(() => ({ issues: { nodes: [node, { ...node, identifier: 'KERNEL-84', assignee: null, project: null, cycle: { id: 'cyc-2', number: 5, name: 'Polish' }, labels: { nodes: [] } }] } }))
    const out = await listIssues('lin_key', { mine: true }, l.fetch)
    expect(out[0]).toEqual(mapped)
    expect(out[1]).toEqual({ ...mapped, id: 'KERNEL-84', assignee: undefined, project: undefined, cycle: { id: 'cyc-2', number: 5, name: 'Polish' }, labels: [] })
    expect(out[1]).not.toHaveProperty('assignee')
    expect(l.calls[0].auth).toBe('lin_key')
    expect(l.calls[0].query).toMatch(/issues\(first: 100, filter: \$filter, orderBy: updatedAt\)/)
    expect(l.calls[0].variables.filter).toEqual(issueFilter({ mine: true }))
  })

  it('searches open issues only, with or without a query', async () => {
    const l = linear(() => ({ issues: { nodes: [] } }))
    await searchIssues('k', '', l.fetch)
    await searchIssues('k', 'KERNEL-83', l.fetch)
    expect(l.calls[0].variables.filter).toEqual(OPEN)
    expect(l.calls[1].variables.filter).toEqual({ and: [OPEN, { or: [{ title: { containsIgnoreCase: 'KERNEL-83' } }, { number: { eq: 83 } }] }] })
  })

  it('reads an issue marked as a duplicate with its state type', async () => {
    const l = linear(() => ({ issue: { ...detail, state: { id: 'st-dup', name: 'Duplicate', type: 'duplicate', position: 4 } } }))
    expect((await getIssue('k', 'KERNEL-83', l.fetch)).state).toEqual({ id: 'st-dup', name: 'Duplicate', type: 'duplicate', position: 4 })
  })

  it('reads one issue by identifier with its description and comments, oldest first', async () => {
    const l = linear(() => ({ issue: detail }))
    const out = await getIssue('k', 'KERNEL-83', l.fetch)
    expect(l.calls[0].variables).toEqual({ id: 'KERNEL-83' })
    expect(l.calls[0].query).toContain('comments(first: 50)')
    expect(out).toEqual({ ...mapped, description: detail.description, comments: [
      { id: 'c1', body: 'First', author: 'Rowan', createdAt: '2026-10-09T11:00:00.000Z' },
      { id: 'c2', body: 'Second', createdAt: '2026-10-09T12:00:00.000Z' }
    ], blockedBy: [] })
  })

  it('reads the issues that block it from its inverse relations, once each (KERNEL-263)', async () => {
    const l = linear(() => ({ issue: { ...detail, inverseRelations: { nodes: [
      { type: 'blocks', issue: { identifier: 'KERNEL-197' } },
      { type: 'related', issue: { identifier: 'KERNEL-200' } },
      { type: 'duplicate', issue: { identifier: 'KERNEL-201' } },
      { type: 'blocks', issue: { identifier: 'KERNEL-202' } },
      { type: 'blocks', issue: { identifier: 'KERNEL-197' } },
      { type: 'blocks', issue: null }
    ] } } }))
    const out = await getIssue('k', 'KERNEL-198', l.fetch)
    expect(l.calls[0].query).toContain('inverseRelations { nodes { type issue { identifier } } }')
    expect(out.blockedBy).toEqual(['KERNEL-197', 'KERNEL-202'])
  })

  it('reads an issue with no relations as blocked by nothing', async () => {
    const l = linear(() => ({ issue: { ...detail, inverseRelations: { nodes: [] } } }))
    expect((await getIssue('k', 'KERNEL-198', l.fetch)).blockedBy).toEqual([])
  })

  it('reads an issue with no description as empty', async () => {
    const l = linear(() => ({ issue: { ...detail, description: null, comments: { nodes: [] } } }))
    expect(await getIssue('k', 'KERNEL-83', l.fetch)).toMatchObject({ description: '', comments: [] })
  })

  it('reads teams, open projects with their teams, and active and upcoming cycles', async () => {
    const l = linear(() => ({
      teams: { nodes: [{ id: 'team-1', key: 'KERNEL', name: 'Kernel' }] },
      projects: { nodes: [{ id: 'proj-1', name: 'Kernel v1', teams: { nodes: [{ id: 'team-1' }] } }] },
      cycles: { nodes: [{ id: 'cyc-1', number: 4, name: null, isActive: true, team: { id: 'team-1' } }, { id: 'cyc-2', number: 5, name: 'Polish', isActive: false, team: { id: 'team-1' } }] }
    }))
    expect(await getScope('k', l.fetch)).toEqual({
      teams: [{ id: 'team-1', key: 'KERNEL', name: 'Kernel' }],
      projects: [{ id: 'proj-1', name: 'Kernel v1', teamIds: ['team-1'] }],
      cycles: [{ id: 'cyc-1', number: 4, teamId: 'team-1', active: true }, { id: 'cyc-2', number: 5, name: 'Polish', teamId: 'team-1', active: false }]
    })
    expect(l.calls[0].query).toContain('isFuture')
  })

  it('fails with the same words for every query: no key, a rejected key, no connection', async () => {
    const rejected = linear(() => new Response('{}', { status: 401 }))
    const offline = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    for (const run of [
      (f?: typeof fetch) => listIssues(undefined, { mine: false }, f), (f?: typeof fetch) => getIssue(undefined, 'KERNEL-1', f), (f?: typeof fetch) => getScope(undefined, f)
    ]) await expect(run()).rejects.toThrow(NO_LINEAR_TOKEN)
    await expect(listIssues('bad', { mine: false }, rejected.fetch)).rejects.toThrow('Linear rejected the token. Reconnect it in Settings > Integrations.')
    await expect(getIssue('bad', 'KERNEL-1', rejected.fetch)).rejects.toThrow('Linear rejected the token.')
    await expect(getScope('k', offline)).rejects.toThrow('Could not reach Linear. Check your connection.')
    await expect(getIssue('k', 'NOPE-1', linear(() => new Response(JSON.stringify({ errors: [{ message: 'Entity not found: Issue' }] }))).fetch)).rejects.toThrow('Entity not found: Issue')
  })
})

describe('moving an issue to In Progress', () => {
  /** An issue in `type`, on a team whose started states are In Review (position 3) and In Progress (position 1). */
  const team = (type: string) => linear((c) => c.query.includes('mutation')
    ? { issueUpdate: { success: true } }
    : { issue: { id: 'uuid-83', state: { type }, team: { states: { nodes: [{ id: 'st-review', name: 'In Review', position: 3 }, { id: 'st-progress', name: 'In Progress', position: 1 }] } } } })

  it('moves an issue from Todo to the started state with the lowest position', async () => {
    const l = team('unstarted')
    expect(await moveToStarted('k', 'KERNEL-83', l.fetch)).toBe('In Progress')
    expect(l.calls[0].query).toContain('states(filter: { type: { eq: "started" } })')
    expect(l.calls[1].query).toContain('issueUpdate')
    expect(l.calls[1].variables).toEqual({ id: 'uuid-83', stateId: 'st-progress' })
  })

  it('moves an issue from triage and backlog too', async () => {
    for (const type of ['triage', 'backlog']) {
      const l = team(type)
      expect(await moveToStarted('k', 'KERNEL-83', l.fetch)).toBe('In Progress')
      expect(l.calls).toHaveLength(2)
    }
  })

  it('leaves an issue alone once it is in progress, done, canceled or a duplicate', async () => {
    for (const type of ['started', 'completed', 'canceled', 'duplicate']) {
      const l = team(type)
      expect(await moveToStarted('k', 'KERNEL-83', l.fetch)).toBeUndefined()
      expect(l.calls).toHaveLength(1)
    }
  })
})

/** Stands in for safeStorage, which doesn't work under ELECTRON_RUN_AS_NODE. Its output never holds the text it was given. */
const cipher: Cipher = { encrypt: (t) => `enc:${Buffer.from([...t].reverse().join('')).toString('base64')}`, decrypt: (d) => [...Buffer.from(d.slice(4), 'base64').toString()].reverse().join('') }
/** A Keychain that is there but refuses, as safeStorage does when the user denies access. */
const refusing: Cipher = { encrypt: () => { throw new Error('denied') }, decrypt: () => { throw new Error('denied') } }

describe('the saved Linear token (KERNEL-445)', () => {
  const dataDir = () => mkdtemp(join(tmpdir(), 'kernel-data-'))
  const onDisk = async (dir: string) => ({
    text: await readFile(join(dir, 'integrations.json'), 'utf8'),
    mode: (await stat(join(dir, 'integrations.json'))).mode & 0o777
  })

  it('round trips through the Keychain and never writes the token in the clear', async () => {
    const dir = await dataDir()
    await saveLinearToken(dir, '  lin_secret  ', cipher)
    const file = await onDisk(dir)
    expect(file.text).not.toContain('lin_secret')
    expect(JSON.parse(file.text)).toEqual({ linearTokenEncrypted: cipher.encrypt('lin_secret') })
    expect(file.mode).toBe(0o600)
    expect(await storedLinearToken(dir, cipher)).toBe('lin_secret')
    // No temp file is left next to it.
    expect(await readdir(dir)).toEqual(['integrations.json'])
    await saveLinearToken(dir, '', cipher)
    expect(JSON.parse((await onDisk(dir)).text)).toEqual({})
    expect(await storedLinearToken(dir, cipher)).toBeUndefined()
  })

  it('encrypts a plain text token on its first read', async () => {
    const dir = await dataDir()
    await writeFile(join(dir, 'integrations.json'), JSON.stringify({ linearToken: 'lin_old' }), { mode: 0o644 })
    expect(await storedLinearToken(dir, cipher)).toBe('lin_old')
    const file = await onDisk(dir)
    expect(file.text).not.toContain('lin_old')
    expect(JSON.parse(file.text)).toEqual({ linearTokenEncrypted: cipher.encrypt('lin_old') })
    expect(file.mode).toBe(0o600)
    expect(await storedLinearToken(dir, cipher)).toBe('lin_old')
  })

  it('leaves one encrypted file when several first reads land together', async () => {
    const dir = await dataDir()
    await writeFile(join(dir, 'integrations.json'), JSON.stringify({ linearToken: 'lin_old' }))
    expect(await Promise.all([1, 2, 3, 4].map(() => storedLinearToken(dir, cipher)))).toEqual(['lin_old', 'lin_old', 'lin_old', 'lin_old'])
    expect(JSON.parse((await onDisk(dir)).text)).toEqual({ linearTokenEncrypted: cipher.encrypt('lin_old') })
    expect(await readdir(dir)).toEqual(['integrations.json'])
  })

  it('falls back to a file only the user can read without the Keychain', async () => {
    for (const c of [undefined, refusing]) {
      const dir = await dataDir()
      await writeFile(join(dir, 'integrations.json'), '{}', { mode: 0o644 })
      await saveLinearToken(dir, 'lin_plain', c)
      const file = await onDisk(dir)
      expect(JSON.parse(file.text)).toEqual({ linearToken: 'lin_plain' })
      expect(file.mode).toBe(0o600)
      expect(await storedLinearToken(dir, c)).toBe('lin_plain')
      // A read that can't encrypt leaves the plain text file as it was.
      expect(JSON.parse((await onDisk(dir)).text)).toEqual({ linearToken: 'lin_plain' })
    }
  })

  it('reads an encrypted token it can\'t decrypt as none', async () => {
    const dir = await dataDir()
    await saveLinearToken(dir, 'lin_secret', cipher)
    expect(await storedLinearToken(dir)).toBeUndefined()
    expect(await storedLinearToken(dir, refusing)).toBeUndefined()
    expect(await storedLinearToken(dir, cipher)).toBe('lin_secret')
  })

  it('reads a missing or odd file as no token', async () => {
    const dir = await dataDir()
    expect(await storedLinearToken(dir, cipher)).toBeUndefined()
    for (const text of ['not json', 'null', '[]', '{"linearToken":42}', '{"linearTokenEncrypted":42}']) {
      await writeFile(join(dir, 'integrations.json'), text)
      expect(await storedLinearToken(dir, cipher)).toBeUndefined()
    }
  })
})

describe('Linear in the kernel', () => {
  const ROWAN = '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.'
  const NOOR = '---\nname: noor\ndescription: Engine.\nrole: Engine\n---\nYou are Noor. Open a PR for each task.'
  const kernels: Kernel[] = []
  afterEach(async () => { vi.unstubAllEnvs(); for (const k of kernels.splice(0)) await k.stop() })

  /**
   * A Kernel on a temp repo with Rowan and Noor, whose Linear calls go to `answer`. Sessions only record what they are sent.
   * `plain` saves the token the way Kernel did before KERNEL-445; `cipher` is the Kernel's Keychain. The room names its
   * Linear team, so with a token its tracker is Linear (KERNEL-462).
   */
  async function kernel(answer: (c: Call) => unknown, o: { token?: string; plain?: boolean; cipher?: Cipher } = { token: 'lin_stored' }) {
    vi.stubEnv('LINEAR_API_KEY', '')
    const repo = await tempRepo({ 'README.md': '# app\n', '.kernel/settings.toml': '[linear]\nteam = "KERNEL"\n', '.claude/agents/rowan.md': ROWAN, '.claude/agents/noor.md': NOOR })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    if (o.token) await saveLinearToken(dataDir, o.token, o.plain ? undefined : o.cipher)
    const l = linear(answer)
    const k = new Kernel({ dataDir, home, fetch: l.fetch, cipher: o.cipher })
    kernels.push(k)
    await k.start()
    const sent: { chatId: string; parts: ChatPart[] }[] = []
    k.sessions.send = async (chatId, parts) => { sent.push({ chatId, parts }); return { queued: false } }
    const room = await k.addRoom(repo)
    return { k, room, calls: l.calls, sent, dataDir }
  }

  const scope = () => ({ teams: { nodes: [] }, projects: { nodes: [] }, cycles: { nodes: [] }, issues: { nodes: [] } })

  it('moves a plain text token into the Keychain on the first Linear call, and saves a new one encrypted (KERNEL-445)', async () => {
    const { k, calls, dataDir } = await kernel(scope, { token: 'lin_old', plain: true, cipher })
    await k.handlers()['linear.scope']()
    expect(calls[0].auth).toBe('lin_old')
    expect(await readFile(join(dataDir, 'integrations.json'), 'utf8')).not.toContain('lin_old')
    await k.handlers()['linear.scope']()
    expect(calls[1].auth).toBe('lin_old')
    expect(await k.handlers()['integrations.connect']({ id: 'linear', token: 'lin_new' })).toMatchObject({ id: 'linear', connected: true })
    expect(await readFile(join(dataDir, 'integrations.json'), 'utf8')).not.toContain('lin_new')
    await k.handlers()['linear.scope']()
    expect(calls.at(-1)!.auth).toBe('lin_new')
  })

  it('uses LINEAR_API_KEY when the saved token can\'t be decrypted (KERNEL-445)', async () => {
    const { k, calls, dataDir } = await kernel(scope, { cipher: refusing })
    await saveLinearToken(dataDir, 'lin_other_mac', cipher)
    vi.stubEnv('LINEAR_API_KEY', 'lin_env')
    await k.handlers()['linear.scope']()
    expect(calls[0].auth).toBe('lin_env')
  })

  /** The Lead's create_workspace, run against the kernel as Rowan's chat would. */
  async function createWorkspace(k: Kernel, roomId: string, args: Record<string, string>) {
    const lead = (await k.agents(roomId)).find((a) => a.lead) as AgentDef
    const chat = await k.leadChat(roomId)
    const deps = k.lead.leadToolDeps(roomId, lead, chat)
    const tool = kernelTools(deps).find((t) => t.name === 'create_workspace')!
    const out = await tool.handler({ agent: 'noor', title: 'Build the screen', brief: 'Goal, files, acceptance criteria', ...args } as never, {})
    return { text: (out.content[0] as { text: string }).text, ws: k.store.workspaces(roomId).find((w) => w.agentId === 'noor')! }
  }

  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)) }

  /** Answers the detail, the In Progress lookup and the move for KERNEL-83, which starts in Todo. */
  const answer = (c: Call) => c.query.includes('mutation') ? { issueUpdate: { success: true } }
    : c.query.includes('Started') ? { issue: { id: 'uuid-83', state: { type: 'unstarted' }, team: { states: { nodes: [{ id: 'st-progress', name: 'In Progress', position: 1 }] } } } }
    : { issue: detail }

  it('reads the saved token first, then LINEAR_API_KEY, for every Linear channel', async () => {
    const { k, room, calls } = await kernel(() => ({ teams: { nodes: [] }, projects: { nodes: [] }, cycles: { nodes: [] }, issues: { nodes: [] }, issue: detail }))
    const h = k.handlers()
    await h['linear.scope']()
    await h['linear.issues']({ filter: { mine: false } })
    await h['linear.issue']({ id: 'KERNEL-83' })
    await h['issues.list']({ roomId: room.id, query: '' })
    expect(calls.map((c) => c.auth)).toEqual(['lin_stored', 'lin_stored', 'lin_stored', 'lin_stored'])
    const env = await kernel(() => ({ teams: { nodes: [] }, projects: { nodes: [] }, cycles: { nodes: [] } }), {})
    vi.stubEnv('LINEAR_API_KEY', 'lin_env')
    await env.k.handlers()['linear.scope']()
    expect(env.calls[0].auth).toBe('lin_env')
    vi.stubEnv('LINEAR_API_KEY', '')
    await expect(env.k.handlers()['linear.issues']({ filter: { mine: false } })).rejects.toThrow(NO_LINEAR_TOKEN)
  })

  it('create_workspace with issue links the workspace, names the branch from the key and moves the issue to In Progress', async () => {
    const { k, room, calls } = await kernel(answer)
    const { text, ws } = await createWorkspace(k, room.id, { issue: 'KERNEL-83' })
    expect(ws.source).toEqual({ kind: 'issue', id: 'KERNEL-83', title: 'Issues screen', url: 'https://linear.app/cj/issue/KERNEL-83', tracker: 'linear' })
    // The Bug label makes it a fix, and Linear's own cj/kernel-83-issues-screen is not used (KERNEL-275).
    expect(ws.branch).toBe('fix/kernel-83-issues-screen')
    expect(text).toBe(`Created ${ws.id} on fix/kernel-83-issues-screen for noor.`)
    await until(() => calls.some((c) => c.query.includes('mutation')))
    expect(calls.find((c) => c.query.includes('mutation'))?.variables).toEqual({ id: 'uuid-83', stateId: 'st-progress' })
  })

  it('starts an issue with no Bug label on feat (KERNEL-275)', async () => {
    const { k, room } = await kernel((c) => c.query.includes('IssueDetail') ? { issue: { ...detail, labels: { nodes: [{ name: 'Engine' }] } } } : answer(c))
    const { ws } = await createWorkspace(k, room.id, { issue: 'KERNEL-83' })
    expect(ws.branch).toBe('feat/kernel-83-issues-screen')
  })

  it('cuts a 90-character branch from the Lead to 60 and starts the workspace (KERNEL-275)', async () => {
    const { k, room } = await kernel(answer)
    const branch = 'cjjutbaofficial/kernel-83-the-issues-screen-lists-open-issues-and-filters-them-by-the-team'
    expect(branch).toHaveLength(90)
    const { text, ws } = await createWorkspace(k, room.id, { issue: 'KERNEL-83', branch })
    expect(ws.branch).toBe('cjjutbaofficial/kernel-83-the-issues-screen-lists-open')
    expect(text).toBe(`Created ${ws.id} on ${ws.branch} for noor.`)
    expect(ws.status).toBe('ready')
  })

  it('names a branch from the New workspace modal after the issue\'s labels (KERNEL-275)', async () => {
    const { k, room } = await kernel(answer)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it', source: { kind: 'issue', id: 'KERNEL-83', title: 'Issues screen' } })
    expect(ws.branch).toBe('fix/kernel-83-issues-screen')
  })

  it('starts on feat when Linear takes over 5 seconds to send the labels (KERNEL-275)', async () => {
    // The detail's body never finishes arriving.
    const { k, room } = await kernel((c) => c.query.includes('IssueDetail') ? new Response(new ReadableStream()) : answer(c))
    const started = Date.now()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it', source: { kind: 'issue', id: 'KERNEL-83', title: 'Issues screen' } })
    expect(ws.branch).toBe('feat/kernel-83-issues-screen')
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900)
  }, 15000)

  it('an explicit branch wins over Linear\'s', async () => {
    const { k, room } = await kernel(answer)
    const { ws } = await createWorkspace(k, room.id, { issue: 'KERNEL-83', branch: 'feat/my-own-name' })
    expect(ws.branch).toBe('feat/my-own-name')
    expect(ws.source).toMatchObject({ kind: 'issue', id: 'KERNEL-83', title: 'Issues screen' })
  })

  it('uses the task title when Linear does not answer, and the workspace still starts with one note', async () => {
    const notes: ActivityEvent[] = []
    const listen = (e: ActivityEvent) => { if (e.kind === 'note' && e.text.includes('In Progress')) notes.push(e) }
    bus.on('activity', listen)
    try {
      const { k, room } = await kernel(() => new Response('{}', { status: 500 }))
      const { ws } = await createWorkspace(k, room.id, { issue: 'KERNEL-83' })
      expect(ws.source).toEqual({ kind: 'issue', id: 'KERNEL-83', title: 'Build the screen', tracker: 'linear' })
      expect(ws.branch).toBe('feat/kernel-83-build-screen')
      expect(ws.status).toBe('ready')
      await until(() => notes.length > 0)
      await new Promise((r) => setTimeout(r, 50))
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatchObject({ workspaceId: ws.id, text: 'could not move KERNEL-83 to In Progress in Linear:', warn: true })
    } finally { bus.off('activity', listen) }
  })

  it('leaves a GitHub issue, and Linear without a token, alone', async () => {
    const github = await kernel(answer)
    const { ws } = await createWorkspace(github.k, github.room.id, { issue: '#41' })
    expect(ws.source).toEqual({ kind: 'issue', id: '#41', title: 'Build the screen', tracker: 'github' })
    expect(ws.branch).toBe('feat/41-build-screen')
    const none = await kernel(answer, {})
    const made = await createWorkspace(none.k, none.room.id, { issue: 'KERNEL-83' })
    expect(made.ws.source).toMatchObject({ id: 'KERNEL-83', title: 'Build the screen' })
    await new Promise((r) => setTimeout(r, 50))
    expect(github.calls).toEqual([])
    expect(none.calls).toEqual([])
  })

  it('Plan with Rowan starts a fresh Lead chat in plan mode, briefed with the issue', async () => {
    const { k, room, sent } = await kernel(answer)
    const before = await k.leadChat(room.id)
    const out = await k.handlers()['linear.plan']({ id: 'KERNEL-83', roomId: room.id })
    const chat = k.store.chat(out.chatId)!
    expect(out.chatId).not.toBe(before.id)
    // A chat of its own has a workspace of its own (KERNEL-405), and its brief waits for setup.
    expect(out.workspaceId).not.toBe(before.workspaceId)
    expect(k.sessions.queued(out.chatId)).toHaveLength(1)
    const queued = k.sessions.queued(out.chatId).map((q) => ({ chatId: out.chatId, parts: q.parts }))
    expect(sent).toEqual([])
    sent.push(...queued)
    expect(chat.plan).toBe(true)
    // In a Lead chat of its own (KERNEL-337).
    expect(chat.threadId).toBeTruthy()
    expect(chat.threadId).not.toBe(before.threadId)
    expect(sent).toHaveLength(1)
    expect(sent[0].chatId).toBe(out.chatId)
    const [chip, words] = sent[0].parts
    expect(chip).toEqual({ type: 'issue', name: 'KERNEL-83', title: 'Issues screen', url: 'https://linear.app/cj/issue/KERNEL-83', source: 'linear' })
    expect(words.type === 'text' && words.text).toBe(`${detail.description}\n\nWhen you hand it off, pass KERNEL-83 as issue to create_workspace.`)
  })
})
