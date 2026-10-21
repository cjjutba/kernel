import { createSdkMcpServer, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'

/**
 * The one place Kernel's MCP server gets its name (KERNEL-302). Every agent's server is called `kernel`, whatever tools it
 * carries, so `canUseTool` (sessions.ts) and the hook server's quiet list keep treating `mcp__kernel__*` as Kernel's own.
 */
export const KERNEL_SERVER = 'kernel'

/** The meta key Claude Code reads to keep a tool in the prompt instead of behind tool search (`McpSdkServerConfig.alwaysLoad`). */
export const ALWAYS_LOAD = 'anthropic/alwaysLoad'

/**
 * The Lead's tools that stay in its prompt: the ones most sessions call (lean-lead-prompt). The rest load on demand through
 * ToolSearch, which every agent keeps (`ALWAYS` in agentTools.ts), and a deferred tool is called like any other once loaded.
 */
export const LEAD_ALWAYS_LOADED: readonly string[] = ['list_agents', 'list_workspaces', 'create_workspace', 'message_agent', 'request_plan_approval', 'ask_user', 'say']

/**
 * The `kernel` server for a session. With `loaded`, only the tools it names are always in the prompt and the others are
 * deferred behind tool search. Without it every tool is always loaded, which suits a teammate's or reviewer's few tools.
 * alwaysLoad asks the CLI to load the tools with the prompt. A resumed session still deferred them in the first live run
 * (KERNEL-67), so the hand-off doesn't depend on it.
 */
export function kernelServer(tools: SdkMcpToolDefinition<any>[], instructions?: string, o: { loaded?: readonly string[] } = {}) {
  const { loaded } = o
  const sorted = loaded ? tools.map((t) => ({ ...t, _meta: { ...t._meta, [ALWAYS_LOAD]: loaded.includes(t.name) } })) : tools
  return createSdkMcpServer({ name: KERNEL_SERVER, version: '0.1.0', ...(instructions ? { instructions } : {}), ...(loaded ? {} : { alwaysLoad: true }), tools: sorted })
}
