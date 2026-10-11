import { describe, expect, it, vi } from 'vitest'

// The suite runs Electron as plain Node, where `electron` is only the binary's path. These tests cover the pure parts.
vi.mock('electron', () => ({}))
const { allowedUrl, appShortcut, PREVIEW_CSP, route, scaleRect, servedHeaders } = await import('../src/main/previewHost')

const key = (code: string, mods: { meta?: boolean; shift?: boolean; alt?: boolean; control?: boolean } = {}, type = 'keyDown') =>
  ({ type, key: '', code, meta: false, shift: false, alt: false, control: false, ...mods })
const meta = { meta: true }

describe('appShortcut', () => {
  it('forwards the app shortcuts to Kernel', () => {
    const forwarded = [
      key('KeyK', meta), key('KeyN', meta), key('KeyN', { meta: true, shift: true }), key('KeyT', meta), key('KeyT', { meta: true, shift: true }),
      key('KeyW', meta), key('KeyB', meta), key('KeyB', { meta: true, alt: true }), key('Backslash', meta), key('Comma', meta),
      key('BracketLeft', meta), key('BracketRight', meta), key('KeyL', { meta: true, shift: true }), key('KeyP', { meta: true, shift: true }),
      key('KeyL', meta), key('Slash', { meta: true, shift: true }),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => key(`Digit${n}`, meta)),
      ...[1, 2, 3, 4].map((n) => key(`Digit${n}`, { meta: true, control: true }))
    ]
    for (const k of forwarded) expect(appShortcut(k), JSON.stringify(k)).toBe('forward')
  })

  it('reloads the preview on Cmd+R and hands focus back on F6', () => {
    expect(appShortcut(key('KeyR', meta))).toBe('reload')
    expect(appShortcut(key('F6'))).toBe('return')
  })

  it('leaves editing, quit, hide and minimize to the page and the system', () => {
    for (const c of ['KeyC', 'KeyV', 'KeyX', 'KeyA', 'KeyZ', 'KeyQ', 'KeyH', 'KeyM']) expect(appShortcut(key(c, meta)), c).toBeNull()
    expect(appShortcut(key('KeyZ', { meta: true, shift: true }))).toBeNull()
  })

  it('matches modifiers exactly and only on key down', () => {
    expect(appShortcut(key('KeyK'))).toBeNull()
    expect(appShortcut(key('KeyK', { meta: true, alt: true }))).toBeNull()
    expect(appShortcut(key('KeyW', { meta: true, shift: true }))).toBeNull()
    expect(appShortcut(key('Digit5', { meta: true, control: true }))).toBeNull()
    expect(appShortcut(key('KeyK', meta, 'keyUp'))).toBeNull()
  })
})

describe('allowedUrl', () => {
  const live = new Set(['abc123'])
  it("allows only a live token's URLs, its blobs and data: URLs", () => {
    expect(allowedUrl('kernel-shared://abc123/', live, false)).toBe(true)
    expect(allowedUrl('kernel-shared://abc123/file', live, false)).toBe(true)
    expect(allowedUrl('blob:kernel-shared://abc123/5f0c', live, false)).toBe(true)
    expect(allowedUrl('data:image/png;base64,AAAA', live, false)).toBe(true)
  })

  it('cancels other tokens, the network, files and other schemes', () => {
    for (const url of [
      'kernel-shared://dead00/', 'blob:kernel-shared://dead00/5f0c', 'blob:null/5f0c', 'https://example.com/', 'http://127.0.0.1:4306/',
      'ws://127.0.0.1:9/', 'file:///etc/hosts', 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', 'devtools://devtools/x', 'not a url'
    ]) expect(allowedUrl(url, live, false), url).toBe(false)
  })

  it('allows DevTools in a dev build only', () => {
    expect(allowedUrl('devtools://devtools/bundled/inspector.html', live, true)).toBe(true)
  })
})

describe('route', () => {
  const page = { path: '/data/shared/a/v1/page.html', mime: 'text/html', kind: 'html' as const }
  const image = { path: '/data/shared/b/v2/dot.svg', mime: 'image/svg+xml', kind: 'image' as const, frame: true }
  const served = new Map([['t1', page], ['t2', image]])

  it("serves a token's version at its root and nothing else", () => {
    expect(route('kernel-shared://t1/', served)).toEqual({ file: page })
    expect(route('kernel-shared://t1/other.html', served)).toBeNull()
    expect(route('kernel-shared://t1/file', served)).toBeNull()
    expect(route('kernel-shared://t9/', served)).toBeNull()
    expect(route('https://t1/', served)).toBeNull()
  })

  it("draws an image's thumbnail in a page that loads the image", () => {
    expect(route('kernel-shared://t2/', served)).toEqual({ frame: image })
    expect(route('kernel-shared://t2/file', served)).toEqual({ file: image })
    expect(route('kernel-shared://t2/other', served)).toBeNull()
  })
})

describe('served headers', () => {
  it('locks HTML down with the CSP and no caching or sniffing', () => {
    expect(PREVIEW_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
      "media-src data: blob:; worker-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
    expect(servedHeaders('text/html')).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': PREVIEW_CSP,
      'x-content-type-options': 'nosniff',
      'x-dns-prefetch-control': 'off',
      'cache-control': 'no-store'
    })
  })

  it('gives an image its own type and the same CSP', () => {
    expect(servedHeaders('image/svg+xml')).toMatchObject({ 'content-type': 'image/svg+xml', 'content-security-policy': PREVIEW_CSP })
  })
})

describe('scaleRect', () => {
  it('keeps the rect at zoom 1', () => {
    expect(scaleRect({ x: 240, y: 96, width: 800, height: 600 }, 1)).toEqual({ x: 240, y: 96, width: 800, height: 600 })
  })

  it('scales by the zoom factor and rounds the edges, so views next to each other meet', () => {
    expect(scaleRect({ x: 240, y: 96, width: 800, height: 600 }, 1.25)).toEqual({ x: 300, y: 120, width: 1000, height: 750 })
    const left = scaleRect({ x: 10.3, y: 0, width: 100.3, height: 10 }, 1.1)
    const right = scaleRect({ x: 110.6, y: 0, width: 50, height: 10 }, 1.1)
    expect(left.x + left.width).toBe(right.x)
  })
})
