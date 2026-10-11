import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { DynamicToolCallResponse } from './protocol/v2/DynamicToolCallResponse'
import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec'

// Kernel's own tools on Codex (KERNEL-406). The same definitions Claude gets in its `kernel` MCP server go to Codex as
// dynamic tools, named `kernel_<tool>`, and Kernel answers each call in process.

/** What Codex calls one of Kernel's tools. Claude's name for it is `mcp__kernel__<tool>`. */
export const CODEX_TOOL_PREFIX = 'kernel_'

/** Text written for Claude names Kernel's tools `mcp__kernel__<tool>`. Codex reads them as `kernel_<tool>`. */
const codexNames = (text: string) => text.replace(/mcp__kernel__/g, CODEX_TOOL_PREFIX)

/** The dynamic tool specs for Kernel's tools, their input as JSON Schema. */
export function toolSpecs(tools: SdkMcpToolDefinition<any>[]): DynamicToolSpec[] {
  return tools.map((t) => ({ type: 'function' as const, name: `${CODEX_TOOL_PREFIX}${t.name}`, description: codexNames(t.description), inputSchema: z.toJSONSchema(z.object(t.inputSchema)) as never }))
}

/**
 * Runs the tool Codex called and turns its result into Codex's answer. Arguments the schema refuses, an unknown tool and a
 * handler that throws all come back as a failed call with the reason, as the MCP server answers Claude.
 */
export async function callTool(tools: SdkMcpToolDefinition<any>[], name: string, args: unknown): Promise<DynamicToolCallResponse> {
  const fail = (text: string): DynamicToolCallResponse => ({ contentItems: [{ type: 'inputText', text }], success: false })
  const tool = tools.find((t) => `${CODEX_TOOL_PREFIX}${t.name}` === name || t.name === name)
  if (!tool) return fail(`Kernel has no tool called ${name}.`)
  const parsed = z.object(tool.inputSchema).safeParse(args ?? {})
  if (!parsed.success) return fail(`The arguments for ${tool.name} are wrong: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)
  try {
    const result = await tool.handler(parsed.data, {})
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
