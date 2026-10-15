// Records the landing page's feature clips from the scene build: `pnpm demo:clips [name...]`.
//
// Each clip opens one scene (demo/scenes) at 1440x900 and 2x, moves a drawn cursor to what it clicks, and captures every
// frame Chrome paints over CDP. ffmpeg writes an MP4 and a poster to site/public/clips. Needs ffmpeg on PATH.
// `pnpm demo:clips reviews` records one clip; `node demo/clips.ts --encode` re-encodes from the last recording's frames.
//
// Every clip moves a camera, the way a product video zooms in on each step. The page itself never moves: the driver
// only notes where the camera goes and when, and after recording each output frame is drawn from the 2x capture through
// that moving window, with sub-pixel precision. Up to 1.8x on a 1600 wide clip, the zoomed frames stay sharp.
import { chromium, type Locator, type Page } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = join(root, 'out/scenes')
const outDir = join(root, 'site/public/clips')
const work = join(root, 'out/clips-work')
const ORIGIN = 'http://localhost:4360'
const SCALE = 2
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }

type Clip = {
  scene: string
  /** The width of the encoded video, in pixels. Up to 1600, a 1.8x zoom stays sharp. */
  width: number
  /** Runs before recording starts, so the clip opens on the moment it is about. */
  setup?: (d: Driver) => Promise<void>
  play: (d: Driver) => Promise<void>
  /** Seconds into the clip for the poster frame. Defaults to the last frame. */
  poster?: number
}

/** Where the camera heads at `t` seconds into the recording: `s` times, centered on (x, y) in window pixels. */
type Shot = { t: number; ms: number; s: number; x: number; y: number }
type View = { s: number; x: number; y: number }
const W = 1440
const H = 900

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
  /** When recording started, in seconds, and the camera moves made since. */
  start = 0
  readonly shots: Shot[] = []
  private glide = async (x: number, y: number, ms: number) => {
    await this.page.evaluate(([cx, cy, t]) => (window as unknown as { __cursor: { move(x: number, y: number, ms: number): Promise<void> } }).__cursor.move(cx!, cy!, t!), [x, y, ms])
    await this.page.mouse.move(x, y)
  }
  /** The middle of `target`, scrolled into view first. `x` keeps the camera on a column while it follows a row. */
  async point(target: Locator, x?: number) {
    await target.waitFor({ state: 'visible', timeout: 20_000 })
    await target.scrollIntoViewIfNeeded()
    const box = (await target.boundingBox())!
    return { x: x ?? box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  /** Glides the cursor to the middle of `target` and hovers it there. */
  async to(target: Locator, ms = 750) {
    await target.waitFor({ state: 'visible', timeout: 20_000 })
    await target.scrollIntoViewIfNeeded()
    const box = (await target.boundingBox())!
    const x = Math.round(box.x + box.width / 2)
    const y = Math.round(box.y + box.height / 2)
    await this.glide(x, y, ms)
    return { x, y }
  }
  async click(target: Locator, ms?: number) {
    const { x, y } = await this.to(target, ms)
    await this.wait(150)
    await this.page.evaluate(() => (window as unknown as { __cursor: { press(): void } }).__cursor.press())
    await this.page.mouse.click(x, y)
  }
  /** Glides to a point on screen and clicks there. */
  async clickAt(x: number, y: number, ms = 750) {
    await this.glide(x, y, ms)
    await this.wait(150)
    await this.page.evaluate(() => (window as unknown as { __cursor: { press(): void } }).__cursor.press())
    await this.page.mouse.click(x, y)
  }
  /**
   * Moves the camera to `s` times on the middle of `target`, or on a point, over `ms`. The move plays in the video while
   * the script goes on: `hold` is how much of it to wait for before the next step.
   */
  async zoom(target: Locator | { x: number; y: number }, s: number, ms = 1200, hold = 0.6) {
    const point = 'x' in target ? target : await this.point(target)
    this.shots.push({ t: Date.now() / 1000 - this.start, ms, s, ...point })
    await this.wait(ms * hold)
  }
  unzoom(ms = 1200, hold = 0.6) {
    return this.zoom({ x: W / 2, y: H / 2 }, 1, ms, hold)
  }
  type = (text: string, delay = 38) => this.page.keyboard.type(text, { delay })
}


const CLIPS: Record<string, Clip> = {
  workspaces: {
    scene: 'team',
    width: 2400,
    poster: 2.1,
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
    // in, Theo reviews the first pull request and it merges. The camera leans in on each step and eases back out.
    play: async (d) => {
      const p = d.page
      await d.show(980, 640)
      await d.wait(500)
      const approve = p.getByRole('button', { name: /^Approve/ }).first()
      await d.zoom(approve, 1.4, 1300, 0.45)
      await d.click(approve, 750)
      await d.wait(500)
      // The sidebar's new workspaces and the chat column, without the empty top of the window.
      await d.zoom({ x: 554, y: 560 }, 1.3, 1300, 0.5)
      await d.wait(2400)
      await d.click(p.getByText(/^Save new plans as plan\.md/).first(), 750)
      await d.wait(4200)
      await d.click(p.getByText(/^Show the saved plan file/).first(), 650)
      await d.wait(3600)
      await d.click(p.getByText(/^Cover plan naming/).first(), 650)
      await d.wait(3000)
      await d.unzoom(1300, 0.4)
      await d.click(p.getByText('Save plans as plan.md', { exact: true }).first(), 800)
      const merge = p.getByRole('button', { name: /^Merge PR #70/ }).first()
      await merge.waitFor({ timeout: 45_000 })
      await d.wait(800)
      await d.zoom(await d.point(merge, 640), 1.3, 1300, 0.5)
      await d.wait(900)
      await d.click(merge, 750)
      await d.wait(2200)
      await d.unzoom(1400, 0.6)
      await d.wait(1200)
    }
  },
  reviews: {
    scene: 'reviews',
    width: 1600,
    poster: 5,
    play: async (d) => {
      const p = d.page
      await d.show(760, 760)
      await d.wait(300)
      await d.zoom({ x: 634, y: 520 }, 1.5, 1300, 0.6)
      await d.step('update')
      await d.wait(3600)
      const first = p.getByText('Merge #161', { exact: true }).first()
      await d.zoom(await d.point(first, 634), 1.65, 1200, 0.4)
      await d.click(first, 750)
      await d.wait(900)
      await d.zoom({ x: 634, y: 520 }, 1.5, 1300, 0.4)
      await d.wait(3600)
      const second = p.getByText('Merge #158', { exact: true }).last()
      await d.zoom(await d.point(second, 634), 1.65, 1200, 0.4)
      await d.click(second, 750)
      await d.wait(1600)
      await d.unzoom(1400, 0.6)
      await d.wait(1200)
    }
  },
  permissions: {
    scene: 'permissions',
    width: 1600,
    poster: 6.7,
    play: async (d) => {
      const p = d.page
      await d.show(800, 780)
      await d.wait(300)
      await d.zoom({ x: 634, y: 360 }, 1.5, 1300, 0.6)
      await d.step('ask')
      await d.wait(2600)
      const once = p.getByRole('button', { name: /^Allow once/ }).last()
      await d.zoom(await d.point(once, 634), 1.65, 1200, 0.45)
      await d.wait(700)
      await d.click(once, 750)
      await d.zoom({ x: 634, y: 360 }, 1.5, 1300, 0.4)
      await d.wait(2000)
      const always = p.getByRole('button', { name: /^Always allow here/ }).last()
      await d.zoom(await d.point(always, 634), 1.65, 1200, 0.45)
      await d.wait(700)
      await d.click(always, 750)
      await d.zoom({ x: 634, y: 360 }, 1.5, 1300, 0.4)
      await d.wait(4200)
      await d.unzoom(1400, 0.6)
      await d.wait(1200)
    }
  },
  // A product-video take: the camera follows the cursor in to each control and back out to show what changed.
  accounts: {
    scene: 'accounts',
    width: 1600,
    poster: 23,
    play: async (d) => {
      const p = d.page
      await d.show(760, 520)
      await d.wait(500)
      const menu = p.getByRole('button', { name: /^Account menu/ })
      await d.zoom(menu, 1.8, 1300, 0.45)
      await d.click(menu, 750)
      await d.wait(400)
      await d.click(p.getByRole('menuitem', { name: /^Settings/ }).first(), 600)
      await d.wait(450)
      const accounts = p.getByText('Accounts', { exact: true }).first()
      await d.zoom(accounts, 1.8, 1200, 0.35)
      await d.click(accounts, 650)
      await d.wait(400)
      await d.zoom({ x: 860, y: 260 }, 1.45, 1300, 0.45)
      const add = p.getByRole('button', { name: 'Add account' })
      await d.click(add, 750)
      await d.wait(400)
      await d.click(p.getByRole('menuitem', { name: /API key/ }).first(), 600)
      await d.zoom(p.getByRole('dialog'), 1.7, 1100, 0.45)
      await d.click(p.locator('#acct-label'), 600)
      await d.type('Team key', 45)
      await d.click(p.locator('#acct-key'), 500)
      await d.type('sk-ant-api03-kernel-demo-key', 22)
      await d.wait(250)
      await d.click(p.getByRole('button', { name: 'Add key' }), 600)
      await d.wait(1400)
      await d.zoom({ x: 860, y: 300 }, 1.45, 1200, 0.5)
      await d.wait(800)
      await d.click(add, 750)
      await d.wait(400)
      await d.click(p.getByRole('menuitem', { name: /Subscription/ }).last(), 600)
      await d.zoom(p.getByRole('dialog'), 1.7, 1100, 0.45)
      await d.click(p.getByRole('button', { name: /^Sign in with ChatGPT/ }), 600)
      await d.wait(2300)
      await d.zoom({ x: 860, y: 380 }, 1.45, 1200, 0.5)
      await d.wait(1300)
      await d.unzoom(1500, 0.7)
      await d.wait(1500)
    }
  },
  sharing: {
    scene: 'sharing',
    width: 1600,
    poster: 6,
    play: async (d) => {
      const p = d.page
      await d.show(760, 640)
      await d.wait(500)
      await d.zoom({ x: 634, y: 430 }, 1.45, 1300, 0.45)
      await d.click(p.getByRole('button', { name: 'Comment', exact: true }), 750)
      await p.locator('.cm-layer').waitFor()
      await d.wait(400)
      // The Start free trial button, measured from the comment layer over the page as scripts/shots.ts does.
      const layer = (await p.locator('.cm-layer').boundingBox())!
      await d.clickAt(Math.round(layer.x + 159), Math.round(layer.y + 162), 750)
      const box = p.getByRole('textbox', { name: 'Comment' })
      await box.waitFor()
      await d.zoom(box, 1.75, 1100, 0.45)
      await d.type('Make this button the same blue as the header.', 30)
      await d.wait(300)
      await d.click(p.locator('button', { hasText: /^Send$/ }).last(), 600)
      await d.wait(400)
      await d.unzoom(1300, 0.5)
      await d.click(p.getByText('PDF renderer', { exact: true }).first(), 750)
      await d.zoom({ x: 634, y: 560 }, 1.5, 1300, 0.4)
      await d.wait(3000)
      await d.unzoom(1200, 0.4)
      await d.click(p.getByText('Pricing page draft', { exact: true }).first(), 750)
      await d.wait(700)
      const versions = p.getByRole('button', { name: 'Versions' }).first()
      await d.zoom(versions, 1.75, 1200, 0.45)
      await d.click(versions, 600)
      await d.wait(2200)
      await p.keyboard.press('Escape')
      await d.unzoom(1400, 0.7)
      await d.wait(800)
    }
  },
  issues: {
    scene: 'issues',
    width: 2400,
    poster: 3,
    // Open the issue, plan it with Kernel, approve the plan, and back in Issues its three workspaces are linked to it.
    play: async (d) => {
      const p = d.page
      await d.show(700, 300)
      await d.wait(300)
      const issue = p.getByText('Export invoices as PDF', { exact: true }).first()
      await d.zoom(issue, 1.35, 1300, 0.45)
      await d.click(issue, 750)
      await d.wait(600)
      await d.zoom({ x: 1000, y: 420 }, 1.3, 1300, 0.5)
      await d.wait(900)
      await d.zoom({ x: 1000, y: 620 }, 1.25, 1200, 0.4)
      await d.click(p.getByRole('button', { name: /^Plan with/ }).first(), 750)
      await d.unzoom(1200, 0.4)
      await d.wait(3800)
      const approve = p.getByRole('button', { name: /^Approve/ }).first()
      await d.zoom(await d.point(approve, 640), 1.3, 1200, 0.45)
      await d.click(approve, 750)
      await d.wait(1200)
      await d.unzoom(1300, 0.4)
      await d.wait(800)
      await d.click(p.getByText('Work', { exact: true }).first(), 800)
      await d.wait(900)
      await d.click(p.getByText('Export invoices as PDF', { exact: true }).first(), 800)
      await p.getByRole('heading', { name: 'Export invoices as PDF' }).waitFor()
      await d.zoom({ x: 1000, y: 520 }, 1.3, 1300, 0.5)
      await d.wait(2600)
      await d.unzoom(1400, 0.6)
      await d.wait(1000)
    }
  }
}

// ---------- The camera, after recording

/** Slow out of rest and slow into it, with no jolt at either end. */
const ease = (p: number) => p * p * p * (p * (p * 6 - 15) + 10)

/** A view kept inside the window: at `s` times, its center can't come closer to an edge than half the view. */
function inside(v: View): View {
  const hw = W / (2 * v.s)
  const hh = H / (2 * v.s)
  return { s: v.s, x: Math.min(W - hw, Math.max(hw, v.x)), y: Math.min(H - hh, Math.max(hh, v.y)) }
}

/**
 * The view part way through a move. The zoom changes at a steady rate (it eases in log scale), and the view's edges
 * travel in step with its size, so a zoom into a point holds that point still on screen instead of sliding past it.
 */
function between(from: View, to: View, p: number): View {
  const e = ease(Math.min(1, Math.max(0, p)))
  const s = Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * e)
  const u = Math.abs(to.s - from.s) < 1e-6 ? e : (1 / from.s - 1 / s) / (1 / from.s - 1 / to.s)
  return { s, x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u }
}

/** Where the camera is `t` seconds into the recording. A move that starts before the last one ends starts from mid-way. */
function cameraAt(shots: Shot[], t: number): View {
  type Move = { from: View; to: View; t: number; d: number }
  let move: Move | null = null
  const at = (m: Move, time: number): View => between(m.from, m.to, (time - m.t) / m.d)
  for (const shot of shots) {
    if (shot.t > t) break
    const from: View = move ? at(move, shot.t) : { s: 1, x: W / 2, y: H / 2 }
    move = { from, to: inside({ s: shot.s, x: shot.x, y: shot.y }), t: shot.t, d: shot.ms / 1000 }
  }
  return move ? at(move, t) : { s: 1, x: W / 2, y: H / 2 }
}

/**
 * Draws each output frame at 30 fps: the capture frame on screen at that moment, through the camera's view, scaled to
 * `width` in a canvas with high quality smoothing. Writes numbered JPEGs into `into`.
 */
async function renderCamera(frames: { file: string; t: number }[], start: number, length: number, shots: Shot[], width: number, into: string) {
  mkdirSync(into, { recursive: true })
  const height = Math.round((width * H) / W / 2) * 2
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.route('http://frames.local/**', (route) => route.fulfill({ body: readFileSync(decodeURIComponent(new URL(route.request().url()).pathname)), contentType: 'image/jpeg' }))
  await page.goto('http://frames.local/' + encodeURIComponent(frames[0]!.file))
  await page.evaluate(([w, h]) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h })
    const g = canvas.getContext('2d')!
    g.imageSmoothingEnabled = true
    g.imageSmoothingQuality = 'high'
    const cache = new Map<string, HTMLImageElement>()
    ;(window as unknown as { draw: unknown }).draw = async (file: string, sx: number, sy: number, sw: number, sh: number) => {
      let img = cache.get(file)
      if (!img) {
        img = new Image()
        img.src = 'http://frames.local/' + encodeURIComponent(file)
        await img.decode()
        cache.clear()
        cache.set(file, img)
      }
      g.drawImage(img, sx, sy, sw, sh, 0, 0, w!, h!)
      return canvas.toDataURL('image/jpeg', 0.95).slice('data:image/jpeg;base64,'.length)
    }
  }, [width, height])
  const count = Math.round(length * 30)
  let f = 0
  for (let i = 0; i < count; i++) {
    const t = i / 30
    while (f + 1 < frames.length && frames[f + 1]!.t - start <= t) f++
    const v = cameraAt(shots, t)
    const sw = (W / v.s) * SCALE
    const sh = (H / v.s) * SCALE
    const data = await page.evaluate(
      ([file, x, y, w, h]) => (window as unknown as { draw(f: string, x: number, y: number, w: number, h: number): Promise<string> }).draw(file as string, x as number, y as number, w as number, h as number),
      [frames[f]!.file, (v.x - W / (2 * v.s)) * SCALE, (v.y - H / (2 * v.s)) * SCALE, sw, sh] as const
    )
    writeFileSync(join(into, `${String(i).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'))
  }
  await browser.close()
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
  d.start = start
  await clip.play(d)
  const end = Date.now() / 1000
  await cdp.send('Page.stopScreencast')
  await browser.close()
  if (!frames.length) throw new Error(`${name}: no frames`)

  if (!d.shots.length) throw new Error(`${name}: a clip moves the camera at least once`)
  await renderCamera(frames, start, end - start, d.shots, clip.width, join(dir, 'camera'))
  encode(name, clip)
}

/** Encodes a clip's drawn frames into its MP4 and poster. CRF 30 on the slowest preset: text reads the same as at 24, at about half the size. */
function encode(name: string, clip: Clip) {
  const drawn = join(work, name, 'camera')
  if (!existsSync(drawn)) throw new Error(`${name}: no drawn frames. Record it first: pnpm demo:clips ${name}`)
  const length = readdirSync(drawn).filter((f) => f.endsWith('.jpg')).length / 30
  const fades = ['fade=t=in:st=0:d=0.35', `fade=t=out:st=${(length - 0.45).toFixed(2)}:d=0.45`, 'format=yuv420p'].join(',')
  mkdirSync(outDir, { recursive: true })
  const mp4 = join(outDir, `${name}.mp4`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(drawn, '%05d.jpg'), '-vf', fades, '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '30', '-tune', 'animation', '-movflags', '+faststart', '-an', mp4])
  const at = Math.min(clip.poster ?? length - 0.6, length - 0.6)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', mp4, '-frames:v', '1', '-q:v', '3', join(outDir, `${name}.jpg`)])
  const kb = (p: string) => Math.round(readFileSync(p).length / 1024)
  console.log(`${name}: ${length.toFixed(1)}s, ${kb(mp4)} kB, poster ${kb(join(outDir, `${name}.jpg`))} kB`)
}

// `--encode` re-encodes from the frames the last recording drew, without recording again.
const args = process.argv.slice(2)
const encodeOnly = args.includes('--encode')
const wanted = args.filter((a) => a !== '--encode')
for (const name of wanted.length ? wanted : Object.keys(CLIPS)) {
  const clip = CLIPS[name]
  if (!clip) throw new Error(`No clip named ${name}. Clips: ${Object.keys(CLIPS).join(', ')}`)
  if (encodeOnly) encode(name, clip)
  else await record(name, clip)
}
