import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, AgentReach, Approval, Decision } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { agentList, kernelTools, NO_TEAMMATES, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { LEAD_RULE } from '../src/main/services/handoff'
import { callTool } from '../src/main/services/providers/codex/tools'
import { tempRepo } from './helpers'

// KERNEL-476: a new agent that should open pull requests gets Edit and Write, and create_agent says where it landed and
// which MCP servers it can reach. The SDK is scripted so the room's MCP check lists `servers` and no Claude Code starts.
const sdk = vi.hoisted(() => ({ servers: [] as unknown[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, applyFlagSettings: async () => {}, getContextUsage: async () => ({ percentage: 0 }),
    supportedCommands: async () => [],
    mcpServerStatus: async () => sdk.servers
  })
}))

const PR_TOOLS = 'tools: Read, Edit, Write, Bash, Grep, Glob'

/** create_agent with a user who answers the card with `answer`, a team of `team` after the save, and the servers `reach` gives. */
function hireTool(o: { answer: Decision | null; team?: (saved: { id: string; tools?: string[] }) => AgentDef[]; reach?: AgentReach }) {
  const askUser = vi.fn<KernelToolDeps['askUser']>(async () => o.answer)
  const saved: Parameters<KernelToolDeps['hireAgent']>[0][] = []
  const reach = vi.fn<NonNullable<KernelToolDeps['reach']>>(async () => o.reach!)
  const deps = {
    roomId: 'room', lead: undefined, workspaces: () => [], createWorkspace: async () => { throw new Error('no') }, messageWorkspace: async () => ({ ok: true, note: '' }),
    agents: async () => (saved.length && o.team ? o.team(saved[0]) : []), askUser,
    hireAgent: async (a: Parameters<KernelToolDeps['hireAgent']>[0]) => { saved.push(a); return `/repo/.claude/agents/${a.id}.md` },
    archiveWorkspace: async () => {}, isRunning: () => false, unsaved: async () => false as const,
    ...(o.reach ? { reach } : {})
  } satisfies KernelToolDeps
  const tools = kernelTools(deps)
  const tool = tools.find((t) => t.name === 'create_agent')!
  const run = async (args: object) => {
    const r = await tool.handler(args as never, {})
    return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
  }
  return { run, tools, askUser, saved, reach, card: () => askUser.mock.calls[0]?.[0].agentFile }
}

const agent = (id: string, more: Partial<AgentDef>): AgentDef => ({ id, name: id[0].toUpperCase() + id.slice(1), role: 'Agent', description: '', lead: false, prompt: '', file: `/repo/.claude/agents/${id}.md`, ...more })

describe('create_agent', () => {
  it("gives a hire with no tools line its role's tools, so a Designer can open PRs, and says it takes tasks", async () => {
    const reach: AgentReach = { reach: ['figma'], blocked: [{ name: 'claude.ai Linear', why: 'needs-auth' }] }
    const h = hireTool({ answer: { behavior: 'allow' }, reach, team: (a) => [agent(a.id, { role: 'Designer', tools: a.tools, member: true })] })
    const r = await h.run({ id: 'lumi', description: 'Designer. Checks every screen against DESIGN.md.', prompt: 'You are Lumi.', role: 'Designer' })
    expect(h.card()!.text).toContain(PR_TOOLS)
    // The card shows what the file would reach, so the user sees it before approving (WorkspaceHireServers.png).
    expect(h.card()!.servers).toEqual(reach)
    expect(h.saved[0].tools).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'])
    expect(r).toEqual({
      isError: false,
      text: 'Saved /repo/.claude/agents/lumi.md, just for the user on this Mac. Lumi joins the team and takes tasks. MCP servers Lumi can reach: figma. Lumi can\'t use a server its file names. claude.ai Linear needs the user to sign in with /mcp in Claude Code. Don\'t hand Lumi work that needs it until the user fixes that.'
    })
    // Once for the card, and again after the save, waiting for the room's first check.
    expect(h.reach.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([['lumi', undefined], ['lumi', { wait: true }]])
  })

  it('reads the role, else the id and description, for the defaults, and treats an empty tools list as none', async () => {
    const reviewer = hireTool({ answer: null })
    await reviewer.run({ id: 'sec', description: 'Finds injection bugs.', prompt: 'x', role: 'Security reviewer', tools: [] })
    expect(reviewer.card()!.text).toContain('tools: Read, Grep, Glob\n')
    const docs = hireTool({ answer: null })
    await docs.run({ id: 'docs-writer', description: 'Keeps the README current.', prompt: 'x' })
    expect(docs.card()!.text).toContain(PR_TOOLS)
  })

  it("keeps a tools line the Lead wrote, and says a hire that can't open a PR is a helper and how to change that", async () => {
    const h = hireTool({ answer: { behavior: 'allow' }, reach: { reach: [], blocked: [] }, team: (a) => [agent(a.id, { tools: a.tools, member: false })] })
    const r = await h.run({ id: 'lumi', description: 'Designer.', prompt: 'x', tools: ['Read', 'Grep', 'Glob', 'Bash(pnpm screenshot:*)'] })
    expect(h.saved[0].tools).toEqual(['Read', 'Grep', 'Glob', 'Bash(pnpm screenshot:*)'])
    expect(r.text).toBe("Saved /repo/.claude/agents/lumi.md, just for the user on this Mac. Lumi joins as a helper and doesn't take tasks. To open a PR, its tools need Bash, and Edit or Write. The user can add them on Lumi's profile in Team. Lumi can reach no MCP servers besides Kernel's own.")
  })

  it('says when the hire reviews, or is a helper the room made one, and names every server it lacks', async () => {
    const reach: AgentReach = { reach: [], blocked: [{ name: 'neon', why: 'failed' }, { name: 'slack', why: 'missing' }, { name: 'lin', why: 'missing', suggestion: 'claude_ai_Linear' }] }
    const reviews = await hireTool({ answer: { behavior: 'allow' }, reach, team: (a) => [agent(a.id, { role: 'Reviewer', reviewer: true, member: false, tools: a.tools })] })
      .run({ id: 'sec', description: 'Reviews security.', prompt: 'x', role: 'Reviewer' })
    expect(reviews.text).toBe("Saved /repo/.claude/agents/sec.md, just for the user on this Mac. Sec joins the team and reviews PRs. Sec can reach no MCP servers besides Kernel's own. Sec can't use 3 servers its file names. neon failed to connect. slack is not a server in this room. lin is not a server in this room, but claude_ai_Linear may be the one it means. Don't hand Sec work that needs those until the user fixes that.")
    const helper = await hireTool({ answer: { behavior: 'allow' }, team: (a) => [agent(a.id, { tools: a.tools, member: false })] }).run({ id: 'kai', description: 'Frontend.', prompt: 'x' })
    // No `reach` in the deps: nothing about servers.
    expect(helper.text).toBe("Saved /repo/.claude/agents/kai.md, just for the user on this Mac. Kai joins as a helper and doesn't take tasks.")
  })

  it('saves nothing when the user says no', async () => {
    const h = hireTool({ answer: { behavior: 'deny' }, reach: { reach: [], blocked: [] } })
    expect((await h.run({ id: 'lumi', description: 'Designer.', prompt: 'x' })).text).toBe('The user did not approve this agent.')
    expect(h.saved).toEqual([])
  })

  // A resumed Codex thread keeps the tools it started with, so a Lead thread from before KERNEL-554 still calls the old name.
  it('shows the card and saves the agent when a Codex Lead calls it by its old name, hire_agent', async () => {
    const h = hireTool({ answer: { behavior: 'allow' }, team: (a) => [agent(a.id, { tools: a.tools, member: true })] })
    expect(h.tools.map((t) => t.name)).not.toContain('hire_agent')
    const r = await callTool(h.tools, 'kernel_hire_agent', { id: 'lumi', description: 'Designer.', prompt: 'You are Lumi.' })
    expect(h.askUser).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent', title: 'Add lumi to the team' }), undefined)
    expect(h.saved.map((a) => a.id)).toEqual(['lumi'])
    expect(r).toEqual({ success: true, contentItems: [{ type: 'inputText', text: 'Saved /repo/.claude/agents/lumi.md, just for the user on this Mac. Lumi joins the team and takes tasks.' }] })
    expect(await callTool(h.tools, 'kernel_fire_agent', {})).toEqual({ success: false, contentItems: [{ type: 'inputText', text: 'Kernel has no tool called kernel_fire_agent.' }] })
  })
})

// KERNEL-554: the Lead checks each task against the team, offers to create an agent when nobody fits, and never builds a
// task itself.
describe('a plan that needs an agent the team lacks', () => {
  it('lists members in full and 30 plugin helpers as one line of names', () => {
    const helpers = Array.from({ length: 30 }, (_, i) => agent(`plug-${i}`, { name: `Plug ${i}`, origin: 'plugin', member: false, description: 'A plugin agent with a long description. '.repeat(5) }))
    const team = [
      agent('rowan', { role: 'Lead', lead: true, description: 'Plans.' }), agent('noor', { role: 'Backend', member: true, description: 'Builds the API.' }),
      agent('theo', { role: 'Reviewer', reviewer: true, member: false, description: 'Reviews PRs.' }), ...helpers
    ]
    const lines = agentList(team).split('\n')
    expect(lines).toEqual([
      'rowan: Rowan, Lead (the Lead, you). Plans.',
      'noor: Noor, Backend. Builds the API.',
      'theo: Theo, Reviewer (reviews PRs). Reviews PRs.',
      `Helpers, which don't take tasks: ${helpers.map((a) => a.name).join(', ')}.`
    ])
    expect(agentList(team)).not.toContain('A plugin agent')
  })

  it('tells the Lead to check the team before asking, to offer a new agent, and never to build a task itself', () => {
    expect(LEAD_RULE).toContain('Before you ask for plan approval or suggest a hand-off, check each task against mcp__kernel__list_agents.')
    expect(LEAD_RULE).toContain('"Give it to Noor" for the closest teammate and "Create a payments engineer agent"')
    expect(LEAD_RULE).toContain('When nobody on the team takes tasks, stop at the first task')
    expect(LEAD_RULE).toContain('whether to create an agent with create_agent or to add a starter agent in Team. Never build a task yourself.')
    expect(LEAD_RULE).not.toMatch(/hire/i)
  })
})

describe('creating an agent in a real room', () => {
  it("writes a Designer that takes tasks, and lists the servers it reaches after the room's first check", async () => {
    const repo = await tempRepo({ 'README.md': '# app\n', '.mcp.json': JSON.stringify({ mcpServers: { figma: {}, neon: {} } }), '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home, claudeSettingsFile: join(home, 'claude-settings.json') })
    onTestFinished(() => k.stop())
    await k.start()
    const room = await k.rooms.addRoom(repo)
    const chat = await k.lead.leadChat(room.id)
    const lead = (await k.team.agents(room.id)).find((a) => a.lead)!
    sdk.servers = [
      { name: 'figma', status: 'connected', scope: 'project' }, { name: 'neon', status: 'failed', scope: 'project' },
      { name: 'claude.ai Linear', status: 'needs-auth', scope: 'claudeai', source: 'claudeai' }
    ]
    const cards: Approval['agentFile'][] = []
    const deps: KernelToolDeps = { ...k.lead.leadToolDeps(room.id, lead, chat), askUser: async (o) => { cards.push(o.agentFile); return { behavior: 'allow' } } }
    const leadTools = kernelTools(deps)
    const call = async (name: string, args: object) => {
      const r = await leadTools.find((t) => t.name === name)!.handler(args as never, {})
      return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
    }
    const run = async (args: object) => (await call('create_agent', args)).text

    // Only the Lead so far: list_agents says how to get a teammate, and create_workspace builds nothing (KERNEL-554).
    expect((await call('list_agents', {})).text).toBe('rowan: Rowan, Lead (the Lead, you). Lead.\nNobody on this team takes tasks yet. Before planning work, ask the user whether to create an agent with create_agent or to add a starter agent in Team.')
    const before = k.store.workspaces().length
    expect(await call('create_workspace', { agent: 'kai', title: 'Checkout', brief: 'Build checkout.' })).toEqual({ isError: true, text: NO_TEAMMATES })
    expect(await call('create_workspace', { agent: 'rowan', title: 'Checkout', brief: 'Build checkout.' })).toMatchObject({ isError: true })
    expect(k.store.workspaces()).toHaveLength(before)

    // Just for the user by default, so the file goes to ~/.claude/agents (KERNEL-466).
    expect(await run({ id: 'lumi', description: 'Designer. Checks every screen against DESIGN.md.', prompt: 'You are Lumi. Open a PR with your fixes.' }))
      .toBe(`Saved ${join(home, '.claude', 'agents', 'lumi.md')}, just for the user on this Mac. Lumi joins the team and takes tasks. Lumi can reach no MCP servers besides Kernel's own.`)
    expect(await readFile(join(home, '.claude', 'agents', 'lumi.md'), 'utf8')).toContain(PR_TOOLS)
    expect((await k.team.agents(room.id)).find((a) => a.id === 'lumi')).toMatchObject({ member: true, tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'] })
    expect((await call('list_agents', {})).text).toBe('rowan: Rowan, Lead (the Lead, you). Lead.\nlumi: Lumi, Designer. Designer. Checks every screen against DESIGN.md.')

    const tools = ['Read', 'Edit', 'Write', 'Bash', 'mcp__figma', 'mcp__claude_ai_Linear', 'mcp__neon__run_sql', 'mcp__slack']
    expect(await run({ id: 'ivy', description: 'Frontend engineer.', prompt: 'You are Ivy.', tools })).toBe(
      `Saved ${join(home, '.claude', 'agents', 'ivy.md')}, just for the user on this Mac. Ivy joins the team and takes tasks. MCP servers Ivy can reach: figma. Ivy can't use 3 servers its file names. claude.ai Linear needs the user to sign in with /mcp in Claude Code. neon failed to connect. slack is not a server in this room. Don't hand Ivy work that needs those until the user fixes that.`
    )
    // The room was checked by then, so the second card knew every server.
    expect(cards[1]!.servers).toEqual({ reach: ['figma'], blocked: [{ name: 'claude.ai Linear', why: 'needs-auth' }, { name: 'neon', why: 'failed' }, { name: 'slack', why: 'missing' }] })
  })
})
