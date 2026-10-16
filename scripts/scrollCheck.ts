// End-to-end check that every view keeps its scroll position (KERNEL-923, contract in KERNEL-919). Runs on plain Node with built-in type
// stripping, so only erasable TypeScript here. Launches the real app headless on fixtures, the way scripts/shots.ts does.
//
//   pnpm scroll-check                  build, then check every view
//   pnpm scroll-check --no-build       reuse the last build
//   pnpm scroll-check inbox-list prs   only the views whose name starts with one of these
//
// Per view: 20 round trips away and back, a window resize while away, an item removed and one added above while away, a restart on the same
// localStorage, and for views left at their end, new content while away. A view that fails prints the case and the pixels.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { views, type Ctx, type View } from './scrollCheck/views.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = join(root, 'shots')
const args = process.argv.slice(2).filter((a) => a !== '--')
const flags = new Set(args.filter((a) => a.startsWith('--')))
const only = args.filter((a) => !a.startsWith('--'))
const TRIPS = 20

interface Probe { id: string | null; offset: number; top: number; range: number; end: boolean }

/** The item at the top of the scroller and how far it sits from the top edge, in pixels. What a restore has to hold. */
async function probe(page: Page, v: View): Promise<Probe | null> {
  return page.evaluate(({ sel, item, axis, raw, wheel, endText }) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) return null
    const x = axis === 'x'
    const box = el.getBoundingClientRect()
    const edge = x ? box.left : box.top
    let id: string | null = raw ? 'raw' : null
    let offset = 0
    if (wheel) {
      // xterm draws its own scrollbar, so the scroller has no scrollTop. The first line on screen is the anchor, and the last tells whether it is at the end.
      const rows = [...el.querySelectorAll<HTMLElement>('.xterm-rows > div')].map((r) => (r.textContent ?? '').trim()).filter(Boolean)
      return { id: rows[0] ?? null, offset: 0, top: 0, range: 0, end: !!endText && new RegExp(endText).test(rows[rows.length - 1] ?? '') }
    }
    if (!raw) {
      for (const n of el.querySelectorAll<HTMLElement>(item)) {
        const r = n.getBoundingClientRect()
        if ((x ? r.right : r.bottom) > edge + 1) {
          // Rows carry data-keep-id. The chat transcript has none, so its rows are told apart by their jump id or their first words.
          id = n.getAttribute('data-keep-id') ?? n.querySelector('[data-jump]')?.getAttribute('data-jump') ?? n.getAttribute('data-jump') ?? (n.textContent ?? '').trim().slice(0, 40)
          offset = (x ? r.left : r.top) - edge
          break
        }
      }
    }
    const top = x ? el.scrollLeft : el.scrollTop
    const range = x ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight
    return { id, offset, top, range, end: range - top <= 2 }
  }, { sel: v.scroller, item: v.item ?? '[data-keep-id]', axis: v.axis ?? 'y', raw: !!v.raw, wheel: !!v.wheel, endText: v.endText ?? '' })
}

/** The ids of the rows mounted in the scroller, in order. */
const rowIds = (page: Page, v: View) =>
  page.evaluate(({ sel, item }) => [...(document.querySelector(sel)?.querySelectorAll<HTMLElement>(item) ?? [])].map((n) => n.getAttribute('data-keep-id') ?? (n.textContent ?? '').trim().slice(0, 40)), { sel: v.scroller, item: v.item ?? '[data-keep-id]' })

/** Waits for the scroller to hold still: the same probe three times, 80ms apart. A restore keeps correcting for up to 600ms. */
async function settled(page: Page, v: View, within = 2500): Promise<Probe | null> {
  const from = Date.now()
  let last = ''
  let still = 0
  let p: Probe | null = null
  while (Date.now() - from < within) {
    p = await probe(page, v)
    const s = JSON.stringify(p)
    still = s === last ? still + 1 : 0
    last = s
    if (still >= 3) return p
    await page.waitForTimeout(80)
  }
  return p
}

const same = (a: Probe | null, b: Probe | null) => !!a && !!b && a.id === b.id && (a.id === 'raw' ? Math.abs(a.top - b.top) < 1 : Math.abs(a.offset - b.offset) < 0.5)

/** Wheels the scroller by hand to `to` (a pixel position or 'end'), the way a reader would, then waits for it to settle. */
async function scrollTo(page: Page, v: View, to: number | 'end') {
  if (v.wheel) {
    const box = (await page.locator(v.scroller).first().boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 1_000_000)
    await page.waitForTimeout(250)
    if (to !== 'end') await page.mouse.wheel(0, -to)
    await page.waitForTimeout(250)
    return
  }
  await page.locator(v.scroller).first().evaluate((el, [at, axis]) => {
    const x = axis === 'x'
    const range = x ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight
    const n = at === 'end' ? range : Math.min(range, at as number)
    if (x) el.scrollLeft = n; else el.scrollTop = n
  }, [to, v.axis ?? 'y'] as const)
  await page.waitForTimeout(250)
}

interface Run { app: ElectronApplication; page: Page; data: string }

async function launch(fixture: string, data: string, size: [number, number] = [1440, 900]): Promise<Run> {
  const env: Record<string, string> = {}
  for (const [k, val] of Object.entries(process.env)) if (val !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ELECTRON_RENDERER_URL') env[k] = val
  env.KERNEL_FIXTURES = fixture
  env.KERNEL_HEADLESS = '1'
  env.KERNEL_FIXTURE_DATA = data
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], cwd: root, env })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h), { w: size[0], h: size[1] })
  await page.waitForSelector('html[data-fixture="ready"]', { state: 'attached', timeout: 20_000 })
  await page.waitForSelector('[data-lazy="pending"]', { state: 'detached', timeout: 20_000 })
  await page.waitForTimeout(600)
  return { app, page, data }
}

/** Closes the window the way a quit does, so the spots are flushed to localStorage (pagehide) before the next launch reads them. */
async function quit(run: Run) {
  await run.page.evaluate(() => window.dispatchEvent(new Event('pagehide'))).catch(() => undefined)
  await run.page.waitForTimeout(150)
  await run.app.close().catch(() => undefined)
}

const fail = (v: View, step: string, detail: string) => ({ view: v.name, step, detail })
type Failure = ReturnType<typeof fail>

const fmt = (p: Probe | null) => (p ? `${p.id}@${p.offset.toFixed(1)}px top=${p.top.toFixed(1)}/${p.range.toFixed(1)}` : 'none')

async function checkView(v: View, results: Failure[]) {
  const data = mkdtempSync(join(tmpdir(), 'kernel-scroll-'))
  let run: Run | undefined
  const bad = (step: string, detail: string) => { results.push(fail(v, step, detail)); console.log(`  FAIL ${step}: ${detail}`) }
  try {
    run = await launch(v.fixture, data, v.size)
    const size = v.size ?? [1440, 900]
    const ctx = (): Ctx => ({ app: run!.app, page: run!.page })
    await v.open?.(ctx())
    await run.page.waitForSelector(v.scroller, { timeout: 10_000 })
    await run.page.waitForTimeout(500)

    // 1. Leave it somewhere in the middle, or at its end.
    const at = v.end ? 'end' : v.at ?? 600
    await scrollTo(run.page, v, at)
    const start = await settled(run.page, v)
    if (!start?.id) return bad('setup', `no anchor item in ${v.scroller} (${fmt(start)}); the fixture needs rows`)
    if (!v.end && !v.wheel && start.top < 50) return bad('setup', `the view did not scroll (top=${start.top}, range=${start.range}); it needs more content`)
    if (v.end && !start.end) return bad('setup', `the view is not at its end (${fmt(start)})`)

    // 2. Round trips.
    let held = start
    for (let i = 1; i <= TRIPS; i++) {
      await v.away(ctx())
      await run.page.waitForTimeout(120)
      await v.back(ctx())
      held = (await settled(run.page, v))!
      if (start.end ? !held?.end : !same(start, held)) return bad(`round trip ${i} of ${TRIPS}`, `left at ${fmt(start)}, came back at ${fmt(held)}`)
    }
    console.log(`  ok  ${TRIPS} round trips hold ${fmt(start)}`)

    // 3. A resize while away: the anchor and the offset still apply.
    await v.away(ctx())
    await run.app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]?.setContentSize(s.w, s.h), { w: size[0] - 260, h: size[1] - 140 })
    await run.page.waitForTimeout(250)
    await v.back(ctx())
    const resized = await settled(run.page, v)
    await run.app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]?.setContentSize(s.w, s.h), { w: size[0], h: size[1] })
    await run.page.waitForTimeout(250)
    if (start.end ? !resized?.end : !same(start, resized)) bad('resize while away', `left at ${fmt(start)}, came back at ${fmt(resized)}`)
    else console.log('  ok  resize while away')
    // Put it back where it was for the next step, whatever the resize did.
    await scrollTo(run.page, v, at)
    const base = (await settled(run.page, v))!

    // 4. An item removed and one added above while away.
    if (v.change) {
      const rowsBefore = await rowIds(run.page, v)
      await v.away(ctx())
      await v.change.remove(ctx(), base, rowsBefore)
      await v.change.add(ctx(), base)
      await run.page.waitForTimeout(200)
      await v.back(ctx())
      const changed = await settled(run.page, v)
      // A change that changed nothing would pass for the wrong reason, so the rows on screen have to differ.
      const rowsAfter = await rowIds(run.page, v)
      const gone = rowsBefore.filter((r) => !rowsAfter.includes(r)).length
      const came = rowsAfter.filter((r) => !rowsBefore.includes(r)).length
      console.log(`      ${gone} row(s) gone, ${came} new among the mounted rows`)
      // The anchor holds when it is still there. When the anchor itself was removed the view falls back to its neighbor above, so only the id may differ.
      if (!gone && !came) bad('item removed and added above while away', 'the rows did not change, so the case proved nothing')
      else if (base.end ? !changed?.end : v.change.removesAnchor ? !changed?.id : !same(base, changed)) bad('item removed and added above while away', `left at ${fmt(base)}, came back at ${fmt(changed)}`)
      else console.log('  ok  item removed and added above while away')
    }

    // 5. New content while away, for a view left at its end: it reopens at the new end.
    if (v.end && v.grow) {
      await scrollTo(run.page, v, 'end')
      await v.away(ctx())
      await v.grow(ctx())
      await run.page.waitForTimeout(200)
      await v.back(ctx())
      const grown = await settled(run.page, v)
      if (!grown?.end) bad('new content while away', `left at its end, came back at ${fmt(grown)}`)
      else console.log('  ok  new content while away, reopens at the new end')
    }

    // 6. Restart: the same user data, so the same localStorage.
    await scrollTo(run.page, v, at)
    const before = (await settled(run.page, v))!
    await run.page.waitForTimeout(900) // the spots are written a moment after they change
    await quit(run)
    run = await launch(v.fixture, data, v.size)
    await v.open?.(ctx())
    await run.page.waitForSelector(v.scroller, { timeout: 10_000 })
    const after = await settled(run.page, v)
    if (before.end ? !after?.end : !same(before, after)) bad('restart', `left at ${fmt(before)}, reopened at ${fmt(after)}`)
    else console.log('  ok  restart')

    // 7. A target still wins.
    if (v.target) {
      const r = await v.target(ctx())
      if (r) bad('explicit target', r)
      else console.log('  ok  explicit target wins')
    }
  } catch (err) {
    bad('error', err instanceof Error ? err.message.split('\n')[0] : String(err))
    if (run) await run.page.screenshot({ path: join(shotsDir, `scroll-check-${v.name}-error.png`) }).catch(() => undefined)
  } finally {
    if (run) await run.app.close().catch(() => undefined)
    rmSync(data, { recursive: true, force: true })
  }
}

async function main() {
  if (!flags.has('--no-build')) {
    const build = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], { cwd: root, stdio: 'inherit' })
    if (build.status !== 0) process.exit(build.status ?? 1)
  }
  mkdirSync(shotsDir, { recursive: true })
  const list = only.length ? views.filter((v) => only.some((o) => v.name.startsWith(o))) : views
  if (!list.length) throw new Error(`No view matches ${only.join(', ')}. Views: ${views.map((v) => v.name).join(', ')}`)
  const results: Failure[] = []
  const t0 = Date.now()
  for (const v of list) {
    const before = results.length
    console.log(v.name)
    await checkView(v, results)
    if (results.length === before) console.log(`  PASS ${v.name}`)
  }
  const secs = Math.round((Date.now() - t0) / 1000)
  console.log(`\n${list.length} views in ${secs}s, ${results.length} failures`)
  for (const f of results) console.log(`FAIL ${f.view} / ${f.step}: ${f.detail}`)
  if (results.length) process.exit(1)
}

await main()
