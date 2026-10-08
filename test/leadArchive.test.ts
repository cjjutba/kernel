import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Workspace } from '@shared/types'
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

const ws = (id: string, o: Partial<Workspace> = {}) => ({ id, roomId: 'room', name: id, agentId: 'kai', status: 'ready', prState: 'merged', ...o }) as Workspace

/** The Lead's tools over `list`, with `running` workspaces mid-turn and `failing` ones whose archive throws. */
function leadTools(list: Workspace[], o: { running?: string[]; failing?: Record<string, string> } = {}) {
  const archiveWorkspace = vi.fn(async (id: string) => {
    if (o.failing?.[id]) throw new Error(o.failing[id])
    const w = list.find((x) => x.id === id)!
    w.status = 'archived'
  })
  const handedOff = vi.fn()
  const deps: KernelToolDeps = {
    roomId: 'room', lead: { id: 'rowan', lead: true } as AgentDef, agents: async () => [], workspaces: () => list,
    createWorkspace: async () => list[0], messageWorkspace: async () => {}, askUser: async () => null, hireAgent: async () => '',
    archiveWorkspace, isRunning: (id) => o.running?.includes(id) ?? false, handedOff
  }
  const tool = kernelTools(deps).find((t) => t.name === 'archive_workspace')!
  const archive = async (ids: string[]) => ((await tool.handler({ workspace_ids: ids } as never, {})).content[0] as { text: string }).text
  return { archive, archiveWorkspace, handedOff }
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
    const t = leadTools([ws('lead', { agentId: 'rowan', prState: 'none' })])
    expect(await t.archive(['lead'])).toBe('Skipped lead: it is your own workspace.')
    expect(t.archiveWorkspace).not.toHaveBeenCalled()
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

  it('handles a mixed list one id at a time, and a failed archive does not stop the rest', async () => {
    const t = leadTools([
      ws('first'), ws('lead', { agentId: 'rowan' }), ws('broken'), ws('open-pr', { prState: 'open' }), ws('busy'), ws('last', { prState: 'none' })
    ], { running: ['busy'], failing: { broken: 'The folder is locked.' } })
    expect(await t.archive(['first', 'lead', 'missing', 'broken', 'open-pr', 'busy', 'last', 'first'])).toBe([
      'Archived first.',
      'Skipped lead: it is your own workspace.',
      'Skipped missing: not an open workspace in this room.',
      'Skipped broken: The folder is locked.',
      'Skipped open-pr: its PR is open and not merged.',
      'Skipped busy: its agent is still working.',
      'Archived last.',
      'Skipped first: not an open workspace in this room.'
    ].join('\n'))
    expect(t.archiveWorkspace.mock.calls.map(([id]) => id)).toEqual(['first', 'broken', 'last'])
  })
})

describe('archive_workspace in the Kernel (KERNEL-93)', () => {
  it('archives through the sidebar path on a real repo, and skips the Lead and a running agent', async () => {
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
    const busyChat = k.chatTabs(busy.id)[0].id
    k.sessions.isRunning = (chatId) => chatId === busyChat
    const lead = await k.leadChat(room.id)
    const agents = await k.agents(room.id)
    k['leadTools'](room.id, agents.find((a) => a.lead)!, lead)

    const tool = kernelTools(wired!).find((t) => t.name === 'archive_workspace')!
    const result = await tool.handler({ workspace_ids: [lead.workspaceId, busy.id, done.id] } as never, {})
    expect((result.content[0] as { text: string }).text).toBe([
      'Skipped lead: it is your own workspace.',
      `Skipped ${busy.name}: its agent is still working.`,
      `Archived ${done.name}.`
    ].join('\n'))

    expect(k.store.workspace(done.id)?.status).toBe('archived')
    await expect(stat(done.path)).rejects.toThrow()
    // Settings keep branches on archive by default, so the branch stays for Restore.
    expect(await git(repo, 'branch', '--list', done.branch)).toContain(done.branch)
    expect(k.store.workspace(busy.id)?.status).not.toBe('archived')
    expect(k.store.workspace(lead.workspaceId)?.status).not.toBe('archived')
    expect(k.store.activity(room.id).filter((a) => a.kind === 'workspace.archived').map((a) => a.workspaceId)).toEqual([done.id])
  })
})
