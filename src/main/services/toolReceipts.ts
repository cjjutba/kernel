import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'

// A retried or replayed Kernel tool call does its work once (docs/decisions/durable-tool-calls.md). The key is the id the
// provider gave the call, so the model never passes one. The first result is stored with it, and a repeat gets that result back.

/** Tools that change nothing. Every other tool of Kernel's is wrapped, so a tool added later is covered until it is listed here. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['list_agents', 'list_workspaces', 'read_plans', 'get_issue'])

/** A result bigger than this isn't stored, and its call runs again when repeated. */
const MAX_RESULT_BYTES = 1_000_000

/**
 * The provider's id for this call, from the handler's `extra`. Claude Code puts the tool_use id in the request's `_meta` as
 * `claudecode/toolUseId`, which the MCP server hands the handler as `extra._meta`. Codex's `callId` is passed in by Kernel's
 * `callTool`. Undefined when the path has none, and the call then runs with no receipt.
 */
export function callIdOf(extra: unknown): string | undefined {
  const e = extra as { callId?: unknown; _meta?: Record<string, unknown> } | undefined
  const id = e?._meta?.['claudecode/toolUseId'] ?? e?.callId
  return typeof id === 'string' && id ? id : undefined
}

export interface ReceiptStore {
  toolReceipt(chatId: string, callId: string): { tool: string; result: string } | undefined
  saveToolReceipt(r: { chatId: string; callId: string; tool: string; result: string }): void
}

type Result = Awaited<ReturnType<SdkMcpToolDefinition<any>['handler']>>

/**
 * `tools` with each side-effecting handler answering a repeat of a call id from its receipt. A call is stored when it returns
 * without `isError` and its turn wasn't stopped, since a refusal did no work and a repeat should try again. Two calls with one
 * id at the same time share one run.
 */
export function withReceipts<T extends SdkMcpToolDefinition<any>>(tools: T[], o: { chatId: string; store: ReceiptStore }): T[] {
  const running = new Map<string, Promise<Result>>()
  return tools.map((t) => {
    if (READ_ONLY_TOOLS.has(t.name)) return t
    return {
      ...t,
      handler: async (args: never, extra: unknown) => {
        const callId = callIdOf(extra)
        if (!callId) return t.handler(args, extra)
        const key = `${o.chatId}\0${callId}`
        const seen = o.store.toolReceipt(o.chatId, callId)
        if (seen?.tool === t.name) {
          try { return JSON.parse(seen.result) as Result } catch { /* unreadable, so it runs again */ }
        }
        const shared = running.get(key)
        if (shared) return shared
        const run = (async () => {
          const result = await t.handler(args, extra)
          const stopped = (extra as { signal?: AbortSignal } | undefined)?.signal?.aborted
          if (!(result as { isError?: boolean }).isError && !stopped) {
            const json = JSON.stringify(result)
            if (json.length <= MAX_RESULT_BYTES) {
              try { o.store.saveToolReceipt({ chatId: o.chatId, callId, tool: t.name, result: json }) } catch (err) { console.warn('[tools] receipt not saved', err) }
            }
          }
          return result
        })().finally(() => running.delete(key))
        running.set(key, run)
        return run
      }
    }
  })
}
