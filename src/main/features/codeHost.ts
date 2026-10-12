import type { MergeMethod, Room } from '@shared/types'
import type { CodeHost } from '../services/github'
import { localMerge, localStatus } from '../services/localMerge'
import { loadRepoSettings } from '../services/settings'
import { remoteRepo } from '../services/worktrees'
import { Feature } from './feature'

/** The order Kernel picks a merge method in when the repo doesn't allow the app's. */
const METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase']

/** The app's method when the repo allows it or Kernel couldn't tell, else the first one the repo allows (KERNEL-468). */
export function allowedMethod(app: MergeMethod, allowed?: readonly MergeMethod[]): MergeMethod {
  if (!allowed?.length || allowed.includes(app)) return app
  return METHODS.find((m) => allowed.includes(m)) ?? app
}

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

  /** The merge methods each room's host last said its repo allows, and when, by the room's folder. */
  private allowed = new Map<string, { methods: MergeMethod[]; at: number }>()
  /** How long Kernel goes by the host's last answer before asking again. Tests shorten it. */
  allowedMs = 10 * 60_000

  /**
   * The method the room's PRs merge with, on GitHub and on the Mac alike: its `[pr] merge_method`, else the app's
   * `pr.mergeMethod` if the repo allows it, else the first one the repo allows (KERNEL-468). A host that can't say takes the
   * app's: the local host allows every method, and a GitHub read that failed is asked again next time.
   */
  async methodFor(room: Pick<Room, 'host' | 'path'>): Promise<MergeMethod> {
    const own = (await loadRepoSettings(room.path).catch(() => undefined))?.pr?.mergeMethod
    return own ?? allowedMethod(this.settings.pr.mergeMethod, await this.mergeMethods(room))
  }

  private async mergeMethods(room: Pick<Room, 'host' | 'path'>): Promise<MergeMethod[] | undefined> {
    const last = this.allowed.get(room.path)
    if (last && Date.now() - last.at < this.allowedMs) return last.methods
    const methods = await this.hostFor(room).mergeMethods?.(room.path).catch(() => undefined)
    if (methods?.length) this.allowed.set(room.path, { methods, at: Date.now() })
    return methods
  }

  /** Asks the room's host again next time, as after a merge that failed: the repo's settings may have changed. */
  forgetMergeMethods(room: Pick<Room, 'path'>) { this.allowed.delete(room.path) }

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
          local: { ahead: s.ahead, behind: s.behind, stat: s.stat, method: await this.methodFor({ host: 'local', path: repo }), ...(s.checkout ? { checkout: s.checkout } : {}) }
        }
      },
      merge: async (_cwd, ref, method, o = {}) => localMerge({ repo, branch: ref, base: baseOf(o.base), method, ...(o.title ? { title: o.title } : {}) }),
      ready: none,
      reopen: none
    }
  }

  /**
   * The host a checkout gets at room setup: GitHub when the room's remote (`workspace.remote`, origin by default) is on
   * github.com, and local for a remote anywhere else or none (KERNEL-477).
   */
  async detect(path: string): Promise<{ host: NonNullable<Room['host']>; repo?: string }> {
    const repo = await remoteRepo(path, await this.k.config.remoteFor(path))
    return repo ? { host: 'github', repo } : { host: 'local' }
  }

  /** The Code host line of room setup (RoomSetupGitHub.png, RoomSetupLocal.png). */
  line(room: Pick<Room, 'host' | 'repo'>): string {
    return room.host !== 'local' && room.repo ? `GitHub, ${room.repo}` : 'Local, no GitHub remote. Kernel merges branches on this Mac.'
  }

  /**
   * Whether preflight checks gh: while a room's PRs go to GitHub, a room from before KERNEL-477 with no host included. With
   * no room yet it does too, since the first one may well be a GitHub clone. An archived room opens no PRs.
   */
  usesGitHub(): boolean {
    const open = this.store.rooms().filter((r) => !r.archived)
    return !open.length || open.some((r) => (r.host ?? 'github') === 'github')
  }
}
