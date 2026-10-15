import { ATTACH_FILE_MAX, ATTACH_FILES_MAX, ATTACH_MESSAGE_MAX, type ChatPart } from '@shared/types'
import { actions } from '../../../store'
import { isLongPaste, pasteLines } from './autocomplete'
import { cleanError } from '../../../api'

// Attachments for every composer: the workspace chat and the new workspace prompt.

const MAX_ATTACH_BYTES = 1024 * 1024
const PASTE_NAME = /^pasted_text_(\d+)\.txt$/
const IMAGE_NAME = /^image(?:-(\d+))?\.[a-z]+$/

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

const pathOf = (file: File) => { try { return window.kernel.pathOf(file) } catch { return '' } }

/** An image, a file on disk by its path, or a text file made in the page, as a message part. Throws a plain sentence when it can't be attached. */
export const PLAN_FILES_ONLY = 'Plan change requests take images and text files only.'

export const PLAN_SEND_BLOCKED = `${PLAN_FILES_ONLY} Remove the other files to send.`

/** The files a plan's change request can't carry: attached by path, with no text of their own. */
export const pathOnlyFiles = (parts: ChatPart[]) => parts.filter((p) => p.type === 'file' && !!p.src && p.text === undefined)

/**
 * `textOnly` is a plan's change request, which carries images and text and no files on disk: a text file under the inline cap is read here,
 * and anything else is refused.
 */
export async function partOf(file: File, textOnly = false): Promise<ChatPart> {
  if (file.type.startsWith('image/')) {
    const dataUrl = await readAsDataUrl(file)
    return { type: 'image', name: file.name || 'image.png', dataUrl, ...(await imageSize(dataUrl)) }
  }
  const src = textOnly ? '' : pathOf(file)
  if (src) return { type: 'file', name: file.name, src, size: file.size }
  if (file.size > MAX_ATTACH_BYTES) throw new Error(textOnly ? PLAN_FILES_ONLY : `${file.name} is too large to attach (${Math.round(file.size / 1024)} KB).`)
  const text = await file.text().catch(() => { throw new Error(textOnly ? PLAN_FILES_ONLY : `Could not read ${file.name}.`) })
  if (text.includes('\0')) throw new Error(textOnly ? PLAN_FILES_ONLY : `${file.name} is a binary file. Attach an image or a text file.`)
  return { type: 'file', name: file.name, lines: pasteLines(text), text }
}

/** The files a composer is still reading, by placeholder id. A cancelled one leaves at once, so the count is right before its read ends. */
export class Held {
  private names = new Map<string, string>()
  get size() { return this.names.size }
  ids() { return [...this.names.keys()] }
  all() { return [...this.names.values()] }
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
  /** The names already in the message, chips and placeholders, which new images are numbered after. */
  taken?: string[]
  /** What the message already holds, files and images, which the count and size caps add to. */
  used?: { count: number; bytes: number }
  /** A plan's change request: files are read as text here, not sent by path. */
  textOnly?: boolean
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

const isFolder = (file: File) => file.slice(0, 1).arrayBuffer().then(() => false, () => true)

/** The files the caps allow, in order. Each refusal gets its own toast naming the cap, and the rest still go. */
async function allowed(files: File[], used = { count: 0, bytes: 0 }, textOnly = false): Promise<File[]> {
  const ok: File[] = []
  let count = used.count
  let bytes = used.bytes
  let full = false
  let over = false
  for (const f of files) {
    const onDisk = !textOnly && !f.type?.startsWith('image/') && !!pathOf(f)
    if (!onDisk && !f.type?.startsWith('image/')) { ok.push(f); continue }
    if (count >= ATTACH_FILES_MAX) { full = true; continue }
    if (f.size > ATTACH_FILE_MAX) {
      actions.ui.toast({ title: 'File is too large', sub: `${f.name} is ${mb(f.size)}. Each file can be up to ${mb(ATTACH_FILE_MAX)}.` })
      continue
    }
    if (bytes + f.size > ATTACH_MESSAGE_MAX) { over = true; continue }
    if (onDisk && await isFolder(f)) {
      actions.ui.toast({ title: `${f.name} is a folder`, sub: 'Attach the files inside instead.' })
      continue
    }
    count++
    bytes += f.size
    ok.push(f)
  }
  if (full) actions.ui.toast({ title: 'Too many files', sub: `A message can hold up to ${ATTACH_FILES_MAX} files.` })
  if (over) actions.ui.toast({ title: 'Message is too large', sub: `Files in one message can add up to ${mb(ATTACH_MESSAGE_MAX)}.` })
  return ok
}

/**
 * Images renamed by their place in the message: image.png, then image-2.png, numbered after the images already in it, so the
 * user can name one in the prompt. Every message starts at image.png. Other files keep their names.
 */
export function numberImages(files: File[], taken: string[] = []): File[] {
  let last = Math.max(0, ...taken.map((name) => { const m = IMAGE_NAME.exec(name); return m ? Number(m[1] ?? 1) : 0 }))
  return files.map((f) => {
    if (!f.type?.startsWith('image/')) return f
    const ext = f.type.slice('image/'.length).replace(/\+.*$/, '').replace('jpeg', 'jpg') || 'png'
    last++
    return new File([f], `${last === 1 ? 'image' : `image-${last}`}.${ext}`, { type: f.type, lastModified: f.lastModified })
  })
}

/**
 * Files as parts, in order. Every file gets its placeholder before the first is read, so the chips show at once and keep the order the
 * files came in. One that can't be attached loses its placeholder and gets a toast, and the rest still go.
 */
export async function attachFiles(files: File[], host: AttachHost, read: (file: File) => Promise<ChatPart> = (f) => partOf(f, host.textOnly)) {
  const held = numberImages(await allowed(files, host.used, host.textOnly), host.taken).map((f) => ({ file: f, id: host.hold(f.name || 'image.png') }))
  for (const { file, id } of held) {
    try { host.settle(id, await read(file)) } catch (e) {
      host.drop(id)
      actions.ui.toast({ title: 'Could not attach', sub: cleanError(e) })
    }
  }
}

/** Images on the clipboard: a screenshot, or images copied in Finder. */
export const clipboardImages = (data: DataTransfer) => [...data.files].filter((f) => f.type?.startsWith('image/'))

/** A paste long enough to become a chip, or null to leave it in the text box. It is numbered after the pastes already in the draft, so every message starts at pasted_text_1. */
export function pastedText(text: string, draft: ChatPart[]): ChatPart | null {
  if (!isLongPaste(text)) return null
  const last = Math.max(0, ...draft.map((p) => (p.type === 'file' ? Number(PASTE_NAME.exec(p.name)?.[1] ?? 0) : 0)))
  return { type: 'file', name: `pasted_text_${last + 1}.txt`, lines: pasteLines(text), text }
}
