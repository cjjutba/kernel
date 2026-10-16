import { readFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { McpAccount, McpAccountServer, Provider } from '@shared/types'

/**
 * Each account's last MCP check, in `mcp-accounts.json` in Kernel's data folder (KERNEL-936), so Settings, MCP servers opens
 * with it after a restart. Only what the page shows: names, kinds, states, notes and errors. Never a token.
 */
export type SavedMcpAccount = Pick<McpAccount, 'provider' | 'accountId' | 'checkedAt' | 'error' | 'servers'>

/** The file's format. A file with another one is ignored, and the next check writes this one. */
export const MCP_SAVED_VERSION = 1

export const mcpSavedFile = (dataDir: string) => join(dataDir, 'mcp-accounts.json')

/** The saved checks. A missing file, one that doesn't parse, or one of another format version reads as none. */
export function readMcpSaved(file: string): SavedMcpAccount[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; accounts?: unknown }
    if (data?.version !== MCP_SAVED_VERSION || !Array.isArray(data.accounts)) return []
    return data.accounts.flatMap((a): SavedMcpAccount[] => {
      if (!a || (a.provider !== 'claude' && a.provider !== 'codex') || typeof a.accountId !== 'string' || !Array.isArray(a.servers)) return []
      const servers = (a.servers as unknown[]).flatMap((s) => (isServer(s) ? [server(s)] : []))
      return [{ provider: a.provider as Provider, accountId: a.accountId, ...(typeof a.checkedAt === 'number' ? { checkedAt: a.checkedAt } : {}), ...(typeof a.error === 'string' ? { error: a.error } : {}), servers }]
    })
  } catch { return [] }
}

/** Saves the checks through a temp file and a rename, so a crash mid-write leaves the last whole file. */
export async function writeMcpSaved(file: string, accounts: SavedMcpAccount[]): Promise<void> {
  const data = { version: MCP_SAVED_VERSION, accounts: accounts.map((a) => ({ provider: a.provider, accountId: a.accountId, checkedAt: a.checkedAt, error: a.error, servers: a.servers.map(server) })) }
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(tmp, file)
  } catch (e) { await rm(tmp, { force: true }); throw e }
}

const isServer = (s: unknown): s is McpAccountServer => !!s && typeof (s as McpAccountServer).name === 'string' && typeof (s as McpAccountServer).state === 'string' && typeof (s as McpAccountServer).kind === 'string'

/** A server's fields the page shows, and no other, so nothing a provider adds later reaches the file. */
function server(s: McpAccountServer): McpAccountServer {
  return {
    name: s.name, kind: s.kind, connector: s.kind === 'connector', state: s.state,
    ...(typeof s.error === 'string' ? { error: s.error } : {}), ...(typeof s.note === 'string' ? { note: s.note } : {}), ...(typeof s.connectUrl === 'string' ? { connectUrl: s.connectUrl } : {})
  }
}
