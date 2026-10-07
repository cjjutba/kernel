import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Integration, McpServer } from '@shared/types'

// Settings > Integrations (KERNEL-26). The Linear token lives in its own file in the data folder, readable by the user only,
// so it never travels with settings.json or a repo's .kernel folder.

const file = (dataDir: string) => join(dataDir, 'integrations.json')

export async function storedLinearToken(dataDir: string): Promise<string | undefined> {
  try { return (JSON.parse(await readFile(file(dataDir), 'utf8')) as { linearToken?: string }).linearToken?.trim() || undefined } catch { return undefined }
}

/** An empty token removes it. */
export async function saveLinearToken(dataDir: string, token: string) {
  await mkdir(dataDir, { recursive: true })
  const trimmed = token.trim()
  await writeFile(file(dataDir), JSON.stringify(trimmed ? { linearToken: trimmed } : {}, null, 2), { mode: 0o600 })
  await chmod(file(dataDir), 0o600)
}

/** The four rows of the page. GitHub is the signed-in `gh`; Vercel and Remote Control are not built in this version. */
export function integrationRows(o: { ghUser: string | null; linear: boolean }): Integration[] {
  return [
    { id: 'github', name: 'GitHub', connected: !!o.ghUser, detail: o.ghUser ? `Through the GitHub CLI as ${o.ghUser}` : 'Sign in with gh auth login in a terminal' },
    { id: 'linear', name: 'Linear', connected: o.linear, detail: o.linear ? 'Token saved. Create workspaces from issues' : 'Create workspaces from issues' },
    { id: 'vercel', name: 'Vercel', connected: false, detail: 'Preview deployments show up in Checks' },
    { id: 'remote', name: 'Remote Control', connected: false, detail: 'Approvals and briefs from your phone' }
  ]
}

/** MCP servers Claude Code would load for the room: the repo's `.mcp.json` and the user's own list in `~/.claude.json`. Off ones come from the room's settings. */
export async function discoverMcp(root: string, home: string, disabled: string[]): Promise<McpServer[]> {
  const names = async (path: string, pick: (j: any) => unknown): Promise<string[]> => {
    try { const v = pick(JSON.parse(await readFile(path, 'utf8'))); return v && typeof v === 'object' ? Object.keys(v) : [] } catch { return [] }
  }
  const project = await names(join(root, '.mcp.json'), (j) => j.mcpServers)
  const user = await names(join(home, '.claude.json'), (j) => j.mcpServers)
  const out = new Map<string, McpServer>()
  for (const name of project) out.set(name, { name, source: 'project', enabled: !disabled.includes(name) })
  for (const name of user) if (!out.has(name)) out.set(name, { name, source: 'user', enabled: !disabled.includes(name) })
  return [...out.values()]
}
