import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Room } from '@shared/types'
import { exec, type ExecResult } from './exec'

// Room icons (KERNEL-241): the GitHub owner's avatar or a picked PNG or JPEG, stored as downloaded in the data folder.
// Grayscale is the renderer's job. nativeImage isn't available in tests, so the checks read magic bytes.

export const ICON_MAX_BYTES = 2 * 1024 * 1024
export const AVATAR_FAILED = "Couldn't get the GitHub avatar. The room keeps its letter."
export const NOT_AN_IMAGE = 'Pick a PNG or JPEG image.'
export const TOO_BIG = 'That image is over 2 MB. Pick a smaller one.'

type Ext = 'png' | 'jpg'
const MIME: Record<Ext, string> = { png: 'image/png', jpg: 'image/jpeg' }
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]

/** png or jpg from the file's first bytes, or null for anything else. */
export function imageType(buf: Uint8Array): Ext | null {
  const starts = (sig: number[]) => buf.length >= sig.length && sig.every((b, i) => buf[i] === b)
  return starts(PNG) ? 'png' : starts(JPEG) ? 'jpg' : null
}

/** Throws a plain error unless the bytes are a PNG or JPEG of 2 MB or less. */
export function checkImage(buf: Uint8Array): Ext {
  if (buf.length > ICON_MAX_BYTES) throw new Error(TOO_BIG)
  const ext = imageType(buf)
  if (!ext) throw new Error(NOT_AN_IMAGE)
  return ext
}

/** The owner in `owner/repo`, or null for a room that isn't on GitHub. */
export function githubOwner(repo?: string): string | null {
  const owner = repo?.split('/')[0]
  return owner && /^[A-Za-z0-9-]+$/.test(owner) ? owner : null
}

export interface AvatarDeps {
  /** Runs `gh` with these args. Tests pass a stub. */
  gh?: (args: string[]) => Promise<ExecResult>
  fetch?: typeof fetch
}

/**
 * The owner's avatar at 128 px, user or org. `gh api users/<owner>` answers for both.
 * No gh, no network or a bad answer all throw AVATAR_FAILED.
 */
export async function githubAvatar(owner: string, deps: AvatarDeps = {}): Promise<Buffer> {
  const gh = deps.gh ?? ((args) => exec('gh', args, { timeoutMs: 15_000 }))
  const get = deps.fetch ?? fetch
  try {
    const r = await gh(['api', `users/${owner}`, '--jq', '.avatar_url'])
    const url = r.stdout.trim()
    if (r.code !== 0 || !/^https:\/\//.test(url)) throw new Error(AVATAR_FAILED)
    const res = await get(`${url}${url.includes('?') ? '&' : '?'}s=128`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(AVATAR_FAILED)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > ICON_MAX_BYTES || !imageType(buf)) throw new Error(AVATAR_FAILED)
    return buf
  } catch {
    throw new Error(AVATAR_FAILED)
  }
}

/** Reads a picked file, refusing anything that isn't a PNG or JPEG of 2 MB or less before reading it whole. */
export async function readImage(path: string): Promise<Buffer> {
  const s = await stat(path).catch(() => null)
  if (!s?.isFile()) throw new Error("Couldn't read that file. Pick it again.")
  if (s.size > ICON_MAX_BYTES) throw new Error(TOO_BIG)
  const buf = await readFile(path)
  checkImage(buf)
  return buf
}

/** The icon files in `<dataDir>/room-icons`, one per room, named `<roomId>-<at>.<ext>`. */
export class RoomIcons {
  readonly dir: string
  constructor(dataDir: string) { this.dir = join(dataDir, 'room-icons') }

  /** Writes the image and returns the icon for the room. `at` is always past the old icon's, so the new file never overwrites it. */
  async save(roomId: string, kind: 'github' | 'image', buf: Buffer, old?: Room['icon']): Promise<NonNullable<Room['icon']>> {
    const ext = checkImage(buf)
    const at = Math.max(Date.now(), (old?.at ?? 0) + 1)
    const file = `${roomId}-${at}.${ext}`
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, file), buf)
    return { kind, file, at }
  }

  async remove(icon?: Room['icon']) {
    if (icon) await rm(this.path(icon.file), { force: true })
  }

  /** The icon as a data URL, or null for no icon or a file that has gone. */
  async dataUrl(icon?: Room['icon']): Promise<string | null> {
    if (!icon) return null
    const buf = await readFile(this.path(icon.file)).catch(() => null)
    const ext = buf && imageType(buf)
    return ext ? `data:${MIME[ext]};base64,${buf.toString('base64')}` : null
  }

  /** basename keeps a hand-edited file name inside the folder. */
  private path(file: string) { return join(this.dir, basename(file)) }
}
