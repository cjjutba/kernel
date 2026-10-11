import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, protocol, session, WebContentsView, type Session, type WebContents, type WebPreferences } from 'electron'
import type { Channel, KernelApi, PushEvent } from '@shared/ipc'
import type { SharedAnchor, SharedFile, SharedKind, SharedVersion } from '@shared/types'
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
  'meta+shift+Slash', 'meta+shift+KeyM', 'meta+shift+KeyF', 'meta+shift+KeyA',
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

// Pinning comments (KERNEL-310). The scripts run in an isolated world: they share the page's DOM but not its globals, so
// the page's own scripts can't see them, patch what they call or fake what they return.
export const PIN_WORLD = 999
/** The space a crop keeps around what was pinned, and the smallest and largest crop, in the page's CSS pixels. */
export const CROP = { pad: 24, min: { width: 320, height: 200 }, max: { width: 1200, height: 800 } }
/** The deepest selector chain `hit` builds. */
export const SELECTOR_DEPTH = 8

/**
 * `selectorOf(el)`, as page code: the element's id when the document has no other with it, else a chain of at most 8
 * steps up to an ancestor with such an id or to `body`. A step is the tag, up to two plain class names, and
 * `:nth-of-type(n)` when a sibling shares the tag. A string, so the build can't rename or wrap anything inside it.
 */
export const SELECTOR_JS = `function selectorOf(el) {
  var esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : function (s) {
    return String(s).replace(/[^\\w-]/g, function (c) { return '\\\\' + c }).replace(/^-?\\d/, function (c) { return c.slice(0, -1) + '\\\\3' + c.slice(-1) + ' ' })
  }
  var doc = el.ownerDocument
  var unique = function (n) { return !!n.id && doc.querySelectorAll('#' + esc(n.id)).length === 1 }
  if (unique(el)) return '#' + esc(el.id)
  var steps = []
  for (var n = el; n && n.tagName && steps.length < ${SELECTOR_DEPTH}; n = n.parentElement) {
    var tag = n.tagName.toLowerCase()
    if (tag === 'body' || tag === 'html') break
    if (steps.length && unique(n)) { steps.unshift('#' + esc(n.id)); break }
    var step = tag
    var classes = (typeof n.className === 'string' ? n.className : '').split(/\\s+/).filter(function (c) { return /^[A-Za-z_][\\w-]*$/.test(c) }).slice(0, 2)
    for (var i = 0; i < classes.length; i++) step += '.' + classes[i]
    var p = n.parentElement
    if (p) {
      var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === n.tagName })
      if (same.length > 1) step += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'
    }
    steps.unshift(step)
  }
  return steps.join(' > ')
}`

/** Page code: what is under a point in the page's CSS pixels, as an anchor. Over the page itself, the point alone. */
export function hitJs(x: number, y: number) {
  return `(() => {
  ${SELECTOR_JS}
  var x = ${Number(x)}, y = ${Number(y)}
  var viewport = { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY) }
  var el = document.elementFromPoint(x, y)
  if (!el || el === document.documentElement || el === document.body) return { x: x, y: y, viewport: viewport }
  var r = el.getBoundingClientRect()
  var text = (el.getAttribute('aria-label') || el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
  var element = { selector: selectorOf(el), tag: el.tagName.toLowerCase(), rect: { x: r.x, y: r.y, width: r.width, height: r.height } }
  if (text) element.text = text
  return { x: x, y: y, viewport: viewport, element: element }
})()`
}

/** Page code: each selector's element rect in the page's CSS pixels, null for one that matches nothing or isn't drawn. */
export function locateJs(selectors: string[]) {
  return `(() => ${JSON.stringify(selectors)}.map(function (s) {
  var el = null
  try { el = document.querySelector(s) } catch (e) { return null }
  if (!el) return null
  var r = el.getBoundingClientRect()
  return r.width || r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
}))()`
}

/** Page code: scrolls by `dx`, `dy` or to `y`, then says where the page is. */
export function scrollJs(o: { dx?: number; dy?: number; y?: number }) {
  const to = Number.isFinite(o.y) ? `scrollTo(scrollX, ${Number(o.y)})` : `scrollBy(${Number(o.dx) || 0}, ${Number(o.dy) || 0})`
  return `(() => { ${to}; return { scrollY: Math.round(scrollY) } })()`
}

/**
 * The part of a view a crop takes around `r`, all in the page's CSS pixels: `r` padded by 24, grown to 320x200 or cut to
 * 1200x800 about its center, then moved inside the view. Never larger than the view.
 */
export function cropRect(r: Rect, view: { width: number; height: number }): Rect {
  const fit = (start: number, size: number, min: number, max: number, room: number) => {
    const want = Math.min(Math.max(size + CROP.pad * 2, min), max, room)
    const at = Math.round(start + size / 2 - want / 2)
    return [Math.max(0, Math.min(at, room - Math.round(want))), Math.round(want)]
  }
  const [x, width] = fit(r.x, r.width, CROP.min.width, CROP.max.width, Math.max(0, Math.round(view.width)))
  const [y, height] = fit(r.y, r.height, CROP.min.height, CROP.max.height, Math.max(0, Math.round(view.height)))
  return { x, y, width, height }
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
    'system.preview.close': async () => ok,
    'system.preview.hit': async ({ x, y }) => {
      const inside = (f.sharedHits ?? []).filter((a) => a.element && x >= a.element.rect.x && x <= a.element.rect.x + a.element.rect.width && y >= a.element.rect.y && y <= a.element.rect.y + a.element.rect.height)
      const area = (a: SharedAnchor) => (a.element?.rect.width ?? 0) * (a.element?.rect.height ?? 0)
      const best = inside.sort((a, b) => area(a) - area(b))[0]
      return best ? { ...best, x, y } : null
    },
    'system.preview.crop': async () => null,
    'system.preview.scroll': async () => null,
    'system.preview.locate': async ({ selectors }) => selectors.map(() => null)
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
      'system.preview.close': async ({ viewId }) => { const v = this.views.get(viewId); if (v) this.drop(v); return ok },
      'system.preview.hit': ({ viewId, x, y }) => this.hit(viewId, x, y),
      'system.preview.crop': ({ viewId, rect }) => this.crop(viewId, rect),
      'system.preview.scroll': ({ viewId, ...o }) => this.scroll(viewId, o),
      'system.preview.locate': ({ viewId, selectors }) => this.locate(viewId, selectors)
    }
  }

  /** The anchor under a point in Kernel's CSS pixels from the view's corner. The anchor itself is in the page's pixels. */
  async hit(viewId: string, x: number, y: number): Promise<SharedAnchor | null> {
    const z = this.zoom()
    return this.pin<SharedAnchor>(viewId, hitJs(Math.round(x * z), Math.round(y * z)))
  }

  /** A PNG of the view around `rect`, which is in Kernel's CSS pixels. Width and height are the image's. */
  async crop(viewId: string, rect: Rect): Promise<{ dataUrl: string; width: number; height: number } | null> {
    const v = this.live(viewId)
    if (!v || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null
    const z = this.zoom()
    const b = v.view.getBounds()
    const area = cropRect({ x: rect.x * z, y: rect.y * z, width: rect.width * z, height: rect.height * z }, b)
    if (!area.width || !area.height) return null
    const img = await v.view.webContents.capturePage(area, { stayHidden: true }).catch(() => null)
    if (!img || img.isEmpty()) return null
    const size = img.getSize()
    return { dataUrl: `data:image/png;base64,${img.toPNG().toString('base64')}`, width: size.width, height: size.height }
  }

  /** Scrolls the page, in its own pixels, and says where it ended up. A still is worth taking once it settles. */
  async scroll(viewId: string, o: { dx?: number; dy?: number; y?: number }): Promise<{ scrollY: number } | null> {
    const v = this.live(viewId)
    const r = await this.pin<{ scrollY: number }>(viewId, scrollJs(o))
    if (v && r) this.settleSoon(v)
    return r
  }

  /** Where each pinned element is now, in Kernel's CSS pixels from the view's corner. */
  async locate(viewId: string, selectors: string[]): Promise<(Rect | null)[]> {
    const rects = await this.pin<(Rect | null)[]>(viewId, locateJs(selectors))
    const z = this.zoom()
    return selectors.map((_s, i) => {
      const r = rects?.[i]
      return r ? { x: r.x / z, y: r.y / z, width: r.width / z, height: r.height / z } : null
    })
  }

  /** Runs page code in the pin world. Null when the view is gone or the page doesn't answer. */
  private async pin<T>(viewId: string, code: string): Promise<T | null> {
    const v = this.live(viewId)
    if (!v) return null
    return ((await v.view.webContents.executeJavaScriptInIsolatedWorld(PIN_WORLD, [{ code }]).catch(() => null)) ?? null) as T | null
  }

  /** Kernel's page zoom: its CSS pixels times this are the view's. */
  private zoom() { return this.o.window()?.webContents.getZoomFactor() ?? 1 }

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
