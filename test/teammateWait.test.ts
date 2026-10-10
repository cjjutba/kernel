import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Chat, PrInfo, PrState, Workspace } from '@shared/types'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { Kernel } from '../src/main/kernel'
import { run } from '../src/main/services/exec'
import { teammateTools } from '../src/main/services/teammateMcp'
import { TEAMMATE_RULE } from '../src/main/services/handoff'
import { tempRepo } from './helpers'

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

/** A room on a repo with a bare origin and a fake GitHub. Noor's work is open as PR #164 for KERNEL-197; Kai has started on its brief. */
async function setup() {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/rowan.md': AGENT('rowan', 'lead: true\n'), '.claude/agents/kai.md': AGENT('kai'), '.claude/agents/noor.md': AGENT('noor'), '.claude/agents/theo.md': AGENT('theo', 'role: Reviewer\n') })
  const origin = join(await mkdtemp(join(tmpdir(), 'kernel-origin-')), 'o.git')
  await run('git', ['clone', '-q', '--bare', repo, origin])
  await run('git', ['-C', repo, 'remote', 'add', 'origin', origin])
  await run('git', ['-C', repo, 'fetch', '-q', 'origin'])
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, pr: { requireGreen: false } }))
  const prs = new Map<string, PrInfo>()
  const k = new Kernel({ dataDir, home })
  k.github = { info: async (_cwd, ref, workspaceId) => { const pr = prs.get(ref); return pr ? { ...pr, workspaceId } : null }, merge: async () => {}, ready: async () => {}, reopen: async () => {} }
  await k.start()
  const room = await k.addRoom(repo)
  const lead = await k.leadChat(room.id)
  const made = await k.createWorkspace(room.id, { prompt: 'Tool rows', agentId: 'noor', title: 'Tool rows', leadChatId: lead.id })
  prs.set(made.branch, prInfo('open', 164))
  await k.refreshPr(made.id)
  const noor = k.store.saveWorkspace({ ...k.store.workspace(made.id)!, source: { kind: 'issue', id: 'KERNEL-197', title: 'Tool rows' } })
  const kai = await k.createWorkspace(room.id, { prompt: 'Build KERNEL-198', agentId: 'kai', title: 'Thinking rows', leadChatId: lead.id })
  const call = async (ws: Workspace, input: { on: string; why?: string }) => {
    const [t] = teammateTools(k['teammateToolDeps'](ws.id))
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
  return { k, room, lead, noor, kai, call, mergeOnGitHub, deps }
}

const chatOf = (k: Kernel, ws: Workspace) => k.store.chats(ws.id).find((c) => c.kind !== 'terminal')!
const text = (parts: { type: string; text?: string }[]) => parts.find((p) => p.type === 'text')?.text ?? ''
const users = (k: Kernel, chat: Chat) => k.store.items(chat.id).flatMap((i) => (i.kind === 'user' ? [[text(i.parts), i.from]] : []))
const callsIn = (ws: Workspace) => sdk.calls.filter((c) => c.options.cwd === ws.path)
const result = (uuid: string) => ({ type: 'result', subtype: 'success', uuid, duration_ms: 1, session_id: 's' })
const pending = (k: Kernel) => (k.store.meta<{ pending: [string, { events: { kind: string; workspaceId: string; wait?: { told?: boolean; why?: string } }[] }][] }>('leadUpdates')?.pending ?? []).flatMap(([, p]) => p.events)

describe("a teammate's wait_for_merge", () => {
  it('records the wait on its own workspace whether it names the PR, the Linear issue or the workspace', async () => {
    const { k, noor, kai, call } = await setup()
    for (const on of ['#164', '164', 'KERNEL-197', 'kernel-197', noor.id]) {
      k.store.saveWorkspace({ ...k.store.workspace(kai.id)!, waitsFor: undefined })
      expect(await call(kai, { on })).toEqual({ isError: false, text: 'Kernel will message you when PR #164 merges. End your turn now.' })
      expect(k.store.workspace(kai.id)!.waitsFor).toEqual({ on: [noor.id], held: false })
    }
    expect(k.store.workspace(noor.id)!.waitsFor).toBeUndefined()
    expect(k.store.items(chatOf(k, kai).id).filter((i) => i.kind === 'note').at(-1)).toMatchObject({ text: 'Waiting for PR #164 by Noor to merge. Kernel asks Kai to rebase onto it then.' })
    await k.stop()
  })

  it('refuses refs it cannot wait for, with what to pass instead', async () => {
    const { k, room, lead, noor, kai, call } = await setup()
    const review = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'theo', title: 'Review PR #164', leadChatId: lead.id, reviewOf: noor.id })
    const leadWs = k.store.workspace(lead.workspaceId)!
    const refused = async (on: string) => { const r = await call(kai, { on }); expect(r.isError).toBe(true); return r.text }
    expect(await refused('#999')).toBe('Not set: there is no workspace "#999" in this room to wait for. Pass a PR number like #164, a Linear issue key or a workspace id.')
    expect(await refused('KERNEL-1')).toBe('Not set: there is no workspace "KERNEL-1" in this room to wait for. Pass a PR number like #164, a Linear issue key or a workspace id.')
    expect(await refused(kai.id)).toBe(`Not set: ${kai.name} can't wait for itself.`)
    expect(await refused(leadWs.id)).toBe(`Not set: ${leadWs.name} is the Lead's workspace, which never opens a pull request.`)
    expect(await refused(review.id)).toBe(`Not set: ${review.name} is a review. Wait for the work it reviews instead (workspace ${noor.id}).`)
    // Noor already waits for Kai, so Kai waiting for Noor would hold both forever.
    k.store.saveWorkspace({ ...k.store.workspace(noor.id)!, waitsFor: { on: [kai.id], held: false } })
    expect(await refused('#164')).toBe(`Not set: ${noor.name} already waits for ${kai.name}, so both would wait forever.`)
    expect(k.store.workspace(kai.id)!.waitsFor).toBeUndefined()
    await k.stop()
  })

  it('tells a teammate on the main checkout to say it in its reply instead', async () => {
    const { k, kai, call } = await setup()
    k.store.saveWorkspace({ ...k.store.workspace(kai.id)!, mode: 'current' })
    expect(await call(kai, { on: '#164' })).toEqual({ isError: true, text: "Not set: you work on the main checkout, which has no branch of its own to rebase later, so you can't wait for a PR. Say in your reply what you are waiting for, and the Lead picks it up." })
    await k.stop()
  })

  it('records nothing for work that already merged', async () => {
    const { k, noor, kai, call, mergeOnGitHub } = await setup()
    await mergeOnGitHub(noor)
    expect(await call(kai, { on: '#164' })).toEqual({ isError: false, text: 'PR #164 already merged, so there is nothing to wait for. Rebase onto it and carry on.' })
    expect(k.store.workspace(kai.id)!.waitsFor).toBeUndefined()
    await k.stop()
  })

  it("keeps what the Lead set it waiting for, and adds the teammate's own", async () => {
    const { k, room, lead, noor, kai, call } = await setup()
    const ivy = await k.createWorkspace(room.id, { prompt: 'Other work', agentId: 'noor', title: 'Other work', leadChatId: lead.id })
    await k.setWait(kai.id, [ivy.id])
    await call(kai, { on: '#164' })
    expect(k.store.workspace(kai.id)!.waitsFor).toEqual({ on: [ivy.id, noor.id], held: false })
    await k.stop()
  })

  it("is news for the Lead, with the teammate's reason, while the Lead's own wait isn't", async () => {
    const { k, noor, kai, call } = await setup()
    await call(kai, { on: '#164', why: 'I need the full tool input it adds.' })
    expect(pending(k).filter((e) => e.kind === 'wait.started')).toEqual([expect.objectContaining({ workspaceId: kai.id, wait: expect.objectContaining({ why: 'I need the full tool input it adds.' }) })])
    expect(pending(k).find((e) => e.kind === 'wait.started')!.wait).not.toHaveProperty('told')
    await k.setWait(kai.id, [noor.id])
    expect(pending(k).find((e) => e.kind === 'wait.started')!.wait).toMatchObject({ told: true })
    await k.stop()
  })

  it("gets Kernel's rebase message once the PR it waits for merges", async () => {
    const { k, noor, kai, call, mergeOnGitHub } = await setup()
    await call(kai, { on: '#164' })
    callsIn(kai)[0].feed(result('r1'))
    await flush()
    await mergeOnGitHub(noor)
    const chat = chatOf(k, kai)
    await vi.waitFor(() => expect(users(k, chat).at(-1)).toEqual(['PR #164 by Noor merged into main. Fetch origin, rebase onto origin/main, re-run the tests, then carry on with your task.', 'kernel']), SLOW)
    callsIn(kai)[0].feed(result('r2'))
    await vi.waitFor(() => expect(k.store.workspace(kai.id)?.waitsFor).toBeUndefined(), SLOW)
    await k.stop()
  })
})

describe('who gets wait_for_merge', () => {
  it('gives the tool and the rule to teammates, not to reviewers or the Lead', async () => {
    const { k, room, lead, noor, kai, deps } = await setup()
    const agents = await k.agents(room.id)
    const agent = (id: string) => agents.find((a) => a.id === id)
    const review = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'theo', title: 'Review PR #164', leadChatId: lead.id, reviewOf: noor.id })
    const leadWs = k.store.workspace(lead.workspaceId)!
    expect(deps.mcpFor(kai, agent('kai'), chatOf(k, kai))?.kernel.tools).toEqual(['wait_for_merge'])
    expect(deps.mcpFor(review, agent('theo'), chatOf(k, review))?.kernel.tools).toEqual(['submit_review'])
    expect(deps.mcpFor(leadWs, agent('rowan'), lead)?.kernel.tools).not.toContain('submit_review')
    expect(deps.rulesFor(kai, agent('kai'))).toBe(TEAMMATE_RULE)
    expect(deps.rulesFor(review, agent('theo'))).not.toContain('wait_for_merge')
    expect(deps.rulesFor(leadWs, agent('rowan'))).toBeUndefined()
    expect(TEAMMATE_RULE).toContain("If you can't go on until another teammate's PR merges, call mcp__kernel__wait_for_merge and end your turn. Don't poll or loop.")
    await k.stop()
  })

  it("runs in the teammate's session without asking for permission, as submit_review does", async () => {
    const { k, kai } = await setup()
    const options = callsIn(kai)[0].options
    expect(options.mcpServers.kernel.tools).toEqual(['wait_for_merge'])
    expect(options.systemPrompt.append).toContain(TEAMMATE_RULE)
    // A prompt would wait on the user; this answers at once.
    const answer = await (options.canUseTool as CanUseTool)('mcp__kernel__wait_for_merge', { on: '#164' }, { signal: new AbortController().signal, toolUseID: 'w1', requestId: 'r1' } as never)
    expect(answer).toEqual({ behavior: 'allow', updatedInput: { on: '#164' } })
    await k.stop()
  })
})
