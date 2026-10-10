import { createSdkMcpServer, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'

/**
 * The one place Kernel's MCP server gets its name (KERNEL-302). Every agent's server is called `kernel`, whatever tools it
 * carries, so `canUseTool` (sessions.ts) and the hook server's quiet list keep treating `mcp__kernel__*` as Kernel's own.
 */
export const KERNEL_SERVER = 'kernel'

export function kernelServer(tools: SdkMcpToolDefinition<any>[], instructions?: string) {
  // alwaysLoad asks the CLI to load the tools with the prompt. A resumed session still deferred them in the first live run
  // (KERNEL-67), so the hand-off doesn't depend on it.
  return createSdkMcpServer({ name: KERNEL_SERVER, version: '0.1.0', ...(instructions ? { instructions } : {}), alwaysLoad: true, tools })
}
