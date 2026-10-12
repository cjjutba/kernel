import type { TrackerKind } from './types'

/**
 * The tracker a room uses (KERNEL-462). The room's `[tracker] kind` always wins. Without one, a Linear token plus the room's
 * `[linear] team` means Linear, then a github.com remote means GitHub Issues, and otherwise the room has none. Main builds the
 * room's tracker with it and Settings, Room, General shows what it finds (KERNEL-472), so both read the same rule.
 */
export function trackerKind(o: { kind?: TrackerKind | 'none'; linearToken: boolean; linearTeam: boolean; githubRemote: boolean }): TrackerKind | 'none' {
  if (o.kind) return o.kind
  if (o.linearToken && o.linearTeam) return 'linear'
  return o.githubRemote ? 'github' : 'none'
}
