import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { AgentDef, PrState, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { kernelTools, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { Kernel } from '../src/main/kernel'
import { git } from '../src/main/services/exec'
import { setUp, tempRepo, trustRoom, freePort } from './helpers'

// A chat with Kernel's held first message goes out through the real send once its setup passes (KERNEL-405).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

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
    roomId: 'room', lead: { id: 'kernel', lead: true } as AgentDef, agents: async () => [], workspaces: () => list,
    createWorkspace: async () => list[0], messageWorkspace: async () => ({ ok: true, sent: true, note: 'Sent.' }), askUser: async () => null, hireAgent: async () => '',
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
    const t = leadTools([ws('lead', { agentId: 'kernel', mode: 'current', lead: true, prState: 'none' })])
    expect(await t.archive(['lead'])).toBe('Skipped lead: it is your own workspace.')
    expect(t.archiveWorkspace).not.toHaveBeenCalled()
  })

  it('archives a worktree workspace handed to the Lead when its agent retired', async () => {
    const t = leadTools([ws('inherited', { agentId: 'kernel' })])
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

  it('falls back to the saved PR state when the refresh throws', async () => {
    const t = leadTools([ws('offline', { prState: 'ready', prNumber: 9 })], { refreshed: { offline: new Error('gh failed') } })
    expect(await t.archive(['offline'])).toBe('Skipped offline: its PR #9 is open and not merged.')
    expect(t.archiveWorkspace).not.toHaveBeenCalled()
  })

  it("does not refresh the Lead's own workspace, a running one or a closed PR", async () => {
    const t = leadTools([ws('lead', { agentId: 'kernel', mode: 'current', lead: true, prState: 'open' }), ws('busy', { prState: 'open' }), ws('merged')], { running: ['busy'] })
    expect(await t.archive(['lead', 'busy', 'merged'])).toBe('Skipped lead: it is your own workspace.\nSkipped busy: its agent is still working.\nArchived merged.')
    expect(t.refreshPr).not.toHaveBeenCalled()
  })

  it('handles a mixed list one id at a time, and a failed archive does not stop the rest', async () => {
    const t = leadTools([
      ws('first'), ws('lead', { agentId: 'kernel', mode: 'current', lead: true }), ws('broken'), ws('open-pr', { prState: 'open' }), ws('busy'), ws('dirty'), ws('last', { prState: 'none' })
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

/** A started Kernel over a temp repo with Kernel as Lead and Kai, plus any `files`. Sessions never start a real turn. */
async function kernelRoom(files: Record<string, string> = {}) {
  const repo = await tempRepo({
    'README.md': '# client\n',
    '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
    '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
    ...files
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop())
  k.sessions.send = async () => ({ queued: false })
  const room = await k.addRoom(repo)
  return { k, repo, room }
}

describe('archive_workspace in the Kernel (KERNEL-93)', () => {
  it('archives through the sidebar path on a real repo, and skips the Lead, a running agent and uncommitted work', async () => {
    const { k, repo, room } = await kernelRoom()
    const done = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Invoice table' })
    const busy = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Still going' })
    const dirty = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Half done' })
    await writeFile(join(dirty.path, 'draft.ts'), 'export {}\n')
    const busyChat = k.chatTabs(busy.id)[0].id
    k.sessions.isRunning = (chatId) => chatId === busyChat
    const lead = await k.leadChat(room.id)
    const agents = await k.agents(room.id)
    k.lead['leadTools'](room.id, agents.find((a) => a.lead)!, lead)

    const tool = kernelTools(wired!).find((t) => t.name === 'archive_workspace')!
    const result = await tool.handler({ workspace_ids: [lead.workspaceId, busy.id, dirty.id, done.id] } as never, {})
    expect((result.content[0] as { text: string }).text).toBe([
      `Skipped ${k.store.workspace(lead.workspaceId)!.name}: it is your own workspace.`,
      `Skipped ${busy.name}: its agent is still working.`,
      `Skipped ${dirty.name}: it has uncommitted changes.`,
      `Archived ${done.name}.`
    ].join('\n'))

    expect(k.store.workspace(done.id)?.status).toBe('archived')
    await k.archive.cleanedUp(done.id)
    await expect(stat(done.path)).rejects.toThrow()
    // Settings keep branches on archive by default, so the branch stays for Restore.
    expect(await git(repo, 'branch', '--list', done.branch)).toContain(done.branch)
    expect(k.store.workspace(busy.id)?.status).not.toBe('archived')
    expect(await readFile(join(dirty.path, 'draft.ts'), 'utf8')).toBe('export {}\n')
    expect(k.store.workspace(lead.workspaceId)?.status).not.toBe('archived')
    expect(k.store.activity(room.id).filter((a) => a.kind === 'workspace.archived').map((a) => a.workspaceId)).toEqual([done.id])
  })

  it('archives a workspace whose folder was deleted and whose saved PR state is stale (KERNEL-109)', async () => {
    const { k, repo, room } = await kernelRoom()
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
    k.lead['leadTools'](room.id, agents.find((a) => a.lead)!, lead)

    expect(await wired!.unsaved(gone.id)).toBe(false)
    const tool = kernelTools(wired!).find((t) => t.name === 'archive_workspace')!
    const result = await tool.handler({ workspace_ids: [gone.id] } as never, {})
    expect((result.content[0] as { text: string }).text).toBe(`Archived ${gone.name}.`)
    // gh ran in the room, asked for the PR by number, and left conflicts alone: the room's HEAD is main, not the PR.
    expect(asked).toEqual([[room.path, '12', { conflicts: false }]])
    expect(k.store.workspace(gone.id)).toMatchObject({ status: 'archived', prState: 'merged' })
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain(basename(gone.path))
  })

  it('reports unknown, not gone, for a worktree whose folder it cannot read', async () => {
    const { k, room } = await kernelRoom()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Invoice table' })
    const lead = await k.leadChat(room.id)
    const agents = await k.agents(room.id)
    k.lead['leadTools'](room.id, agents.find((a) => a.lead)!, lead)
    await chmod(dirname(ws.path), 0o000)
    onTestFinished(() => chmod(dirname(ws.path), 0o755))
    expect(await wired!.unsaved(ws.id)).toBe('unknown')
  })

  it("skips the repo's archive script for a workspace whose folder is gone, and still runs it for one that is there", async () => {
    const { k, room } = await kernelRoom({ '.kernel/settings.toml': '[scripts]\narchive = "echo tearing down"\n' })
    const gone = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Invoice table' })
    const there = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Export button' })
    await rm(gone.path, { recursive: true, force: true })
    const ran: string[] = []
    const on = (e: PushEvent) => { if ((e.type === 'script.output' || e.type === 'script.exit') && e.kind === 'archive') ran.push(e.workspaceId) }
    bus.on('push', on)
    onTestFinished(() => { bus.off('push', on) })

    await k.archiveWorkspace(gone.id)
    await k.archiveWorkspace(there.id)
    await k.archive.cleanedUp(gone.id)
    await k.archive.cleanedUp(there.id)
    expect(k.store.workspace(gone.id)?.status).toBe('archived')
    expect(k.store.workspace(there.id)?.status).toBe('archived')
    expect(ran).not.toContain(gone.id)
    expect(ran).toContain(there.id)
  })

  it('looks a PR up by branch from the room when the folder is gone and there is no PR number yet', async () => {
    const { k, room } = await kernelRoom()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Invoice table' })
    await rm(ws.path, { recursive: true, force: true })
    const asked: [string, string, { conflicts?: boolean } | undefined][] = []
    k.github = {
      ...k.github,
      info: async (cwd, ref, workspaceId, o) => {
        asked.push([cwd, ref, o])
        return { workspaceId, number: 31, url: 'https://github.com/o/r/pull/31', title: 'feat: table', state: 'open', baseRef: 'main', checks: [], comments: [], conflicts: [] }
      }
    }

    const next = await k.refreshPr(ws.id, { settle: true })
    expect(asked).toEqual([[room.path, ws.branch, { conflicts: false }]])
    expect(next).toMatchObject({ prState: 'open', prNumber: 31 })
  })
})

describe('archiving clears the inbox, on every path (KERNEL-155)', () => {
  /** A pending approval with a live waiter and a "ready to merge" row, both for `workspaceId`. */
  function seed(k: Kernel, workspaceId: string, roomId: string) {
    const { approval, decision } = k.approvals.request({ kind: 'tool', source: 'sdk', roomId, workspaceId, agentId: 'kai', toolName: 'Bash', title: 'Run pnpm build' })
    bus.push({ type: 'pr', workspaceId, state: 'ready' })
    const rows = () => k.store.notifications().filter((n) => n.workspaceId === workspaceId)
    expect(rows().map((n) => n.kind).sort()).toEqual(['approval', 'merge'])
    const removed: string[] = []
    const on = (e: PushEvent) => { if (e.type === 'notification.removed') removed.push(...e.ids) }
    bus.on('push', on)
    onTestFinished(() => { bus.off('push', on) })
    const ids = rows().map((n) => n.id).sort()
    return {
      decision,
      check: async () => {
        expect(await decision).toBeNull()
        expect(k.store.approvals({ workspaceId, pendingOnly: true })).toEqual([])
        expect(k.store.approvals().find((a) => a.id === approval.id)?.status).toBe('expired')
        expect(rows()).toEqual([])
        expect(removed.sort()).toEqual(ids)
        // History still has the workspace.
        expect(k.store.workspace(workspaceId)?.status).toBe('archived')
      }
    }
  }

  it('by hand, from the sidebar or the archive dialog', async () => {
    const { k, room } = await kernelRoom()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Invoice table' })
    const s = seed(k, ws.id, room.id)
    await k.handlers()['workspaces.archive']({ workspaceId: ws.id })
    await s.check()
  })

  it("through the Lead's archive_workspace", async () => {
    const { k, room } = await kernelRoom()
    const ws = await k.createWorkspace(room.id, { prompt: 'Go', agentId: 'kai', title: 'Invoice table' })
    k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prState: 'merged', prNumber: 3 })
    const lead = await k.leadChat(room.id)
    const agents = await k.agents(room.id)
    k.lead['leadTools'](room.id, agents.find((a) => a.lead)!, lead)
    // The PR merged on GitHub, but the "ready to merge" row never heard: the stale row this issue found.
    const s = seed(k, ws.id, room.id)
    const tool = kernelTools(wired!).find((t) => t.name === 'archive_workspace')!
    expect(((await tool.handler({ workspace_ids: [ws.id] } as never, {})).content[0] as { text: string }).text).toBe(`Archived ${ws.name}.`)
    await s.check()
  })

  it('after the work a review looked at merged', async () => {
    const { k, room } = await kernelRoom({ '.claude/agents/theo.md': '---\nname: theo\ndescription: Reviewer. Reviews PRs.\nrole: Reviewer\n---\nYou are Theo.' })
    let state: 'ready' | 'merged' = 'ready'
    k.github = { ...k.github, info: async (_cwd, _ref, workspaceId) => ({ workspaceId, number: 42, url: 'https://github.com/o/r/pull/42', title: 'feat: table', state, baseRef: 'main', checks: [], comments: [], conflicts: [] }) }
    const lead = await k.leadChat(room.id)
    const author = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table', leadChatId: lead.id })
    const review = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'theo', title: 'Review PR #42', leadChatId: lead.id, reviewOf: author.id })
    await k.refreshPr(author.id)
    const s = seed(k, review.id, room.id)
    const archived = new Promise<void>((resolve) => {
      const done = (e: PushEvent) => { if (e.type === 'notification.removed') { bus.off('push', done); resolve() } }
      bus.on('push', done)
    })
    state = 'merged'
    await k.refreshPr(author.id)
    await archived
    await s.check()
  })
})

describe('archiving a chat with Kernel (KERNEL-405)', () => {
  /** A room whose archive script logs each workspace it runs in, with Kernel's chat and a teammate it handed off. */
  async function chatWithWork(workspace: Record<string, unknown> = {}) {
    const log = join(await mkdtemp(join(tmpdir(), 'kernel-log-')), 'archived.txt')
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nYou are Kai.',
      '.kernel/settings.toml': `[scripts]\narchive = "echo $KERNEL_WORKSPACE_NAME >> ${log}"\n`
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', ...workspace } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop({ budgetMs: 0 }))
    k.sessions.send = async () => ({ queued: false })
    const room = await k.addRoom(repo)
    await trustRoom(k, room.id)
    // No first message, so nothing runs in it once setup passes.
    const chat = await k.lead.newLeadChat(room.id, { prompt: '' })
    const own = await setUp(k, chat.id)
    const kai = await k.workspaces.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Build', leadChatId: chat.id })
    const loose = await k.workspaces.createWorkspace(room.id, { prompt: 'Other', agentId: 'kai', title: 'Loose' })
    const lines = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    return { k, repo, room, chat, own, kai, loose, lines, dataDir }
  }

  it('archives the workspaces the chat handed off, then its own, each with the archive script, and the chat goes to History', async () => {
    const { k, chat, own, kai, loose, lines } = await chatWithWork()
    const pushed: string[] = []
    const on = (e: PushEvent) => { if (e.type === 'thread') pushed.push(`${e.thread.id}:${e.thread.closedAt ? 'closed' : 'open'}`) }
    bus.on('push', on)
    onTestFinished(() => { bus.off('push', on) })
    expect(await k.handlers()['threads.archive']({ threadId: chat.threadId! })).toEqual({ ok: true })
    expect(k.store.workspace(kai.id)?.status).toBe('archived')
    expect(k.store.workspace(own.id)?.status).toBe('archived')
    expect(k.store.workspace(loose.id)?.status).toBe('ready')
    await k.archive.cleanedUp(kai.id)
    await k.archive.cleanedUp(own.id)
    // Each cleanup runs its archive script in the background, so the two may finish in either order (KERNEL-702).
    expect((await lines()).sort()).toEqual([kai.name, own.name].sort())
    expect(k.store.thread(chat.threadId!)!.closedAt).toBeGreaterThan(0)
    expect(pushed).toEqual([`${chat.threadId}:closed`])
    expect(await k.handlers()['lead.open']({ roomId: own.roomId })).toBeNull()
  })

  it('leaves the workspaces it handed off open when Archive a chat\'s workspaces is off', async () => {
    const { k, chat, own, kai } = await chatWithWork({ archiveChatWorkspaces: false })
    expect((await k.handlers()['threads.archivePreview']({ threadId: chat.threadId! })).workspaces.map((w) => w.id)).toEqual([own.id])
    await k.lead.archiveLeadChat(chat.threadId!)
    expect(k.store.workspace(own.id)?.status).toBe('archived')
    expect(k.store.workspace(kai.id)).toMatchObject({ status: 'ready', threadId: chat.threadId })
  })

  it("deletes Kernel's branch when it has no commits of its own, whatever Delete branch on archive says, and keeps one with commits", async () => {
    const { k, repo, room, chat, own } = await chatWithWork()
    await k.lead.archiveLeadChat(chat.threadId!)
    await k.archive.cleanedUp(own.id)
    expect(await git(repo, 'branch', '--list', own.branch)).toBe('')
    const other = await k.lead.newLeadChat(room.id, { prompt: 'Write the plan down' })
    const ws = await setUp(k, other.id)
    await writeFile(join(ws.path, 'plan.md'), '# Plan\n')
    await git(ws.path, 'add', '-A')
    await git(ws.path, '-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'plan')
    await k.lead.archiveLeadChat(other.threadId!)
    await k.archive.cleanedUp(ws.id)
    expect((await git(repo, 'branch', '--list', ws.branch)).trim()).toBe(ws.branch)
  })

  it('says what archiving would stop, per workspace, its own last', async () => {
    const { k, chat, own, kai } = await chatWithWork()
    expect((await k.lead.archivePreview(chat.threadId!)).workspaces).toEqual([
      { id: kai.id, name: kai.name, own: false, running: false, dirty: 0, unpushed: 0 },
      { id: own.id, name: own.name, own: true, running: false, dirty: 0, unpushed: 0 }
    ])
    await writeFile(join(kai.path, 'draft.ts'), 'export {}\n')
    k.store.saveWorkspace({ ...k.store.workspace(kai.id)!, prNumber: 41, prState: 'open' })
    const isRunning = k.sessions.isRunning.bind(k.sessions)
    k.sessions.isRunning = (id) => id === chat.id || isRunning(id)
    const preview = await k.lead.archivePreview(chat.threadId!)
    expect(preview).toMatchObject({ threadId: chat.threadId, title: 'New tab' })
    expect(preview.workspaces).toEqual([
      { id: kai.id, name: kai.name, own: false, running: false, pr: 41, dirty: 1, unpushed: 0 },
      { id: own.id, name: own.name, own: true, running: true, dirty: 0, unpushed: 0 }
    ])
  })

  it("archives a chat in Build here as a teammate's work: it warns about unpushed work, keeps the branch, and a merge doesn't archive it (KERNEL-778)", async () => {
    const { k, repo, chat, own } = await chatWithWork({ archiveChatWorkspaces: false })
    k.lead.setMode(own.id, 'build')
    await writeFile(join(own.path, 'retry.ts'), 'export {}\n')
    await git(own.path, 'add', '-A')
    await git(own.path, '-c', 'user.email=t@t.dev', '-c', 'user.name=Test', 'commit', '-q', '-m', 'retry')
    await writeFile(join(own.path, 'draft.ts'), 'export {}\n')
    k.store.saveWorkspace({ ...k.store.workspace(own.id)!, prNumber: 58, prState: 'merged' })
    await k.autoArchive.archiveMerged(own.id)
    expect(k.store.workspace(own.id)?.status).toBe('ready')
    k.store.saveWorkspace({ ...k.store.workspace(own.id)!, prState: 'open' })
    expect((await k.lead.archivePreview(chat.threadId!)).workspaces).toEqual([{ id: own.id, name: own.name, own: true, running: false, pr: 58, dirty: 1, unpushed: 1 }])
    await k.lead.archiveLeadChat(chat.threadId!)
    await k.archive.cleanedUp(own.id)
    expect((await git(repo, 'branch', '--list', own.branch)).trim()).toBe(own.branch)
  })

  it('restores the chat with its tabs and a new branch when the old one was deleted, and sets it up again', async () => {
    const { k, repo, chat, own } = await chatWithWork()
    await k.lead.archiveLeadChat(chat.threadId!)
    await k.archive.cleanedUp(own.id)
    expect(await git(repo, 'branch', '--list', own.branch)).toBe('')
    const back = await k.restoreWorkspace(own.id)
    expect(back).toMatchObject({ status: 'setup', branch: own.branch, baseRef: 'main' })
    expect(k.store.thread(chat.threadId!)!.closedAt).toBeUndefined()
    expect(k.chatTabs(own.id).map((c) => c.id)).toEqual([chat.id])
    await setUp(k, own.id)
    expect((await git(back.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(own.branch)
    expect((await k.handlers()['lead.open']({ roomId: own.roomId }))?.id).toBe(own.id)
  })

  it('never archives a chat with Kernel when its PR merges, and Delete removes the chat with its workspace', async () => {
    const { k, chat, own, dataDir } = await chatWithWork()
    k.store.saveWorkspace({ ...k.store.workspace(own.id)!, prNumber: 7, prState: 'merged' })
    await k.autoArchive.archiveMerged(own.id)
    expect(k.store.workspace(own.id)?.status).toBe('ready')
    await k.lead.archiveLeadChat(chat.threadId!)
    const r = await k.deleteWorkspaces([own.id], { deleteUnpushed: true })
    expect(r.deleted).toEqual([own.id])
    expect(k.store.thread(chat.threadId!)).toBeUndefined()
    expect(existsSync(join(dataDir, 'setup-env', `${own.id}.env`))).toBe(false)
  })
})
