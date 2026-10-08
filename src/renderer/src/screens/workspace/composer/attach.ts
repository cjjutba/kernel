import type { ChatPart } from '@shared/types'
import { actions } from '../../../store'
import { isLongPaste, pasteLines } from './autocomplete'

// Attachments for every composer: the workspace chat, the new workspace prompt and the floor brief.

const MAX_ATTACH_BYTES = 1024 * 1024
let pasteCount = 1

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

/** Files as parts, in order. One that can't be attached gets a toast and the rest still go. */
export async function attachFiles(files: File[], add: (part: ChatPart) => void) {
  for (const f of files) {
    try { add(await partOf(f)) } catch (e) { actions.ui.toast({ title: 'Could not attach', sub: (e as Error).message }) }
  }
}

/** Images on the clipboard: a screenshot, or images copied in Finder. */
export const clipboardImages = (data: DataTransfer) => [...data.files].filter((f) => f.type.startsWith('image/'))

/** A paste long enough to become a chip, or null to leave it in the text box. */
export const pastedText = (text: string): ChatPart | null =>
  isLongPaste(text) ? { type: 'file', name: `pasted_text_${pasteCount++}.txt`, lines: pasteLines(text), text } : null
