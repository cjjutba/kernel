import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import type { Approval, ChatPart } from '@shared/types'
import { excludeFromGit } from './settings'

/**
 * Plan-mode plans as files (D-092). Each plan is written to `.kernel/plans/plan.md` in its workspace folder, so any chat
 * there can build from it (`@.kernel/plans/plan.md`) after the card is gone: a closed tab, /clear, a restart. The folder
 * goes in `info/exclude` like `.kernel/settings.local.toml`, so a plan never shows in Changes or lands in a PR.
 */
export const PLANS_DIR = '.kernel/plans'

const exists = (path: string) => access(path).then(() => true, () => false)

/**
 * Writes the plan and returns its path relative to `root`. `reuse` is the file an earlier version of the same plan went
 * to (a revision after "Request changes"), which is overwritten. A new plan never overwrites another one: it takes the
 * next free name of `plan.md`, `plan-2.md` and up (KERNEL-767).
 */
export async function savePlan(root: string, text: string, o: { reuse?: string } = {}): Promise<string> {
  await excludeFromGit(root, `${PLANS_DIR}/`)
  await mkdir(join(root, PLANS_DIR), { recursive: true })
  let file = o.reuse && /^\.kernel\/plans\/[^/]+\.md$/.test(o.reuse) ? o.reuse : undefined
  if (!file) {
    for (let n = 1; ; n++) {
      file = `${PLANS_DIR}/${n === 1 ? 'plan' : `plan-${n}`}.md`
      if (!(await exists(join(root, file)))) break
    }
  }
  await writeFile(join(root, file), text.endsWith('\n') ? text : `${text}\n`)
  return file
}

export const planExists = (root: string, file: string) => exists(join(root, file))

/**
 * Where a new plan-mode plan in a chat is saved, from ExitPlanMode or the Lead's request_plan_approval (D-092, KERNEL-373).
 * After "Request changes" the revision overwrites the last plan's file. Once a plan there was approved, the next one gets a
 * file of its own. `approvals` are the room's, newest first, read before the new plan's approval is added.
 */
export function revisedPlanFile(approvals: Approval[], chatId: string): string | undefined {
  const last = approvals.find((a) => a.chatId === chatId && a.kind === 'plan')
  return last && last.status !== 'allowed' ? last.planFile : undefined
}

/**
 * Images sent with a plan's change request (D-134). A denial carries text only, so each image is saved to
 * `.kernel/attachments/` in the workspace, out of git like the plans, and the message names its path for the agent to Read.
 * A chat message's images go there too, so the agent opens each one as a step of its own (KERNEL-545).
 */
export const ATTACHMENTS_DIR = '.kernel/attachments'

/** A base64 image data URL: its media type and data. `toUserMessage` reads chat images with it too. */
export const IMAGE_DATA_URL = /^data:(image\/[a-z+]+);base64,(.*)$/

/**
 * Writes each image under a name of its own (pasted images often all arrive as `image.png`) and returns absolute paths.
 * Every image is checked before any is written, so a refused one leaves no files behind.
 */
export async function saveAttachments(root: string, images: { name: string; dataUrl: string }[]): Promise<string[]> {
  const files = images.map((image) => {
    const m = IMAGE_DATA_URL.exec(image.dataUrl)
    if (!m) throw new Error(`${image.name} isn't an image Kernel can attach.`)
    const ext = m[1].slice('image/'.length).replace(/\+.*$/, '').replace('jpeg', 'jpg')
    const slug = image.name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 60).replace(/-+$/, '')
    return { base: slug || 'image', ext, data: Buffer.from(m[2], 'base64') }
  })
  await excludeFromGit(root, `${ATTACHMENTS_DIR}/`)
  await mkdir(join(root, ATTACHMENTS_DIR), { recursive: true })
  const paths: string[] = []
  for (const { base, ext, data } of files) {
    for (let n = 1; ; n++) {
      const path = join(root, ATTACHMENTS_DIR, `${n === 1 ? base : `${base}-${n}`}.${ext}`)
      // `wx` fails on a taken name, so two requests saving at once never write to the same file.
      try { await writeFile(path, data, { flag: 'wx' }) }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; throw e }
      paths.push(path)
      break
    }
  }
  return paths
}

/** The change request with a line per saved image after what the user typed. */
export const attachmentNote = (message: string | undefined, paths: string[]) =>
  [message?.trim(), paths.map((p) => `Attached image: ${p}. Read it before revising the plan.`).join('\n')].filter(Boolean).join('\n\n')

type ImagePart = ChatPart & { type: 'image' }

/** A chat image Kernel can save that has no file yet. */
const unsaved = (p: ChatPart): p is ImagePart & { dataUrl: string } => p.type === 'image' && !p.path && !!p.dataUrl && IMAGE_DATA_URL.test(p.dataUrl)

export const hasUnsavedImages = (parts: ChatPart[]) => parts.some(unsaved)

/**
 * A chat message with its images saved to `.kernel/attachments/`, each image's `path` relative to `root`, so the agent opens
 * them as files (KERNEL-545). Images that already have a path keep it. When saving fails the parts come back as they were,
 * and the images go inline as before.
 */
export async function withImageFiles(root: string, parts: ChatPart[]): Promise<ChatPart[]> {
  const images = parts.filter(unsaved)
  if (!images.length) return parts
  const paths = await saveAttachments(root, images).catch(() => undefined)
  if (!paths) return parts
  const saved = new Map<ChatPart, string>(images.map((image, i) => [image, relative(root, paths[i])]))
  return parts.map((p) => (p.type === 'image' && saved.has(p) ? { ...p, path: saved.get(p) } : p))
}

/** Where a saved image sat in a chat message: its number in the message, its path and its size. */
export const imageMarker = (n: number, image: ImagePart & { path: string }) =>
  `[Image ${n}: ${image.path}${image.width && image.height ? `, ${image.width}x${image.height}` : ''}]`

/** The line after a message's last part when it has saved images. `tool` is how the agent's own tool for opening one reads. */
export const imagesNote = (count: number, tool: string) =>
  `${count === 1 ? 'Read the attached image' : `Read each of the ${count} attached images`} with ${tool} before answering.`

/** The longest side and the most pixels Claude reads an image at. A larger one is scaled down before it is sent. */
export const IMAGE_MAX_SIDE = 1568
export const IMAGE_MAX_PIXELS = 1_150_000

/** The image types an agent can open, by their first bytes. */
const SIGNATURES: [string, (b: Buffer) => boolean][] = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))],
  ['image/gif', (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP']
]
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

/** An image as the model reads it: its bytes, type and size. */
export interface Scaled { data: Buffer; mime: string; width: number; height: number }

/** Scales an image down to what the model reads, or says what it is when it already fits. Undefined when it can't decode it. */
export type Downscale = (data: Buffer, mime: string) => Promise<Scaled | undefined>

/**
 * Electron's nativeImage, which reads PNG and JPEG. A GIF or WebP it can't read goes as it is. A scaled image stays a JPEG
 * when it was one and is a PNG otherwise. Tests run without Electron's API, where every image goes as it is.
 */
export const nativeDownscale: Downscale = async (data, mime) => {
  const { nativeImage } = await import('electron').catch(() => ({})) as Partial<typeof import('electron')>
  if (!nativeImage?.createFromBuffer) return undefined
  const image = nativeImage.createFromBuffer(data)
  if (image.isEmpty()) return undefined
  const { width, height } = image.getSize()
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(width, height), Math.sqrt(IMAGE_MAX_PIXELS / (width * height)))
  if (scale >= 1) return { data, mime, width, height }
  const small = image.resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), quality: 'best' })
  return { ...(mime === 'image/jpeg' ? { data: small.toJPEG(85), mime } : { data: small.toPNG(), mime: 'image/png' }), ...small.getSize() }
}

/**
 * A chat image part from an image file, scaled down to what the model reads, with its data URL and no path yet: the send
 * saves it to the receiving workspace's `.kernel/attachments/` (`withImageFiles`). Throws the reason when the file isn't a
 * PNG, JPEG, GIF or WebP. The Lead's attached images come through here, and a stored shared file can too.
 */
export async function imagePart(file: string, downscale: Downscale = nativeDownscale): Promise<ImagePart & { dataUrl: string }> {
  const name = basename(file)
  const data = await readFile(file).catch(() => undefined)
  if (!data) throw new Error(`there is no file at ${file}.`)
  const mime = SIGNATURES.find(([, is]) => is(data))?.[0]
  if (!mime) throw new Error(`${name} isn't a PNG, JPEG, GIF or WebP image.`)
  const scaled = await downscale(data, mime).catch(() => undefined)
  const out = scaled ?? { data, mime }
  const ext = out.mime.slice('image/'.length).replace('jpeg', 'jpg')
  return {
    type: 'image', name: name.replace(/\.[^.]*$/, `.${ext}`), dataUrl: `data:${out.mime};base64,${out.data.toString('base64')}`,
    ...(scaled ? { width: scaled.width, height: scaled.height } : {})
  }
}

/**
 * The images the Lead named, from the user's attachments in its own workspace `root`, as chat parts to pass on (KERNEL-658).
 * Every path is checked before any is read, and the first that can't go throws why, so a refused call sends nothing. A path
 * may be relative to `root` or absolute, and a link out of the folder doesn't count as in it.
 */
export async function attachedImages(root: string, paths: string[], downscale?: Downscale): Promise<(ImagePart & { dataUrl: string })[]> {
  const dir = await realpath(join(root, ATTACHMENTS_DIR)).catch(() => undefined)
  const files: string[] = []
  for (const path of paths) {
    const outside = new Error(`${path} isn't in ${ATTACHMENTS_DIR}/ of your workspace. Send only images the user attached in this chat.`)
    if (!dir) throw outside
    const file = await realpath(resolve(root, path)).catch(() => undefined)
    if (!file) throw new Error(`there is no file at ${path}.`)
    if (!file.startsWith(dir + sep)) throw outside
    if (!IMAGE_EXT.test(extname(file))) throw new Error(`${path} isn't a PNG, JPEG, GIF or WebP image.`)
    files.push(file)
  }
  const parts: (ImagePart & { dataUrl: string })[] = []
  for (const file of files) parts.push(await imagePart(file, downscale))
  return parts
}
