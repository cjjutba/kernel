import type { ChatPart } from '@shared/types'

const MAX_ATTACH_BYTES = 1024 * 1024

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
  return { type: 'file', name: file.name, lines: text.split('\n').length, text }
}
