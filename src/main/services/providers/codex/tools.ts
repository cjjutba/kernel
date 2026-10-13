import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ToolPolicy } from '../../agentTools'
import type { JsonValue } from './protocol/serde_json/JsonValue'
import type { DynamicToolCallResponse } from './protocol/v2/DynamicToolCallResponse'
import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec'

// Kernel's own tools on Codex (KERNEL-406). The same definitions Claude gets in its `kernel` MCP server go to Codex as
// dynamic tools, named `kernel_<tool>`, and Kernel answers each call in process.

/** What Codex calls one of Kernel's tools. Claude's name for it is `mcp__kernel__<tool>`. */
export const CODEX_TOOL_PREFIX = 'kernel_'

/** Text written for Claude names Kernel's tools `mcp__kernel__<tool>`. Codex reads them as `kernel_<tool>`. */
const codexNames = (text: string) => text.replace(/mcp__kernel__/g, CODEX_TOOL_PREFIX)

/**
 * Kernel's tools under an old name. A resumed thread keeps the tools it started with, so a Lead thread from before the
 * rename still calls the old one, and its card has to show and save all the same (KERNEL-554).
 */
const RENAMED: Record<string, string> = { hire_agent: 'create_agent' }

/** The dynamic tool specs for Kernel's tools, their input as JSON Schema. */
export function toolSpecs(tools: SdkMcpToolDefinition<any>[]): DynamicToolSpec[] {
  return tools.map((t) => ({ type: 'function' as const, name: `${CODEX_TOOL_PREFIX}${t.name}`, description: codexNames(t.description), inputSchema: z.toJSONSchema(z.object(t.inputSchema)) as never }))
}

/**
 * Runs the tool Codex called and turns its result into Codex's answer. Arguments the schema refuses, an unknown tool and a
 * handler that throws all come back as a failed call with the reason, as the MCP server answers Claude. `extra` reaches the
 * handler as the MCP server's does: its `signal` aborts when the turn stops, which ends a card the tool put up (KERNEL-563).
 */
export async function callTool(tools: SdkMcpToolDefinition<any>[], name: string, args: unknown, extra: { signal?: AbortSignal } = {}): Promise<DynamicToolCallResponse> {
  const fail = (text: string): DynamicToolCallResponse => ({ contentItems: [{ type: 'inputText', text }], success: false })
  const bare = name.startsWith(CODEX_TOOL_PREFIX) ? name.slice(CODEX_TOOL_PREFIX.length) : name
  const tool = tools.find((t) => t.name === bare || t.name === name) ?? tools.find((t) => t.name === RENAMED[bare])
  if (!tool) return fail(`Kernel has no tool called ${name}.`)
  const parsed = z.object(tool.inputSchema).safeParse(args ?? {})
  if (!parsed.success) return fail(`The arguments for ${tool.name} are wrong: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
  try {
    const result = await tool.handler(parsed.data, extra)
    // A result can name another tool, as request_plan_approval's "hand it off now" does.
    const items: DynamicToolCallResponse['contentItems'] = (result.content ?? []).flatMap((c: any): DynamicToolCallResponse['contentItems'] => c.type === 'text' ? [{ type: 'inputText', text: codexNames(String(c.text)) }]
      : c.type === 'image' ? [{ type: 'inputImage', imageUrl: `data:${c.mimeType};base64,${c.data}` }]
      : [])
    return { contentItems: items.length ? items : [{ type: 'inputText', text: '' }], success: !result.isError }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

/** The text of a finished call's answer, for its row in the chat. */
export const toolOutput = (items: DynamicToolCallResponse['contentItems'] | null | undefined) => (items ?? []).flatMap((i) => (i.type === 'inputText' ? [i.text] : [])).join('\n')

/** A server name Codex takes in a dotted config key. */
const KEY = /^[A-Za-z0-9_-]+$/

/**
 * An agent file's tools line and disallowedTools as config for the Codex thread, the way Claude Code applies them to a
 * subagent's MCP tools (KERNEL-451). A server the file doesn't reach is switched off, and one it reaches in part keeps
 * only the tools it may use. `servers` is Codex's own `mcp_servers` from config/read: an override that names a server
 * Codex doesn't have fails the thread. Kernel's tools are dynamic tools on Codex, not a server, and every agent keeps them.
 * A server the room switched off (`off`) is off whatever the file says, as on Claude (KERNEL-464). With `unlisted`, a server
 * the tools line leaves out stays on, for Bypass permissions with `unlisted_tools = "ask"` (bypass-allows-unlisted-mcp).
 */
export function mcpOverrides(policy: ToolPolicy | undefined, servers: Record<string, unknown>, off: string[] = [], o: { unlisted?: boolean } = {}): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  if (!policy && !off.length) return out
  for (const [name, raw] of Object.entries(servers)) {
    const own = (raw && typeof raw === 'object' ? raw : {}) as { enabled?: unknown; enabled_tools?: unknown; disabled_tools?: unknown }
    if (!KEY.test(name) || own.enabled === false) continue
    const access = off.includes(name) ? { on: false as const } : policy?.server(name, o) ?? { on: true as const }
    const key = `mcp_servers.${name}`
    // The user's own lists for the server still hold: the file can only narrow them.
    const only = access.on && access.only && Array.isArray(own.enabled_tools) ? access.only.filter((t) => (own.enabled_tools as unknown[]).includes(t)) : access.on ? access.only : []
    if (!access.on || only?.length === 0) { out[`${key}.enabled`] = false; continue }
    if (only) out[`${key}.enabled_tools`] = only
    if (access.except) out[`${key}.disabled_tools`] = [...new Set([...(Array.isArray(own.disabled_tools) ? own.disabled_tools.map(String) : []), ...access.except])]
  }
  return out
}
