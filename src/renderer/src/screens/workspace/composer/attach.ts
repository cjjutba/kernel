import type { ChatPart } from '@shared/types'
import { actions } from '../../../store'
import { isLongPaste, pasteLines } from './autocomplete'
import { cleanError } from '../../../api'

// Attachments for every composer: the workspace chat and the new workspace prompt.

const MAX_ATTACH_BYTES = 1024 * 1024
const PASTE_NAME = /^pasted_text_(\d+)\.txt$/

const readAsDataUrl = (file: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result))
  r.onerror = () => reject(new Error('Could not read that file.'))
  r.readAsDataURL(file)
})

const imageSize = (src: string) => new Promise<{ width: number; height: number } | undefined>((resolve) => {
  const img = new Image()
  img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
  img.onerror = () => resolve(undefined)
  img.src = src
})

/** An image or a text file as a message part. Throws a plain sentence when it can't be attached. */
export async function partOf(file: File): Promise<ChatPart> {
  if (file.type.startsWith('image/')) {
    const dataUrl = await readAsDataUrl(file)
    return { type: 'image', name: file.name || 'image.png', dataUrl, ...(await imageSize(dataUrl)) }
  }
  if (file.size > MAX_ATTACH_BYTES) throw new Error(`${file.name} is too large to attach (${Math.round(file.size / 1024)} KB).`)
  const text = await file.text()
  if (text.includes('\0')) throw new Error(`${file.name} is a binary file. Attach an image or a text file.`)
  return { type: 'file', name: file.name, lines: pasteLines(text), text }
}

/** The files a composer is still reading, by placeholder id. A cancelled one leaves at once, so the count is right before its read ends. */
export class Held {
  private names = new Map<string, string>()
  get size() { return this.names.size }
  ids() { return [...this.names.keys()] }
  add(id: string, name: string) { this.names.set(id, name) }
  nameOf(id: string) { return this.names.get(id) }
  /** Takes the file out, for a read that ended or a cancel. False when it was already out. */
  release(id: string) { return this.names.delete(id) }
  clear() { this.names.clear() }
}

/** What a composer gives `attachFiles`: a place for each file while it reads, and what to do with it once it is read or fails. */
export interface AttachHost {
  /** Puts a placeholder chip with the file's name at the caret, and returns its id. */
  hold: (name: string) => string
  /** The placeholder becomes the real chip, where it stands. */
  settle: (id: string, part: ChatPart) => void
  /** The placeholder goes. */
  drop: (id: string) => void
}

/**
 * Files as parts, in order. Every file gets its placeholder before the first is read, so the chips show at once and keep the order the
 * files came in. One that can't be attached loses its placeholder and gets a toast, and the rest still go.
 */
export async function attachFiles(files: File[], host: AttachHost, read: (file: File) => Promise<ChatPart> = partOf) {
  const held = files.map((f) => ({ file: f, id: host.hold(f.name || 'image.png') }))
  for (const { file, id } of held) {
    try { host.settle(id, await read(file)) } catch (e) {
      host.drop(id)
      actions.ui.toast({ title: 'Could not attach', sub: cleanError(e) })
    }
  }
}

/** Images on the clipboard: a screenshot, or images copied in Finder. */
export const clipboardImages = (data: DataTransfer) => [...data.files].filter((f) => f.type.startsWith('image/'))

/** A paste long enough to become a chip, or null to leave it in the text box. It is numbered after the pastes already in the draft, so every message starts at pasted_text_1. */
export function pastedText(text: string, draft: ChatPart[]): ChatPart | null {
  if (!isLongPaste(text)) return null
  const last = Math.max(0, ...draft.map((p) => (p.type === 'file' ? Number(PASTE_NAME.exec(p.name)?.[1] ?? 0) : 0)))
  return { type: 'file', name: `pasted_text_${last + 1}.txt`, lines: pasteLines(text), text }
}
