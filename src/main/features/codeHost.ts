import type { Room } from '@shared/types'
import type { CodeHost } from '../services/github'
import { remoteRepo } from '../services/worktrees'
import { Feature } from './feature'

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
