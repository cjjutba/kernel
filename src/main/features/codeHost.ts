import type { MergeMethod, Room } from '@shared/types'
import type { CodeHost } from '../services/github'
import { localMerge, localStatus } from '../services/localMerge'
import { loadRepoSettings } from '../services/settings'
import { Feature } from './feature'

/** Where each room's pull requests live, so the PR feature asks the room's host and never GitHub by name (KERNEL-453). */
export class CodeHosts extends Feature {
  /**
   * The calls for the room's PRs. GitHub, through `k.github`, unless the room merges locally. It is read through the Kernel
   * each time, so a test that swaps `k.github` reaches every caller. A room that merges locally never reaches GitHub.
   */
  hostFor(room: Pick<Room, 'host' | 'path'>): CodeHost {
    switch (room.host ?? 'github') {
      case 'github': return this.k.github
      case 'local': return this.local(room.path)
    }
  }

  /** How the room's PRs merge: its `[pr] merge_method`, else Settings, Pull requests (KERNEL-432). */
  async methodFor(room: Pick<Room, 'path'>): Promise<MergeMethod> {
    return (await loadRepoSettings(room.path).catch(() => undefined))?.pr?.mergeMethod ?? this.settings.pr.mergeMethod
  }

  /**
   * A room with no GitHub, whose PR is the branch itself, read and merged with git in the room's repo (KERNEL-467). A branch
   * with nothing its base lacks has no PR. One that has is ready, or conflicting, with no number, url or checks. There is
   * nothing to mark ready or reopen.
   */
  private local(repo: string): CodeHost {
    const none = async () => { throw new Error('This room merges on this Mac, so it has no pull request.') }
    const baseOf = (base?: string) => {
      if (!base) throw new Error('A local merge needs the branch it goes into.')
      return base
    }
    return {
      info: async (_cwd, ref, workspaceId, o = {}) => {
        const s = await localStatus(repo, ref, baseOf(o.base))
        if (!s.ahead) return null
        return {
          workspaceId, number: 0, url: '', title: '', state: s.conflicts.length ? 'conflict' : 'ready', baseRef: s.base,
          checks: [], comments: [], conflicts: s.conflicts, head: s.head,
          local: { ahead: s.ahead, behind: s.behind, stat: s.stat, method: await this.methodFor({ path: repo }), ...(s.checkout ? { checkout: s.checkout } : {}) }
        }
      },
      merge: async (_cwd, ref, method, o = {}) => localMerge({ repo, branch: ref, base: baseOf(o.base), method, ...(o.title ? { title: o.title } : {}) }),
      ready: none,
      reopen: none
    }
  }
}
