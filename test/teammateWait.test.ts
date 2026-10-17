import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Chat, PrInfo, PrState, Workspace } from '@shared/types'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { Kernel } from '../src/main/kernel'
import { run } from '../src/main/services/exec'
import { teammateTools } from '../src/main/services/teammateMcp'
import { SHARE_RULE, TEAMMATE_RULE } from '../src/main/services/handoff'
import { tempRepo, freePort } from './helpers'

// KERNEL-262: a teammate that finds a dependency mid-task tells Kernel with wait_for_merge, and Kernel moves it on at the merge.

// A scripted SDK, as in waits.test.ts. `tool` keeps the handler so a teammate's tool can run against a real Kernel.
const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (o: { name: string; tools: { name: string }[] }) => ({ name: o.name, tools: o.tools.map((t) => t.name) }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  query: ({ options }: { options: unknown }) => {
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    sdk.calls.push({ options, feed: (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) } })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 10 })
    }
  }
}))

const flush = () => new Promise((r) => setTimeout(r, 30))
const SLOW = { timeout: 10_000 }
const AGENT = (id: string, extra = '') => `---\nname: ${id}\ndescription: ${id}.\n${extra}---\nYou are ${id}.`
const prInfo = (state: PrState, number: number): PrInfo => ({ workspaceId: '', number, url: `https://github.com/x/y/pull/${number}`, title: `PR ${number}`, state, baseRef: 'main', checks: [], comments: [], conflicts: [] })

/** Another clone pushes a commit to origin's main, as a merged PR does. */
async function land(origin: string, file: string) {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-clone-'))
  await run('git', ['clone', '-q', origin, dir])
  await run('git', ['-C', dir, 'config', 'user.email', 't@t.dev'])
  await run('git', ['-C', dir, 'config', 'user.name', 'Test'])
  await writeFile(join(dir, file), `${file}\n`)
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-q', '-m', file])
  await run('git', ['-C', dir, 'push', '-q', 'origin', 'HEAD:main'])
}

/** A project on a repo with a bare origin and a fake GitHub. Sean's work is open as PR #164 for KERNEL-197; Christian has started on its brief. */
async function setup() {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/kernel.md': AGENT('kernel', 'lead: true\n'), '.claude/agents/christian.md': AGENT('christian'), '.claude/agents/sean.md': AGENT('sean'), '.claude/agents/artkin.md': AGENT('artkin', 'role: Reviewer\n') })
  const origin = join(await mkdtemp(join(tmpdir(), 'kernel-origin-')), 'o.git')
  await run('git', ['clone', '-q', '--bare', repo, origin])
  await run('git', ['-C', repo, 'remote', 'add', 'origin', origin])
  await run('git', ['-C', repo, 'fetch', '-q', 'origin'])
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { requireGreen: false } }))
  const prs = new Map<string, PrInfo>()
  const k = new Kernel({ dataDir, home })
  k.github = { info: async (_cwd, ref, workspaceId) => { const pr = prs.get(ref); return pr ? { ...pr, workspaceId } : null }, merge: async () => {}, ready: async () => {}, reopen: async () => {} }
  await k.start()
  const project = await k.addProject(repo)
  const lead = await k.leadChat(project.id)
  const made = await k.createWorkspace(project.id, { prompt: 'Tool rows', agentId: 'sean', title: 'Tool rows', leadChatId: lead.id })
  prs.set(made.branch, prInfo('open', 164))
  await k.refreshPr(made.id)
  const sean = k.store.saveWorkspace({ ...k.store.workspace(made.id)!, source: { kind: 'issue', id: 'KERNEL-197', title: 'Tool rows' } })
  const christian = await k.createWorkspace(project.id, { prompt: 'Build KERNEL-198', agentId: 'christian', title: 'Thinking rows', leadChatId: lead.id })
  const call = async (ws: Workspace, input: { on: string; why?: string }) => {
    const [t] = teammateTools(k.waits['teammateToolDeps'](ws.id))
    const r = await t.handler(input as never, {})
    return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
  }
  const mergeOnGitHub = async (ws: Workspace) => {
    const pr = prs.get(ws.branch)!
    await land(origin, `pr-${pr.number}.txt`)
    prs.set(ws.branch, { ...pr, state: 'merged' })
    return k.refreshPr(ws.id)
  }
  const deps = (k.sessions as unknown as { d: { mcpFor: (ws: Workspace, a: AgentDef | undefined, c: Chat) => Record<string, { tools: string[] }> | undefined; rulesFor: (ws: Workspace, a: AgentDef | undefined) => string | undefined } }).d
  return { k, project, lead, sean, christian, call, mergeOnGitHub, deps }
}

const chatOf = (k: Kernel, ws: Workspace) => k.store.chats(ws.id).find((c) => c.kind !== 'terminal')!
const text = (parts: { type: string; text?: string }[]) => parts.find((p) => p.type === 'text')?.text ?? ''
const users = (k: Kernel, chat: Chat) => k.store.items(chat.id).flatMap((i) => (i.kind === 'user' ? [[text(i.parts), i.from]] : []))
const callsIn = (ws: Workspace) => sdk.calls.filter((c) => c.options.cwd === ws.path)
const result = (uuid: string) => ({ type: 'result', subtype: 'success', uuid, duration_ms: 1, session_id: 's' })
const pending = (k: Kernel) => (k.store.meta<{ pending: [string, { events: { kind: string; workspaceId: string; wait?: { told?: boolean; why?: string } }[] }][] }>('leadUpdates')?.pending ?? []).flatMap(([, p]) => p.events)

describe("a teammate's wait_for_merge", () => {
  it('records the wait on its own workspace whether it names the PR, the Linear issue or the workspace', async () => {
    const { k, sean, christian, call } = await setup()
    for (const on of ['#164', '164', 'KERNEL-197', 'kernel-197', sean.id]) {
      k.store.saveWorkspace({ ...k.store.workspace(christian.id)!, waitsFor: undefined })
      expect(await call(christian, { on })).toEqual({ isError: false, text: 'Kernel will message you when PR #164 merges. End your turn now.' })
      expect(k.store.workspace(christian.id)!.waitsFor).toEqual({ on: [sean.id], held: false })
    }
    expect(k.store.workspace(sean.id)!.waitsFor).toBeUndefined()
    expect(k.store.items(chatOf(k, christian).id).filter((i) => i.kind === 'note').at(-1)).toMatchObject({ text: 'Waiting for PR #164 by Sean to merge. Kernel asks Christian to rebase onto it then.' })
    await k.stop({ budgetMs: 0 })
  })

  it('refuses refs it cannot wait for, with what to pass instead', async () => {
    const { k, project, lead, sean, christian, call } = await setup()
    const review = await k.createWorkspace(project.id, { prompt: 'Review it', agentId: 'artkin', title: 'Review PR #164', leadChatId: lead.id, reviewOf: sean.id })
    const leadWs = k.store.workspace(lead.workspaceId)!
    const refused = async (on: string) => { const r = await call(christian, { on }); expect(r.isError).toBe(true); return r.text }
    expect(await refused('#999')).toBe('Not set: there is no workspace "#999" in this project to wait for. Pass a PR number like #164, an issue key or a workspace id.')
    expect(await refused('KERNEL-1')).toBe('Not set: there is no workspace "KERNEL-1" in this project to wait for. Pass a PR number like #164, an issue key or a workspace id.')
    expect(await refused(christian.id)).toBe(`Not set: ${christian.name} can't wait for itself.`)
    expect(await refused(leadWs.id)).toBe(`Not set: ${leadWs.name} is the Lead's workspace, which never opens a pull request.`)
    expect(await refused(review.id)).toBe(`Not set: ${review.name} is a review. Wait for the work it reviews instead (workspace ${sean.id}).`)
    // Sean already waits for Christian, so Christian waiting for Sean would hold both forever.
    k.store.saveWorkspace({ ...k.store.workspace(sean.id)!, waitsFor: { on: [christian.id], held: false } })
    expect(await refused('#164')).toBe(`Not set: ${sean.name} already waits for ${christian.name}, so both would wait forever.`)
    expect(k.store.workspace(christian.id)!.waitsFor).toBeUndefined()
    await k.stop({ budgetMs: 0 })
  })

  it('tells a teammate on the main checkout to say it in its reply instead', async () => {
    const { k, christian, call } = await setup()
    k.store.saveWorkspace({ ...k.store.workspace(christian.id)!, mode: 'current' })
    expect(await call(christian, { on: '#164' })).toEqual({ isError: true, text: "Not set: you work on the main checkout, which has no branch of its own to rebase later, so you can't wait for a PR. Say in your reply what you are waiting for, and the Lead picks it up." })
    await k.stop({ budgetMs: 0 })
  })

  it('refuses work that merges into another base, which the branch would never get (KERNEL-693)', async () => {
    const { k, sean, christian, call } = await setup()
    k.store.saveWorkspace({ ...k.store.workspace(sean.id)!, baseRef: 'origin/release/1.2' })
    expect(await call(christian, { on: '#164' })).toEqual({ isError: true, text: 'Not set: PR #164 merges into release/1.2, and your workspace starts from main, so its merge never reaches that branch.' })
    expect(k.store.workspace(christian.id)!.waitsFor).toBeUndefined()
    // The remote's copy of the same branch is the same base.
    k.store.saveWorkspace({ ...k.store.workspace(sean.id)!, baseRef: 'origin/main' })
    expect((await call(christian, { on: '#164' })).isError).toBe(false)
    await k.stop({ budgetMs: 0 })
  })

  it('records nothing for work that already merged', async () => {
    const { k, sean, christian, call, mergeOnGitHub } = await setup()
    await mergeOnGitHub(sean)
    expect(await call(christian, { on: '#164' })).toEqual({ isError: false, text: 'PR #164 already merged, so there is nothing to wait for. Rebase onto it and carry on.' })
    expect(k.store.workspace(christian.id)!.waitsFor).toBeUndefined()
    // A branch on origin takes the base by a merge, since its rebase would need a force push (KERNEL-886).
    await run('git', ['-C', christian.path, 'push', '-q', '-u', 'origin', 'HEAD'])
    expect(await call(christian, { on: '#164' })).toEqual({ isError: false, text: 'PR #164 already merged, so there is nothing to wait for. Merge origin/main into your branch and carry on.' })
    await k.stop({ budgetMs: 0 })
  })

  it("keeps what the Lead set it waiting for, and adds the teammate's own", async () => {
    const { k, project, lead, sean, christian, call } = await setup()
    const teng = await k.createWorkspace(project.id, { prompt: 'Other work', agentId: 'sean', title: 'Other work', leadChatId: lead.id })
    await k.setWait(christian.id, [teng.id])
    await call(christian, { on: '#164' })
    expect(k.store.workspace(christian.id)!.waitsFor).toEqual({ on: [teng.id, sean.id], held: false })
    await k.stop({ budgetMs: 0 })
  })

  it("is news for the Lead, with the teammate's reason, while the Lead's own wait isn't", async () => {
    const { k, sean, christian, call } = await setup()
    await call(christian, { on: '#164', why: 'I need the full tool input it adds.' })
    expect(pending(k).filter((e) => e.kind === 'wait.started')).toEqual([expect.objectContaining({ workspaceId: christian.id, wait: expect.objectContaining({ why: 'I need the full tool input it adds.' }) })])
    expect(pending(k).find((e) => e.kind === 'wait.started')!.wait).not.toHaveProperty('told')
    await k.setWait(christian.id, [sean.id])
    expect(pending(k).find((e) => e.kind === 'wait.started')!.wait).toMatchObject({ told: true })
    await k.stop({ budgetMs: 0 })
  })

  it("gets Kernel's rebase message once the PR it waits for merges", async () => {
    const { k, sean, christian, call, mergeOnGitHub } = await setup()
    await call(christian, { on: '#164' })
    callsIn(christian)[0].feed(result('r1'))
    await flush()
    await mergeOnGitHub(sean)
    const chat = chatOf(k, christian)
    await vi.waitFor(() => expect(users(k, chat).at(-1)).toEqual(['PR #164 by Sean merged into main. Fetch origin, rebase onto origin/main, re-run the tests, then carry on with your task. PR #164 is "PR 164". Read what changed with `gh pr view 164` and `git log HEAD..origin/main`.', 'kernel']), SLOW)
    // The teammate rebases before its turn ends, so the wait ends (KERNEL-691).
    await run('git', ['-C', christian.path, 'rebase', '-q', 'origin/main'])
    callsIn(christian)[0].feed(result('r2'))
    await vi.waitFor(() => expect(k.store.workspace(christian.id)?.waitsFor).toBeUndefined(), SLOW)
    await k.stop({ budgetMs: 0 })
  })
})

describe('who gets wait_for_merge', () => {
  it('gives the tool and the rule to teammates, not to reviewers or the Lead', async () => {
    const { k, project, lead, sean, christian, deps } = await setup()
    const agents = await k.agents(project.id)
    const agent = (id: string) => agents.find((a) => a.id === id)
    const review = await k.createWorkspace(project.id, { prompt: 'Review it', agentId: 'artkin', title: 'Review PR #164', leadChatId: lead.id, reviewOf: sean.id })
    const leadWs = k.store.workspace(lead.workspaceId)!
    expect(deps.mcpFor(christian, agent('christian'), chatOf(k, christian))?.kernel.tools).toEqual(['wait_for_merge', 'ask_lead', 'propose_handoff', 'get_issue', 'share_file'])
    expect(deps.mcpFor(review, agent('artkin'), chatOf(k, review))?.kernel.tools).toEqual(['submit_review', 'get_issue', 'share_file'])
    expect(deps.mcpFor(leadWs, agent('kernel-lead'), lead)?.kernel.tools).not.toContain('submit_review')
    expect(deps.rulesFor(christian, agent('christian'))).toBe(`${TEAMMATE_RULE}\n${SHARE_RULE}`)
    expect(deps.rulesFor(review, agent('artkin'))).not.toContain('wait_for_merge')
    expect(deps.rulesFor(leadWs, agent('kernel-lead'))).not.toContain('wait_for_merge')
    expect(TEAMMATE_RULE).toContain("If you can't go on until another teammate's PR merges, call mcp__kernel__wait_for_merge and end your turn. Don't poll or loop.")
    await k.stop({ budgetMs: 0 })
  })

  it("runs in the teammate's session without asking for permission, as submit_review does", async () => {
    const { k, christian } = await setup()
    const options = callsIn(christian)[0].options
    expect(options.mcpServers.kernel.tools).toEqual(['wait_for_merge', 'ask_lead', 'propose_handoff', 'get_issue', 'share_file'])
    expect(options.systemPrompt.append).toContain(TEAMMATE_RULE)
    // A prompt would wait on the user; this answers at once.
    const answer = await (options.canUseTool as CanUseTool)('mcp__kernel__wait_for_merge', { on: '#164' }, { signal: new AbortController().signal, toolUseID: 'w1', requestId: 'r1' } as never)
    expect(answer).toEqual({ behavior: 'allow', updatedInput: { on: '#164' } })
    await k.stop({ budgetMs: 0 })
  })
})
