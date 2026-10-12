import { describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { createSdkMcpServer, query, tool, type AgentDefinition, type HookCallback, type Options, type SDKControlGetContextUsageResponse, type SDKSystemMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { InputQueue, sessionEnv, toUserMessage } from '../src/main/services/providers/claude'
import { tempRepo } from './helpers'

// KERNEL-439: what Claude Code itself enforces when an agent file runs as the main thread through `Options.agent` and
// `agents`, with the options ClaudeRunner passes today: Claude Code's prompt with Kernel's rules appended and an in-process
// `kernel` MCP server. docs/decisions/KERNEL-439.md is the draft these confirm. Haiku turns on the Claude plan, so it
// only runs when asked:
//   KERNEL_LIVE=1 pnpm test test/live.agentOption.test.ts
// The repo is a temp one, and no user, project or local settings load: the user's own servers, agents and hooks would
// change the tool pool under test.

const MODEL = 'claude-haiku-4-5-20251001'
const APPEND = "Kernel's rules follow. The Kernel codeword is OSPREY."

interface Run {
  init: SDKSystemMessage
  said: string
  /** Whether the `kernel` server's tool ran. */
  pinged: boolean
  /** Tools Kernel's PreToolUse hook saw, in order. */
  hooked: string[]
  usage?: SDKControlGetContextUsageResponse
}

/** One turn on a new session, with the agent as its main thread when there is one. */
async function run(o: { agent?: AgentDefinition; prompt: string; usage?: boolean }): Promise<Run> {
  const cwd = await tempRepo()
  const input = new InputQueue<SDKUserMessage>()
  let pinged = false
  const hooked: string[] = []
  const seen: HookCallback = async (h) => {
    if (h.hook_event_name === 'PreToolUse') hooked.push(h.tool_name)
    return {}
  }
  const kernel = createSdkMcpServer({ name: 'kernel', tools: [tool('ping', 'Answers pong.', {}, async () => { pinged = true; return { content: [{ type: 'text', text: 'pong' }] } })] })
  const other = createSdkMcpServer({ name: 'other', tools: [tool('echo', 'Answers echo.', {}, async () => ({ content: [{ type: 'text', text: 'echo' }] }))] })
  const options: Options = {
    cwd,
    model: MODEL,
    settingSources: [],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: APPEND },
    mcpServers: { kernel, other },
    ...(o.agent ? { agent: 'probe', agents: { probe: o.agent } } : {}),
    permissionMode: 'default',
    // Allows every call, so the tool pool is the only thing that can keep a tool from the model.
    canUseTool: async (_name, toolInput) => ({ behavior: 'allow', updatedInput: toolInput }),
    hooks: { PreToolUse: [{ hooks: [seen] }] },
    persistSession: false,
    env: sessionEnv(process.env, {})
  }
  const q = query({ prompt: input, options })
  input.push(toUserMessage([{ type: 'text', text: o.prompt }]))
  let init: SDKSystemMessage | undefined
  let said = ''
  try {
    // Read by hand: leaving a for-await ends the query, and the context usage below needs the process.
    for (;;) {
      const { value: m, done } = await q.next()
      if (done) break
      if (m.type === 'system' && m.subtype === 'init') init = m
      if (m.type === 'result') { said = m.subtype === 'success' ? m.result : ''; break }
    }
    const usage = o.usage ? await q.getContextUsage({ detail: 'summary' }) : undefined
    if (!init) throw new Error('No init message')
    console.log(`[live] agent ${JSON.stringify(o.agent ?? null)}: tools ${JSON.stringify(init.tools)}, servers ${JSON.stringify(init.mcp_servers)}, model ${init.model}, said ${JSON.stringify(said)}, hooked ${JSON.stringify(hooked)}`)
    return { init, said, pinged, hooked, usage }
  } finally {
    input.close()
    q.close()
    await rm(cwd, { recursive: true, force: true })
  }
}

/** The system prompt's tokens, from its sections when the CLI reports them. */
function systemTokens(u: SDKControlGetContextUsageResponse | undefined): number {
  if (u?.systemPromptSections?.length) return u.systemPromptSections.reduce((n, s) => n + s.tokens, 0)
  return u?.categories.find((c) => /system prompt/i.test(c.name))?.tokens ?? 0
}

const probe = (o: Partial<AgentDefinition> = {}): AgentDefinition => ({ description: 'Probe for KERNEL-439.', prompt: 'Reply in one short sentence.', ...o })

describe.skipIf(!process.env.KERNEL_LIVE)('live: the SDK agent option for the main thread', () => {
  it("a tools line is the whole tool pool, and Kernel's tools are in it only when it lists them", { timeout: 300_000 }, async () => {
    const r = await run({ agent: probe({ tools: ['Read', 'Edit', 'mcp__kernel'] }), prompt: 'Reply OK.' })
    expect(r.init.tools).toEqual(expect.arrayContaining(['Read', 'Edit', 'mcp__kernel__ping']))
    // Kernel keeps these for every agent today (KERNEL-397), so a definition it builds would have to list them.
    for (const name of ['Bash', 'Write', 'ExitPlanMode', 'AskUserQuestion', 'mcp__other__echo']) expect(r.init.tools).not.toContain(name)
    // A definition with no model leaves the chat's model alone.
    expect(r.init.model).toBe(MODEL)
  })

  it("a tools line without mcp__kernel hides Kernel's tools while its server stays connected", { timeout: 300_000 }, async () => {
    const r = await run({ agent: probe({ tools: ['Read'] }), prompt: 'Reply OK.' })
    expect(r.init.tools.filter((name) => name.startsWith('mcp__kernel__'))).toEqual([])
    expect(r.init.mcp_servers).toContainEqual(expect.objectContaining({ name: 'kernel', status: 'connected' }))
  })

  it('disallowedTools removes a built-in tool and a whole server', { timeout: 300_000 }, async () => {
    const r = await run({ agent: probe({ disallowedTools: ['Bash', 'mcp__other'] }), prompt: 'Reply OK.' })
    expect(r.init.tools).toEqual(expect.arrayContaining(['Read', 'mcp__kernel__ping']))
    expect(r.init.tools).not.toContain('Bash')
    expect(r.init.tools.filter((name) => name.startsWith('mcp__other__'))).toEqual([])
  })

  it("an agent's mcpServers hides no other server", { timeout: 300_000 }, async () => {
    const r = await run({ agent: probe({ mcpServers: ['kernel'] }), prompt: 'Reply OK.' })
    expect(r.init.tools).toEqual(expect.arrayContaining(['mcp__kernel__ping', 'mcp__other__echo']))
  })

  it("the agent's prompt replaces Claude Code's, and Kernel's appended rules still reach the model", { timeout: 600_000 }, async () => {
    const preset = await run({ prompt: 'Reply OK.', usage: true })
    const agent = await run({
      agent: probe({ prompt: 'The agent codeword is HERON.' }),
      prompt: 'Reply with the agent codeword and the Kernel codeword, separated by one space, and nothing else.',
      usage: true
    })
    console.log(`[live] system prompt tokens: preset ${systemTokens(preset.usage)}, agent ${systemTokens(agent.usage)}`)
    expect(agent.said).toMatch(/HERON/)
    expect(agent.said).toMatch(/OSPREY/)
    expect(systemTokens(preset.usage)).toBeGreaterThan(0)
    expect(systemTokens(agent.usage)).toBeLessThan(systemTokens(preset.usage) / 2)
  })

  it("Kernel's MCP tool and its PreToolUse hook still run under the agent", { timeout: 300_000 }, async () => {
    const r = await run({ agent: probe({ tools: ['mcp__kernel', 'ToolSearch'] }), prompt: 'Call the mcp__kernel__ping tool once, then reply done.' })
    expect(r.pinged).toBe(true)
    expect(r.hooked).toContain('mcp__kernel__ping')
  })
})
