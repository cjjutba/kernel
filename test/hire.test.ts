import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, AgentReach, Approval, Decision } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { kernelTools, type KernelToolDeps } from '../src/main/services/kernelMcp'
import { tempRepo } from './helpers'

// KERNEL-476: a hire that should open pull requests gets Edit and Write, and hire_agent says where the new agent landed and
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

/** hire_agent with a user who answers the card with `answer`, a team of `team` after the save, and the servers `reach` gives. */
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
  const tool = kernelTools(deps).find((t) => t.name === 'hire_agent')!
  const run = async (args: object) => {
    const r = await tool.handler(args as never, {})
    return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
  }
  return { run, askUser, saved, reach, card: () => askUser.mock.calls[0]?.[0].agentFile }
}

const agent = (id: string, more: Partial<AgentDef>): AgentDef => ({ id, name: id[0].toUpperCase() + id.slice(1), role: 'Agent', description: '', lead: false, prompt: '', file: `/repo/.claude/agents/${id}.md`, ...more })

describe('hire_agent', () => {
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
      text: 'Saved /repo/.claude/agents/lumi.md. Lumi joins the team and takes tasks. MCP servers Lumi can reach: figma. Lumi can\'t use a server its file names. claude.ai Linear needs the user to sign in with /mcp in Claude Code. Don\'t hand Lumi work that needs it until the user fixes that.'
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
    expect(r.text).toBe("Saved /repo/.claude/agents/lumi.md. Lumi joins as a helper and doesn't take tasks. To open a PR, its tools need Bash, and Edit or Write. The user can add them on Lumi's profile in Team. Lumi can reach no MCP servers besides Kernel's own.")
  })

  it('says when the hire reviews, or is a helper the room made one, and names every server it lacks', async () => {
    const reach: AgentReach = { reach: [], blocked: [{ name: 'neon', why: 'failed' }, { name: 'slack', why: 'missing' }, { name: 'lin', why: 'missing', suggestion: 'claude_ai_Linear' }] }
    const reviews = await hireTool({ answer: { behavior: 'allow' }, reach, team: (a) => [agent(a.id, { role: 'Reviewer', reviewer: true, member: false, tools: a.tools })] })
      .run({ id: 'sec', description: 'Reviews security.', prompt: 'x', role: 'Reviewer' })
    expect(reviews.text).toBe("Saved /repo/.claude/agents/sec.md. Sec joins the team and reviews PRs. Sec can reach no MCP servers besides Kernel's own. Sec can't use 3 servers its file names. neon failed to connect. slack is not a server in this room. lin is not a server in this room, but claude_ai_Linear may be the one it means. Don't hand Sec work that needs those until the user fixes that.")
    const helper = await hireTool({ answer: { behavior: 'allow' }, team: (a) => [agent(a.id, { tools: a.tools, member: false })] }).run({ id: 'kai', description: 'Frontend.', prompt: 'x' })
    // No `reach` in the deps: nothing about servers.
    expect(helper.text).toBe("Saved /repo/.claude/agents/kai.md. Kai joins as a helper and doesn't take tasks.")
  })

  it('saves nothing when the user says no', async () => {
    const h = hireTool({ answer: { behavior: 'deny' }, reach: { reach: [], blocked: [] } })
    expect((await h.run({ id: 'lumi', description: 'Designer.', prompt: 'x' })).text).toBe('The user did not approve this agent.')
    expect(h.saved).toEqual([])
  })
})

describe('hiring in a real room', () => {
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
    const hire = kernelTools(deps).find((t) => t.name === 'hire_agent')!
    const run = async (args: object) => ((await hire.handler(args as never, {})).content[0] as { text: string }).text

    expect(await run({ id: 'lumi', description: 'Designer. Checks every screen against DESIGN.md.', prompt: 'You are Lumi. Open a PR with your fixes.' }))
      .toBe(`Saved ${join(room.path, '.claude', 'agents', 'lumi.md')}. Lumi joins the team and takes tasks. Lumi can reach no MCP servers besides Kernel's own.`)
    expect(await readFile(join(repo, '.claude', 'agents', 'lumi.md'), 'utf8')).toContain(PR_TOOLS)
    expect((await k.team.agents(room.id)).find((a) => a.id === 'lumi')).toMatchObject({ member: true, tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'] })

    const tools = ['Read', 'Edit', 'Write', 'Bash', 'mcp__figma', 'mcp__claude_ai_Linear', 'mcp__neon__run_sql', 'mcp__slack']
    expect(await run({ id: 'ivy', description: 'Frontend engineer.', prompt: 'You are Ivy.', tools })).toBe(
      `Saved ${join(room.path, '.claude', 'agents', 'ivy.md')}. Ivy joins the team and takes tasks. MCP servers Ivy can reach: figma. Ivy can't use 3 servers its file names. claude.ai Linear needs the user to sign in with /mcp in Claude Code. neon failed to connect. slack is not a server in this room. Don't hand Ivy work that needs those until the user fixes that.`
    )
    // The room was checked by then, so the second card knew every server.
    expect(cards[1]!.servers).toEqual({ reach: ['figma'], blocked: [{ name: 'claude.ai Linear', why: 'needs-auth' }, { name: 'neon', why: 'failed' }, { name: 'slack', why: 'missing' }] })
  })
})
