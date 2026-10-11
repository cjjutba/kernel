import type { Workspace } from './types'

/**
 * Who waits for whose PR to merge (KERNEL-259), and the words for it. Pure, so the engine's notes and the window's live
 * lines name the same work the same way.
 */

/** A target's work merged. Only its PR state counts: Continue keeps `mergedAt` from the PR before. */
export const isMerged = (w: Workspace | undefined) => w?.prState === 'merged'

/** "PR #164 by Noor". Before it has a PR, "KERNEL-12 by Noor", or "Noor's work" with no issue. */
export function waitLabel(target: Workspace, name: string): string {
  if (target.prNumber) return `PR #${target.prNumber} by ${name}`
  // Two of one teammate's workspaces read the same as "Noor's work", so the issue says which.
  return target.source?.kind === 'issue' ? `${target.source.id} by ${name}` : `${name}'s work`
}

/** Labels joined for a sentence: "PR #164 by Noor and PR #170 by Ivy". */
export function joinLabels(labels: string[]): string {
  return labels.length <= 2 ? labels.join(' and ') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
}

/** The open workspaces that wait for `id`. */
export function waitersOf(id: string, workspaces: Workspace[]): Workspace[] {
  return workspaces.filter((w) => w.status !== 'archived' && !!w.waitsFor?.on.includes(id))
}

/** What `ws` still waits for: the targets that exist and haven't merged, in the order it waits for them. */
export function waitingOn(ws: Workspace, workspaces: Workspace[]): Workspace[] {
  return (ws.waitsFor?.on ?? []).map((id) => workspaces.find((w) => w.id === id)).filter((t): t is Workspace => !!t && !isMerged(t))
}
