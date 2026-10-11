import { randomUUID } from 'node:crypto'
import type { ChatPart, QueueReason, SharedAnchor, SharedComment, SharedFile } from '@shared/types'
import type { Store } from '../db'
import { slugify } from './worktrees'

// Comments on shared files (KERNEL-310). A comment goes to the agent that shared the file as a plain user message: a text
// part naming the file, version and spot, and the crop around it as an image part. Any harness that takes text and images
// reads it, and the agent answers by sharing the same path again.

/** The crop the renderer took around the spot, attached as the message's image. */
export interface CommentImage { dataUrl: string; width: number; height: number }

/** What a comment says about its spot, after "Where: ". */
export function whereOf(file: SharedFile, version: number, anchor: SharedAnchor): string {
  const at = `at ${Math.round(anchor.x)}, ${Math.round(anchor.y)}`
  if (file.kind === 'markdown') {
    const b = anchor.block
    return b ? `the block "${clip(b.text, 80)}" (block ${b.index}).` : 'the top of the file.'
  }
  if (file.kind === 'image') {
    const width = anchor.viewport?.width ?? file.versions.find((v) => v.n === version)?.width
    return width ? `a point, ${at} in a ${Math.round(width)} px wide image.` : `a point, ${at} in the image.`
  }
  const window = anchor.viewport ? ` in a ${Math.round(anchor.viewport.width)} px wide window` : ''
  const el = anchor.element
  if (!el) return `a point, ${at}${window}.`
  const text = el.text ? ` "${clip(el.text, 120)}"` : ''
  return `the <${el.tag}>${text} (${el.selector}), ${at}${window}.`
}

/** The message's text: the file and version, a word when newer versions exist, the spot, then the note quoted. */
export function commentText(file: SharedFile, version: number, note: string, anchor: SharedAnchor): string {
  const latest = Math.max(...file.versions.map((v) => v.n))
  const since = latest > version ? ` You have shared v${latest} since.` : ''
  const quoted = note.trim().split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')
  return `Comment on "${file.title}" v${version} (${file.source}).${since}\nWhere: ${whereOf(file, version, anchor)}\n${quoted}`
}

/** The message: the text, and the crop as an image part. Markdown sends no image, as its block's text says where. */
export function commentParts(file: SharedFile, version: number, note: string, anchor: SharedAnchor, image?: CommentImage): ChatPart[] {
  const parts: ChatPart[] = [{ type: 'text', text: commentText(file, version, note, anchor) }]
  if (image && file.kind !== 'markdown') parts.push({ type: 'image', name: `${slugify(file.title, 40)}-v${version}-comment.png`, dataUrl: image.dataUrl, width: image.width, height: image.height })
  return parts
}

/** What sending needs from the engine: the session's send, and the Lead's word that the user stepped in. */
export interface CommentDeps {
  store: Store
  send: (chatId: string, parts: ChatPart[]) => Promise<{ queued: boolean; why?: QueueReason }>
  userSpoke: (chatId: string) => void
}

/**
 * Sends a comment into a chat as a plain user message and stores it on its version. `itemId` is the message in the chat,
 * empty when it waits in the queue.
 */
export async function sendComment(d: CommentDeps, chatId: string, o: { file: SharedFile; version: number; note: string; anchor: SharedAnchor; image?: CommentImage }) {
  const parts = commentParts(o.file, o.version, o.note, o.anchor, o.image)
  // The user is stepping in, so the loop guard starts over for this chat's work (KERNEL-125).
  d.userSpoke(chatId)
  const before = lastUser(d.store, chatId)
  const { queued, why } = await d.send(chatId, parts)
  const sent = queued ? undefined : lastUser(d.store, chatId)
  const comment: SharedComment = {
    id: randomUUID(), sharedId: o.file.id, version: o.version, at: Date.now(), note: o.note.trim(), anchor: o.anchor, chatId,
    itemId: sent && sent !== before ? sent : ''
  }
  d.store.saveSharedComment(comment)
  return { comment, queued, why }
}

function lastUser(store: Store, chatId: string) {
  return [...store.items(chatId)].reverse().find((i) => i.kind === 'user')?.id
}

function clip(text: string, max: number) {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.slice(0, max).trimEnd()
}
