import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { AgentDef, PrState, Workspace } from '@shared/types'
import { kernelTools, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { Kernel } from '../src/main/kernel'
import { git } from '../src/main/services/exec'
import { tempRepo } from './helpers'

// Keeps the deps the Kernel hands the Lead's server, so the wiring test can call the same tools.
let wired: KernelToolDeps | undefined
vi.mock('../src/main/services/kernelMcp', async (original) => {
  const m = await original<typeof import('../src/main/services/kernelMcp')>()
  return { ...m, kernelMcpServer: (d: KernelToolDeps) => { wired = d; return m.kernelMcpServer(d) } }
})

const ws = (id: string, o: Partial<Workspace> = {}) => ({ id, roomId: 'room', name: id, agentId: 'kai', mode: 'worktree', status: 'ready', prState: 'merged', ...o }) as Workspace

/**
 * The Lead's tools over `list`, with `running` workspaces mid-turn, `unsaved` ones git reports on, `failing` ones whose
 * archive throws, and `refreshed` ones GitHub reports a new PR state for (an Error when GitHub can't be reached).
 */
function leadTools(list: Workspace[], o: { running?: string[]; unsaved?: Record<string, 'dirty' | 'unknown'>; failing?: Record<string, string>; refreshed?: Record<string, PrState | Error> } = {}) {
  const archiveWorkspace = vi.fn(async (id: string) => {
    if (o.failing?.[id]) throw new Error(o.failing[id])
    const w = list.find((x) => x.id === id)!
    w.status = 'archived'
  })
  const refreshPr = vi.fn(async (id: string) => {
    const w = list.find((x) => x.id === id)!
    const r = o.refreshed?.[id]
    if (r instanceof Error) throw r
    if (r) w.prState = r
    return w
  })
  const handedOff = vi.fn()
  const deps: KernelToolDeps = {
    roomId: 'room', lead: { id: 'rowan', lead: true } as AgentDef, agents: async () => [], workspaces: () => list,
    createWorkspace: async () => list[0], messageWorkspace: async () => {}, askUser: async () => null, hireAgent: async () => '',
    archiveWorkspace, refreshPr, isRunning: (id) => o.running?.includes(id) ?? false, unsaved: async (id) => o.unsaved?.[id] ?? false, handedOff
  }
  const tool = kernelTools(deps).find((t) => t.name === 'archive_workspace')!
  const archive = async (ids: string[]) => ((await tool.handler({ workspace_ids: ids } as never, {})).content[0] as { text: string }).text
  return { archive, archiveWorkspace, refreshPr, handedOff }
}

describe('archive_workspace (KERNEL-93)', () => {
  it('archives a finished workspace', async () => {
    const t = leadTools([ws('symlink-node-modules')])
    expect(await t.archive(['symlink-node-modules'])).toBe('Archived symlink-node-modules.')
    expect(t.archiveWorkspace).toHaveBeenCalledWith('symlink-node-modules')
    expect(t.handedOff).not.toHaveBeenCalled()
  })

  it('archives a workspace that never opened a PR, and one whose PR was closed', async () => {
    const t = leadTools([ws('spike', { prState: 'none' }), ws('dropped', { prState: 'closed' })])
    expect(await t.archive(['spike', 'dropped'])).toBe('Archived spike.\nArchived dropped.')
  })

  it('skips an id that is not an open workspace in this room', async () => {
    const t = leadTools([ws('done', { status: 'archived' })])
    expect(await t.archive(['done', 'nope'])).toBe('Skipped done: not an open workspace in this room.\nSkipped nope: not an open workspace in this room.')
    expect(t.archiveWorkspace).not.toHaveBeenCalled()
  })

  it("skips the Lead's own workspace", async () => {
    const t = leadTools([ws('lead', { agentId: 'rowan', mode: 'current', prState: 'none' })])
    expect(await t.archive(['lead'])).toBe('Skipped lead: it is your own workspace.')
    expect(t.archiveWorkspace).not.toHaveBeenCalled()
  })

  it('archives a worktree workspace handed to the Lead when its agent retired', async () => {
    const t = leadTools([ws('inherited', { agentId: 'rowan' })])
    expect(await t.archive(['inherited'])).toBe('Archived inherited.')
  })

  it('skips a workspace with uncommitted changes, or whose git status could not be read', async () => {
    const t = leadTools([ws('dirty'), ws('unreadable')], { unsaved: { dirty: 'dirty', unreadable: 'unknown' } })
    expect(await t.archive(['dirty', 'unreadable'])).toBe('Skipped dirty: it has uncommitted changes.\nSkipped unreadable: its git status could not be read.')
    expect(t.archiveWorkspace).not.toHaveBeenCalled()
  })

  it("names a failed archive by the error's first sentence", async () => {
    const t = leadTools([ws('broken'), ws('terse')], { failing: { broken: 'git worktree remove failed. fatal: some detail\nmore output', terse: 'locked' } })
    expect(await t.archive(['broken', 'terse'])).toBe('Skipped broken: git worktree remove failed.\nSkipped terse: locked.')
  })

  it('skips a workspace whose agent is mid-turn', async () => {
    const t = leadTools([ws('busy')], { running: ['busy'] })
    expect(await t.archive(['busy'])).toBe('Skipped busy: its agent is still working.')
    expect(t.archiveWorkspace).not.toHaveBeenCalled()
  })

  it('skips a workspace whose PR is open and not merged', async () => {
    const states = ['creating', 'draft', 'open', 'checks', 'cifail', 'changes', 'conflict', 'resolving', 'ready', 'merging'] as const
    const t = leadTools(states.map((s, i) => ws(s, { prState: s, prNumber: i + 1 })))
    const lines = (await t.archive([...states])).split('\n')
    expect(lines).toEqual(states.map((s, i) => `Skipped ${s}: its PR #${i + 1} is open and not merged.`))
    expect(t.archiveWorkspace).not.toHaveBeenCalled()
  })

  it('archives a workspace whose saved PR state is stale once GitHub reports it merged (KERNEL-109)', async () => {
    const t = leadTools([ws('stale', { prState: 'cifail', prNumber: 7 })], { refreshed: { stale: 'merged' } })
    expect(await t.archive(['stale'])).toBe('Archived stale.')
    expect(t.refreshPr).toHaveBeenCalledWith('stale')
  })

  it('skips a workspace GitHub still reports open', async () => {
    const t = leadTools([ws('live', { prState: 'cifail', prNumber: 7 })], { refreshed: { live: 'open' } })
    expect(await t.archive(['live'])).toBe('Skipped live: its PR #7 is open and not merged.')
    expect(t.archiveWorkspace).not.toHaveBeenCalled()
  })

  it('falls back to the saved PR state when GitHub cannot be reached', async () => {
    const t = leadTools([ws('offline', { prState: 'ready', prNumber: 9 })], { refreshed: { offline: new Error('gh failed') } })
    expect(await t.archive(['offline'])).toBe('Skipped offline: its PR #9 is open and not merged.')
    expect(t.archiveWorkspace).not.toHaveBeenCalled()
  })

  it("does not refresh the Lead's own workspace, a running one or a closed PR", async () => {
    const t = leadTools([ws('lead', { agentId: 'rowan', mode: 'current', prState: 'open' }), ws('busy', { prState: 'open' }), ws('merged')], { running: ['busy'] })
    expect(await t.archive(['lead', 'busy', 'merged'])).toBe('Skipped lead: it is your own workspace.\nSkipped busy: its agent is still working.\nArchived merged.')
    expect(t.refreshPr).not.toHaveBeenCalled()
  })

  it('handles a mixed list one id at a time, and a failed archive does not stop the rest', async () => {
    const t = leadTools([
      ws('first'), ws('lead', { agentId: 'rowan', mode: 'current' }), ws('broken'), ws('open-pr', { prState: 'open' }), ws('busy'), ws('dirty'), ws('last', { prState: 'none' })
    ], { running: ['busy'], unsaved: { dirty: 'dirty' }, failing: { broken: 'The folder is locked.' } })
    expect(await t.archive(['first', 'lead', 'missing', 'broken', 'open-pr', 'busy', 'dirty', 'last', 'first'])).toBe([
      'Archived first.',
      'Skipped lead: it is your own workspace.',
      'Skipped missing: not an open workspace in this room.',
      'Skipped broken: The folder is locked.',
      'Skipped open-pr: its PR is open and not merged.',
      'Skipped busy: its agent is still working.',
      'Skipped dirty: it has uncommitted changes.',
      'Archived last.',
      'Skipped first: not an open workspace in this room.'
    ].join('\n'))
    expect(t.archiveWorkspace.mock.calls.map(([id]) => id)).toEqual(['first', 'broken', 'last'])
  })
})

describe('archive_workspace in the Kernel (KERNEL-93)', () => {
  it('archives through the sidebar path on a real repo, and skips the Lead, a running agent and uncommitted work', async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop())
    k.sessions.send = async () => ({ queued: false })
    const room = await k.addRoom(repo)
    const done = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Invoice table' })
    const busy = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Still going' })
    const dirty = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Half done' })
    await writeFile(join(dirty.path, 'draft.ts'), 'export {}\n')
    const busyChat = k.chatTabs(busy.id)[0].id
    k.sessions.isRunning = (chatId) => chatId === busyChat
    const lead = await k.leadChat(room.id)
    const agents = await k.agents(room.id)
    k['leadTools'](room.id, agents.find((a) => a.lead)!, lead)

    const tool = kernelTools(wired!).find((t) => t.name === 'archive_workspace')!
    const result = await tool.handler({ workspace_ids: [lead.workspaceId, busy.id, dirty.id, done.id] } as never, {})
    expect((result.content[0] as { text: string }).text).toBe([
      'Skipped lead: it is your own workspace.',
      `Skipped ${busy.name}: its agent is still working.`,
      `Skipped ${dirty.name}: it has uncommitted changes.`,
      `Archived ${done.name}.`
    ].join('\n'))

    expect(k.store.workspace(done.id)?.status).toBe('archived')
    await expect(stat(done.path)).rejects.toThrow()
    // Settings keep branches on archive by default, so the branch stays for Restore.
    expect(await git(repo, 'branch', '--list', done.branch)).toContain(done.branch)
    expect(k.store.workspace(busy.id)?.status).not.toBe('archived')
    expect(await readFile(join(dirty.path, 'draft.ts'), 'utf8')).toBe('export {}\n')
    expect(k.store.workspace(lead.workspaceId)?.status).not.toBe('archived')
    expect(k.store.activity(room.id).filter((a) => a.kind === 'workspace.archived').map((a) => a.workspaceId)).toEqual([done.id])
  })

  it('archives a workspace whose folder was deleted and whose saved PR state is stale (KERNEL-109)', async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop())
    k.sessions.send = async () => ({ queued: false })
    const room = await k.addRoom(repo)
    const made = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Invoice table' })
    // The PR merged on GitHub while Kernel still had it failing checks, and the folder was deleted by hand.
    const gone = k.store.saveWorkspace({ ...k.store.workspace(made.id)!, prState: 'cifail', prNumber: 12 })
    await rm(gone.path, { recursive: true, force: true })
    // git's own record of the worktree is gone too, as after a gc, so `worktree remove` would exit 128.
    await git(repo, 'worktree', 'prune')
    const asked: [string, string, { conflicts?: boolean } | undefined][] = []
    k.github = {
      ...k.github,
      info: async (cwd, ref, workspaceId, o) => {
        asked.push([cwd, ref, o])
        return { workspaceId, number: 12, url: 'https://github.com/o/r/pull/12', title: 'feat: table', state: 'merged', baseRef: 'main', checks: [], comments: [], conflicts: [] }
      }
    }
    const lead = await k.leadChat(room.id)
    const agents = await k.agents(room.id)
    k['leadTools'](room.id, agents.find((a) => a.lead)!, lead)

    expect(await wired!.unsaved(gone.id)).toBe(false)
    const tool = kernelTools(wired!).find((t) => t.name === 'archive_workspace')!
    const result = await tool.handler({ workspace_ids: [gone.id] } as never, {})
    expect((result.content[0] as { text: string }).text).toBe(`Archived ${gone.name}.`)
    // gh ran in the room, asked for the PR by number, and left conflicts alone: the room's HEAD is main, not the PR.
    expect(asked).toEqual([[room.path, '12', { conflicts: false }]])
    expect(k.store.workspace(gone.id)).toMatchObject({ status: 'archived', prState: 'merged' })
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain(basename(gone.path))
  })
})
