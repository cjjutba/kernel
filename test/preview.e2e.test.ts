import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// KERNEL-303: a shared HTML page runs in a locked-down view. A hostile page tries every way out it can, and none works,
// while Kernel's own bridge keeps answering. It builds the app into out/ and launches Electron on a fixture with the
// window hidden, so it is off by default, like the other click-throughs:
//   KERNEL_E2E=1 pnpm test test/preview.e2e.test.ts
describe.skipIf(!process.env.KERNEL_E2E || process.platform !== 'darwin')('a shared HTML page in its preview', () => {
  let app: ElectronApplication
  let page: Page
  let data: string
  let server: Server
  /** Every request the local server saw. A preview must never reach it. */
  const hits: string[] = []
  let origin = ''

  /** Writes a version where the e2e host looks for copies, as Kernel lays them out. */
  const share = (id: string, name: string, body: string | Buffer) => {
    const dir = join(data, 'shared', id, 'v1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), body)
  }

  beforeAll(async () => {
    server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.end('reached') })
    server.on('upgrade', (req, socket) => { hits.push(`UPGRADE ${req.url}`); socket.destroy() })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    origin = `127.0.0.1:${(server.address() as AddressInfo).port}`

    const build = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], { stdio: 'pipe', encoding: 'utf8' })
    expect(build.status, build.stdout + build.stderr).toBe(0)
    data = mkdtempSync(join(tmpdir(), 'kernel-preview-'))
    share('hostile', 'page.html', hostilePage(origin))
    share('loop', 'loop.html', '<p>busy</p><script>setTimeout(() => { for (;;) {} }, 50)</script>')
    share('pic', 'dot.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#36c"/></svg>')
    share('doc', 'doc.pdf', '%PDF-1.4\n%%EOF\n')
    for (const n of [1, 2, 3, 4, 5]) share(`page${n}`, 'p.html', `<p>page ${n}</p>`)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ELECTRON_RENDERER_URL') env[k] = v
    Object.assign(env, { KERNEL_FIXTURES: 'QuickAskOpenChat', KERNEL_HEADLESS: '1', KERNEL_FIXTURE_DATA: data, KERNEL_E2E_PREVIEWS: '1' })
    app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env })
    page = await app.firstWindow()
    await page.waitForSelector('html[data-fixture="ready"]', { state: 'attached', timeout: 15_000 })
    // Record what main pushes to the app's page.
    await page.evaluate(() => { const w = window as any; w.pushed = []; w.kernel.on((e: { type: string }) => { if (e.type.startsWith('preview')) w.pushed.push(e) }) })
  }, 120_000)

  afterAll(async () => {
    await app?.close().catch(() => undefined)
    server?.close()
    if (data) rmSync(data, { recursive: true, force: true })
  })

  const invoke = (channel: string, req?: unknown) => page.evaluate(([c, r]) => (window as any).kernel.invoke(c, r).then((v: unknown) => v, (e: Error) => ({ error: e.message })), [channel, req] as const)
  const open = async (sharedId: string, key = sharedId) => (await invoke('system.preview.open', { sharedId, version: 1, key })) as { viewId: string | null; still?: string | null }
  const pushed = () => page.evaluate(() => (window as any).pushed as { type: string; viewId?: string; state?: string; code?: string }[])
  /** Runs a script in the preview showing kernel-shared: URLs, the newest first. */
  const inPreview = (js: string) => app.evaluate(({ webContents }, code) => {
    const views = webContents.getAllWebContents().filter((w) => w.getURL().startsWith('kernel-shared://'))
    return views[views.length - 1].executeJavaScript(code)
  }, js)
  const previewCount = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getURL().startsWith('kernel-shared://')).length)

  it('blocks every request a hostile page makes and gives it no bridge', async () => {
    const before = app.windows().length
    const { viewId } = await open('hostile')
    expect(viewId).toEqual(expect.any(String))
    expect(await invoke('system.preview.place', { viewId, rect: { x: 0, y: 0, width: 800, height: 600 } })).toEqual({ ok: true })
    await expect.poll(() => inPreview('window.done === true').catch(() => false), { timeout: 15_000 }).toBe(true)
    const r = await inPreview('window.results')
    expect(r).toMatchObject({
      kernel: 'undefined', process: 'undefined', require: 'undefined',
      fetch: 'blocked', img: 'blocked', ws: 'blocked', xhr: 'blocked', open: 'blocked',
      geolocation: 'blocked', camera: 'blocked', notification: 'denied'
    })
    // Navigations the page started: a form post, meta refresh and location all leave it where it was.
    await page.waitForTimeout(1500)
    expect(await inPreview('location.pathname + "|" + document.title')).toBe('/|hostile')
    // Nothing reached the network, CSS url() and sendBeacon included.
    expect(hits).toEqual([])
    expect(app.windows().length).toBe(before + 1)
    expect(await invoke('rooms.list')).toEqual(expect.any(Array))
  })

  it('refuses downloads', async () => {
    await app.evaluate(({ session }) => {
      const g = globalThis as any
      g.downloads = []
      session.fromPartition('kernel-preview').on('will-download', (e, item) => { g.downloads.push({ prevented: e.defaultPrevented, state: item.getState() }) })
    })
    await inPreview(`(() => { const a = document.createElement('a'); a.href = 'data:text/plain,hi'; a.download = 'x.txt'; document.body.append(a); a.click() })()`)
    await expect.poll(() => app.evaluate(() => (globalThis as any).downloads.length)).toBeGreaterThan(0)
    expect(await app.evaluate(() => (globalThis as any).downloads[0].prevented)).toBe(true)
  })

  it('sends app shortcuts to Kernel and leaves the rest to the page', async () => {
    await app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('kernel-shared://'))!
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['meta'] })
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['meta'] })
    })
    await expect.poll(async () => (await pushed()).filter((e) => e.type === 'preview.key').map((e) => e.code)).toEqual(['KeyK'])
  })

  it('pushes the view state and gives a still', async () => {
    const events = await pushed()
    expect(events.map((e) => e.state)).toEqual(expect.arrayContaining(['loading', 'ready', 'settled']))
    const viewId = events.find((e) => e.type === 'preview')!.viewId!
    expect(await invoke('system.preview.place', { viewId, rect: null })).toEqual({ ok: true })
    expect(await invoke('system.preview.still', { viewId })).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('keeps Kernel responsive while a page loops forever', async () => {
    const { viewId } = await open('loop')
    await page.waitForTimeout(500)
    expect(await invoke('rooms.list')).toEqual(expect.any(Array))
    expect(await page.evaluate(() => 1 + 1)).toBe(2)
    expect(await invoke('system.preview.close', { viewId })).toEqual({ ok: true })
  })

  it('opens no live view for a PDF, and keeps at most four views', async () => {
    expect(await open('doc')).toEqual({ viewId: null, still: null })
    for (const n of [1, 2, 3, 4, 5]) await open(`page${n}`)
    await expect.poll(previewCount).toBe(4)
  })

  it('draws thumbnails for HTML and images, and none for a PDF', async () => {
    const size = (id: string, kind: string) => app.evaluate(async (_e, [sharedId, k]) => {
      const host = (globalThis as any).kernelPreview
      const png: Buffer | null = await host.thumbnail({ id: sharedId, kind: k }, 1)
      return png ? png.length : null
    }, [id, kind] as const)
    expect(await size('page1', 'html')).toBeGreaterThan(1000)
    expect(await size('pic', 'image')).toBeGreaterThan(1000)
    expect(await size('doc', 'pdf')).toBeNull()
  })
})

/** Tries every way out, records each outcome in `window.results`, then sets `window.done`. */
function hostilePage(origin: string) {
  const http = `http://${origin}`
  return `<!doctype html><title>hostile</title>
<style>body { background: url(${http}/css) }</style>
<form id="f" method="post" action="${http}/form"><input name="a" value="1"></form>
<script>
const results = (window.results = {})
const settle = (p, ms = 3000) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))])
results.kernel = typeof window.kernel
results.process = typeof process
results.require = typeof require
;(async () => {
  results.fetch = await fetch('${http}/fetch').then(() => 'reached', () => 'blocked')
  results.img = await settle(new Promise((r) => { const i = new Image(); i.onload = () => r('reached'); i.onerror = () => r('blocked'); i.src = '${http}/img' }))
  results.ws = await settle(new Promise((r) => { try { const s = new WebSocket('ws://${origin}/ws'); s.onopen = () => r('reached'); s.onerror = () => r('blocked') } catch { r('blocked') } }))
  results.xhr = await settle(new Promise((r) => { const x = new XMLHttpRequest(); x.onload = () => r('reached'); x.onerror = () => r('blocked'); try { x.open('GET', '${http}/xhr'); x.send() } catch { r('blocked') } }))
  try { results.beacon = navigator.sendBeacon('${http}/beacon', 'x') } catch { results.beacon = 'threw' }
  results.open = window.open('${http}/open') === null ? 'blocked' : 'opened'
  results.geolocation = await settle(new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted'), () => r('blocked'))))
  results.camera = await settle(navigator.mediaDevices ? navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', () => 'blocked') : Promise.resolve('blocked'))
  results.notification = await settle(Notification.requestPermission())
  document.getElementById('f').submit()
  const meta = document.createElement('meta'); meta.httpEquiv = 'refresh'; meta.content = '0;url=${http}/meta'; document.head.append(meta)
  location.href = '${http}/location'
  window.done = true
})()
</script>`
}
