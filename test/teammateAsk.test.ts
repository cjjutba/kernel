import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatPart, TeamUpdate, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { teammateTools } from '../src/main/services/teammateMcp'
import { forProvider, LEAD_RULE, TEAMMATE_RULE } from '../src/main/services/handoff'
import { tempRepo, freePort } from './helpers'

// KERNEL-747: a teammate asks the Lead with ask_lead, or proposes handing part of its work to another agent with
// propose_handoff. Both reach the Lead chat that handed the workspace off as Team update events.

// A scripted SDK, as in teammateWait.test.ts. `tool` keeps the handler so a teammate's tool can run against a real Kernel.
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

const SLOW = { timeout: 10_000 }
const AGENT = (id: string, extra = '') => `---\nname: ${id}\ndescription: ${id}.\n${extra}---\nYou are ${id}. You build tasks and open pull requests.`
const result = (uuid: string) => ({ type: 'result', subtype: 'success', uuid, duration_ms: 1, session_id: 's' })
const callsIn = (ws: Workspace) => sdk.calls.filter((c) => c.options.cwd === ws.path)

/** A project with Kai and Noor at work, each handed off from its own Lead tab, and Scout, a helper that can't open a PR. */
async function setup() {
  const repo = await tempRepo({
    'README.md': '# client\n', '.claude/agents/kernel.md': AGENT('kernel', 'lead: true\n'), '.claude/agents/kai.md': AGENT('kai'), '.claude/agents/noor.md': AGENT('noor'),
    '.claude/agents/scout.md': AGENT('scout', 'tools: Read, Grep\n')
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  const project = await k.addProject(repo)
  const lead = await k.leadChat(project.id)
  const other = await k.lead.newLeadChat(project.id, { prompt: '' })
  const kai = await k.createWorkspace(project.id, { prompt: 'Build the export', agentId: 'kai', title: 'Invoice export', leadChatId: lead.id })
  const noor = await k.createWorkspace(project.id, { prompt: 'Build the table', agentId: 'noor', title: 'Invoice table', leadChatId: other.id })
  const posts: { chatId: string; text: string; update?: TeamUpdate }[] = []
  k.sessions.post = (chatId: string, parts: ChatPart[], o: { update?: TeamUpdate } = {}) => { posts.push({ chatId, text: parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), update: o.update }); return true }
  ;(k.leadUpdates as unknown as { d: { delayMs?: number } }).d.delayMs = 20
  const call = async (ws: Workspace, name: 'ask_lead' | 'propose_handoff', input: Record<string, unknown>) => {
    const t = teammateTools(k.waits['teammateToolDeps'](ws.id)).find((x) => x.name === name)!
    const r = await t.handler(input as never, {})
    return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
  }
  const pending = () => (k.store.meta<{ pending: [string, { owner?: string; events: { kind: string; workspaceId: string; question?: unknown; proposal?: unknown }[] }][] }>('leadUpdates')?.pending ?? [])
    .flatMap(([, p]) => p.events.map((e) => ({ ...e, owner: p.owner })))
  return { k, project, lead, other, kai, noor, posts, call, pending }
}

describe('ask_lead', () => {
  it("records the question for the Lead chat that handed the work off, which hears it once the teammate's turn ends", async () => {
    const { k, lead, kai, posts, call, pending } = await setup()
    expect(await call(kai, 'ask_lead', { question: 'Keep drafts per tab or one per chat?', options: ['Per tab', 'One per chat'] }))
      .toEqual({ isError: false, text: 'Kernel passed your question to the Lead. End your turn now. The answer arrives as a message.' })
    expect(pending()).toEqual([expect.objectContaining({ kind: 'question', workspaceId: kai.id, owner: lead.id, question: { text: 'Keep drafts per tab or one per chat?', options: ['Per tab', 'One per chat'] } })])
    // The question waits for the turn the teammate ends right after, so the Lead wakes once for both.
    await new Promise((r) => setTimeout(r, 100))
    expect(posts).toEqual([])
    callsIn(kai)[0].feed(result('r1'))
    await vi.waitFor(() => expect(posts).toHaveLength(1), SLOW)
    const [post] = posts
    expect(post.chatId).toBe(lead.id)
    expect(post.text).toContain('- Asked you: "Keep drafts per tab or one per chat?"\n  Options: "Per tab", "One per chat".\n  Kai ended the turn and waits for your answer.')
    expect(post.text).toContain(`- Answer Kai's question with message_agent (workspace ${kai.id}): from the approved plan if it covers it, otherwise ask the user with ask_user first. Kai waits until you do.`)
    // The question speaks for the turn, so there is no second To do line asking the Lead to read the reply.
    expect(post.text).not.toContain("Read Kai's reply")
    expect(post.update?.rows[0].events).toEqual([
      { kind: 'question', text: 'Asks: Keep drafts per tab or one per chat?', actionable: true },
      { kind: 'turn', text: 'Finished a turn', actionable: false }
    ])
    await k.stop()
  })

  it('refuses an empty question', async () => {
    const { k, kai, call, pending } = await setup()
    expect(await call(kai, 'ask_lead', { question: '  ' })).toEqual({ isError: true, text: 'Not sent: the question is empty.' })
    expect(pending()).toEqual([])
    await k.stop()
  })
})

describe('propose_handoff', () => {
  it("records the proposal for the Lead chat that handed the work off, and wakes it without waiting for the teammate's turn", async () => {
    const { k, lead, other, kai, noor, posts, call, pending } = await setup()
    expect(await call(noor, 'propose_handoff', { agent: 'Kai', task: 'Retry button on failed exports', why: 'Exports are Kai\'s area.' }))
      .toEqual({ isError: false, text: 'Kernel passed your proposal for Kai to the Lead, who asks the user. Carry on with your own work, and leave that task out of it.' })
    expect(pending()).toEqual([expect.objectContaining({ kind: 'handoff.proposed', workspaceId: noor.id, owner: other.id, proposal: { agentId: 'kai', agent: 'Kai', task: 'Retry button on failed exports', why: "Exports are Kai's area." } })])
    await vi.waitFor(() => expect(posts).toHaveLength(1), SLOW)
    const [post] = posts
    // Noor was handed off from the other Lead chat, so it hears, not the one that handed off Kai.
    expect(post.chatId).toBe(other.id)
    expect(other.id).not.toBe(lead.id)
    expect(post.text).toContain(`- Proposed handing a task to Kai (kai): "Retry button on failed exports". Why: Exports are Kai's area. Noor carries on with the rest.`)
    expect(post.text).toContain('- Noor proposes handing "Retry button on failed exports" to Kai. Propose it to the user and ask for a go-ahead. Call create_workspace for it only on a go-ahead that approves it.')
    expect(post.update?.rows[0].events).toEqual([{ kind: 'handoff.proposed', text: 'Proposes Kai for: Retry button on failed exports', actionable: true }])
    // Kernel never creates the workspace itself.
    expect(k.store.workspaces(kai.projectId).filter((w) => w.agentId === 'kai')).toHaveLength(1)
    await k.stop()
  })

  it('refuses an unknown agent, the Lead, a helper and the teammate itself, and records nothing', async () => {
    const { k, kai, call, pending } = await setup()
    const refused = async (agent: string) => { const r = await call(kai, 'propose_handoff', { agent, task: 'Retry button', why: 'Not mine.' }); expect(r.isError).toBe(true); return r.text }
    expect(await refused('ivy')).toMatch(/^Not proposed: no agent "ivy" on this team\. Use an id from list_agents: .*kai.*noor/)
    expect(await refused('scout')).toBe("Not proposed: Scout is a helper in this project and doesn't take tasks.")
    expect(await refused('kai')).toBe('Not proposed: that is you. Carry on with it yourself, or ask the Lead with ask_lead if it is outside your task.')
    expect(await refused('kernel')).toMatch(/^Not proposed: .* is the Lead, who hands work out and builds none\./)
    expect(pending()).toEqual([])
    await k.stop()
  })
})

describe('the rules and Codex', () => {
  it('tells teammates when to use each tool, and the Lead that a proposal needs the user', () => {
    expect(TEAMMATE_RULE).toContain("When you need a decision your brief doesn't cover, call mcp__kernel__ask_lead and end your turn.")
    expect(TEAMMATE_RULE).toContain('call mcp__kernel__propose_handoff and carry on with the rest. The Lead asks the user, so never start that work yourself.')
    expect(LEAD_RULE).toContain('A hand-off a teammate proposes is yours to propose to the user, and needs the same go-ahead.')
    expect(forProvider(TEAMMATE_RULE, 'codex')).toContain('call kernel_ask_lead and end your turn')
    expect(forProvider(TEAMMATE_RULE, 'codex')).toContain('call kernel_propose_handoff')
    expect(TEAMMATE_RULE).not.toMatch(/[–—]/)
  })

  it("gives a Codex teammate both tools as Kernel's dynamic tools", async () => {
    const { k, project, kai } = await setup()
    const agents = await k.agents(project.id)
    const tools = k.tools.codexTools(kai, agents.find((a) => a.id === 'kai'), k.store.chats(kai.id)[0]).tools.map((t) => t.name)
    expect(tools).toEqual(expect.arrayContaining(['ask_lead', 'propose_handoff']))
    await k.stop()
  })
})
