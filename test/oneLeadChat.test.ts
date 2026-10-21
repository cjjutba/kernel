import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, ChatItem, PrInfo, Workspace } from '@shared/types'
import { ownsFolder } from '@shared/leadWorkspace'
import { buildOpen, kernelTools, LEAD_INSTRUCTIONS, PLAN_MODE_OFF, uncommittedNote, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { toolPolicy } from '../src/main/services/agentTools'
import { forProvider, LEAD_RULE } from '../src/main/services/handoff'
import { agentPrompt } from '../src/main/services/sessions'
import { loadRepoSettings, saveRepoSettings } from '../src/main/services/settings'
import { sharesFile } from '../src/main/services/providers/codex/runner'
import { Kernel } from '../src/main/kernel'
import { sessionDeps } from '../src/main/features/sessionDeps'
import { git } from '../src/main/services/exec'
import { oldSharedChat, setUp, tempRepo, freePort } from './helpers'

// One chat with Kernel, no modes (one-lead-chat, replacing KERNEL-770's Hand off and Build here): the Lead answers, does the work in its
// own folder, hands it to teammates, or both, and a chat's own PR takes a teammate's path.
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.'
}

/** A started Kernel on a temp repo, with `app` as the app's settings. Sends are recorded, not run. */
async function setup(o: { app?: Record<string, unknown>; files?: Record<string, string> } = {}) {
  const repo = await tempRepo({ ...REPO, ...o.files })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...o.app, pr: { autoReview: false, ...(o.app?.pr as object | undefined) } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop())
  k.sessions.send = async () => ({ queued: false })
  const project = await k.addProject(repo)
  const chat = async () => {
    const c = await k.lead.newLeadChat(project.id, { prompt: '', baseRef: 'main' })
    await setUp(k, c.id, 'settled')
    return k.store.chat(c.id)!
  }
  return { k, project, repo, chat }
}

describe('what the old modes left behind is ignored (one-lead-chat)', () => {
  it("drops the app's team.leadMode and reads nothing from a project's [agents] lead_mode, with no error", async () => {
    const { k, repo } = await setup({ app: { team: { leadMode: 'build', defaultTemplate: 'pair' } } })
    expect(k.settings.team).toEqual({ defaultTemplate: 'pair' })
    await mkdir(join(repo, '.kernel'), { recursive: true })
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[agents]\nlead_mode = "build"\nopen_workspaces = 3\n')
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[agents]\nlead_mode = "solo"\n')
    expect((await loadRepoSettings(repo)).agents).toEqual({ openWorkspaces: 3 })
    await saveRepoSettings(repo, { agents: { openWorkspaces: 4 } })
    expect((await loadRepoSettings(repo)).agents).toEqual({ openWorkspaces: 4 })
  })

  it('treats a saved workspace that carries a leadMode or a go-ahead as any other chat, and has no way to switch', async () => {
    const { k, project, chat } = await setup()
    const c = await chat()
    const ws = k.store.workspace(c.workspaceId)!
    k.store.saveWorkspace({ ...ws, leadMode: 'handoff', buildGoAhead: { quote: 'fix it', at: 1, branch: ws.branch } } as Workspace)
    expect(ownsFolder(k.store.workspace(ws.id))).toBe(true)
    k.store.saveChat({ ...k.store.chat(c.id)!, plan: false })
    expect(k.lead.buildOpen(c.id)).toBe(true)
    const handlers = k.handlers() as Record<string, unknown>
    expect(handlers).not.toHaveProperty('lead.setMode')
    expect(handlers).not.toHaveProperty('lead.sendAsHandoff')
    expect(project.id).toBe(ws.projectId)
  })

  it('draws an old chat\'s mode divider and suggestion as items it still reads', async () => {
    const { k, chat } = await setup()
    const c = await chat()
    const items: ChatItem[] = [
      { kind: 'leadMode', id: 'd1', ts: 1, mode: 'build' },
      { kind: 'modeSuggestion', id: 's1', ts: 2, mode: 'handoff', why: 'It touches three modules.' }
    ]
    for (const i of items) k.store.saveItem(c.id, i)
    expect(k.store.items(c.id)).toMatchObject(items)
  })
})

describe('a new chat (one-lead-chat)', () => {
  it('gets a folder and branch of its own that it may edit, and never starts on the shared main folder', async () => {
    const { k, project, chat } = await setup()
    const c = await chat()
    const ws = k.store.workspace(c.workspaceId)!
    expect(ws).toMatchObject({ lead: true, mode: 'worktree', threadId: c.threadId })
    expect(ws.shared).toBeFalsy()
    expect(ws.branch).toMatch(/^kernel\//)
    expect(ws.port).toBeGreaterThan(0)
    expect(ownsFolder(ws)).toBe(true)
    // Plan mode is on for a new chat unless Settings says otherwise, and it shuts the gate until the plan is approved.
    expect(k.lead.buildOpen(c.id)).toBe(!c.plan)
    k.store.saveChat({ ...k.store.chat(c.id)!, plan: false })
    expect(k.lead.buildOpen(c.id)).toBe(true)
    expect(existsSync(k.mainFolder.path(project.id))).toBe(false)
  })
})

describe("Kernel's tools in every chat (one-lead-chat)", () => {
  const kernel = { id: 'kernel', name: 'Kernel', role: 'Lead', description: '', lead: true, prompt: '' } as AgentDef
  const christian = { id: 'christian', name: 'Christian', role: 'Frontend', description: '', lead: false, prompt: '' } as AgentDef
  const artkin = { id: 'artkin', name: 'Artkin', role: 'Reviewer', description: '', lead: false, prompt: '' } as AgentDef
  const target: Workspace = { id: 'w-christian', projectId: 'project', name: 'padding', branch: 'feat/padding', baseRef: 'main', path: '/tmp/w-christian', mode: 'worktree', agentId: 'christian', port: 4301, status: 'ready', prState: 'open', createdAt: 1 }
  function tools(o: Partial<KernelToolDeps>) {
    const created: { agentId: string; baseRef?: string; reviewOf?: string }[] = []
    const asked: { detail?: string }[] = []
    const deps = {
      projectId: 'project', lead: kernel, chatId: 'chat', agents: async () => [kernel, christian, artkin], workspaces: () => [target],
      createWorkspace: async (c: { agentId: string; baseRef?: string; reviewOf?: string }) => { created.push(c); return { ...target, id: `new-${created.length}`, agentId: c.agentId, branch: 'feat/x', baseRef: 'origin/main' } },
      messageWorkspace: async () => ({ ok: true, sent: true, note: '' }), askUser: async (a: { detail?: string }) => { asked.push(a); return { behavior: 'allow' } }, hireAgent: async () => '', archiveWorkspace: async () => {},
      isRunning: () => false, unsaved: async () => false, planMode: () => true, planApproved: () => 'Plan approved.', ...o
    } as unknown as KernelToolDeps
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await kernelTools(deps).find((t) => t.name === name)!.handler(args as never, {})
      return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
    }
    return { call, created, asked, names: kernelTools(deps).map((t) => t.name) }
  }

  it('offers create_workspace and link_issue together, and neither suggest_hand_off nor start_build', () => {
    const { names } = tools({})
    expect(names).toEqual(expect.arrayContaining(['create_workspace', 'link_issue', 'request_plan_approval', 'file_issue']))
    expect(names).not.toContain('suggest_hand_off')
    expect(names).not.toContain('start_build')
  })

  it('hands a task to a teammate, from the branch the Lead built on when it says so, and still starts a review', async () => {
    const t = tools({})
    const handed = await t.call('create_workspace', { agent: 'christian', title: 'Padding', brief: 'Fix it', base_ref: 'kernel/refund-rounding' })
    expect(handed.isError).toBe(false)
    expect(t.created).toMatchObject([{ agentId: 'christian', baseRef: 'kernel/refund-rounding' }])
    const review = await t.call('create_workspace', { agent: 'artkin', title: 'Review padding', brief: 'Review it', review_of: 'w-christian' })
    expect(review.isError).toBe(false)
    expect(t.created[1]).toMatchObject({ agentId: 'artkin', reviewOf: 'w-christian' })
  })

  it('a hand-off or plan from a chat with uncommitted changes says teammates start without them, and goes ahead', async () => {
    const t = tools({ ownChanges: async () => 2, handoffBase: async () => ({ remote: 'origin', base: 'origin/main' }) })
    const handed = await t.call('create_workspace', { agent: 'christian', title: 'Padding', brief: 'Fix it' })
    expect(handed.isError).toBe(false)
    expect(handed.text).toContain(uncommittedNote(2, 'origin/main'))
    expect(uncommittedNote(2, 'origin/main')).toBe("This chat's worktree has 2 uncommitted changes. Teammates start from origin/main and won't see them.")
    await t.call('request_plan_approval', { title: 'Padding', plan: 'Fix the padding.', steps: ['Padding · Christian'] })
    expect(t.asked[0].detail).toBe(`Fix the padding.\n\n${uncommittedNote(2, 'origin/main')}`)
    // A clean worktree adds nothing.
    const clean = tools({ ownChanges: async () => 0 })
    expect((await clean.call('create_workspace', { agent: 'christian', title: 'Padding', brief: 'Fix it' })).text).not.toContain('uncommitted')
  })

  it('link_issue links the chat, says whether the branch was renamed, and says why when it cannot (KERNEL-778)', async () => {
    const linked: string[] = []
    const t = tools({ linkIssue: async (issue) => { linked.push(issue); return { id: 'KERNEL-760', title: 'Retry button', branch: 'feat/kernel-760-retry-button' } } })
    const r = await t.call('link_issue', { issue: ' KERNEL-760 ' })
    expect(linked).toEqual(['KERNEL-760'])
    expect(r).toEqual({ text: 'Linked KERNEL-760, "Retry button". The branch is now feat/kernel-760-retry-button. Write "Closes KERNEL-760" in the PR body.', isError: false })
    const pushed = tools({ linkIssue: async () => ({ id: 'KERNEL-760', title: 'Retry button' }) })
    expect((await pushed.call('link_issue', { issue: 'KERNEL-760' })).text).toContain('The branch keeps its name, since it was pushed.')
    const failed = tools({ linkIssue: async () => { throw new Error('That chat no longer exists.') } })
    expect(await failed.call('link_issue', { issue: 'KERNEL-760' })).toEqual({ text: 'Not linked: That chat no longer exists.', isError: true })
    expect((await tools({}).call('link_issue', { issue: 'KERNEL-760' })).isError).toBe(true)
  })

  it('request_plan_approval with plan mode off says to do it or hand it off, in one message for every chat', async () => {
    const t = tools({ planMode: () => false })
    expect(await t.call('request_plan_approval', { title: 'x', plan: 'y', steps: ['z'] })).toEqual({ text: PLAN_MODE_OFF, isError: true })
    expect(PLAN_MODE_OFF).toContain('do it yourself or hand it off')
    expect(LEAD_INSTRUCTIONS).toContain('do the work yourself')
  })

  it("counts files changed in the chat's own worktree, which teammates won't start from", async () => {
    const { k, project, chat } = await setup()
    const c = await chat()
    const lead = (await k.agents(project.id)).find((a) => a.lead) as AgentDef
    const deps = () => k.lead.leadToolDeps(project.id, lead, k.store.chat(c.id)!)
    expect(await deps().ownChanges!()).toBe(0)
    const path = k.store.workspace(c.workspaceId)!.path
    await mkdir(join(path, '.kernel', 'shared'), { recursive: true })
    await writeFile(join(path, '.kernel', 'shared', 'mock.html'), '<p>mock</p>\n')
    expect(await deps().ownChanges!()).toBe(0)
    await writeFile(join(path, 'draft.md'), 'notes\n')
    await writeFile(join(path, 'README.md'), '# changed\n')
    expect(await deps().ownChanges!()).toBe(2)
  })

  it('does the work in its own folder and hands a follow-up to a teammate from that branch, in one chat', async () => {
    const { k, project, chat } = await setup()
    const c = await chat()
    const ws = k.store.workspace(c.workspaceId)!
    // The Lead's part: a committed change in its own worktree.
    await writeFile(join(ws.path, 'money.ts'), 'export const round = (n: number) => Math.round(n)\n')
    await git(ws.path, 'add', '-A')
    await git(ws.path, 'commit', '-qm', 'round refunds')
    // The teammate's part, started from the Lead's branch, so it sees the Lead's commit.
    const mate = await k.createWorkspace(project.id, { prompt: 'Round the CSV export the same way.', agentId: 'christian', title: 'Export rounding', baseRef: ws.branch, leadChatId: c.id })
    expect((await git(mate.path, 'log', '-1', '--format=%s')).trim()).toBe('round refunds')
    expect(mate.baseRef).toBe(ws.branch)
    expect(mate.leadChatId).toBe(c.id)
    expect(existsSync(join(mate.path, 'money.ts'))).toBe(true)
  })
})

describe("the Lead's prompt and tools in every chat (one-lead-chat)", () => {
  const kernel = { id: 'kernel', name: 'Kernel', role: 'Lead', description: '', lead: true, prompt: 'You are Kernel.' } as AgentDef
  const ws = { id: 'ws', projectId: 'project', name: 'chat', branch: 'kernel/chat', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'kernel', lead: true, threadId: 't', port: 4300, status: 'ready', prState: 'none', createdAt: 1 } as Workspace

  it('one rule tells the Lead to choose per request, to commit before a hand-off, and to leave a teammate\'s files alone', () => {
    const prompt = agentPrompt(kernel, ws)
    expect(prompt).toContain(LEAD_RULE)
    for (const part of [
      'Answer a question, opinion or report, then stop',
      'Do it yourself when the work stays in one area of the code, takes about an hour and has no parallel pieces',
      'Hand it off when the work spans several areas, has parallel pieces or takes longer',
      'Mixed work: do the quick one-area part yourself and hand off the rest in the same turn.',
      "Teammates don't see your uncommitted edits",
      'commit them and pass base_ref, or open your PR first',
      'Never edit a file a teammate is changing.',
      'Team update', 'Never use em dashes', 'read_plans', 'Never leave a teammate waiting', 'Reviews start on their own'
    ]) expect(LEAD_RULE, part).toContain(part)
    for (const gone of ['Never build a task yourself', 'suggest_hand_off', 'start_build', 'Build here', 'Hand off mode']) expect(LEAD_RULE, gone).not.toContain(gone)
    expect(LEAD_RULE).not.toMatch(/[–—]/)
    // A teammate gets none of it, and a Lead's rule is the same for every chat.
    const sean = { ...kernel, id: 'sean', lead: false, prompt: 'You are Sean.' }
    expect(agentPrompt(sean, ws)).not.toContain(LEAD_RULE)
    expect(agentPrompt(kernel, { ...ws, shared: true })).toContain(LEAD_RULE)
    // Codex reads Kernel's tools under its own names.
    expect(forProvider(LEAD_RULE, 'codex')).toContain('kernel_create_workspace')
    expect(forProvider(LEAD_RULE, 'codex')).toContain('kernel_list_agents')
    expect(LEAD_INSTRUCTIONS).toContain('Call link_issue before your first push when your work builds a tracker issue.')
    expect(forProvider(LEAD_RULE, 'codex')).not.toContain('mcp__kernel__')
  })

  it.each(['AGENTS.md', 'docs/decisions/KERNEL-783.md', '.changes/unreleased/KERNEL-783.md', '.claude/agents/kernel.md', 'package.json'])('lets a Lead edit %s, whatever its tools line says', (file) => {
    const path = `/tmp/ws/${file}`
    for (const tools of [undefined, ['Read', 'Bash']]) {
      const p = toolPolicy(tools, { lead: true, plans: '/tmp/plans' })!
      for (const tool of ['Edit', 'Write', 'MultiEdit']) expect(p.allows(tool, { file_path: path }), `${tool} with ${tools ? 'a tools line' : 'none'}`).toBe(true)
    }
  })

  it("Codex's plan mode takes only files under the workspace's .kernel/shared", () => {
    expect(sharesFile('/tmp/ws', '.kernel/shared/mock.html')).toBe(true)
    expect(sharesFile('/tmp/ws', '/tmp/ws/.kernel/shared/a/b.png')).toBe(true)
    expect(sharesFile('/tmp/ws', '.kernel/shared')).toBe(false)
    expect(sharesFile('/tmp/ws', '.kernel/shared/../plans/x.md')).toBe(false)
    expect(sharesFile('/tmp/ws', 'src/app.ts')).toBe(false)
    expect(sharesFile('/tmp/ws', '/tmp/other/.kernel/shared/x.html')).toBe(false)
  })
})

describe('a chat still on the shared folder edits nothing, and moves to its own folder on its next send (one-lead-chat)', () => {
  it('keeps the edit gate shut and its PR off the teammate path, until the send gives it a folder', async () => {
    const { k, project } = await setup()
    const { chat, ws } = await oldSharedChat(k, project.id)
    expect(ownsFolder(ws)).toBe(false)
    expect(k.lead.buildOpen(chat.id)).toBe(false)
    expect(k.lead.buildTab(ws)).toBeUndefined()

    await k.lead.send(chat.id, [{ type: 'text', text: 'Fix the rounding' }])
    await vi.waitFor(() => { const w = k.store.workspace(ws.id)!; expect(w.status).toBe('ready'); expect(w.shared).toBeFalsy(); expect(w.worktreePending).toBeFalsy() })
    const now = k.store.workspace(ws.id)!
    expect(now.path).not.toBe(ws.path)
    expect(now.path).not.toMatch(/\.main$/)
    expect(now.branch).not.toBe('HEAD')
    expect(ownsFolder(now)).toBe(true)
    expect(k.lead.buildOpen(chat.id)).toBe(true)
    expect(k.lead.buildTab(now)).toBe(chat.id)
  })

  it('leaves the gate shut in plan mode, in a folder of its own too', async () => {
    const { k, chat } = await setup()
    const c = await chat()
    k.store.saveChat({ ...k.store.chat(c.id)!, plan: false })
    expect(k.lead.buildOpen(c.id)).toBe(true)
    k.store.saveChat({ ...k.store.chat(c.id)!, plan: true })
    expect(k.lead.buildOpen(c.id)).toBe(false)
    expect(buildOpen({ planMode: false })).toBe(true)
    expect(buildOpen({ planMode: true })).toBe(false)
  })
})

describe("a chat's pull requests take a teammate's path (KERNEL-778, one-lead-chat)", () => {
  /** A chat with Kernel with a commit of its own on its branch. */
  async function building(app?: Record<string, unknown>) {
    const t = await setup({ app })
    const c = await t.chat()
    const ws = t.k.store.workspace(c.workspaceId)!
    await writeFile(join(ws.path, 'retry.ts'), 'export {}\n')
    await git(ws.path, 'add', '-A')
    await git(ws.path, 'commit', '-qm', 'retry')
    return { ...t, c, ws }
  }
  const notes = (k: Kernel, chatId: string) => k.store.items(chatId).filter((i): i is Extract<ChatItem, { kind: 'note' }> => i.kind === 'note').map((n) => n.text)

  it('starts a new branch from the base once the PR merged and the worktree is clean, and says why it waits while it is not', async () => {
    const { k, project, c, ws } = await building()
    const head = (await git(ws.path, 'rev-parse', 'HEAD')).trim()
    k.store.saveWorkspace({ ...ws, prNumber: 54, prState: 'merged', prUrl: 'https://x/54', prHead: head, mergedAt: 2, source: { kind: 'issue', id: 'KERNEL-760', title: 'Retry button' } })
    await writeFile(join(ws.path, 'README.md'), '# edited\n')
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    expect(k.store.workspace(ws.id)).toMatchObject({ branch: ws.branch, prNumber: 54, prState: 'merged' })
    expect(notes(k, c.id)).toEqual(['Kernel kept this branch because it has uncommitted changes. A new branch starts once nothing here is left out of the merge.'])

    // Committed after the merge: the commit isn't in the PR, so the chat stays where it is, and hears why once.
    await git(ws.path, 'commit', '-qam', 'after the merge')
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    expect(k.store.workspace(ws.id)).toMatchObject({ branch: ws.branch, prState: 'merged' })
    expect((await git(ws.path, 'log', '-1', '--format=%s')).trim()).toBe('after the merge')
    expect(notes(k, c.id).slice(1)).toEqual(["Kernel kept this branch because it has a commit the PR didn't include. A new branch starts once nothing here is left out of the merge."])
    // Pushed to the merged branch, it still isn't in the PR. Dropping it lets the chat go on.
    await git(project.path, 'update-ref', `refs/remotes/origin/${ws.branch}`, 'HEAD')
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    expect(k.store.workspace(ws.id)).toMatchObject({ branch: ws.branch, prState: 'merged' })
    await git(ws.path, 'reset', '-q', '--hard', head)
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    const next = k.store.workspace(ws.id)!
    expect(next.branch).not.toBe(ws.branch)
    expect(next.branch).toMatch(/^kernel\//)
    expect(next).toMatchObject({ baseRef: 'main', prState: 'none' })
    for (const f of ['prNumber', 'prUrl', 'prHead', 'mergedAt', 'source'] as const) expect(next[f], f).toBeUndefined()
    expect((await git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(next.branch)
    expect((await git(ws.path, 'rev-parse', 'HEAD')).trim()).toBe((await git(project.path, 'rev-parse', 'main')).trim())
    // No merge row existed here, so the ending is a row of its own. No row names a branch.
    expect(notes(k, c.id).at(-1)).toBe('PR #54 merged. Next changes start on a new branch')
    expect(notes(k, c.id).join('\n')).not.toContain(next.branch)
    expect(notes(k, c.id).join('\n')).not.toContain(ws.branch)
    // The next PR is a new one, opened from the new branch, and its merge starts another.
    k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prNumber: 55, prState: 'merged' })
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    expect(k.store.workspace(ws.id)).toMatchObject({ prState: 'none' })
    expect(k.store.workspace(ws.id)!.branch).not.toBe(next.branch)
  })

  it('leaves a chat on the shared folder alone after a merge, since it has no branch of its own', async () => {
    const { k, project } = await setup()
    const { ws } = await oldSharedChat(k, project.id)
    k.store.saveWorkspace({ ...ws, prNumber: 56, prState: 'merged' })
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    expect(k.store.workspace(ws.id)).toMatchObject({ branch: 'HEAD', prState: 'merged', shared: true })
  })

  /** A fake GitHub that reads the PR `gh.state` is in. */
  function github(k: Kernel, ws: Workspace, head: string) {
    const gh = { state: 'open' as PrInfo['state'], blocked: undefined as PrInfo['blocked'] }
    k.github = {
      info: async (_cwd, _ref, workspaceId) => ({ workspaceId, number: 54, url: 'https://github.com/o/r/pull/54', title: 'feat: retry', state: gh.state, baseRef: 'main', checks: [{ name: 'Test', state: 'pass' }], comments: [], conflicts: [], head, ...(gh.blocked ? { blocked: gh.blocked } : {}) }),
      merge: async () => undefined, ready: async () => undefined, reopen: async () => undefined
    }
    return gh
  }

  /** The chat's own PR going open, then ready, with `approved` reviews on its head. */
  async function readyPr(o: { approved?: boolean; app?: Record<string, unknown>; blocked?: PrInfo['blocked'] } = {}) {
    const t = await building(o.app)
    const head = (await git(t.ws.path, 'rev-parse', 'HEAD')).trim()
    const gh = github(t.k, t.ws, head)
    gh.blocked = o.blocked
    if (o.approved) t.k.store.saveWorkspace({ ...t.ws, reviews: [{ workspaceId: 'rev', agentId: 'artkin', verdict: 'approved', summary: 'Fine.', ts: 1, sha: head, prNumber: 54, lens: 'code' }] })
    await t.k.refreshPr(t.ws.id, { settle: true })
    gh.state = 'ready'
    await t.k.refreshPr(t.ws.id, { settle: true })
    await t.k.refreshPr(t.ws.id, { settle: true })
    // The reviews feature weighs a ready PR in the background.
    await new Promise((r) => setTimeout(r, 200))
    return t
  }

  it('posts no opened row, and no ready row after an approving review (KERNEL-990)', async () => {
    const { k, c } = await readyPr({ approved: true })
    expect(notes(k, c.id)).toEqual([])
  })

  it('posts the ready row when no review ran, since it is the only sign checks passed', async () => {
    const { k, c } = await readyPr()
    expect(notes(k, c.id)).toEqual(['PR #54 is ready to merge'])
  })

  it('posts the ready row with GitHub\'s block, even after an approval', async () => {
    const { k, c } = await readyPr({ approved: true, blocked: 'rules' })
    expect(notes(k, c.id)).toEqual(["PR #54 is ready to merge. GitHub blocks the merge: the branch's rules"])
  })

  it('posts the ready row with the reason auto-merge left an approved PR, once', async () => {
    const { k, c, ws } = await readyPr({ approved: true, app: { pr: { autoMerge: { on: true } } } })
    // GitHub refuses the merge Kernel starts.
    k.github.merge = async () => { throw new Error('Base branch was protected') }
    expect(await k.prs.autoMerge(ws.id)).toEqual({ refused: 'Base branch was protected' })
    await k.prs.autoMerge(ws.id)
    const rows = notes(k, c.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/^PR #54 is ready to merge\. Kernel didn't merge it automatically: the merge Kernel started failed\. Base branch was protected$/)
  })

  it('draws the PR as rows, once each, ends the merge row with the new branch, and tells the next turn (KERNEL-990)', async () => {
    const { k, project, c, ws } = await building()
    const head = (await git(ws.path, 'rev-parse', 'HEAD')).trim()
    const gh = github(k, ws, head)
    const refresh = () => k.refreshPr(ws.id, { settle: true })
    await refresh()
    gh.state = 'ready'
    await refresh()
    await refresh()
    // No review covers this PR, so the ready row is the only sign its checks passed. The reviews feature posts it.
    await vi.waitFor(() => expect(notes(k, c.id)).toEqual(['PR #54 is ready to merge']))
    gh.state = 'merged'
    await refresh()
    await vi.waitFor(() => expect(k.store.workspace(ws.id)).toMatchObject({ prState: 'none' }), { timeout: 10_000, interval: 20 })
    const first = k.store.workspace(ws.id)!
    expect(first.branch).not.toBe(ws.branch)
    // One merge row, which carries the ending, and no second row for the switch. No row names a branch.
    expect(notes(k, c.id)).toEqual(['PR #54 is ready to merge', 'PR #54 was merged on GitHub. Next changes start on a new branch'])
    expect(notes(k, c.id).join('\n')).not.toContain(ws.branch)
    // The chat's next turn starts with one short line, once.
    const deps = sessionDeps(k)
    expect(deps.turnNote!(c)).toBe('PR #54 merged. This chat is now on a new branch from main.')
    expect(deps.turnNote!(c)).toBeUndefined()

    // The same merge seen again, as a replay or a refresh after a restart would, adds no row. The new branch is another one still.
    k.store.saveWorkspace({ ...first, prNumber: 54, prState: 'ready' })
    await refresh()
    await vi.waitFor(() => expect(k.store.workspace(ws.id)).toMatchObject({ prState: 'none' }), { timeout: 10_000, interval: 20 })
    expect(notes(k, c.id).filter((t) => t.startsWith('PR #54 was merged'))).toHaveLength(1)
    expect(notes(k, c.id)).toHaveLength(2)
    expect(k.store.workspace(ws.id)!.branch).not.toBe(first.branch)
    expect(project.id).toBe(ws.projectId)
  })

  it('says Kernel could not update to the latest main when the fetch fails, and keeps the branch (KERNEL-990)', async () => {
    const { k, project, c, ws } = await building()
    const head = (await git(ws.path, 'rev-parse', 'HEAD')).trim()
    const gh = github(k, ws, head)
    k.store.saveWorkspace({ ...ws, prNumber: 54, prState: 'ready', prHead: head })
    gh.state = 'merged'
    await git(project.path, 'remote', 'add', 'origin', join(project.path, 'nowhere'))
    await k.refreshPr(ws.id, { settle: true })
    await vi.waitFor(() => expect(notes(k, c.id).at(-1)).toBe("PR #54 was merged on GitHub. Kernel couldn't update to the latest main"), { timeout: 10_000, interval: 20 })
    expect(k.store.workspace(ws.id)).toMatchObject({ branch: ws.branch, prState: 'merged' })
  })

  it('draws no row and cuts no branch for a chat that was archived before the switch (KERNEL-990)', async () => {
    const { k, project, c, ws } = await building()
    const head = (await git(ws.path, 'rev-parse', 'HEAD')).trim()
    k.store.saveWorkspace({ ...ws, prNumber: 54, prState: 'merged', prHead: head, status: 'archived' })
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    expect(k.store.workspace(ws.id)).toMatchObject({ branch: ws.branch, prState: 'merged' })
    expect(notes(k, c.id)).toEqual([])
  })

  it('links an issue in any chat, renaming the branch before the first push and only linking after it (KERNEL-778)', async () => {
    const { k, project, ws, chat } = await building()
    const linked = await k.lead.linkIssue(ws.id, 'KERNEL-760')
    expect(linked.source).toMatchObject({ kind: 'issue', id: 'KERNEL-760' })
    expect(linked.branch).toMatch(/^feat\/kernel-760/)
    expect((await git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(linked.branch)
    // Pushed: the branch keeps its name, and only the link changes.
    await git(project.path, 'update-ref', `refs/remotes/origin/${linked.branch}`, 'HEAD')
    const relinked = await k.lead.linkIssue(ws.id, 'KERNEL-761')
    expect(relinked).toMatchObject({ branch: linked.branch, source: { kind: 'issue', id: 'KERNEL-761' } })
    // So does a branch with a PR.
    const other = await chat()
    k.store.saveWorkspace({ ...k.store.workspace(other.workspaceId)!, prNumber: 57, prState: 'open' })
    const before = k.store.workspace(other.workspaceId)!.branch
    expect((await k.lead.linkIssue(other.workspaceId, 'KERNEL-762')).branch).toBe(before)
    // A chat that still sits on the shared folder links without a branch to rename.
    const old = await oldSharedChat(k, project.id)
    const shared = await k.lead.linkIssue(old.ws.id, 'KERNEL-763')
    expect(shared).toMatchObject({ branch: 'HEAD', source: { kind: 'issue', id: 'KERNEL-763' } })
  })
})
