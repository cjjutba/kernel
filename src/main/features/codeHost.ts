import type { Room } from '@shared/types'
import type { CodeHost } from '../services/github'
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
}
