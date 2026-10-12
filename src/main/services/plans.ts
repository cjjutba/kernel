import { access, mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Approval, ChatPart } from '@shared/types'
import { excludeFromGit } from './settings'

/**
 * Plan-mode plans as files (D-092). Each plan is written to `.kernel/plans/<name>.md` in its workspace folder, so any chat
 * there can build from it (`@.kernel/plans/<name>.md`) after the card is gone: a closed tab, /clear, a restart. The folder
 * goes in `info/exclude` like `.kernel/settings.local.toml`, so a plan never shows in Changes or lands in a PR.
 */
export const PLANS_DIR = '.kernel/plans'

const exists = (path: string) => access(path).then(() => true, () => false)

/** A file name from the plan's opening heading, or from `fallback` when it has none. */
export function planName(text: string, fallback: string): string {
  const first = text.split('\n').find((l) => l.trim())
  const title = /^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/.exec(first ?? '')?.[1] ?? fallback
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 60).replace(/-+$/, '')
  return slug || 'plan'
}

/**
 * Writes the plan and returns its path relative to `root`. `reuse` is the file an earlier version of the same plan went
 * to (a revision after "Request changes"), which is overwritten. A new plan never overwrites another one: it takes the
 * next free name.
 */
export async function savePlan(root: string, text: string, o: { fallback: string; reuse?: string }): Promise<string> {
  await excludeFromGit(root, `${PLANS_DIR}/`)
  await mkdir(join(root, PLANS_DIR), { recursive: true })
  let file = o.reuse && /^\.kernel\/plans\/[^/]+\.md$/.test(o.reuse) ? o.reuse : undefined
  if (!file) {
    const base = planName(text, o.fallback)
    for (let n = 1; ; n++) {
      file = `${PLANS_DIR}/${n === 1 ? base : `${base}-${n}`}.md`
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
