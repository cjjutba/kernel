// Records the landing page's feature clips from the scene build: `pnpm demo:clips [name...]`.
//
// Each clip opens one scene (demo/scenes) at 1440x900 and 2x, moves a drawn cursor to what it clicks, and captures every
// frame Chrome paints over CDP. ffmpeg crops the frames to the part of the window the clip is about and writes an MP4
// and a poster to site/public/clips. Needs ffmpeg on PATH.
import { chromium, type Locator, type Page } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = join(root, 'out/scenes')
const outDir = join(root, 'site/public/clips')
const work = join(root, 'out/clips-work')
const ORIGIN = 'http://scenes.local'
const SCALE = 2
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }

/** A region of the 1440x900 window, in CSS pixels. */
type Rect = { x: number; y: number; width: number; height: number }
type Clip = {
  scene: string
  crop: Rect
  /** The width of the encoded video, in pixels. Defaults to the crop at 2x. */
  width?: number
  /** Runs before recording starts, so the clip opens on the moment it is about. */
  setup?: (d: Driver) => Promise<void>
  play: (d: Driver) => Promise<void>
  /** Seconds into the clip for the poster frame. Defaults to the last frame. */
  poster?: number
}

class Driver {
  readonly page: Page
  constructor(page: Page) {
    this.page = page
  }
  wait = (ms: number) => this.page.waitForTimeout(ms)
  step = (name: string) => this.page.evaluate((n) => (window as unknown as { __scene: { step(n: string): void } }).__scene.step(n), name)
  async show(x = 720, y = 520) {
    await this.page.evaluate(([cx, cy]) => (window as unknown as { __cursor: { show(p: object): void } }).__cursor.show({ x: cx, y: cy }), [x, y])
  }
  /** Screen coordinates to the layout coordinates the cursor lives in, while the camera is zoomed. */
  private layout = (x: number, y: number) =>
    this.page.evaluate(([sx, sy]) => (window as unknown as { __camera: { toLayout(x: number, y: number): { x: number; y: number } } }).__camera.toLayout(sx!, sy!), [x, y])
  private glide = async (x: number, y: number, ms: number) => {
    const at = await this.layout(x, y)
    await this.page.evaluate(([cx, cy, t]) => (window as unknown as { __cursor: { move(x: number, y: number, ms: number): Promise<void> } }).__cursor.move(cx!, cy!, t!), [at.x, at.y, ms])
    await this.page.mouse.move(x, y)
  }
  /** Glides the cursor to the middle of `target` and hovers it there. */
  async to(target: Locator, ms = 750) {
    await target.waitFor({ state: 'visible', timeout: 20_000 })
    const box = (await target.boundingBox())!
    const x = Math.round(box.x + box.width / 2)
    const y = Math.round(box.y + box.height / 2)
    await this.glide(x, y, ms)
    return { x, y }
  }
  async click(target: Locator, ms?: number) {
    const { x, y } = await this.to(target, ms)
    await this.wait(180)
    await this.page.evaluate(() => (window as unknown as { __cursor: { press(): void } }).__cursor.press())
    await this.page.mouse.click(x, y)
  }
  /** Glides to a point on screen and clicks there. */
  async clickAt(x: number, y: number, ms = 750) {
    await this.glide(x, y, ms)
    await this.wait(180)
    await this.page.evaluate(() => (window as unknown as { __cursor: { press(): void } }).__cursor.press())
    await this.page.mouse.click(x, y)
  }
  /** Zooms the camera to `s` times on the middle of `target`, or on a point in layout coordinates, and waits for it. */
  async zoom(target: Locator | { x: number; y: number }, s: number, ms = 900) {
    let point: { x: number; y: number }
    if ('x' in target) point = target
    else {
      await target.waitFor({ state: 'visible', timeout: 20_000 })
      const box = (await target.boundingBox())!
      point = await this.layout(box.x + box.width / 2, box.y + box.height / 2)
    }
    await this.page.evaluate(([x, y, z, t]) => (window as unknown as { __camera: { zoom(x: number, y: number, s: number, ms: number): void } }).__camera.zoom(x!, y!, z!, t!), [point.x, point.y, s, ms])
    await this.wait(ms + 60)
  }
  async unzoom(ms = 900) {
    await this.page.evaluate((t) => (window as unknown as { __camera: { reset(ms: number): void } }).__camera.reset(t), ms)
    await this.wait(ms + 60)
  }
  type = (text: string, delay = 38) => this.page.keyboard.type(text, { delay })
}

const full: Rect = { x: 0, y: 0, width: 1440, height: 900 }
/** The middle column of a workspace: the chat or an open tab, without the sidebar and the right panel. */
const column = (y: number, height: number): Rect => ({ x: 236, y, width: 796, height })

const CLIPS: Record<string, Clip> = {
  workspaces: {
    scene: 'team',
    crop: full,
    width: 2400,
    poster: 12,
    setup: async (d) => {
      const box = d.page.locator('[role=textbox][aria-label^=Message]').first()
      await box.click()
      await d.type('Save new plans as plan.md instead of context.md.', 5)
      await d.page.keyboard.press('Enter')
      await d.page.getByText(/^Switch this chat to Plan/).first().waitFor({ timeout: 20_000 })
      await box.click()
      await d.page.keyboard.press('Shift+Tab')
      await d.type('Write the implementation plan.', 5)
      await d.page.keyboard.press('Enter')
      await d.page.getByRole('button', { name: /^Approve/ }).first().waitFor({ timeout: 30_000 })
      await d.wait(600)
    },
    // Approve, watch the three workspaces start, look in on each agent, then back in Kernel's chat the team updates come
    // in, Theo reviews the first pull request and it merges.
    play: async (d) => {
      await d.show(980, 640)
      await d.wait(600)
      await d.click(d.page.getByRole('button', { name: /^Approve/ }).first())
      await d.wait(4600)
      await d.click(d.page.getByText(/^Save new plans as plan\.md/).first(), 900)
      await d.wait(6500)
      await d.click(d.page.getByText(/^Show the saved plan file/).first(), 700)
      await d.wait(4500)
      await d.click(d.page.getByText(/^Cover plan naming/).first(), 700)
      await d.wait(3800)
      await d.click(d.page.getByText('Save plans as plan.md', { exact: true }).first(), 900)
      const merge = d.page.getByRole('button', { name: /^Merge PR #70/ }).first()
      await merge.waitFor({ timeout: 45_000 })
      await d.wait(2200)
      await d.click(merge, 900)
      await d.wait(3800)
    }
  },
  reviews: {
    scene: 'reviews',
    crop: column(90, 780),
    poster: 6,
    play: async (d) => {
      await d.show(760, 760)
      await d.wait(400)
      await d.step('update')
      await d.wait(4200)
      await d.click(d.page.getByText('Merge #161', { exact: true }).first(), 900)
      await d.wait(6200)
      await d.click(d.page.getByText('Merge #158', { exact: true }).last(), 900)
      await d.wait(4000)
    }
  },
  permissions: {
    scene: 'permissions',
    crop: column(90, 780),
    poster: 5,
    play: async (d) => {
      await d.show(800, 780)
      await d.wait(400)
      await d.step('ask')
      await d.wait(4700)
      await d.click(d.page.getByRole('button', { name: /^Allow once/ }).last(), 900)
      await d.wait(3600)
      await d.click(d.page.getByRole('button', { name: /^Always allow here/ }).last(), 900)
      await d.wait(8800)
    }
  },
  // A product-video take: the camera follows the cursor in to each control and back out to show what changed.
  accounts: {
    scene: 'accounts',
    crop: full,
    width: 1600,
    poster: 21,
    play: async (d) => {
      const p = d.page
      await d.show(760, 520)
      await d.wait(700)
      const menu = p.getByRole('button', { name: /^Account menu/ })
      await d.zoom(menu, 2.1)
      await d.click(menu, 900)
      await d.wait(500)
      await d.click(p.getByRole('menuitem', { name: /^Settings/ }).first(), 700)
      await d.wait(700)
      await d.zoom(p.getByText('Accounts', { exact: true }).first(), 2)
      await d.click(p.getByText('Accounts', { exact: true }).first(), 700)
      await d.wait(600)
      await d.zoom({ x: 860, y: 260 }, 1.55, 1000)
      const add = p.getByRole('button', { name: 'Add account' })
      await d.click(add, 900)
      await d.wait(500)
      await d.click(p.getByRole('menuitem', { name: /API key/ }).first(), 700)
      await d.zoom(p.getByRole('dialog'), 1.75, 900)
      await d.click(p.locator('#acct-label'), 700)
      await d.type('Team key', 55)
      await d.click(p.locator('#acct-key'), 600)
      await d.type('sk-ant-api03-kernel-demo-key', 28)
      await d.wait(300)
      await d.click(p.getByRole('button', { name: 'Add key' }), 700)
      await d.wait(1700)
      await d.zoom({ x: 860, y: 300 }, 1.55, 1000)
      await d.wait(1300)
      await d.click(add, 900)
      await d.wait(500)
      await d.click(p.getByRole('menuitem', { name: /Subscription/ }).last(), 700)
      await d.zoom(p.getByRole('dialog'), 1.75, 900)
      await d.click(p.getByRole('button', { name: /^Sign in with ChatGPT/ }), 700)
      await d.wait(2600)
      await d.zoom({ x: 860, y: 380 }, 1.55, 1000)
      await d.wait(1600)
      await d.unzoom(1100)
      await d.wait(2000)
    }
  },
  sharing: {
    scene: 'sharing',
    crop: full,
    width: 1600,
    poster: 9,
    play: async (d) => {
      const p = d.page
      const zoom = 1.45
      await d.show(760, 640)
      await d.wait(700)
      await d.zoom({ x: 634, y: 430 }, zoom, 1000)
      await d.click(p.getByRole('button', { name: 'Comment', exact: true }), 800)
      await p.locator('.cm-layer').waitFor()
      await d.wait(500)
      // The Start free trial button, measured from the comment layer over the page as scripts/shots.ts does, at the zoom.
      const layer = (await p.locator('.cm-layer').boundingBox())!
      await d.clickAt(Math.round(layer.x + 159 * zoom), Math.round(layer.y + 162 * zoom), 850)
      const box = p.getByRole('textbox', { name: 'Comment' })
      await box.waitFor()
      await d.zoom(box, 1.9, 800)
      await d.type('Make this button the same blue as the header.', 34)
      await d.wait(400)
      await d.click(p.locator('button', { hasText: /^Send$/ }).last(), 700)
      await d.wait(500)
      await d.unzoom(900)
      await d.click(p.getByText('PDF renderer', { exact: true }).first(), 800)
      await d.zoom({ x: 634, y: 560 }, 1.5, 1000)
      await d.wait(3800)
      await d.unzoom(800)
      await d.click(p.getByText('Pricing page draft', { exact: true }).first(), 800)
      await d.wait(900)
      const versions = p.getByRole('button', { name: 'Versions' }).first()
      await d.zoom(versions, 1.9, 900)
      await d.click(versions, 700)
      await d.wait(2600)
      await p.keyboard.press('Escape')
      await d.unzoom(900)
      await d.wait(900)
    }
  },
  issues: {
    scene: 'issues',
    crop: full,
    width: 2400,
    poster: 3,
    // Open the issue, plan it with Kernel, approve the plan, and back in Issues its three workspaces are linked to it.
    play: async (d) => {
      await d.show(700, 300)
      await d.wait(400)
      await d.click(d.page.getByText('Export invoices as PDF', { exact: true }).first(), 800)
      await d.wait(1800)
      await d.click(d.page.getByRole('button', { name: /^Plan with/ }).first(), 900)
      await d.wait(5200)
      await d.click(d.page.getByRole('button', { name: /^Approve/ }).first(), 900)
      await d.wait(4600)
      await d.click(d.page.getByText('Issues', { exact: true }).first(), 900)
      await d.wait(1200)
      await d.click(d.page.getByText('Export invoices as PDF', { exact: true }).first(), 900)
      await d.page.getByRole('heading', { name: 'Export invoices as PDF' }).waitFor()
      await d.wait(4500)
    }
  }
}

async function record(name: string, clip: Clip) {
  const dir = join(work, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // Without the flag, headless Chrome's screencast sends 1x frames whatever the context's scale.
  const browser = await chromium.launch({ args: [`--force-device-scale-factor=${SCALE}`] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE, reducedMotion: 'no-preference' })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error(`  ${name}: ${e.message}`))
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    const file = join(built, path === '/' ? 'index.html' : path)
    if (!existsSync(file)) return route.fulfill({ status: 404 })
    await route.fulfill({ body: readFileSync(file), contentType: MIME[extname(file)] ?? 'application/octet-stream' })
  })
  await page.goto(`${ORIGIN}/index.html?scene=${clip.scene}`)
  await page.locator('#root > *').first().waitFor()
  const d = new Driver(page)
  await d.wait(1500)
  if (clip.setup) await clip.setup(d)

  const cdp = await context.newCDPSession(page)
  const frames: { file: string; t: number }[] = []
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 })
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined)
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 94, maxWidth: 1440 * SCALE, maxHeight: 900 * SCALE, everyNthFrame: 1 })
  const start = Date.now() / 1000
  await clip.play(d)
  const end = Date.now() / 1000
  await cdp.send('Page.stopScreencast')
  await browser.close()
  if (!frames.length) throw new Error(`${name}: no frames`)

  // A concat list with each frame held until the next one, from the start of the recording to its end.
  const lines: string[] = []
  frames.forEach((fr, i) => {
    const from = i === 0 ? start : fr.t
    const to = frames[i + 1]?.t ?? end
    lines.push(`file '${fr.file}'`, `duration ${Math.max(0.001, to - from).toFixed(4)}`)
  })
  lines.push(`file '${frames.at(-1)!.file}'`)
  writeFileSync(join(dir, 'list.txt'), lines.join('\n'))

  const length = end - start
  const c = clip.crop
  const width = clip.width ?? c.width * SCALE
  const filters = [
    `crop=${c.width * SCALE}:${c.height * SCALE}:${c.x * SCALE}:${c.y * SCALE}`,
    `scale=${width}:-2:flags=lanczos`,
    'fps=30',
    'fade=t=in:st=0:d=0.35',
    `fade=t=out:st=${(length - 0.45).toFixed(2)}:d=0.45`,
    'format=yuv420p'
  ].join(',')
  mkdirSync(outDir, { recursive: true })
  const mp4 = join(outDir, `${name}.mp4`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', filters, '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-tune', 'animation', '-movflags', '+faststart', '-an', mp4])
  const at = Math.min(clip.poster ?? length - 0.6, length - 0.6)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', mp4, '-frames:v', '1', '-q:v', '3', join(outDir, `${name}.jpg`)])
  const kb = (p: string) => Math.round(readFileSync(p).length / 1024)
  console.log(`${name}: ${length.toFixed(1)}s, ${frames.length} frames, ${kb(mp4)} kB, poster ${kb(join(outDir, `${name}.jpg`))} kB`)
}

const wanted = process.argv.slice(2)
for (const name of wanted.length ? wanted : Object.keys(CLIPS)) {
  const clip = CLIPS[name]
  if (!clip) throw new Error(`No clip named ${name}. Clips: ${Object.keys(CLIPS).join(', ')}`)
  await record(name, clip)
}
