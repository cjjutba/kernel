import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SharedFile, SharedKind, SharedVersion, Workspace } from '@shared/types'
import type { Store } from '../db'
import { excludeFromGit } from './settings'

// Files agents share with share_file (KERNEL-302). Kernel checks each one, keeps a copy of every version in
// `<dataDir>/shared/<id>/v<n>/<name>` and records it in `shared_files`. The copies outlive the workspace: archiving leaves
// them, and only removing the room deletes them.

/** Where agents save files to share. It goes in `info/exclude` like `.kernel/plans/`, so a shared file never lands in a PR. */
export const SHARED_DIR = '.kernel/shared'

const MB = 1024 * 1024
/** The most versions one file keeps. */
export const MAX_VERSIONS = 100

/** What each extension claims, the cap for it, and its label in the tool's reply. */
interface Claim { kind: SharedKind; mime: string; cap: number; label: string }
const HTML: Claim = { kind: 'html', mime: 'text/html', cap: 10 * MB, label: 'HTML' }
const MARKDOWN: Claim = { kind: 'markdown', mime: 'text/markdown', cap: 2 * MB, label: 'Markdown' }
const CLAIMS: Record<string, Claim> = {
  '.html': HTML, '.htm': HTML,
  '.md': MARKDOWN, '.markdown': MARKDOWN,
  '.svg': { kind: 'image', mime: 'image/svg+xml', cap: 2 * MB, label: 'SVG' },
  '.png': { kind: 'image', mime: 'image/png', cap: 20 * MB, label: 'PNG' },
  '.jpg': { kind: 'image', mime: 'image/jpeg', cap: 20 * MB, label: 'JPEG' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg', cap: 20 * MB, label: 'JPEG' },
  '.gif': { kind: 'image', mime: 'image/gif', cap: 20 * MB, label: 'GIF' },
  '.webp': { kind: 'image', mime: 'image/webp', cap: 20 * MB, label: 'WebP' },
  '.pdf': { kind: 'pdf', mime: 'application/pdf', cap: 50 * MB, label: 'PDF' }
}

/** What the file's extension claims it is, or undefined for a type Kernel doesn't show. */
export const claimOf = (name: string): Claim | undefined => CLAIMS[extname(name).toLowerCase()]

/** The label for a version's type in the tool's reply: "HTML", "PNG". */
export const labelOf = (mime: string) => Object.values(CLAIMS).find((c) => c.mime === mime)?.label ?? mime

/** A refusal. Its message finishes "Not shared: ". */
export class Refused extends Error {}

const starts = (buf: Uint8Array, sig: number[], at = 0) => buf.length >= at + sig.length && sig.every((b, i) => buf[at + i] === b)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** Whether the first bytes agree with the claimed type. Text types only need to be text here; `textOf` checks UTF-8. */
export function bytesMatch(buf: Uint8Array, mime: string): boolean {
  switch (mime) {
    case 'image/png': return starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/jpeg': return starts(buf, [0xff, 0xd8, 0xff])
    case 'image/gif': return starts(buf, ascii('GIF87a')) || starts(buf, ascii('GIF89a'))
    case 'image/webp': return starts(buf, ascii('RIFF')) && starts(buf, ascii('WEBP'), 8)
    case 'application/pdf': return starts(buf, ascii('%PDF-'))
    // An SVG is XML text whose first element is <svg>, after any declaration, comments and doctype.
    case 'image/svg+xml': {
      if (buf.includes(0)) return false
      const head = Buffer.from(buf.subarray(0, 64 * 1024)).toString('utf8').replace(/^﻿/, '')
      const rest = head.replace(/^(\s+|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, '')
      return /^<svg[\s>/]/i.test(rest)
    }
    default: return !buf.includes(0)
  }
}

/** The bytes as UTF-8 text, or undefined when they aren't UTF-8 or hold a NUL. */
export function textOf(buf: Uint8Array): string | undefined {
  if (buf.includes(0)) return undefined
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '') } catch { return undefined }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m }
  return ENTITIES[e.toLowerCase()] ?? m
})
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 120)

/** The argument, else the HTML's <title>, else the Markdown's first # heading, else the file name. */
export function titleOf(o: { title?: string; kind: SharedKind; text?: string; name: string }): string {
  const given = tidy(o.title ?? '')
  if (given) return given
  if (o.kind === 'html' && o.text) {
    const t = tidy(unescape(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(o.text)?.[1] ?? ''))
    if (t) return t
  }
  if (o.kind === 'markdown' && o.text) {
    const t = tidy(/^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m.exec(o.text)?.[1] ?? '')
    if (t) return t
  }
  return o.name
}

/** Tags whose attributes load something when the page draws, and the attributes that do. A link (`<a href>`) loads nothing. */
const LOADS: Record<string, string[]> = {
  img: ['src', 'srcset'], source: ['src', 'srcset'], script: ['src'], iframe: ['src'], frame: ['src'], embed: ['src'], video: ['src', 'poster'],
  audio: ['src'], track: ['src'], input: ['src'], link: ['href'], object: ['data'], image: ['href', 'xlink:href'], use: ['href', 'xlink:href'], feimage: ['href', 'xlink:href']
}
/** References that load nothing from outside the file. */
const INSIDE = /^\s*(?:$|data:|blob:|#|about:|javascript:)/i

/**
 * The URLs in a srcset. Each is a run without spaces, since a data: URL holds commas of its own; a comma ends it only at
 * its end, and otherwise ends the descriptors after it ("a.png 1x, b.png 2x").
 */
function srcsetUrls(value: string): string[] {
  const urls: string[] = []
  for (let rest = value; (rest = rest.replace(/^[\s,]+/, ''));) {
    const url = /^\S+/.exec(rest)![0]
    rest = rest.slice(url.length)
    if (!url.endsWith(',')) rest = rest.replace(/^[^,]*/, '')
    urls.push(url.replace(/,+$/, ''))
  }
  return urls
}

/**
 * How many references in the HTML would load something from outside the file: another file or the network. The preview
 * has neither, so they won't load. Script that fetches at run time can't be counted.
 */
export function outsideRefs(html: string): number {
  let n = 0
  const count = (url: string) => { if (!INSIDE.test(unescape(url))) n++ }
  for (const tag of html.matchAll(/<([a-z][\w:-]*)\b([^>]*)>/gi)) {
    const attrs = LOADS[tag[1].toLowerCase()]
    if (!attrs) continue
    for (const a of tag[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      const name = a[1].toLowerCase()
      if (!attrs.includes(name)) continue
      const value = a[2] ?? a[3] ?? a[4] ?? ''
      if (name === 'srcset') for (const url of srcsetUrls(value)) count(url)
      else count(value)
    }
  }
  for (const m of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi)) count(m[1] ?? m[2] ?? m[3] ?? '')
  for (const m of html.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) count(m[1] ?? m[2] ?? '')
  return n
}

/** An image's size in pixels from its header, for PNG, JPEG, GIF and WebP. Undefined when the header doesn't say. */
export function imageSize(b: Buffer, mime: string): { width: number; height: number } | undefined {
  try {
    const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined)
    if (mime === 'image/png' && b.length >= 24) return size(b.readUInt32BE(16), b.readUInt32BE(20))
    if (mime === 'image/gif' && b.length >= 10) return size(b.readUInt16LE(6), b.readUInt16LE(8))
    if (mime === 'image/webp' && b.length >= 30) {
      const chunk = b.toString('latin1', 12, 16)
      if (chunk === 'VP8 ') return size(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff)
      if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return size((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1) }
      if (chunk === 'VP8X') return size(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1)
      return undefined
    }
    if (mime === 'image/jpeg') {
      // Walk the segments to the first start-of-frame marker, which holds the size.
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue }
        const m = b[i + 1]
        if (m === 0xff) { i++; continue }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return size(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5))
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
        i += 2 + b.readUInt16BE(i + 2)
      }
    }
  } catch { /* a cut-off header has no size */ }
  return undefined
}

/** "48 KB", "1.2 MB", "312 bytes". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / MB).toFixed(1).replace(/\.0$/, '')} MB`
}

const capLabel = (cap: number) => `${cap / MB} MB`
const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex')

/** What sharing did: a new version, or nothing new because the newest version has the same bytes. */
export type ShareResult =
  | { status: 'shared'; file: SharedFile; version: SharedVersion; label: string }
  | { status: 'same'; file: SharedFile; version: SharedVersion }

export interface ShareRequest { path: string; title?: string; note?: string; chatId?: string }

/** The copies in `<dataDir>/shared` and their rows. One instance per Kernel. */
export class SharedFiles {
  readonly dir: string
  /** The share or thumbnail under way per workspace and source path, so two calls for one file take turns. */
  private locks = new Map<string, Promise<unknown>>()

  constructor(private d: { dataDir: string; store: Store }) { this.dir = join(d.dataDir, 'shared') }

  /**
   * Checks the file and keeps a copy as its next version. Throws Refused, with the reason, when the file can't be shared.
   * `path` is relative to the workspace or absolute, and must be inside the workspace once symlinks are followed.
   */
  async share(ws: Workspace, o: ShareRequest): Promise<ShareResult> {
    const asked = o.path.trim()
    if (!asked) throw new Refused('give the path of the file to share.')
    const root = await realpath(ws.path).catch(() => { throw new Refused("the workspace folder is gone, so there is nothing to share from.") })
    const inside = (p: string) => p === root || p.startsWith(root + sep)
    const outside = () => new Refused(`${asked} is outside this workspace. Save it under ${SHARED_DIR}/ in the workspace and share that.`)
    // The folder as written may differ from its real path (/var and /private/var on a Mac), so a path under the written
    // folder is read from the real one.
    const lexical = isAbsolute(asked) ? resolve(asked) : resolve(root, asked)
    const written = resolve(ws.path)
    const from = lexical === written || lexical.startsWith(written + sep) ? join(root, relative(written, lexical)) : lexical
    if (!inside(from)) throw outside()
    const real = await realpath(from).catch(() => { throw new Refused(`there is no file at ${asked}.`) })
    if (!inside(real)) throw outside()
    const source = relative(root, real).split(sep).join('/')
    await excludeFromGit(root, `${SHARED_DIR}/`).catch(() => undefined)
    return this.locked(`${ws.id}\0${source}`, () => this.add(ws, real, source, o))
  }

  private async add(ws: Workspace, real: string, source: string, o: ShareRequest): Promise<ShareResult> {
    const name = basename(real)
    const s = await stat(real).catch(() => null)
    if (!s) throw new Refused(`there is no file at ${o.path.trim()}.`)
    if (s.isDirectory()) throw new Refused(`${o.path.trim()} is a folder. Share one file.`)
    if (!s.isFile()) throw new Refused(`${o.path.trim()} is not a regular file.`)
    const claim = claimOf(name)
    if (!claim) throw new Refused(`Kernel shows HTML, images (PNG, JPEG, GIF, WebP, SVG), PDF and Markdown, and ${name} is none of these.`)
    const tooBig = (bytes: number) => new Refused(`${name} is ${sizeLabel(bytes)}, over the ${capLabel(claim.cap)} limit for ${claim.label}.`)
    if (s.size > claim.cap) throw tooBig(s.size)
    const buf = await readFile(real).catch((e: Error) => { throw new Refused(`Kernel couldn't read ${name} (${e.message}).`) })
    if (buf.length > claim.cap) throw tooBig(buf.length)
    if (!bytesMatch(buf, claim.mime)) throw new Refused(`${name} doesn't hold ${claim.label} inside, so its contents don't match its extension.`)
    const isText = claim.kind === 'html' || claim.kind === 'markdown'
    const text = isText ? textOf(buf) : undefined
    if (isText && text === undefined) throw new Refused(`${name} isn't UTF-8 text. Save ${claim.label} as UTF-8.`)

    const hash = sha256(buf)
    const old = this.d.store.sharedFileAt(ws.id, source)
    const last = old?.versions.at(-1)
    if (old && last?.sha256 === hash) return { status: 'same', file: old, version: last }
    const title = titleOf({ title: o.title, kind: claim.kind, text, name })
    if (old && old.versions.length >= MAX_VERSIONS) throw new Refused(`"${old.title}" already has ${MAX_VERSIONS} versions. Save it under a new name to share more.`)

    const id = old?.id ?? randomUUID()
    const n = (last?.n ?? 0) + 1
    const now = Date.now()
    const outside = claim.kind === 'html' && text ? outsideRefs(text) : 0
    const version: SharedVersion = {
      n, at: now, file: name, mime: claim.mime, bytes: buf.length, sha256: hash,
      ...(o.chatId ? { chatId: o.chatId } : {}), ...(o.note?.trim() ? { note: o.note.trim() } : {}),
      ...(claim.kind === 'image' ? imageSize(buf, claim.mime) ?? {} : {}), ...(outside ? { outside } : {})
    }
    // The bytes go first, through a temp file, so a row never names a copy that isn't whole.
    try {
      const dir = join(this.folder(id), `v${n}`)
      await mkdir(dir, { recursive: true })
      const tmp = join(this.folder(id), `.v${n}-${randomUUID()}.tmp`)
      await writeFile(tmp, buf)
      await rename(tmp, this.copyPath(id, n, name))
    } catch (e) {
      throw new Refused(`Kernel couldn't copy ${name} (${e instanceof Error ? e.message : String(e)}).`)
    }
    const file: SharedFile = old
      ? { ...old, title, kind: claim.kind, versions: [...old.versions, version], updatedAt: now }
      : { id, roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, source, title, kind: claim.kind, versions: [version], createdAt: now, updatedAt: now }
    this.d.store.saveSharedFile(file)
    return { status: 'shared', file, version, label: claim.label }
  }

  /** The file and one of its versions, with the copy's path. Undefined for a file or version Kernel doesn't have. */
  get(id: string, n: number): { file: SharedFile; version: SharedVersion; path: string } | undefined {
    const file = this.d.store.sharedFile(id)
    const version = file?.versions.find((v) => v.n === n)
    return file && version ? { file, version, path: this.copyPath(id, n, version.file) } : undefined
  }

  /** A version's contents: Markdown and HTML as text, images and PDFs as a data URL. */
  async read(id: string, n: number): Promise<{ kind: SharedKind; mime: string; text?: string; dataUrl?: string }> {
    const got = this.must(id, n)
    const buf = await readFile(got.path).catch(() => { throw new Error("Kernel's copy of this file is gone.") })
    const { kind } = got.file
    const { mime } = got.version
    return kind === 'html' || kind === 'markdown' ? { kind, mime, text: buf.toString('utf8') } : { kind, mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
  }

  /** A version's thumbnail as a PNG data URL, or null when none was captured. */
  async thumb(id: string, n: number): Promise<string | null> {
    const got = this.get(id, n)
    if (!got?.version.thumb) return null
    const buf = await readFile(this.thumbPath(id, n)).catch(() => null)
    return buf ? `data:image/png;base64,${buf.toString('base64')}` : null
  }

  /** Saves a version's thumbnail and marks it on the row. Returns the file as saved, or undefined when the version is gone. */
  async saveThumb(id: string, n: number, png: Buffer): Promise<SharedFile | undefined> {
    const first = this.d.store.sharedFile(id)
    if (!first) return undefined
    return this.locked(`${first.workspaceId}\0${first.source}`, async () => {
      const file = this.d.store.sharedFile(id)
      if (!file?.versions.some((v) => v.n === n)) return undefined
      const tmp = join(this.folder(id), `.thumb-${randomUUID()}.tmp`)
      await writeFile(tmp, png)
      await rename(tmp, this.thumbPath(id, n))
      return this.d.store.saveSharedFile({ ...file, versions: file.versions.map((v) => (v.n === n ? { ...v, thumb: true } : v)) })
    })
  }

  /** What Show in Finder reveals: the source file while it still has this version's bytes, else Kernel's copy. */
  async revealPath(id: string, n: number, ws: Workspace | undefined): Promise<string> {
    const got = this.must(id, n)
    if (ws) {
      const source = join(ws.path, got.file.source)
      const buf = await readFile(source).catch(() => null)
      if (buf && sha256(buf) === got.version.sha256) return source
    }
    return got.path
  }

  /** Deletes the copies of these files, for a room that was removed. Their rows go with the room's. */
  async remove(ids: string[]) {
    for (const id of ids) await rm(this.folder(id), { recursive: true, force: true }).catch(() => undefined)
  }

  private must(id: string, n: number) {
    const got = this.get(id, n)
    if (!got) throw new Error('That shared file or version is gone.')
    return got
  }

  // Ids come from randomUUID and names from basename, so a hand-edited row can't point outside the folder (as RoomIcons).
  private folder(id: string) {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('That shared file is gone.')
    return join(this.dir, id)
  }
  private copyPath(id: string, n: number, file: string) { return join(this.folder(id), `v${Math.trunc(n)}`, basename(file)) }
  /** Beside the version's folder, so it can't clash with the shared file's own name. */
  private thumbPath(id: string, n: number) { return join(this.folder(id), `v${Math.trunc(n)}.thumb.png`) }

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(fn, fn)
    const tail = run.catch(() => undefined)
    this.locks.set(key, tail)
    try { return await run } finally { if (this.locks.get(key) === tail) this.locks.delete(key) }
  }
}
