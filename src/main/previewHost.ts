import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, protocol, session, WebContentsView, type Session, type WebContents, type WebPreferences } from 'electron'
import type { Channel, KernelApi, PushEvent } from '@shared/ipc'
import type { SharedFile, SharedKind, SharedVersion } from '@shared/types'
import type { Fixture } from '../../fixtures/types'
import { claimOf } from './services/sharedFiles'

// Live previews of shared HTML (KERNEL-303, docs/decisions/KERNEL-303.md). Each open tab gets its own WebContentsView,
// sandboxed, with no preload, in an in-memory session that reaches nothing but one version's bytes. The renderer says
// where the tab is and main draws the view over it. Electron only: Kernel never imports this; index.ts wires it in.

export const PREVIEW_SCHEME = 'kernel-shared'
export const PREVIEW_PARTITION = 'kernel-preview'

/** What every served HTML page runs under: inline code and data: URLs only, and nothing it can fetch, frame, post or submit. */
export const PREVIEW_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline' 'unsafe-eval' blob:", "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:',
  'media-src data: blob:', 'worker-src blob:', "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"
].join('; ')

/** The page a thumbnail draws an image in: the image and nothing else. */
const FRAME_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"
const FRAME_HTML = '<!doctype html><style>html,body{margin:0;height:100%;background:#fff}img{display:block;width:100%;height:100%;object-fit:contain}</style><img src="file" alt="">'

/** Where a preview's requests go if one gets past the filter: a port nothing listens on. */
const DEAD_PROXY = 'http://127.0.0.1:9'
/** Views kept across tab switches. Past this, the least recently used one closes. */
export const MAX_VIEWS = 4
/** How long input, a load or a move must stop before main says a still is worth taking. */
export const SETTLE_MS = 300
/** The thumbnail's page size in CSS pixels, and the width of the image Kernel keeps. */
const THUMB_PAGE = { width: 1280, height: 800 }
const THUMB_WIDTH = 640
/** Capture after the load plus `after`, or at `cap`. Past `deadline` the whole job gives up, capture included. */
export const THUMB_WAIT = { after: 600, cap: 6000, deadline: 8000 }

/** Make the scheme standard and secure before the app is ready. No fetch, CORS, CSP bypass or service workers. */
export function registerPreviewScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, stream: true } }])
}

/** A key event as `before-input-event` reports it. */
export interface KeyInput { type: string; key: string; code: string; meta: boolean; shift: boolean; alt: boolean; control: boolean }

const combo = (i: Pick<KeyInput, 'code' | 'meta' | 'shift' | 'alt' | 'control'>) =>
  [i.control && 'ctrl', i.meta && 'meta', i.alt && 'alt', i.shift && 'shift', i.code].filter(Boolean).join('+')

/** App shortcuts typed in a preview that Kernel runs. ⌘C, ⌘V, ⌘Q and the rest stay with the page or the system. */
const FORWARD = new Set([
  'meta+KeyK', 'meta+KeyN', 'meta+shift+KeyN', 'meta+KeyT', 'meta+shift+KeyT', 'meta+KeyW', 'meta+KeyB', 'meta+alt+KeyB',
  'meta+Backslash', 'meta+Comma', 'meta+BracketLeft', 'meta+BracketRight', 'meta+shift+KeyL', 'meta+shift+KeyP', 'meta+KeyL',
  'meta+shift+Slash',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `meta+Digit${n}`),
  ...[1, 2, 3, 4].map((n) => `ctrl+meta+Digit${n}`)
])

/**
 * What a key typed in a preview does: `forward` it to Kernel, `reload` the preview (⌘R) or `return` focus to Kernel (F6).
 * Null leaves it to the page, and to the menu for ⌘Q, ⌘H and ⌘M.
 */
export function appShortcut(input: KeyInput): 'forward' | 'reload' | 'return' | null {
  if (input.type !== 'keyDown') return null
  const c = combo(input)
  if (FORWARD.has(c)) return 'forward'
  if (c === 'meta+KeyR') return 'reload'
  if (c === 'F6') return 'return'
  return null
}

/** One version's bytes behind a token. `frame` serves an image inside a page, for its thumbnail. */
export interface Served { path: string; mime: string; kind: SharedKind; frame?: boolean }

/**
 * Whether a preview may make this request: its own token's URLs, the blob: URLs its page made, and data: URLs, which
 * the CSP governs. Dev builds also allow DevTools. Everything else is cancelled.
 */
export function allowedUrl(url: string, tokens: { has(token: string): boolean }, dev: boolean): boolean {
  const live = (u: URL) => u.protocol === `${PREVIEW_SCHEME}:` && tokens.has(u.hostname)
  const u = parse(url)
  if (!u) return false
  if (u.protocol === 'data:') return true
  if (u.protocol === 'blob:') { const inner = parse(u.pathname); return !!inner && live(inner) }
  if (u.protocol === 'devtools:') return dev
  return live(u)
}

const parse = (url: string) => { try { return new URL(url) } catch { return null } }

/** What a request to the scheme gets: the version's bytes, the page an image's thumbnail draws in, or nothing. */
export function route(url: string, served: { get(token: string): Served | undefined }): { file: Served } | { frame: Served } | null {
  const u = parse(url)
  const s = u?.protocol === `${PREVIEW_SCHEME}:` ? served.get(u.hostname) : undefined
  if (!u || !s) return null
  if (u.pathname === '/') return s.frame ? { frame: s } : { file: s }
  return s.frame && u.pathname === '/file' ? { file: s } : null
}

/** Headers for a served response. Every type carries the CSP, so an SVG opened on its own can't run its scripts either. */
export function servedHeaders(mime: string, csp = PREVIEW_CSP): Record<string, string> {
  return {
    'content-type': mime.startsWith('text/') ? `${mime}; charset=utf-8` : mime,
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-dns-prefetch-control': 'off',
    'cache-control': 'no-store'
  }
}

export interface Rect { x: number; y: number; width: number; height: number }

/** A rect in the page's CSS pixels as window bounds: scaled by the page's zoom, edges rounded so neighbors meet. */
export function scaleRect(r: Rect, zoom: number): Rect {
  const x = Math.round(r.x * zoom)
  const y = Math.round(r.y * zoom)
  return { x, y, width: Math.max(0, Math.round((r.x + r.width) * zoom) - x), height: Math.max(0, Math.round((r.y + r.height) * zoom) - y) }
}

/** The same locks for every preview and thumbnail. `plugins` stays off: PDFs get no live view (see the decision file). */
const prefs = (dev: boolean, offscreen = false): WebPreferences => ({
  sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
  webviewTag: false, partition: PREVIEW_PARTITION, plugins: false, navigateOnDragDrop: false, safeDialogs: true, spellcheck: false,
  devTools: dev, offscreen
})

/** A page stays where it was loaded: no navigation, redirects, webviews or windows. Hash links still work, as they don't navigate. */
function guard(wc: WebContents) {
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  const stop = (e: { preventDefault(): void }) => e.preventDefault()
  wc.on('will-navigate', stop)
  wc.on('will-frame-navigate', stop)
  wc.on('will-redirect', stop)
  wc.on('will-attach-webview', stop)
}

const token = () => randomBytes(16).toString('hex')
const ok = { ok: true } as const

type PreviewChannel = Extract<Channel, `system.preview.${string}`>
export type PreviewHandlers = { [C in PreviewChannel]: (req: KernelApi[C]['req']) => Promise<KernelApi[C]['res']> }

/** Fixture mode has no live views: `open` returns the fixture's still, or its thumbnail, and the rest do nothing. */
export function previewFixture(f: Fixture): PreviewHandlers {
  return {
    'system.preview.open': async ({ sharedId, version }) => {
      const d = f.sharedData?.[sharedId]?.[version]
      return { viewId: null, still: d?.still ?? d?.thumb ?? null }
    },
    'system.preview.place': async () => ok,
    'system.preview.still': async () => null,
    'system.preview.reload': async () => ok,
    'system.preview.focus': async () => ok,
    'system.preview.close': async () => ok
  }
}

/**
 * For the preview e2e only: finds copies laid out as Kernel keeps them, `<dir>/shared/<id>/v<n>/<name>`, with no database.
 * A fixture run has no kernel to ask.
 */
export function copiesIn(dir: string): PreviewHostOptions['file'] {
  return (id, n) => {
    if (!/^[A-Za-z0-9-]+$/.test(id) || !Number.isInteger(n)) return undefined
    const folder = join(dir, 'shared', id, `v${n}`)
    const name = existsSync(folder) ? readdirSync(folder)[0] : undefined
    const claim = name ? claimOf(name) : undefined
    if (!name || !claim) return undefined
    const version: SharedVersion = { n, at: 0, file: name, mime: claim.mime, bytes: 0, sha256: '' }
    const file: SharedFile = { id, roomId: '', workspaceId: '', agentId: '', source: name, title: name, kind: claim.kind, versions: [version], createdAt: 0, updatedAt: 0 }
    return { file, version, path: join(folder, name) }
  }
}

interface View {
  id: string
  key: string
  view: WebContentsView
  token?: string
  sharedId?: string
  version?: number
  /** Bumped on open and place, for the least recently used. */
  used: number
  still?: string
  settle?: NodeJS.Timeout
}

export interface PreviewHostOptions {
  /** Kernel's window, which views draw in. Null while it is closed. */
  window: () => BrowserWindow | null
  /** A version and the path of Kernel's copy (Kernel.sharedFile). */
  file: (sharedId: string, version: number) => { file: SharedFile; version: SharedVersion; path: string } | undefined
  push: (e: PushEvent) => void
  /** Allows DevTools. True when the app isn't packaged. */
  dev: boolean
}

export class PreviewHost {
  private readonly ses: Session
  private readonly served = new Map<string, Served>()
  private readonly views = new Map<string, View>()
  private readonly ready: Promise<void>
  private thumbs: Promise<unknown> = Promise.resolve()
  private tick = 0

  /** Call once the app is ready. */
  constructor(private readonly o: PreviewHostOptions) {
    const s = (this.ses = session.fromPartition(PREVIEW_PARTITION))
    s.protocol.handle(PREVIEW_SCHEME, (req) => this.serve(req))
    s.webRequest.onBeforeRequest((d, done) => done({ cancel: !allowedUrl(d.url, this.served, o.dev) }))
    s.setPermissionRequestHandler((_wc, _permission, done) => done(false))
    s.setPermissionCheckHandler(() => false)
    s.setDevicePermissionHandler(() => false)
    s.setDisplayMediaRequestHandler((_req, done) => done({}))
    s.on('will-download', (e, item) => { e.preventDefault(); item.cancel() })
    s.setSpellCheckerEnabled(false)
    // Loopback is normally exempt from a proxy. `<-loopback>` sends it to the dead port too.
    this.ready = s.setProxy({ proxyRules: DEAD_PROXY, proxyBypassRules: '<-loopback>' })
  }

  handlers(): PreviewHandlers {
    return {
      'system.preview.open': (req) => this.open(req),
      'system.preview.place': async ({ viewId, rect }) => { this.place(viewId, rect); return ok },
      'system.preview.still': ({ viewId }) => this.still(viewId),
      'system.preview.reload': async ({ viewId }) => { this.live(viewId)?.view.webContents.reload(); return ok },
      'system.preview.focus': async ({ viewId }) => { this.live(viewId)?.view.webContents.focus(); return ok },
      'system.preview.close': async ({ viewId }) => { const v = this.views.get(viewId); if (v) this.drop(v); return ok }
    }
  }

  async open({ sharedId, version, key }: KernelApi['system.preview.open']['req']): Promise<KernelApi['system.preview.open']['res']> {
    const got = this.o.file(sharedId, version)
    if (!got) throw new Error('That shared file or version is gone.')
    if (got.file.kind !== 'html') return { viewId: null, still: null }
    await this.ready
    const w = this.o.window()
    if (!w) throw new Error('Kernel has no window to show the preview in.')
    let v = [...this.views.values()].find((x) => x.key === key)
    if (v && v.view.webContents.isDestroyed()) { this.drop(v); v = undefined }
    v ??= this.create(key, w)
    v.used = ++this.tick
    if (v.sharedId !== sharedId || v.version !== version) this.load(v, got)
    this.evict(v)
    return { viewId: v.id, still: v.still ?? null }
  }

  place(viewId: string, rect: Rect | null) {
    const v = this.live(viewId)
    if (!v) return
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return v.view.setVisible(false)
    v.view.setBounds(scaleRect(rect, this.o.window()?.webContents.getZoomFactor() ?? 1))
    v.view.setVisible(true)
    v.used = ++this.tick
    this.settleSoon(v)
  }

  /** The view as it is now, drawn even while hidden. */
  async still(viewId: string): Promise<string | null> {
    const v = this.live(viewId)
    if (!v) return null
    const img = await v.view.webContents.capturePage(undefined, { stayHidden: true }).catch(() => null)
    if (!img || img.isEmpty()) return null
    v.still = `data:image/jpeg;base64,${img.toJPEG(85).toString('base64')}`
    return v.still
  }

  /** Closes every view, when Kernel's window closes. */
  closeAll() {
    for (const v of [...this.views.values()]) this.drop(v)
  }

  /**
   * A PNG of the version for its card, 640 px wide, or null for PDF and Markdown. Drawn one at a time in an offscreen
   * window with the same locks, after the load plus 600 ms, or at 6 s if it never finishes. A page that hangs or crashes
   * gets null by the 8 s deadline, so the queue moves on.
   */
  thumbnail(file: SharedFile, n: number): Promise<Buffer | null> {
    if (file.kind !== 'html' && file.kind !== 'image') return Promise.resolve(null)
    const got = this.o.file(file.id, n)
    if (!got) return Promise.resolve(null)
    const run = this.thumbs.then(() => this.drawThumb(got))
    this.thumbs = run.catch(() => undefined)
    return run
  }

  private async drawThumb(got: { file: SharedFile; version: SharedVersion; path: string }): Promise<Buffer | null> {
    await this.ready
    const t = token()
    this.served.set(t, { path: got.path, mime: got.version.mime, kind: got.file.kind, frame: got.file.kind === 'image' })
    // An offscreen window renders without Kernel's window, which may be closed. It joins getAllWindows(), so index.ts
    // sends events and focus to Kernel's window by name, never to the first window.
    const w = new BrowserWindow({ show: false, ...THUMB_PAGE, webPreferences: prefs(this.o.dev, true) })
    const wc = w.webContents
    const timers: NodeJS.Timeout[] = []
    let hung = false
    // A page that loops before its first paint never lets capturePage resolve, so the deadline covers the capture too.
    const stopped = new Promise<null>((resolve) => {
      const stop = () => { hung = true; resolve(null) }
      timers.push(setTimeout(stop, THUMB_WAIT.deadline))
      wc.once('unresponsive', stop)
      wc.once('render-process-gone', stop)
    })
    try {
      guard(wc)
      const settled = new Promise<void>((resolve) => {
        timers.push(setTimeout(resolve, THUMB_WAIT.cap))
        wc.once('did-finish-load', () => timers.push(setTimeout(resolve, THUMB_WAIT.after)))
      })
      void wc.loadURL(`${PREVIEW_SCHEME}://${t}/`).catch(() => undefined)
      const drawn = settled.then(() => wc.capturePage())
        .then((img) => (img.isEmpty() ? null : img.resize({ width: THUMB_WIDTH, quality: 'good' }).toPNG()), () => null)
      return await Promise.race([stopped, drawn])
    } finally {
      for (const timer of timers) clearTimeout(timer)
      this.served.delete(t)
      // Closing a window doesn't stop a renderer stuck in a loop, so a hung page's process is killed first. Only then:
      // a renderer that answered may host another preview.
      if (hung && !wc.isDestroyed()) wc.forcefullyCrashRenderer()
      if (!w.isDestroyed()) w.destroy()
    }
  }

  private async serve(req: Request): Promise<Response> {
    const hit = route(req.url, this.served)
    if (!hit) return new Response('Not found', { status: 404 })
    if ('frame' in hit) return new Response(FRAME_HTML, { headers: servedHeaders('text/html', FRAME_CSP) })
    const body = await readFile(hit.file.path).catch(() => null)
    if (!body) return new Response('Not found', { status: 404 })
    return new Response(body, { headers: servedHeaders(hit.file.mime) })
  }

  private create(key: string, w: BrowserWindow): View {
    const view = new WebContentsView({ webPreferences: prefs(this.o.dev) })
    const v: View = { id: randomUUID(), key, view, used: 0 }
    const wc = view.webContents
    guard(wc)
    const state = (s: Extract<PushEvent, { type: 'preview' }>['state']) => this.o.push({ type: 'preview', viewId: v.id, state: s })
    wc.on('did-start-loading', () => state('loading'))
    wc.on('did-finish-load', () => { state('ready'); this.settleSoon(v) })
    wc.on('render-process-gone', () => state('crashed'))
    wc.on('unresponsive', () => state('unresponsive'))
    wc.on('responsive', () => state('ready'))
    wc.on('input-event', () => this.settleSoon(v))
    wc.on('before-input-event', (e, input) => {
      const act = appShortcut(input)
      if (!act) return
      e.preventDefault()
      if (act === 'reload') return wc.reload()
      this.o.window()?.webContents.focus()
      // F6 is pushed too, so the tab can put focus on its frame. Nothing else in the app runs it.
      this.o.push({ type: 'preview.key', key: input.key, code: input.code, meta: input.meta, shift: input.shift, alt: input.alt, ctrl: input.control })
    })
    view.setVisible(false)
    w.contentView.addChildView(view)
    this.views.set(v.id, v)
    return v
  }

  /** Points the view at a version under a fresh token. The old token stops serving at once. */
  private load(v: View, got: { file: SharedFile; version: SharedVersion; path: string }) {
    if (v.token) this.served.delete(v.token)
    v.token = token()
    v.sharedId = got.file.id
    v.version = got.version.n
    v.still = undefined
    this.served.set(v.token, { path: got.path, mime: got.version.mime, kind: got.file.kind })
    void v.view.webContents.loadURL(`${PREVIEW_SCHEME}://${v.token}/`).catch(() => undefined)
  }

  private settleSoon(v: View) {
    clearTimeout(v.settle)
    v.settle = setTimeout(() => { if (this.views.has(v.id)) this.o.push({ type: 'preview', viewId: v.id, state: 'settled' }) }, SETTLE_MS)
  }

  private evict(keep: View) {
    while (this.views.size > MAX_VIEWS) {
      const oldest = [...this.views.values()].filter((x) => x !== keep).sort((a, b) => a.used - b.used)[0]
      if (!oldest) return
      this.drop(oldest)
    }
  }

  private live(viewId: string): View | undefined {
    const v = this.views.get(viewId)
    if (v && v.view.webContents.isDestroyed()) { this.drop(v); return undefined }
    return v
  }

  private drop(v: View) {
    clearTimeout(v.settle)
    this.views.delete(v.id)
    if (v.token) this.served.delete(v.token)
    const w = this.o.window()
    if (w && !w.isDestroyed()) w.contentView.removeChildView(v.view)
    if (!v.view.webContents.isDestroyed()) v.view.webContents.close()
  }
}
