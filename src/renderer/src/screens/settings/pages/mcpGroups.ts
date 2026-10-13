import type { McpAccountServer, McpServerKind } from '@shared/types'
import { mcpNeedsYou } from '@shared/mcpCounts'

// What the MCP servers page and Set up this account share (KERNEL-661, KERNEL-680): the groups a server falls in and how a state reads.

/** The groups a server falls in, in the order they show. */
export const MCP_GROUPS: { kind: McpServerKind; title: string; note: string }[] = [
  { kind: 'user', title: 'Your servers', note: 'Shared with every account' },
  { kind: 'connector', title: 'claude.ai connectors', note: 'Set up on claude.ai for this account' },
  { kind: 'plugin', title: 'Plugins', note: 'From your Claude Code plugins' }
]

/** One line on what is wrong with a server that needs the user, as the checklist and a row's detail read it. */
export const mcpStatus = (s: McpAccountServer): string =>
  s.state === 'needs-sign-in' ? 'Needs sign-in' : s.state === 'failed' ? `Failed${s.error ? `: ${s.error}` : ''}` : s.kind === 'connector' ? 'Not set up' : s.note ?? 'Not set up'

/** What a row says in place of "Ready" when the server needs the user: the words and whether it is a failure or a missing step. */
export function mcpIssue(s: McpAccountServer): { tone: 'failed' | 'warn'; label: string } | null {
  if (!mcpNeedsYou(s)) return null
  if (s.state === 'failed') return { tone: 'failed', label: 'Failed to start' }
  return { tone: 'warn', label: s.state === 'needs-sign-in' ? 'Needs sign-in' : 'Not set up' }
}

/** A server that is neither ready nor in need: switched off, or off in every room. */
export const mcpIsOff = (s: McpAccountServer): boolean => s.state === 'off' || (!!s.roomOff && s.state !== 'ready' && s.state !== 'ignored')

/** The servers of one group: the ones that need the user first, then the rest in the order they came. */
export function groupServers(servers: McpAccountServer[], kind: McpServerKind, query = ''): McpAccountServer[] {
  const q = query.trim().toLowerCase()
  const list = servers.filter((s) => s.kind === kind && (!q || s.name.toLowerCase().includes(q)))
  return [...list.filter(mcpNeedsYou), ...list.filter((s) => !mcpNeedsYou(s))]
}
