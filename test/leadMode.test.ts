import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, ChatItem, Workspace } from '@shared/types'
import { leadModeOf, leadModeSwitched, newChatLeadMode } from '@shared/leadMode'
import { ALREADY_HANDOFF, BUILD_HERE_REFUSAL, BUILD_PLAN_MODE_OFF, kernelTools, uncommittedNote, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { HANDOFF_NO_EDIT, toolPolicy } from '../src/main/services/agentTools'
import { forProvider, LEAD_BUILD_RULE, LEAD_RULE, leadRule } from '../src/main/services/handoff'
import { agentPrompt } from '../src/main/services/sessions'
import { loadRepoSettings, saveRepoSettings } from '../src/main/services/settings'
import { sharesFile } from '../src/main/services/providers/codex/runner'
import { Kernel } from '../src/main/kernel'
import { git } from '../src/main/services/exec'
import { setUp, tempRepo, freePort } from './helpers'

// Hand off and Build here: the two ways a chat with Kernel works (KERNEL-770).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

const REPO = {
  'README.md': '# client\n',
  '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
  '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
}

/** A started Kernel on a temp repo, with `app` as the app's settings. Sends are recorded, not run. */
async function setup(o: { app?: Record<string, unknown>; files?: Record<string, string> } = {}) {
  const repo = await tempRepo({ ...REPO, ...o.files })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...o.app }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  onTestFinished(() => k.stop())
  k.sessions.send = async () => ({ queued: false })
  const project = await k.addProject(repo)
  const chat = async () => {
    const c = await k.lead.newLeadChat(project.id, { prompt: '' })
    await setUp(k, c.id, 'settled')
    return k.store.chat(c.id)!
  }
  return { k, project, repo, chat }
}

describe("a new chat's mode (KERNEL-770)", () => {
  it('follows the project, then the app, then Hand off', () => {
    expect(newChatLeadMode(undefined, undefined)).toBe('handoff')
    expect(newChatLeadMode({ team: { leadMode: 'build' } }, undefined)).toBe('build')
    expect(newChatLeadMode({ team: { leadMode: 'build' } }, { agents: { leadMode: 'handoff' } })).toBe('handoff')
    expect(newChatLeadMode({ team: { leadMode: 'handoff' } }, { agents: { leadMode: 'build' } })).toBe('build')
    // A value Kernel doesn't know counts as unset.
    expect(newChatLeadMode({ team: { leadMode: 'solo' as never } }, { agents: { leadMode: 'both' as never } })).toBe('handoff')
    expect(leadModeOf(undefined)).toBe('handoff')
    expect(leadModeOf({})).toBe('handoff')
  })

  it("reads and saves the project's [agents] lead_mode", async () => {
    const repo = await tempRepo({ 'README.md': '# x\n', '.kernel/settings.toml': '[agents]\nlead_mode = "build"\n' })
    expect((await loadRepoSettings(repo)).agents?.leadMode).toBe('build')
    await saveRepoSettings(repo, { agents: { leadMode: 'handoff' } })
    expect((await loadRepoSettings(repo)).agents?.leadMode).toBe('handoff')
    await writeFile(join(repo, '.kernel', 'settings.local.toml'), '[agents]\nlead_mode = "solo"\n')
    expect((await loadRepoSettings(repo)).agents?.leadMode).toBe('build')
  })

  it('starts in Hand off by default, in the app default, and in the project default over it, and a changed default leaves open chats alone', async () => {
    const plain = await setup()
    expect(plain.k.settings.team.leadMode).toBe('handoff')
    expect(plain.k.store.workspace((await plain.chat()).workspaceId)?.leadMode).toBe('handoff')

    const app = await setup({ app: { team: { leadMode: 'build' } } })
    const open = await app.chat()
    expect(app.k.store.workspace(open.workspaceId)?.leadMode).toBe('build')
    await mkdir(join(app.repo, '.kernel'), { recursive: true })
    await writeFile(join(app.repo, '.kernel', 'settings.local.toml'), '[agents]\nlead_mode = "handoff"\n')
    const next = await app.chat()
    expect(app.k.store.workspace(next.workspaceId)?.leadMode).toBe('handoff')
    expect(app.k.store.workspace(open.workspaceId)?.leadMode).toBe('build')
  })

  it('starts in the mode lead.start sends over the default (KERNEL-805)', async () => {
    const s = await setup({ app: { team: { leadMode: 'build' } } })
    const picked = await s.k.lead.newLeadChat(s.project.id, { prompt: '', leadMode: 'handoff' })
    expect(s.k.store.workspace(picked.workspaceId)?.leadMode).toBe('handoff')
    const plain = await s.k.lead.newLeadChat(s.project.id, { prompt: '' })
    expect(s.k.store.workspace(plain.workspaceId)?.leadMode).toBe('build')
  })
})

describe('lead.setMode (KERNEL-770)', () => {
  it("switches the chat, leaves a divider in its tabs and restarts its idle processes, and refuses what isn't a chat with Kernel", async () => {
    const { k, project, chat } = await setup()
    const c = await chat()
    const restarted: string[][] = []
    const restartIdle = k.sessions.restartIdle.bind(k.sessions)
    k.sessions.restartIdle = (ids: string[]) => { restarted.push(ids); restartIdle(ids) }
    const ws = await k.handlers()['lead.setMode']({ workspaceId: c.workspaceId, mode: 'build' })
    expect(ws.leadMode).toBe('build')
    expect(k.store.workspace(c.workspaceId)?.leadMode).toBe('build')
    expect(restarted).toEqual([[c.workspaceId]])
    const dividers = () => k.store.items(c.id).filter((i): i is Extract<ChatItem, { kind: 'leadMode' }> => i.kind === 'leadMode')
    expect(dividers().map((d) => d.mode)).toEqual(['build'])
    // The same mode again changes nothing.
    await k.handlers()['lead.setMode']({ workspaceId: c.workspaceId, mode: 'build' })
    expect(dividers()).toHaveLength(1)
    await k.handlers()['lead.setMode']({ workspaceId: c.workspaceId, mode: 'handoff' })
    expect(restarted).toHaveLength(2)
    // Nothing since the last switch: its divider updates in place (KERNEL-809).
    expect(dividers().map((d) => d.mode)).toEqual(['handoff'])
    expect(leadModeSwitched('build')).toBe("Switched to Build here. Kernel can edit files in this chat's worktree.")

    const kai = (await k.agents(project.id)).find((a) => a.id === 'kai')!
    const teammate = await k.workspaces.createWorkspace(project.id, { prompt: 'Fix the padding', agentId: kai.id, title: 'Padding' })
    await expect(k.handlers()['lead.setMode']({ workspaceId: teammate.id, mode: 'build' })).rejects.toThrow('Only a chat with Kernel')
    await expect(k.handlers()['lead.setMode']({ workspaceId: 'nope', mode: 'build' })).rejects.toThrow('Only a chat with Kernel')
    await expect(k.handlers()['lead.setMode']({ workspaceId: c.workspaceId, mode: 'solo' as never })).rejects.toThrow('is not a mode')
  })

  it('updates a tab\'s last divider in place, and adds one after anything else, tab by tab (KERNEL-809)', async () => {
    const { k, chat } = await setup()
    const c = await chat()
    const other = k.store.saveChat({ ...c, id: 'second-tab', title: 'Second' })
    const modes = (id: string) => k.store.items(id).flatMap((i) => (i.kind === 'leadMode' ? [i.mode] : []))
    const setMode = (mode: 'build' | 'handoff') => k.handlers()['lead.setMode']({ workspaceId: c.workspaceId, mode })
    await setMode('build')
    k.store.saveItem(c.id, { kind: 'note', id: 'reply', ts: Date.now(), text: 'Done.' })
    await setMode('handoff')
    expect(modes(c.id)).toEqual(['build', 'handoff'])
    expect(modes(other.id)).toEqual(['handoff'])
    await setMode('build')
    expect(modes(c.id)).toEqual(['build', 'build'])
    expect(modes(other.id)).toEqual(['build'])
    expect(k.store.items(c.id).map((i) => i.kind)).toEqual(['leadMode', 'note', 'leadMode'])
  })

  it('switches with uncommitted edits in the worktree, both ways, and leaves them as they were', async () => {
    const { k, chat } = await setup()
    const c = await chat()
    const path = k.store.workspace(c.workspaceId)!.path
    await writeFile(join(path, 'README.md'), '# edited\n')
    await writeFile(join(path, 'draft.md'), 'notes\n')
    const status = async () => (await git(path, 'status', '--porcelain')).trim()
    const before = await status()
    expect(before).toContain('README.md')
    for (const mode of ['build', 'handoff'] as const) {
      expect((await k.handlers()['lead.setMode']({ workspaceId: c.workspaceId, mode })).leadMode).toBe(mode)
      expect(await status()).toBe(before)
    }
    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('# edited\n')
  })

  it("counts files changed in the chat's own worktree, which teammates won't start from", async () => {
    const { k, project, chat } = await setup()
    const c = await chat()
    const lead = (await k.agents(project.id)).find((a) => a.lead) as AgentDef
    const deps = () => k.lead.leadToolDeps(project.id, lead, k.store.chat(c.id)!)
    expect(deps().leadMode).toBe('handoff')
    expect(await deps().ownChanges!()).toBe(0)
    const path = k.store.workspace(c.workspaceId)!.path
    await mkdir(join(path, '.kernel', 'shared'), { recursive: true })
    await writeFile(join(path, '.kernel', 'shared', 'mock.html'), '<p>mock</p>\n')
    expect(await deps().ownChanges!()).toBe(0)
    await writeFile(join(path, 'draft.md'), 'notes\n')
    await writeFile(join(path, 'README.md'), '# changed\n')
    expect(await deps().ownChanges!()).toBe(2)
    k.lead.setMode(c.workspaceId, 'build')
    expect(deps().leadMode).toBe('build')
    // suggest_hand_off puts the suggestion under Kernel's reply.
    deps().suggestHandoff!('It touches the engine and the UI.')
    expect(k.store.items(c.id).filter((i) => i.kind === 'modeSuggestion')).toMatchObject([{ mode: 'handoff', why: 'It touches the engine and the UI.' }])
  })
})

describe("Kernel's tools in each mode (KERNEL-770)", () => {
  const kernel = { id: 'kernel', name: 'Kernel', role: 'Lead', description: '', lead: true, prompt: '' } as AgentDef
  const kai = { id: 'kai', name: 'Kai', role: 'Frontend', description: '', lead: false, prompt: '' } as AgentDef
  const theo = { id: 'theo', name: 'Theo', role: 'Reviewer', description: '', lead: false, prompt: '' } as AgentDef
  const target: Workspace = { id: 'w-kai', projectId: 'project', name: 'padding', branch: 'feat/padding', baseRef: 'main', path: '/tmp/w-kai', mode: 'worktree', agentId: 'kai', port: 4301, status: 'ready', prState: 'open', createdAt: 1 }
  function tools(o: Partial<KernelToolDeps>) {
    const created: unknown[] = []
    const asked: { detail?: string }[] = []
    const suggested: string[] = []
    const deps = {
      projectId: 'project', lead: kernel, chatId: 'chat', agents: async () => [kernel, kai, theo], workspaces: () => [target],
      createWorkspace: async (c: { agentId: string; baseRef?: string }) => { created.push(c); return { ...target, id: `new-${created.length}`, agentId: c.agentId, branch: 'feat/x', baseRef: 'origin/main' } },
      messageWorkspace: async () => ({ ok: true, sent: true, note: '' }), askUser: async (a: { detail?: string }) => { asked.push(a); return { behavior: 'allow' } }, hireAgent: async () => '', archiveWorkspace: async () => {},
      isRunning: () => false, unsaved: async () => false, planMode: () => true, planApproved: () => 'Plan approved.', suggestHandoff: (why: string) => { suggested.push(why) }, ...o
    } as unknown as KernelToolDeps
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await kernelTools(deps).find((t) => t.name === name)!.handler(args as never, {})
      return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
    }
    return { call, created, asked, suggested }
  }

  it('create_workspace refuses a task in Build here and still starts a review', async () => {
    const t = tools({ leadMode: 'build' })
    expect(await t.call('create_workspace', { agent: 'kai', title: 'Padding', brief: 'Fix it' })).toEqual({ text: BUILD_HERE_REFUSAL, isError: true })
    expect(BUILD_HERE_REFUSAL).toContain('Switch this chat to Hand off to give tasks to teammates.')
    expect(t.created).toEqual([])
    const review = await t.call('create_workspace', { agent: 'theo', title: 'Review padding', brief: 'Review it', review_of: 'w-kai' })
    expect(review.isError).toBe(false)
    expect(t.created).toMatchObject([{ agentId: 'theo', reviewOf: 'w-kai' }])
  })

  it('a hand-off or plan from a chat with uncommitted changes says teammates start without them, and goes ahead', async () => {
    const t = tools({ ownChanges: async () => 2, handoffBase: async () => ({ remote: 'origin', base: 'origin/main' }) })
    const handed = await t.call('create_workspace', { agent: 'kai', title: 'Padding', brief: 'Fix it' })
    expect(handed.isError).toBe(false)
    expect(handed.text).toContain(uncommittedNote(2, 'origin/main'))
    expect(uncommittedNote(2, 'origin/main')).toBe("This chat's worktree has 2 uncommitted changes. Teammates start from origin/main and won't see them.")
    await t.call('request_plan_approval', { title: 'Padding', plan: 'Fix the padding.', steps: ['Padding · Kai'] })
    expect(t.asked[0].detail).toBe(`Fix the padding.\n\n${uncommittedNote(2, 'origin/main')}`)
    // A clean worktree adds nothing.
    const clean = tools({ ownChanges: async () => 0 })
    expect((await clean.call('create_workspace', { agent: 'kai', title: 'Padding', brief: 'Fix it' })).text).not.toContain('uncommitted')
  })

  it('suggest_hand_off shows the suggestion in Build here and refuses in Hand off', async () => {
    const build = tools({ leadMode: 'build' })
    expect((await build.call('suggest_hand_off', { reason: 'It spans two lanes.' })).isError).toBe(false)
    expect(build.suggested).toEqual(['It spans two lanes.'])
    const handoff = tools({})
    expect(await handoff.call('suggest_hand_off', { reason: 'It spans two lanes.' })).toEqual({ text: ALREADY_HANDOFF, isError: true })
    expect(handoff.suggested).toEqual([])
  })

  it('link_issue links in Build here, says whether the branch was renamed, and refuses in Hand off (KERNEL-778)', async () => {
    const linked: string[] = []
    const t = tools({ leadMode: 'build', linkIssue: async (issue) => { linked.push(issue); return { id: 'KERNEL-760', title: 'Retry button', branch: 'feat/kernel-760-retry-button' } } })
    const r = await t.call('link_issue', { issue: ' KERNEL-760 ' })
    expect(linked).toEqual(['KERNEL-760'])
    expect(r).toEqual({ text: 'Linked KERNEL-760, "Retry button". The branch is now feat/kernel-760-retry-button. Write "Closes KERNEL-760" in the PR body.', isError: false })
    const pushed = tools({ leadMode: 'build', linkIssue: async () => ({ id: 'KERNEL-760', title: 'Retry button' }) })
    expect((await pushed.call('link_issue', { issue: 'KERNEL-760' })).text).toContain('The branch keeps its name, since it was pushed.')
    const failed = tools({ leadMode: 'build', linkIssue: async () => { throw new Error('That chat no longer exists.') } })
    expect(await failed.call('link_issue', { issue: 'KERNEL-760' })).toEqual({ text: 'Not linked: That chat no longer exists.', isError: true })
    expect((await tools({ linkIssue: async () => { throw new Error('unreached') } }).call('link_issue', { issue: 'KERNEL-760' })).isError).toBe(true)
  })

  it('request_plan_approval with plan mode off says to build in Build here', async () => {
    const t = tools({ leadMode: 'build', planMode: () => false })
    expect(await t.call('request_plan_approval', { title: 'x', plan: 'y', steps: ['z'] })).toEqual({ text: BUILD_PLAN_MODE_OFF, isError: true })
  })
})

describe("the Lead's prompt and tools in each mode (KERNEL-770)", () => {
  const kernel = { id: 'kernel', name: 'Kernel', role: 'Lead', description: '', lead: true, prompt: 'You are Kernel.' } as AgentDef
  const ws = { id: 'ws', projectId: 'project', name: 'chat', branch: 'kernel/chat', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'kernel', lead: true, threadId: 't', port: 4300, status: 'ready', prState: 'none', createdAt: 1 } as Workspace

  it('Hand off keeps the hand-off lines, Build here drops them for its own, and both keep the shared lines', () => {
    const handoff = agentPrompt(kernel, ws)
    const build = agentPrompt(kernel, { ...ws, leadMode: 'build' })
    expect(handoff).toContain(LEAD_RULE)
    expect(build).toContain(LEAD_BUILD_RULE)
    expect(leadRule('handoff')).toBe(LEAD_RULE)
    expect(LEAD_RULE).toContain('Never build a task yourself.')
    expect(LEAD_BUILD_RULE).not.toContain('Never build a task yourself.')
    expect(LEAD_BUILD_RULE).not.toContain('the approval means "hand it off now"')
    for (const part of ['open a pull request', 'fix your own PR', 'never call mcp__kernel__create_workspace, except with review_of', 'bigger than one PR', 'mcp__kernel__suggest_hand_off']) expect(LEAD_BUILD_RULE, part).toContain(part)
    // A question in Build here gets an answer and changes nothing (feat-lead-stops-ending-answers-with).
    expect(LEAD_BUILD_RULE).toContain('A question is not a request to build, so it changes nothing.')
    for (const part of ['Team update', 'Never use em dashes', 'mcp__kernel__read_plans', 'Never leave a teammate waiting', 'answer and stop, with no closing offer or question']) {
      expect(LEAD_RULE, part).toContain(part)
      expect(LEAD_BUILD_RULE, part).toContain(part)
    }
    // Codex reads Kernel's tools under its own names in both.
    expect(forProvider(LEAD_BUILD_RULE, 'codex')).toContain('kernel_suggest_hand_off')
    expect(forProvider(LEAD_BUILD_RULE, 'codex')).not.toContain('mcp__kernel__')
    // A teammate gets neither.
    const noor = { ...kernel, id: 'noor', lead: false, prompt: 'You are Noor.' }
    expect(agentPrompt(noor, { ...ws, leadMode: 'build' })).not.toContain(LEAD_BUILD_RULE)
  })

  it('Hand off refuses edits whatever the tools line says, keeping the plan file, and Build here grants Edit and Write', () => {
    const plans = '/tmp/plans'
    for (const tools of [undefined, ['Read', 'Edit', 'Write', 'Bash']]) {
      const p = toolPolicy(tools, { lead: 'handoff', plans })!
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
        expect(p.allows(tool, { file_path: '/tmp/ws/a.ts' }), tool).toBe(false)
        expect(p.modeRefuses(tool)).toBe(HANDOFF_NO_EDIT)
      }
      expect(p.allows('Write', { file_path: '/tmp/plans/plan.md' })).toBe(true)
      expect(p.allows('Bash')).toBe(true)
      expect(p.hidden).toContain('NotebookEdit')
    }
    const build = toolPolicy(['Read', 'Bash'], { lead: 'build' })!
    for (const tool of ['Edit', 'Write', 'MultiEdit']) expect(build.allows(tool, { file_path: '/tmp/ws/a.ts' }), tool).toBe(true)
    expect(build.modeRefuses('Edit')).toBeUndefined()
    expect(build.allows('WebFetch')).toBe(false)
    expect(toolPolicy(undefined, { lead: 'build' })).toBeUndefined()
    // disallowedTools still takes them away in Build here.
    expect(toolPolicy(undefined, { lead: 'build', disallowed: ['Edit'] })!.allows('Edit', { file_path: '/tmp/ws/a.ts' })).toBe(false)
  })

  it.each(['AGENTS.md', 'docs/decisions/KERNEL-783.md', '.changes/unreleased/KERNEL-783.md', '.claude/agents/kernel.md', 'package.json'])('Hand off refuses an edit to %s and Build here makes it, whatever its tools line says', (file) => {
    const path = `/tmp/ws/${file}`
    for (const tools of [undefined, ['Read', 'Edit', 'Write', 'Bash']]) {
      const handoff = toolPolicy(tools, { lead: 'handoff', plans: '/tmp/plans' })!
      for (const tool of ['Edit', 'Write', 'MultiEdit']) expect(handoff.allows(tool, { file_path: path }), tool).toBe(false)
    }
    const build = toolPolicy(['Read', 'Bash'], { lead: 'build' })!
    for (const tool of ['Edit', 'Write', 'MultiEdit']) expect(build.allows(tool, { file_path: path }), tool).toBe(true)
  })

  it("Codex's Hand off takes only files under the workspace's .kernel/shared", () => {
    expect(sharesFile('/tmp/ws', '.kernel/shared/mock.html')).toBe(true)
    expect(sharesFile('/tmp/ws', '/tmp/ws/.kernel/shared/a/b.png')).toBe(true)
    expect(sharesFile('/tmp/ws', '.kernel/shared')).toBe(false)
    expect(sharesFile('/tmp/ws', '.kernel/shared/../plans/x.md')).toBe(false)
    expect(sharesFile('/tmp/ws', 'src/app.ts')).toBe(false)
    expect(sharesFile('/tmp/ws', '/tmp/other/.kernel/shared/x.html')).toBe(false)
  })
})

describe("a Build here chat's pull requests (KERNEL-778)", () => {
  /** A chat in Build here with a commit of its own on its branch. */
  async function building() {
    const t = await setup()
    const c = await t.chat()
    t.k.lead.setMode(c.workspaceId, 'build')
    const ws = t.k.store.workspace(c.workspaceId)!
    await writeFile(join(ws.path, 'retry.ts'), 'export {}\n')
    await git(ws.path, 'add', '-A')
    await git(ws.path, 'commit', '-qm', 'retry')
    return { ...t, c, ws }
  }
  const notes = (k: Kernel, chatId: string) => k.store.items(chatId).filter((i): i is Extract<ChatItem, { kind: 'note' }> => i.kind === 'note').map((n) => n.text)

  it('starts a new branch from the base once the PR merged and the worktree is clean, and says why it waits while it is not', async () => {
    const { k, project, c, ws, chat } = await building()
    const head = (await git(ws.path, 'rev-parse', 'HEAD')).trim()
    k.store.saveWorkspace({ ...ws, prNumber: 54, prState: 'merged', prUrl: 'https://x/54', prHead: head, mergedAt: 2, source: { kind: 'issue', id: 'KERNEL-760', title: 'Retry button' } })
    await writeFile(join(ws.path, 'README.md'), '# edited\n')
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    expect(k.store.workspace(ws.id)).toMatchObject({ branch: ws.branch, prNumber: 54, prState: 'merged' })
    expect(notes(k, c.id)).toEqual([`PR #54 merged, but this worktree has uncommitted changes, so Kernel kept this chat on ${ws.branch}. It starts a new branch from main once nothing here is left out of the merge.`])

    // Committed after the merge: the commit isn't in the PR, so the chat stays where it is, and hears why once.
    await git(ws.path, 'commit', '-qam', 'after the merge')
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    expect(k.store.workspace(ws.id)).toMatchObject({ branch: ws.branch, prState: 'merged' })
    expect((await git(ws.path, 'log', '-1', '--format=%s')).trim()).toBe('after the merge')
    expect(notes(k, c.id).slice(1)).toEqual([`PR #54 merged, but ${ws.branch} has a commit the PR didn't include, so Kernel kept this chat on ${ws.branch}. It starts a new branch from main once nothing here is left out of the merge.`])
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
    expect(notes(k, c.id).at(-1)).toBe(`PR #54 merged. This chat now works on ${next.branch}, from main.`)
    // The next PR is a new one, opened from the new branch, and its merge starts another.
    k.store.saveWorkspace({ ...k.store.workspace(ws.id)!, prNumber: 55, prState: 'merged' })
    await k.lead.syncLead(project.id, { workspaceId: ws.id })
    expect(k.store.workspace(ws.id)).toMatchObject({ prState: 'none' })
    expect(k.store.workspace(ws.id)!.branch).not.toBe(next.branch)

    // A chat in Hand off keeps its merged PR's branch.
    const other = await chat()
    const handoff = k.store.workspace(other.workspaceId)!
    k.store.saveWorkspace({ ...handoff, prNumber: 56, prState: 'merged' })
    await k.lead.syncLead(project.id, { workspaceId: handoff.id })
    expect(k.store.workspace(handoff.id)).toMatchObject({ branch: handoff.branch, prState: 'merged' })
  })

  it("links an issue, renaming the branch before the first push and only linking after it, and refuses a chat in Hand off", async () => {
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
    k.lead.setMode(other.workspaceId, 'build')
    k.store.saveWorkspace({ ...k.store.workspace(other.workspaceId)!, prNumber: 57, prState: 'open' })
    const before = k.store.workspace(other.workspaceId)!.branch
    expect((await k.lead.linkIssue(other.workspaceId, 'KERNEL-762')).branch).toBe(before)
    k.lead.setMode(other.workspaceId, 'handoff')
    await expect(k.lead.linkIssue(other.workspaceId, 'KERNEL-763')).rejects.toThrow('Only a chat in Build here links an issue')
  })
})
