import type { Chat, SharedAnchor, SharedFile } from '@shared/types'
import { bus } from '../bus'
import { imagePart, type Downscale } from '../services/plans'
import type { ShareRequest } from '../services/sharedFiles'
import { sendComment, type CommentImage } from '../services/sharedComments'
import type { Handlers } from '../kernel'
import { Feature } from './feature'
import { NEW_CHAT } from './shared'

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

  /**
   * One stored version of a shared image as a chat part the Lead passes on to a teammate, scaled down for the model
   * (KERNEL-659). It reads Kernel's copy of that version, so a later version never changes what was passed on. Throws the
   * reason for a file outside `roomId`, a version Kernel doesn't have, or a file that isn't a PNG, JPEG, GIF or WebP.
   */
  async sharedImage(roomId: string, id: string, version: number, downscale?: Downscale) {
    const file = this.store.sharedFile(id)
    if (!file || file.roomId !== roomId) throw new Error(`there is no shared file ${id} in this room. Use the id a Team update names.`)
    const got = this.shared.get(id, version)
    if (!got) throw new Error(`"${file.title}" has no v${version}. It has ${file.versions.map((v) => `v${v.n}`).join(', ')}.`)
    if (file.kind !== 'image') throw new Error(`"${file.title}" is ${file.kind === 'html' ? 'HTML' : file.kind === 'pdf' ? 'a PDF' : 'Markdown'}. Only shared images can be passed on.`)
    return imagePart(got.path, downscale).catch((e: Error) => {
      throw new Error(e.message.startsWith('there is no file') ? `Kernel's copy of "${file.title}" v${version} is gone.` : `"${file.title}" v${version} isn't a PNG, JPEG, GIF or WebP image.`)
    })
  }

  /**
   * A comment on a shared file, sent to the agent that shared it (KERNEL-310). It goes to the chat that shared the version
   * while that chat is open, else the workspace's first open chat, else a new one, and the Lead's own files go to the
   * Lead's chat. A busy chat or a workspace in setup queues it. Refused for an archived workspace and for a PDF.
   */
  async comment(o: { sharedId: string; version: number; note: string; anchor: SharedAnchor; image?: CommentImage }) {
    const file = this.store.sharedFile(o.sharedId)
    const version = file?.versions.find((v) => v.n === o.version)
    if (!file || !version) throw new Error('That shared file or version is gone.')
    if (file.kind === 'pdf') throw new Error('PDFs take no comments.')
    if (!o.note.trim()) throw new Error('Write a comment first.')
    const chat = await this.commentChat(file, version.chatId)
    const r = await sendComment({ store: this.store, send: (id, parts) => this.sessions.send(id, parts), userSpoke: (id) => this.k.lead.userSpoke(id) }, chat.id, { file, ...o })
    bus.push({ type: 'shared.comment', comment: r.comment })
    return { chatId: chat.id, workspaceId: chat.workspaceId, queued: r.queued, ...(r.why ? { why: r.why } : {}) }
  }

  /** The chat a comment goes to, opened the way the Lead's message_agent opens one when the workspace has none. */
  private async commentChat(file: SharedFile, chatId?: string): Promise<Chat> {
    const ws = this.mustWs(file.workspaceId)
    const was = chatId ? this.store.chat(chatId) : undefined
    const open = was && !was.closed && was.kind !== 'terminal' && was.workspaceId === ws.id ? was : undefined
    // A file a chat with Rowan shared goes back to that chat while it is open, else to the newest open chat (KERNEL-405).
    if (this.isLeadWorkspace(ws)) return (ws.status !== 'archived' && (open ?? this.chatTabs(ws.id).find((c) => c.kind !== 'terminal'))) || this.k.lead.leadChat(ws.roomId)
    const agent = (await this.k.team.agents(ws.roomId)).find((a) => a.id === ws.agentId)
    const name = agent?.name ?? ws.agentId
    if (ws.status === 'archived') throw new Error(`${name}'s workspace is archived, so the comment can't reach ${name}. Restore it from History to send.`)
    return open ?? this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
      ?? this.saveChat(this.newChat(ws.id, NEW_CHAT, { ...(agent ? this.k.team.pickFor(agent) : this.settings.models.roles.engineers), plan: false }))
  }

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
      },
      'shared.comment': async (req) => this.comment(req),
      'shared.comments': async ({ sharedId }) => this.store.sharedComments(sharedId)
    } satisfies Partial<Handlers>
  }
}
