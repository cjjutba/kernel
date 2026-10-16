import type { McpAccount, McpAccountServer } from './types'

// One count of what needs the user on an account, for every surface (KERNEL-660).

/** A server that needs the user: needing a sign-in, failed or not set up, and not switched off in every project. `ignored`, `off` and `checking` never do. */
export const mcpNeedsYou = (s: McpAccountServer): boolean => (s.state === 'needs-sign-in' || s.state === 'failed' || s.state === 'not-set-up') && !s.projectOff

/** An account's `needsYou` and `ready` from its servers. A `checking` server is in neither until Claude Code answers (KERNEL-935). */
export const mcpCounts = (servers: McpAccountServer[]): Pick<McpAccount, 'needsYou' | 'ready'> => ({
  needsYou: servers.filter(mcpNeedsYou).length,
  ready: servers.filter((s) => s.state === 'ready').length
})
