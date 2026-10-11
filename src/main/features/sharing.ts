import type { SharedFile } from '@shared/types'
import { bus } from '../bus'
import type { ShareRequest } from '../services/sharedFiles'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** Files agents share, and their versions (KERNEL-302, KERNEL-329). */
export class Sharing extends Feature {
  /**
   * share_file for a chat: keeps the version, puts its card in the chat, tells the room and the Lead, then asks for a
   * thumbnail. A file with the same bytes as its newest version does none of that. Throws Refused.
   */
  async shareFile(workspaceId: string, chatId: string, o: ShareRequest) {
    const ws = this.mustWs(workspaceId)
    const r = await this.shared.share(ws, { ...o, chatId })
    if (r.status === 'same') return r
    this.sessions.placeShared(chatId, r.file.id, r.version.n)
    bus.push({ type: 'shared', file: r.file })
    this.leadUpdates.shared(ws, r.file, r.version)
    void this.captureThumb(r.file, r.version.n).catch(() => undefined)
    return r
  }

  private async captureThumb(file: SharedFile, n: number) {
    const png = await this.o.capture?.thumbnail(file, n)
    if (!png) return
    const saved = await this.shared.saveThumb(file.id, n, png)
    if (saved) bus.push({ type: 'shared', file: saved })
  }

  /** A shared file's version and the path of Kernel's copy, for the preview host. Undefined when Kernel doesn't have it. */
  sharedFile(id: string, version: number) { return this.shared.get(id, version) }

  handlers() {
    return {
      'shared.list': async ({ roomId, workspaceId, limit }) => this.store.sharedFiles({ roomId, workspaceId, limit }),
      'shared.read': async ({ sharedId, version }) => this.shared.read(sharedId, version),
      'shared.thumb': async ({ sharedId, version }) => this.shared.thumb(sharedId, version),
      'shared.reveal': async ({ sharedId, version }) => {
        const ws = this.store.workspace(this.store.sharedFile(sharedId)?.workspaceId ?? '')
        this.o.reveal?.(await this.shared.revealPath(sharedId, version, ws))
        return { ok: true }
      },
      // Only a PDF, from Kernel's own copy: opening an HTML file or a script by its default app would run it outside the lock.
      'shared.open': async ({ sharedId, version }) => {
        const got = this.shared.get(sharedId, version)
        if (!got) throw new Error('That shared file or version is gone.')
        if (got.file.kind !== 'pdf') throw new Error('Only a PDF opens in Preview.')
        await this.o.openFile?.(got.path)
        return { ok: true }
      }
    } satisfies Partial<Handlers>
  }
}
