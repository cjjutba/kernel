import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
 * Images sent with a plan's change request (D-131). A denial carries text only, so each image is saved to
 * `.kernel/attachments/` in the workspace, out of git like the plans, and the message names its path for the agent to Read.
 */
export const ATTACHMENTS_DIR = '.kernel/attachments'

/** A base64 image data URL: its media type and data. `toUserMessage` reads chat images with it too. */
export const IMAGE_DATA_URL = /^data:(image\/[a-z+]+);base64,(.*)$/

/** Writes each image under a name of its own (pasted images often all arrive as `image.png`) and returns absolute paths. */
export async function saveAttachments(root: string, images: { name: string; dataUrl: string }[]): Promise<string[]> {
  await excludeFromGit(root, `${ATTACHMENTS_DIR}/`)
  await mkdir(join(root, ATTACHMENTS_DIR), { recursive: true })
  const paths: string[] = []
  for (const image of images) {
    const m = IMAGE_DATA_URL.exec(image.dataUrl)
    if (!m) throw new Error(`${image.name} isn't an image Kernel can attach.`)
    const ext = m[1].slice('image/'.length).replace(/\+.*$/, '').replace('jpeg', 'jpg')
    const slug = image.name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 60).replace(/-+$/, '')
    const base = slug || 'image'
    let path = ''
    for (let n = 1; ; n++) {
      path = join(root, ATTACHMENTS_DIR, `${n === 1 ? base : `${base}-${n}`}.${ext}`)
      if (!(await exists(path))) break
    }
    await writeFile(path, Buffer.from(m[2], 'base64'))
    paths.push(path)
  }
  return paths
}

/** The change request with a line per saved image after what the user typed. */
export const attachmentNote = (message: string | undefined, paths: string[]) =>
  [message?.trim(), paths.map((p) => `Attached image: ${p}. Read it before revising the plan.`).join('\n')].filter(Boolean).join('\n\n')
