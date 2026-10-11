import { describe, expect, it, vi } from 'vitest'
import type { Served } from '../src/main/previewHost'

// The suite runs Electron as plain Node, where `electron` is only the binary's path. These tests cover the pure parts.
vi.mock('electron', () => ({}))
const { allowedUrl, appShortcut, cropRect, hitJs, locateJs, PREVIEW_CSP, route, scaleRect, scrollJs, SELECTOR_JS, servedHeaders } = await import('../src/main/previewHost')

const key = (code: string, mods: { meta?: boolean; shift?: boolean; alt?: boolean; control?: boolean } = {}, type = 'keyDown') =>
  ({ type, key: '', code, meta: false, shift: false, alt: false, control: false, ...mods })
const meta = { meta: true }

describe('appShortcut', () => {
  it('forwards the app shortcuts to Kernel', () => {
    const forwarded = [
      key('KeyK', meta), key('KeyN', meta), key('KeyN', { meta: true, shift: true }), key('KeyT', meta), key('KeyT', { meta: true, shift: true }),
      key('KeyW', meta), key('KeyB', meta), key('KeyB', { meta: true, alt: true }), key('Backslash', meta), key('Comma', meta),
      key('BracketLeft', meta), key('BracketRight', meta), key('KeyL', { meta: true, shift: true }), key('KeyP', { meta: true, shift: true }),
      key('KeyL', meta), key('Slash', { meta: true, shift: true }), key('KeyM', { meta: true, shift: true }), key('KeyF', { meta: true, shift: true }),
      key('KeyA', { meta: true, shift: true }),
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
  const served = new Map<string, Served>([['t1', page], ['t2', image]])

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

// Pinning comments (KERNEL-310). The page code runs here on a small fake DOM: the parts of elements and the document the
// scripts read, and no CSS.escape, so the fallback escape runs too.
interface FakeEl { tagName: string; id: string; className: string; parentElement: FakeEl | null; children: FakeEl[]; ownerDocument: FakeDoc; innerText?: string; label?: string; rect: { x: number; y: number; width: number; height: number }; getAttribute(n: string): string | null; getBoundingClientRect(): FakeEl['rect'] }
interface FakeDoc { all: FakeEl[]; body: FakeEl; documentElement: FakeEl; querySelectorAll(s: string): FakeEl[]; querySelector(s: string): FakeEl | null; elementFromPoint(x: number, y: number): FakeEl | null; under?: FakeEl }

/** `['section', { class: 'hero' }, [...children]]`, built under html > body. `#id` lookups unescape the way CSS does. */
type Spec = [tag: string, attrs?: { id?: string; class?: string; text?: string; label?: string }, children?: Spec[]]
function fakeDom(body: Spec[]) {
  const unescape = (s: string) => s.replace(/\\3(\d) /g, '$1').replace(/\\(.)/g, '$1')
  const doc = { all: [] as FakeEl[] } as FakeDoc
  doc.querySelectorAll = (s) => (s.startsWith('#') ? doc.all.filter((e) => e.id === unescape(s.slice(1))) : [])
  doc.querySelector = (s) => doc.querySelectorAll(s)[0] ?? null
  doc.elementFromPoint = () => doc.under ?? null
  const make = ([tag, a = {}, kids = []]: Spec, parent: FakeEl | null): FakeEl => {
    const el: FakeEl = {
      tagName: tag.toUpperCase(), id: a.id ?? '', className: a.class ?? '', parentElement: parent, children: [], ownerDocument: doc,
      innerText: a.text, label: a.label, rect: { x: 10, y: 20, width: 30, height: 40 },
      getAttribute: (n) => (n === 'aria-label' ? a.label ?? null : null), getBoundingClientRect: () => el.rect
    }
    doc.all.push(el)
    el.children = kids.map((k) => make(k, el))
    return el
  }
  doc.documentElement = make(['html', {}, [['body', {}, body]]], null)
  doc.body = doc.documentElement.children[0]
  const find = (pred: (e: FakeEl) => boolean) => doc.all.find(pred)!
  return { doc, find }
}

const selectorOf = (el: FakeEl) => new Function(`${SELECTOR_JS}; return selectorOf`)()(el) as string
/** Runs page code with the page's globals as the fake ones. */
const inPage = (code: string, doc: FakeDoc, win = { innerWidth: 1280, innerHeight: 800, scrollY: 0 }) =>
  new Function('document', 'innerWidth', 'innerHeight', 'scrollY', `return ${code}`)(doc, win.innerWidth, win.innerHeight, win.scrollY)

describe('selectorOf', () => {
  const page = () => fakeDom([
    ['header', { id: 'top' }, [['a', { text: 'Home' }]]],
    ['section', { class: 'hero big  0bad' }, [
      ['h1'],
      ['div', { class: 'actions' }, [['button', { class: 'cta', text: 'Start free trial' }], ['button', { class: 'ghost' }]]]
    ]],
    ['section', {}, [['p', { id: 'dup' }], ['p', { id: 'dup' }], ['span', { id: '1st item' }]]]
  ])

  it('uses an id no other element has', () => {
    const { find } = page()
    expect(selectorOf(find((e) => e.id === 'top'))).toBe('#top')
    expect(selectorOf(find((e) => e.id === '1st item'))).toBe('#\\31 st\\ item')
  })

  it('builds a tag chain with plain class names, numbering only tags a sibling shares, below body', () => {
    const { find } = page()
    expect(selectorOf(find((e) => e.className === 'cta'))).toBe('section.hero.big:nth-of-type(1) > div.actions > button.cta:nth-of-type(1)')
    expect(selectorOf(find((e) => e.tagName === 'H1'))).toBe('section.hero.big:nth-of-type(1) > h1')
  })

  it('skips an id another element shares, and stops at an ancestor with a unique id', () => {
    const { find } = page()
    expect(selectorOf(find((e) => e.id === 'dup'))).toBe('section:nth-of-type(2) > p:nth-of-type(1)')
    expect(selectorOf(find((e) => e.tagName === 'A'))).toBe('#top > a')
  })

  it('stops at 8 steps', () => {
    let spec: Spec = ['b']
    for (let i = 0; i < 12; i++) spec = ['div', {}, [spec]]
    const { find } = fakeDom([spec])
    const sel = selectorOf(find((e) => e.tagName === 'B'))
    expect(sel.split(' > ')).toHaveLength(8)
    expect(sel).toBe('div > div > div > div > div > div > div > b')
  })
})

describe('pin scripts', () => {
  it('hit names the element under the point, its text clipped, with the window', () => {
    const { doc, find } = fakeDom([['div', { class: 'actions' }, [['button', { class: 'cta', text: '  Start\n free   trial ' }], ['i', { label: 'Close', text: 'x' }], ['p', { text: 'y'.repeat(200) }]]]])
    doc.under = find((e) => e.className === 'cta')
    expect(inPage(hitJs(412, 188), doc, { innerWidth: 1280, innerHeight: 800, scrollY: 640.4 })).toEqual({
      x: 412, y: 188, viewport: { width: 1280, height: 800, scrollY: 640 },
      element: { selector: 'div.actions > button.cta', tag: 'button', text: 'Start free trial', rect: { x: 10, y: 20, width: 30, height: 40 } }
    })
    doc.under = find((e) => e.tagName === 'I')
    expect(inPage(hitJs(1, 2), doc).element.text).toBe('Close')
    doc.under = find((e) => e.tagName === 'P')
    expect(inPage(hitJs(1, 2), doc).element.text).toHaveLength(120)
  })

  it('hit over the page itself gives the point alone', () => {
    const { doc } = fakeDom([])
    doc.under = doc.body
    expect(inPage(hitJs(5, 6), doc)).toEqual({ x: 5, y: 6, viewport: { width: 1280, height: 800, scrollY: 0 } })
  })

  it('locate finds each selector again, null for one that is gone, invalid or not drawn', () => {
    const { doc, find } = fakeDom([['p', { id: 'a' }], ['p', { id: 'hidden' }]])
    find((e) => e.id === 'hidden').rect = { x: 0, y: 0, width: 0, height: 0 }
    doc.querySelector = (s) => { if (s === '[') throw new Error('bad selector'); return doc.querySelectorAll(s)[0] ?? null }
    expect(inPage(locateJs(['#a', '#gone', '[', '#hidden']), doc)).toEqual([{ x: 10, y: 20, width: 30, height: 40 }, null, null, null])
  })

  it('scroll scrolls to a place or by an amount', () => {
    expect(scrollJs({ y: 300 })).toContain('scrollTo(scrollX, 300)')
    expect(scrollJs({ dy: 120 })).toContain('scrollBy(0, 120)')
    expect(scrollJs({ dx: 'x' as never })).toContain('scrollBy(0, 0)')
  })

  it('crops around the rect with padding, inside the size limits and the view', () => {
    const view = { width: 1280, height: 800 }
    // A small button: padded, then grown to 320x200 about its center.
    expect(cropRect({ x: 400, y: 180, width: 100, height: 40 }, view)).toEqual({ x: 290, y: 100, width: 320, height: 200 })
    // A big block: padded by 24 on each side.
    expect(cropRect({ x: 100, y: 100, width: 500, height: 300 }, view)).toEqual({ x: 76, y: 76, width: 548, height: 348 })
    // Near the corner: moved inside the view.
    expect(cropRect({ x: 0, y: 0, width: 20, height: 20 }, view)).toEqual({ x: 0, y: 0, width: 320, height: 200 })
    expect(cropRect({ x: 1270, y: 790, width: 10, height: 10 }, view)).toEqual({ x: 960, y: 600, width: 320, height: 200 })
    // Bigger than the most a crop takes: cut to 1200x800 about its center, and never past the view.
    expect(cropRect({ x: 0, y: 0, width: 2000, height: 2000 }, { width: 2400, height: 2400 })).toEqual({ x: 400, y: 600, width: 1200, height: 800 })
    expect(cropRect({ x: 0, y: 0, width: 2000, height: 2000 }, { width: 600, height: 300 })).toEqual({ x: 0, y: 0, width: 600, height: 300 })
  })
})
