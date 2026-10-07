import type { WorkspaceGitStatus } from '@shared/types'
import { exec, git } from './exec'
import { changedFiles } from './worktrees'

// Git facts and actions behind the archive and discard confirmations (ConfirmArchive.png, ConfirmDiscard.png).

const resolves = async (path: string, ref: string) => (await exec('git', ['-C', path, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0

/**
 * What the branch has that the remote doesn't, and what is uncommitted. "Ahead" counts against the upstream, then
 * `origin/<branch>`, then the base the workspace was cut from when the branch was never pushed.
 */
export async function gitStatus(path: string, branch: string, baseRef: string): Promise<WorkspaceGitStatus> {
  const files = await changedFiles(path, 'HEAD')
  const dirty = { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) }
  const upstream = await exec('git', ['-C', path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const candidates = [upstream.code === 0 ? upstream.stdout.trim() : '', `origin/${branch}`, baseRef].filter(Boolean)
  let against: string | undefined
  for (const ref of candidates) if (await resolves(path, ref)) { against = ref; break }
  if (!against) return { branch, ahead: 0, behind: 0, dirty }
  const counts = await exec('git', ['-C', path, 'rev-list', '--left-right', '--count', `${against}...HEAD`])
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map((n) => Number(n) || 0)
  return { branch, ahead: ahead ?? 0, behind: behind ?? 0, dirty }
}

/** Push the branch to origin and track it. Throws with git's own words when it can't. */
export async function pushBranch(path: string, branch: string): Promise<void> {
  await git(path, 'push', '-u', 'origin', branch)
}

/**
 * Throw away every uncommitted change: tracked files go back to HEAD and untracked files are deleted.
 * Ignored files (.env, node_modules) stay, so the worktree still runs.
 */
export async function discardChanges(path: string): Promise<void> {
  await git(path, 'reset', '--hard', 'HEAD')
  await git(path, 'clean', '-fd')
}
