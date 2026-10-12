import type { TrackerKind, WaitsFor, Workspace, WorkspaceMode } from '@shared/types'
import { isMerged } from '@shared/waits'
import { issueTracker } from './trackers'

// Moved to shared so the window names waits as the engine does. Imported from here as before.
export { isMerged, joinLabels, waitLabel } from '@shared/waits'

/**
 * A workspace that waits for other workspaces' PRs to merge (KERNEL-259). Kernel holds its brief, or tells its teammate
 * to rebase, once every PR it waits for has merged. These helpers decide; `kernel.ts` acts.
 */

/** Open workspaces first, then the newest, so an old archived workspace with the same issue or PR loses. */
const best = (list: Workspace[]) => [...list].sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived') || b.createdAt - a.createdAt)[0]

/** `w` builds the issue `key`, in any case, from `tracker` when one is given. */
export const buildsIssue = (w: Workspace, key: string, tracker?: TrackerKind) =>
  w.source?.kind === 'issue' && w.source.id.toLowerCase() === key.toLowerCase() && (!tracker || issueTracker(w.source) === tracker)

/**
 * The workspace `ref` names: its id, its PR as "#164" or "164", or the issue it builds ("KERNEL-197"). GitHub numbers
 * issues and PRs together, so "#41" is also the GitHub issue a workspace builds, by its tracker (KERNEL-470).
 */
export function resolveTarget(workspaces: Workspace[], ref: string): Workspace | undefined {
  const r = ref.trim()
  const byId = workspaces.find((w) => w.id === r)
  if (byId) return byId
  const n = /^#?(\d+)$/.exec(r)?.[1]
  if (n) return best(workspaces.filter((w) => w.prNumber === Number(n) || buildsIssue(w, `#${n}`, 'github')))
  return best(workspaces.filter((w) => buildsIssue(w, r)))
}

/** The workspaces `refs` name, once each. Refs that name nothing are left out; `waitRefusal` reports them. */
export function waitTargets(workspaces: Workspace[], refs: string[]): Workspace[] {
  const out = new Map<string, Workspace>()
  for (const ref of refs) { const t = resolveTarget(workspaces, ref); if (t) out.set(t.id, t) }
  return [...out.values()]
}

/** A target that will never merge now: its PR closed without merging, it was archived without merging, or it is gone. */
export const isBroken = (w: Workspace | undefined) => !w || w.prState === 'closed' || (w.status === 'archived' && w.prState !== 'merged')

/** Every workspace the wait is on has merged. */
export function waitMet(wait: WaitsFor, workspaces: Workspace[]): boolean {
  return wait.on.length > 0 && wait.on.every((id) => isMerged(workspaces.find((w) => w.id === id)))
}

/** The id of a target that will never merge, or nothing while each one still can. */
export function waitBroken(wait: WaitsFor, workspaces: Workspace[]): string | undefined {
  return wait.on.find((id) => isBroken(workspaces.find((w) => w.id === id)))
}

export interface WaitCheck {
  /** The room's workspaces, archived ones included. */
  workspaces: Workspace[]
  refs: string[]
  /** The workspace that would wait. Left out for a hand-off, where it doesn't exist yet. */
  waiter?: Workspace
  /** A hand-off's mode and review_of. A waiter's own are used when it is given. */
  mode?: WorkspaceMode
  reviewOf?: string
  isLead: (w: Workspace) => boolean
  /** The waiter asks for itself (KERNEL-262), so the refusal speaks to a teammate, not the Lead. */
  teammate?: boolean
}

/** Why the wait can't be set, as the end of a tool's refusal, or nothing when it can. */
export function waitRefusal(c: WaitCheck): string | undefined {
  if (c.waiter?.reviewOf ?? c.reviewOf) return 'a review starts from the work it reviews, so it never waits for another PR.'
  if ((c.waiter?.mode ?? c.mode) === 'current') {
    return c.teammate
      ? "you work on the main checkout, which has no branch of its own to rebase later, so you can't wait for a PR. Say in your reply what you are waiting for, and the Lead picks it up."
      : "a workspace on the main checkout has no branch of its own to start later, so it can't wait for a PR. Use worktree mode."
  }
  for (const ref of c.refs) {
    const t = resolveTarget(c.workspaces, ref)
    if (!t) return `there is no workspace "${ref}" in this room to wait for. Pass ${c.teammate ? 'a PR number like #164, an issue key or a workspace id' : 'a workspace id from list_workspaces, a PR number like #164, or an issue key'}.`
    if (c.waiter && t.id === c.waiter.id) return `${t.name} can't wait for itself.`
    if (c.isLead(t)) return `${t.name} is ${c.teammate ? "the Lead's" : 'your own'} workspace, which never opens a pull request.`
    if (t.reviewOf) return `${t.name} is a review. Wait for the work it reviews instead (workspace ${t.reviewOf}).`
    if (t.mode === 'current') return `${t.name} works on the main checkout and never opens a pull request of its own.`
    if (t.prState === 'closed') return `${t.prNumber ? `PR #${t.prNumber}` : `${t.name}'s PR`} was closed without merging, so it will never merge.`
    if (t.status === 'archived' && t.prState !== 'merged') return `${t.name} was archived without merging, so it will never merge.`
    if (c.waiter && reaches(c.workspaces, t.id, c.waiter.id)) return `${t.name} already waits for ${c.waiter.name}, so both would wait forever.`
  }
  return undefined
}

/** Whether `from` waits for `to`, directly or through the workspaces it waits for. */
function reaches(workspaces: Workspace[], from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length) {
    const id = stack.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(workspaces.find((w) => w.id === id)?.waitsFor?.on ?? []))
  }
  return false
}
