import type { GitHubStatus } from '@shared/types'
import { clock } from '../../screens/workspace/banners/model'

/**
 * The footer's word for a GitHub rate limit holding Kernel's PR reads off (WorkspaceGitHubPaused.png, KERNEL-401), or null
 * while Kernel reads. `why` is the tooltip and the screen reader's description. Main pushes the pause's end; a pause whose
 * time has passed reads as over meanwhile.
 */
export function githubPause(status: GitHubStatus, now: number): { label: string; sub: string; why: string } | null {
  if (!status.pausedUntil || status.pausedUntil <= now) return null
  const at = clock(status.pausedUntil)
  return {
    label: 'GitHub paused',
    sub: `PRs update at ${at}`,
    why: status.slowDown
      ? `GitHub asked Kernel to slow down, so it reads pull requests again at ${at}. Agents keep working.`
      : `GitHub's rate limit is almost used up, so Kernel stopped reading pull requests until ${at}. Agents keep working, and opening a workspace still reads its PR.`
  }
}
