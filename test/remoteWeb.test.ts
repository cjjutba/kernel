import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { Kernel } from '../src/main/kernel'
import { staticAssets } from '../src/main/services/remoteAssets'
import { freePort, tempRepo } from './helpers'

// remote-web-client, end to end: a real Kernel with Remote access on serves the built renderer, and a real Chromium pairs with it
// over HTTP and shows the project list through the WebSocket. It needs the renderer build (`pnpm build`) and Playwright's Chromium,
// and says which one is missing instead of failing when it isn't there.

const build = resolve('out/renderer')
const hasBuild = existsSync(join(build, 'index.html'))

let browser: Browser | undefined
let chromiumMissing: string | undefined
if (hasBuild) {
  try { browser = await chromium.launch() } catch (e) { chromiumMissing = e instanceof Error ? e.message.split('\n')[0] : String(e) }
}
const ready = !!browser
if (!ready) console.warn(`[remoteWeb] skipped: ${!hasBuild ? 'no renderer build in out/renderer (run pnpm build)' : `Chromium is not available (${chromiumMissing})`}`)

const stops: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })

async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), remote: { enabled: true, port: await freePort() } }))
  const k = new Kernel({ dataDir, home })
  k.remote.assets = staticAssets(build)
  stops.push(() => k.stop({ budgetMs: 0 }))
  await k.start()
  await k.remote.settled
  return k
}

describe.skipIf(!ready)('Kernel in a browser', () => {
  it('pairs from the link, loads the app and lists the project', async () => {
    const k = await boot()
    const project = await k.projects.addProject(await tempRepo())
    const { url } = await k.handlers()['remote.pair']()
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    stops.push(() => context.close())
    const page = await context.newPage()
    const problems: string[] = []
    page.on('pageerror', (e) => problems.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()) })

    await page.goto(url)
    await page.getByRole('dialog', { name: 'Pair this device' }).waitFor({ timeout: 15000 })
    await page.getByRole('button', { name: 'Pair' }).click()
    // The sidebar names the project once the app has loaded its lists over the socket.
    await page.getByText(basename(project.path), { exact: false }).first().waitFor({ timeout: 15000 })
    // The code is out of the address bar, and the device is listed on the Mac.
    expect(page.url()).not.toContain('pair=')
    expect(await k.handlers()['remote.devices']()).toHaveLength(1)
    // The page's CSP let the socket and the scripts through.
    expect(problems.filter((p) => /Content Security Policy|WebSocket/i.test(p))).toEqual([])

    // A reload keeps the token: no pairing page.
    await page.reload()
    await page.getByText(basename(project.path), { exact: false }).first().waitFor({ timeout: 15000 })

    // Revoking the device on the Mac sends the page back to the message about the pairing link.
    const [device] = await k.handlers()['remote.devices']()
    await k.handlers()['remote.revoke']({ id: device.id })
    await page.getByText('Open the pairing link from Settings, Remote access on your Mac.').waitFor({ timeout: 15000 })
  })

  it('shows where to find the link when the page has no token', async () => {
    const k = await boot()
    const context = await browser!.newContext()
    stops.push(() => context.close())
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${k.remote.status().port}/`)
    await page.getByText('Open the pairing link from Settings, Remote access on your Mac.').waitFor({ timeout: 15000 })
  })

  it('refuses a pairing link that was already used', async () => {
    const k = await boot()
    const { url } = await k.handlers()['remote.pair']()
    const first = await browser!.newContext()
    const second = await browser!.newContext()
    stops.push(() => first.close(), () => second.close())
    const a = await first.newPage()
    await a.goto(url)
    await a.getByRole('button', { name: 'Pair' }).click()
    await a.getByRole('button', { name: 'Pair' }).waitFor({ state: 'detached', timeout: 15000 }).catch(() => undefined)
    const b = await second.newPage()
    await b.goto(url)
    await b.getByRole('button', { name: 'Pair' }).click()
    expect(await b.getByRole('alert').textContent({ timeout: 15000 })).toContain('used or has run out')
  })
})
