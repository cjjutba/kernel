import { describe, expect, it } from 'vitest'
import { fixtures } from '../fixtures'
import { fixtureHandlers } from '../src/main/fixtures'

const entries = Object.entries(fixtures)

describe('fixtures', () => {
  it.each(entries)('%s points only at things that exist', (_name, f) => {
    const projects = new Set(f.projects.map((r) => r.id))
    const workspaces = new Set(f.workspaces.map((w) => w.id))
    const chats = new Set(f.chats.map((c) => c.id))
    const agentIn = (projectId: string, agentId: string) => (f.agents[projectId] ?? []).some((a) => a.id === agentId)

    for (const w of f.workspaces) {
      expect(projects.has(w.projectId), `workspace ${w.id} project`).toBe(true)
      expect(agentIn(w.projectId, w.agentId), `workspace ${w.id} agent`).toBe(true)
    }
    for (const c of f.chats) expect(workspaces.has(c.workspaceId), `chat ${c.id} workspace`).toBe(true)
    for (const id of Object.keys(f.items)) expect(chats.has(id), `items for chat ${id}`).toBe(true)
    // A diff is keyed by its workspace, or by `<workspace>:<path>` for one file's own diff.
    for (const id of [...Object.keys(f.changes), ...Object.keys(f.diffs).map((k) => k.split(':')[0]), ...Object.keys(f.changesAgainst ?? {}), ...Object.keys(f.fileErrors ?? {})]) expect(workspaces.has(id), `changes for ${id}`).toBe(true)
    for (const a of f.approvals) {
      if (a.projectId) expect(projects.has(a.projectId), `approval ${a.id} project`).toBe(true)
      if (a.workspaceId) expect(workspaces.has(a.workspaceId), `approval ${a.id} workspace`).toBe(true)
      if (a.projectId && a.agentId) expect(agentIn(a.projectId, a.agentId), `approval ${a.id} agent`).toBe(true)
    }
    for (const [projectId, byAgent] of Object.entries(f.status)) for (const agentId of Object.keys(byAgent)) expect(agentIn(projectId, agentId), `status ${agentId}`).toBe(true)
    for (const e of f.push) {
      if ('workspaceId' in e) expect(workspaces.has(e.workspaceId), `push ${e.type} workspace`).toBe(true)
      if ('chatId' in e && e.chatId) expect(chats.has(e.chatId), `push ${e.type} chat`).toBe(true)
    }
    if (f.ui.route && 'projectId' in f.ui.route && f.ui.route.projectId) expect(projects.has(f.ui.route.projectId)).toBe(true)
    if (f.ui.route?.name === 'workspace') expect(workspaces.has(f.ui.route.workspaceId)).toBe(true)
  })
})

describe('fixture handlers', () => {
  const f = fixtures.Workspace
  const h = fixtureHandlers(f)

  it('serve the fixture', async () => {
    expect(await h['projects.list']()).toEqual(f.projects)
    const [chat] = await h['chats.list']({ workspaceId: 'ws-invoice-table' })
    expect((await h['chats.items']({ chatId: chat.id })).length).toBeGreaterThan(0)
    expect(await h['workspaces.changes']({ workspaceId: 'ws-invoice-table' })).toHaveLength(4)
    const activity = await h['activity.recent']({ projectId: 'project-a' })
    expect(activity.map((e) => e.ts)).toEqual([...activity.map((e) => e.ts)].sort((a, b) => b - a))
  })

  it('answer writes without changing later reads', async () => {
    const before = structuredClone(f)
    await h['projects.setPaused']({ projectId: 'project-a', paused: true })
    await h['chats.send']({ chatId: 'chat-invoice-table', parts: [{ type: 'text', text: 'hi' }] })
    await h['chats.configure']({ chatId: 'chat-invoice-table', plan: true })
    await h['chats.create']({ workspaceId: 'ws-invoice-table', kind: 'terminal' })
    const decided = await h['approvals.decide']({ id: 'ap-migrate', decision: { behavior: 'allow' } })
    expect(decided.status).toBe('allowed')
    await h['workspaces.archive']({ workspaceId: 'ws-invoice-table' })
    expect(f).toEqual(before)
    expect((await h['approvals.list']({})).find((a) => a.id === 'ap-migrate')?.status).toBe('pending')
  })

  it('refuse to create a workspace', async () => {
    await expect(h['workspaces.create']({ projectId: 'project-a', prompt: 'x' })).rejects.toThrow(/Fixture mode/)
  })

  it("list a fixture's Lead chats, by project when asked (KERNEL-337)", async () => {
    const threads = [{ id: 't1', projectId: 'project-a', title: 'Release plan', createdAt: 1 }, { id: 't2', projectId: 'project-b', title: 'Icons', createdAt: 2 }]
    const withThreads = fixtureHandlers({ ...f, threads })
    expect(await withThreads['threads.list']({})).toEqual(threads)
    expect(await withThreads['threads.list']({ projectId: 'project-b' })).toEqual([threads[1]])
    expect(await h['threads.list']({})).toEqual(f.threads)
  })

  it("opens a project's newest chat with Kernel, or none, and previews what archiving a chat stops (KERNEL-405)", async () => {
    expect((await h['lead.open']({ projectId: f.projects[0].id }))?.id).toBe('ws-lead')
    const none = fixtureHandlers({ ...f, workspaces: f.workspaces.filter((w) => !w.lead) })
    expect(await none['lead.open']({ projectId: f.projects[0].id })).toBeNull()
    expect(await h['threads.archivePreview']({ threadId: 't-lead' })).toEqual({ threadId: 't-lead', title: 'Lead', workspaces: [{ id: 'ws-lead', name: 'lead', own: true, running: false, dirty: 0, unpushed: 0 }] })
  })
})
