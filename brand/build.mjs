// Builds the Block K review sheet and the 1024 close-up from the SVGs that
// k.py writes, then renders both to PNG in headless Chromium.
//   node brand/build.mjs [out dir for PNGs]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const outDir = resolve(process.argv[2] ?? join(repo, '.kernel/shared'))
const read = (f) => readFileSync(join(here, f), 'utf8')
const uri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const tint = (svg, color) => svg.replace('fill="currentColor"', `fill="${color}"`)

const tile = uri(read('icon-tile.svg'))
const tile32 = uri(read('icon-tile-32.svg'))
const tile16 = uri(read('icon-tile-16.svg'))
const lockup = read('wordmark.svg')
const LOCKUP_VIEW = lockup.match(/viewBox="0 0 ([\d.]+) (\d+)"/).slice(1).map(Number)

// The squircle from the tile, for the stand-ins.
const SQUIRCLE = read('icon-tile.svg').match(/<clipPath id="tile"><path d="([^"]+)"/)[1]

// The current site wordmark: the node K at 0.78em with a 0.02em margin, then "ernel".
const oldPath = readFileSync(join(repo, 'site/components/brand/markPath.ts'), 'utf8').match(/MARK_PATH =\s*'([^']+)'/)[1]
const oldMark = (ink) => uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440.49 455.29"><path fill="${ink}" d="${oldPath}"/></svg>`)

// The new lockup at a font size: 2048 units per em, baseline at 1490.
const newWordmark = (ink, size) => {
  const k = size / 2048
  return `<img class="lockup" src="${uri(tint(lockup, ink))}" width="${(LOCKUP_VIEW[0] * k).toFixed(2)}" height="${(LOCKUP_VIEW[1] * k).toFixed(2)}" style="margin-bottom:${(-23 * k).toFixed(2)}px" alt="Kernel">`
}
const oldWordmark = (ink, size) =>
  `<span class="oldwm" style="font-size:${size}px;color:${ink}"><img src="${oldMark(ink)}" style="height:0.78em;width:auto;margin-right:0.02em" alt="">ernel</span>`

// Neutral stand-ins. The T3 one carries the same ink mass as T3's real
// glyph, two letters at about 70% of the tile, so the weight compares.
const standIn = (top, bottom, shape) =>
  uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient><linearGradient id="s" x1="0" y1="340" x2="0" y2="684" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#bdbdc2"/></linearGradient></defs><path d="${SQUIRCLE}" fill="url(#g)"/>${shape}</svg>`)
const refs = {
  finder: { label: 'Finder', src: standIn('#ececef', '#bdbdc2', '<rect x="312" y="312" width="400" height="400" rx="60" fill="#8a8a90"/>') },
  t3: { label: 'T3 Code', src: standIn('#050505', '#050505', '<rect x="222" y="352" width="270" height="320" rx="14" fill="url(#s)"/><rect x="532" y="352" width="270" height="320" rx="14" fill="url(#s)"/><path d="' + SQUIRCLE + '" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="2"/>') },
  vscode: { label: 'VS Code', src: standIn('#3a8ee6', '#1d5fae', '<circle cx="512" cy="512" r="210" fill="#fff" fill-opacity=".92"/>') },
  warp: { label: 'Warp', src: standIn('#2b3440', '#0d1016', '<path d="M512 292 L732 512 L512 732 L292 512 Z" fill="#dfe6ee"/>') },
}

const dock = (theme) => {
  const items = [refs.finder, refs.t3, { label: 'Kernel', src: tile, me: true }, refs.vscode, refs.warp]
  return `
  <figure>
    <div class="wall ${theme}">
      <div class="dock">${items
        .map((it) => `<div class="app${it.me ? ' me' : ''}"><span class="tip">${it.label}</span><img src="${it.src}" width="64" height="64" alt=""><i></i></div>`)
        .join('')}</div>
    </div>
    <figcaption class="cap">${theme === 'dark' ? 'Dark' : 'Light'} wallpaper, 64 pt Dock</figcaption>
  </figure>`
}

const wordCard = (bg, ink, line, label) => `
  <div class="wcard" style="background:${bg};border-color:${line};color:${ink}">
    <div class="wlabel">${label}</div>
    <div class="wgrid">
      <span class="wl">New, 64</span><div>${newWordmark(ink, 64)}</div>
      <span class="wl">Current, 64</span><div>${oldWordmark(ink, 64)}</div>
      <span class="wl">New, 18</span><div class="pair">${newWordmark(ink, 18)}</div>
      <span class="wl">Current, 18</span><div class="pair">${oldWordmark(ink, 18)}</div>
    </div>
  </div>`

// The DMG window: build/dmg-background.svg with the wordmark swapped for the
// new lockup at the same 18 px size and baseline, and the new icon in the
// app slot. Finder draws a 32 pt title bar and shows the art's top 408.
function dmgArt() {
  const svg = readFileSync(join(repo, 'build/dmg-background.svg'), 'utf8')
  const k = 18 / 2048
  const inner = lockup.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '')
  const swapped = svg.replace(
    /<!-- wordmark:[^\n]*\n[^\n]*\n[^\n]*\n/,
    `<!-- wordmark: new lockup, 18 px, baseline 41.2 -->\n  <g transform="translate(36 ${(41.2 - 1490 * k).toFixed(2)}) scale(${k.toFixed(6)})" fill="#18191b">${inner}</g>\n`,
  )
  if (swapped === svg) throw new Error('DMG wordmark not found')
  return uri(swapped)
}
const folder = uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M12 30a8 8 0 0 1 8-8h28l8 8h52a8 8 0 0 1 8 8v62a8 8 0 0 1-8 8H20a8 8 0 0 1-8-8z" fill="#5aa6f0"/><path d="M12 44a8 8 0 0 1 8-8h88a8 8 0 0 1 8 8v56a8 8 0 0 1-8 8H20a8 8 0 0 1-8-8z" fill="#78baf6"/><path d="M64 56 L80 92 H72 L64 74 L56 92 H48 Z" fill="#3d86d4"/></svg>`)

const css = `
@font-face { font-family: Inter; src: url('../design/site/fonts/inter-var.woff2') format('woff2'); font-weight: 100 900; }
:root { --bg: #0c0c0d; --card: #141415; --line: #232325; --ink: #f7f7f8; --ink-2: #d6d6d7; --muted: #8e8e92; }
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); color: var(--ink-2); font: 13px/1.5 Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
img { display: block; }
.cap { color: var(--muted); font-size: 11px; }
`

const sheet = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kernel Block K</title>
<style>${css}
.page { width: 1600px; padding: 56px 64px 64px; }
header { margin-bottom: 36px; }
h1 { color: var(--ink); font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
header p { color: var(--muted); margin-top: 6px; max-width: 900px; }
h2 { color: var(--ink); font-size: 13px; font-weight: 600; margin-bottom: 4px; }
section > .cap { margin-bottom: 20px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px 28px 28px; margin-bottom: 20px; }
.sizes { display: flex; align-items: flex-end; gap: 40px; }
.sizes figure { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.px { display: flex; gap: 40px; margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--line); }
.px figure { display: flex; flex-direction: column; gap: 8px; }
.px canvas { width: 160px; height: 160px; image-rendering: pixelated; border-radius: 4px; background: #1b1b1d; }
.px .group { display: flex; gap: 16px; }
.docks { display: grid; grid-template-columns: 1fr 1fr 220px; gap: 20px; align-items: start; }
.docks figure .cap { margin-top: 8px; }
.wall { height: 220px; border-radius: 10px; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 10px; }
.wall.dark { background: radial-gradient(120% 90% at 20% 0%, #3b3f4f 0%, #1d2029 45%, #0d0e12 100%); }
.wall.light { background: radial-gradient(120% 90% at 20% 0%, #f4efe9 0%, #d9dde6 50%, #b8c0cf 100%); }
.dock { display: flex; gap: 8px; padding: 6px 8px 7px; border-radius: 22px; }
.dark .dock { background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.2); }
.light .dock { background: rgba(255,255,255,.42); border: 1px solid rgba(255,255,255,.6); }
.app { position: relative; display: flex; flex-direction: column; align-items: center; }
.app i { width: 4px; height: 4px; border-radius: 2px; margin-top: 3px; }
.dark .app.me i { background: rgba(255,255,255,.85); }
.light .app.me i { background: rgba(0,0,0,.7); }
.tip { display: none; }
.app.me .tip { display: block; position: absolute; top: -34px; white-space: nowrap; font-size: 12px; color: #f2f2f3; background: rgba(40,40,44,.88); border: 1px solid rgba(255,255,255,.14); padding: 2px 9px; border-radius: 6px; }
.ref img { width: 160px; border-radius: 8px; }
.ref .cap { margin-top: 8px; }
.words { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.wcard { border: 1px solid; border-radius: 10px; padding: 24px 32px 28px; }
.wlabel { font-size: 11px; opacity: .55; margin-bottom: 18px; }
.wgrid { display: grid; grid-template-columns: 110px 1fr; row-gap: 26px; align-items: center; }
.wl { font-size: 11px; opacity: .55; padding-bottom: 2px; }
.oldwm { display: inline-flex; align-items: baseline; font-weight: 600; letter-spacing: -0.02em; line-height: 1; }
.dmgrow { display: flex; gap: 32px; align-items: flex-start; }
.win { width: 660px; border-radius: 12px; overflow: hidden; box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.08) inset; }
.titlebar { height: 32px; background: #ececee; border-bottom: 1px solid #d4d4d8; display: flex; align-items: center; padding: 0 12px; position: relative; }
.lights { display: flex; gap: 8px; }
.lights i { width: 12px; height: 12px; border-radius: 6px; background: #d0d0d4; border: 1px solid #bdbdc2; }
.titlebar span { position: absolute; left: 0; right: 0; text-align: center; font: 600 13px -apple-system, system-ui, sans-serif; color: #3c3c40; }
.content { position: relative; width: 660px; height: 408px; overflow: hidden; }
.content > img.art { position: absolute; inset: 0 auto auto 0; }
.slot { position: absolute; width: 128px; display: flex; flex-direction: column; align-items: center; transform: translate(-64px, -64px); }
.slot span { margin-top: 6px; font: 12px -apple-system, system-ui, sans-serif; color: #18191b; }
.zoom { width: 560px; height: 146px; overflow: hidden; border-radius: 8px; border: 1px solid var(--line); }
.zoom img { width: 1320px; height: 880px; }
</style></head>
<body><div class="page">
  <header>
    <h1>Kernel, Block K, round 2</h1>
    <p>The icon K spans 68% of the tile on the app's canvas color, with a sheen on the glyph only. The 32 and 16 px files are drawn on the pixel grid without the sheen. The wordmark uses a lighter cut of the same K at Inter's cap height. This sheet renders at 2x, so every size below is real pixels.</p>
  </header>

  <section>
    <h2>App icon</h2>
    <p class="cap">1024 and 512 come from the big file. 32 and 16 use the pixel grid files.</p>
    <div class="sizes">
      <figure><img src="${tile}" width="512" height="512" alt=""><span class="cap">1024</span></figure>
      <figure><img src="${tile}" width="256" height="256" alt=""><span class="cap">512</span></figure>
      <figure><img src="${tile}" width="64" height="64" alt=""><span class="cap">128</span></figure>
      <figure><img src="${tile}" width="32" height="32" alt=""><span class="cap">64</span></figure>
      <figure><img src="${tile32}" width="16" height="16" alt=""><span class="cap">32</span></figure>
      <figure><img src="${tile16}" width="8" height="8" alt=""><span class="cap">16</span></figure>
    </div>
    <div class="px">
      <figure><div class="group"><canvas data-src="${tile}" data-size="32" width="32" height="32"></canvas><canvas data-src="${tile32}" data-size="32" width="32" height="32"></canvas></div><span class="cap">32 at 1x: scaled from 1024, then the pixel grid file</span></figure>
      <figure><div class="group"><canvas data-src="${tile}" data-size="16" width="16" height="16"></canvas><canvas data-src="${tile16}" data-size="16" width="16" height="16"></canvas></div><span class="cap">16 at 1x: scaled from 1024, then the pixel grid file</span></figure>
    </div>
  </section>

  <section>
    <h2>In the Dock</h2>
    <p class="cap">Finder, VS Code and Warp are neutral stand-ins. The T3 stand-in carries the same ink as T3's two letters, so the weight compares.</p>
    <div class="docks">
      ${dock('dark')}
      ${dock('light')}
      <figure class="ref"><img src="../.kernel/attachments/image-11.png" alt=""><figcaption class="cap">T3 in the Dock, for reference</figcaption></figure>
    </div>
  </section>

  <section>
    <h2>Wordmark</h2>
    <p class="cap">The wordmark K, then "ernel" in Inter 600 at -0.02em. 18 is the site nav size.</p>
    <div class="words">
      ${wordCard('#f3f3f4', '#18191b', '#dedee2', 'Light, #f3f3f4')}
      ${wordCard('#09090a', '#f7f7f8', '#1f1f21', 'Dark, #09090a')}
    </div>
  </section>

  <section>
    <h2>DMG installer</h2>
    <p class="cap">build/dmg-background.svg with the new wordmark at its real 18 px size and the new icon in the app slot. Right: the header enlarged 2x.</p>
    <div class="dmgrow">
      <div class="win">
        <div class="titlebar"><div class="lights"><i></i><i></i><i></i></div><span>Kernel 1.0.0</span></div>
        <div class="content">
          <img class="art" src="${dmgArt()}" width="660" height="440" alt="">
          <div class="slot" style="left:165px;top:236px"><img src="${tile}" width="128" height="128" alt=""><span>Kernel</span></div>
          <div class="slot" style="left:495px;top:236px"><img src="${folder}" width="128" height="128" alt=""><span>Applications</span></div>
        </div>
      </div>
      <div class="zoom"><img src="${dmgArt()}" alt=""></div>
    </div>
  </section>
</div>
<script>
// Rasterize at true 1x into a small canvas; CSS enlarges it with hard pixels.
const jobs = [...document.querySelectorAll('canvas[data-src]')].map((c) => new Promise((done) => {
  const img = new Image()
  img.onload = () => { const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height); done() }
  img.src = c.dataset.src
}))
Promise.all([...jobs, document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]).then(() => { window.__ready = true })
</script>
</body></html>
`

const closeup = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kernel icon at 1024</title>
<style>${css} body { background: #1c1c1e; } .page { padding: 0; width: 1024px; }</style></head>
<body><div class="page"><img src="${tile}" width="1024" height="1024" alt=""></div>
<script>document.images[0].decode().then(() => { window.__ready = true })</script></body></html>
`

writeFileSync(join(here, 'sheet.html'), sheet)
writeFileSync(join(here, 'closeup.html'), closeup)

const require = createRequire(join(repo, 'package.json'))
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ headless: true })
mkdirSync(outDir, { recursive: true })
for (const [page, png, scale, width] of [
  ['sheet.html', 'kernel-block-k.png', 2, 1600],
  ['closeup.html', 'kernel-block-k-1024.png', 1, 1024],
]) {
  const ctx = await browser.newContext({ deviceScaleFactor: scale, viewport: { width, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(`file://${join(here, page)}`)
  await p.waitForFunction(() => window.__ready === true)
  await p.screenshot({ path: join(outDir, png), fullPage: true })
  await ctx.close()
  console.log('wrote', join(outDir, png))
}
await browser.close()
