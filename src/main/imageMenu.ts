import { app, dialog, Menu, nativeImage, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What the menu reads from a right-click. */
type ImageParams = Pick<ContextMenuParams, 'mediaType' | 'hasImageContents' | 'srcURL' | 'altText' | 'x' | 'y'>

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/avif': 'avif' }

const DATA_URL = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s

/** The type and bytes of a `data:` URL, or null for any other URL. */
export function decodeDataUrl(url: string): { mime: string; bytes: Buffer } | null {
  const m = DATA_URL.exec(url)
  if (!m) return null
  const base64 = m[2].split(';').includes('base64')
  return { mime: m[1].toLowerCase(), bytes: base64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])) }
}

/**
 * The name the save dialog offers: the alt text, or else the URL's last segment, without its extension and with one from the MIME
 * type. An image tab's alt is a path, so only its last segment counts. With nothing to go on it is `image.png`.
 */
export function imageFileName(params: Pick<ImageParams, 'srcURL' | 'altText'>, mime?: string): string {
  const fromUrl = params.srcURL.startsWith('data:') ? '' : safeDecode(lastSegment(params.srcURL.replace(/[?#].*$/s, '')))
  const base = (lastSegment(params.altText.trim()) || fromUrl).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim()
  return `${base || 'image'}.${(mime && EXTENSIONS[mime]) || 'png'}`
}

function safeDecode(s: string) {
  try { return decodeURIComponent(s) } catch { return s }
}

function lastSegment(path: string) {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The menu for a right-click: Copy Image and Save Image… on an image that has loaded, nothing anywhere else. */
export function imageMenuItems(params: ImageParams, act: { copy(): void; save(): void }): MenuItemConstructorOptions[] {
  if (params.mediaType !== 'image' || !params.hasImageContents) return []
  return [{ label: 'Copy Image', click: act.copy }, { label: 'Save Image…', click: act.save }]
}

/** The image's bytes and type. A `data:` URL keeps its own bytes, and anything else is read by `nativeImage` as a PNG. */
function imageBytes(srcURL: string): { mime: string; bytes: Buffer } {
  const data = decodeDataUrl(srcURL)
  if (data) return data
  const image = srcURL.startsWith('file:') ? nativeImage.createFromPath(fileURLToPath(srcURL)) : nativeImage.createFromDataURL(srcURL)
  if (image.isEmpty()) throw new Error(`could not read the image at ${srcURL.slice(0, 200)}`)
  return { mime: 'image/png', bytes: image.toPNG() }
}

export async function saveImage(wc: WebContents, params: ImageParams) {
  try {
    const { mime, bytes } = imageBytes(params.srcURL)
    const r = await dialog.showSaveDialog({ defaultPath: join(app.getPath('downloads'), imageFileName(params, mime)) })
    if (r.canceled || !r.filePath || wc.isDestroyed()) return
    await writeFile(r.filePath, bytes)
  } catch (err) {
    console.error('[kernel] could not save the image', err)
  }
}

/** Right-click or Ctrl-click on an image opens a native menu to copy or save it (KERNEL-738). Anywhere else nothing opens, as before. */
export function attachImageMenu(wc: WebContents) {
  wc.on('context-menu', (_e, params) => {
    const items = imageMenuItems(params, { copy: () => wc.copyImageAt(params.x, params.y), save: () => void saveImage(wc, params) })
    if (items.length) Menu.buildFromTemplate(items).popup()
  })
}
