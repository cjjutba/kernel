import type { MergeMethod, Room } from '@shared/types'
import type { CodeHost } from '../services/github'
import { loadRepoSettings } from '../services/settings'
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
   * each time, so a test that swaps `k.github` reaches every caller. Local merge isn't built yet, and a local room must
   * never have its PR merged on GitHub, so it throws.
   */
  hostFor(room: Pick<Room, 'host'>): CodeHost {
    switch (room.host ?? 'github') {
      case 'github': return this.k.github
      case 'local': throw new Error("This room merges locally, which Kernel can't do yet.")
    }
  }

  /** The merge methods each room's host last said its repo allows, and when. */
  private allowed = new Map<string, { methods: MergeMethod[]; at: number }>()
  /** How long Kernel goes by the host's last answer before asking again. Tests shorten it. */
  allowedMs = 10 * 60_000

  /**
   * The method the room's PRs merge with: its `[pr] merge_method`, else the app's `pr.mergeMethod` if the repo allows it,
   * else the first one the repo allows. A repo whose methods can't be read gets the app's (KERNEL-468).
   */
  async mergeMethod(room: Room): Promise<MergeMethod> {
    const own = (await loadRepoSettings(room.path).catch(() => undefined))?.pr?.mergeMethod
    return own ?? allowedMethod(this.settings.pr.mergeMethod, await this.mergeMethods(room))
  }

  private async mergeMethods(room: Room): Promise<MergeMethod[] | undefined> {
    const last = this.allowed.get(room.id)
    if (last && Date.now() - last.at < this.allowedMs) return last.methods
    const methods = await this.hostFor(room).mergeMethods?.(room.path).catch(() => undefined)
    if (methods?.length) this.allowed.set(room.id, { methods, at: Date.now() })
    return methods
  }

  /** Asks the room's host again next time, as after a merge that failed: the repo's settings may have changed. */
  forgetMergeMethods(roomId: string) { this.allowed.delete(roomId) }
}
