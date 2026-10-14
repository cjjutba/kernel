// Renders the PNG exports in design/site/logo/ from the masters that k.py
// writes, then builds the review sheet and renders it to PNG, all in headless
// Chromium.
//   node design/brand/build.mjs
// Run k.py first. Decision: docs/decisions/KERNEL-818.md.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const logo = join(repo, 'design/site/logo')
const read = (f) => readFileSync(join(here, f), 'utf8')
const uri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const png = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`
const tint = (svg, color) => svg.replace('fill="currentColor"', `fill="${color}"`)
const viewOf = (svg) => svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).slice(1).map(Number)

const INK = '#18191b'
const WHITE = '#f7f7f8'
const tile1024 = read('icon-tile-1024.svg')
const tile32 = read('icon-tile-32.svg')
const tile16 = read('icon-tile-16.svg')
const lockupInk = read('wordmark-ink.svg')
const lockupWhite = read('wordmark-white.svg')
const round2 = read('explorations/wordmark-round-2.svg')
const LOCKUP = viewOf(lockupInk)

// The Apple touch icon is full bleed: iOS draws its own rounded mask, so the
// 824 tile's contents fill the square, without the hairline.
const touchIcon = tile1024
  .replace('viewBox="0 0 1024 1024" width="1024" height="1024"', 'viewBox="100 100 824 824" width="180" height="180"')
  .replace(/<path d="[^"]+" fill="#09090a"\/>/, '<rect x="100" y="100" width="824" height="824" fill="#09090a"/>')
  .replace(/\n {2}<path d="[^"]+" fill="none"[^\n]+/, '')

const require = createRequire(join(repo, 'package.json'))
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ headless: true })

async function render(html, out, width, height, { scale = 1, transparent = false, fullPage = false, file } = {}) {
  const ctx = await browser.newContext({ deviceScaleFactor: scale, viewport: { width, height } })
  const p = await ctx.newPage()
  if (file) await p.goto(`file://${file}`)
  else await p.setContent(html, { waitUntil: 'load' })
  await p.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})))
    if (window.__work) await window.__work
  })
  await p.screenshot({ path: out, omitBackground: transparent, fullPage })
  await ctx.close()
  console.log('wrote', out)
}
const bare = (body, bg = 'transparent') => `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0}body{background:${bg}}img{display:block}</style></head><body>${body}</body></html>`

// Exports -------------------------------------------------------------------

await render(bare(`<img src="${uri(tile16)}" width="16" height="16">`), join(logo, 'favicon-16.png'), 16, 16, { transparent: true })
await render(bare(`<img src="${uri(tile32)}" width="32" height="32">`), join(logo, 'favicon-32.png'), 32, 32, { transparent: true })
await render(bare(`<img src="${uri(touchIcon)}" width="180" height="180">`), join(logo, 'apple-touch-icon.png'), 180, 180)
await render(bare(`<img src="${uri(tile1024)}" width="512" height="512">`), join(logo, 'kernel-app-icon-512.png'), 512, 512, { transparent: true })

// The social image: og-base.png is the old image with its wordmark painted
// out. The new lockup takes the old one's place: left edge 72, baseline 117,
// 34 px, which matches the old wordmark's cap height.
{
  const k = 34 / 2048
  const lock = `<img src="${uri(lockupWhite)}" width="${(LOCKUP[0] * k).toFixed(3)}" height="${(LOCKUP[1] * k).toFixed(3)}" style="position:absolute;left:72px;top:${(117 - 1490 * k).toFixed(3)}px">`
  await render(bare(`<div style="position:relative;width:1200px;height:630px;background:url(${png(join(here, 'og-base.png'))})">${lock}</div>`), join(logo, 'og-image.png'), 1200, 630)
}

// Review sheet --------------------------------------------------------------

const SQUIRCLE = tile1024.match(/<clipPath id="tile"><path d="([^"]+)"/)[1]

// The lockup at a font size: 2048 units per em, baseline at 1490.
const wordmark = (svg, size, ink) => {
  const k = size / 2048
  const [w, h] = viewOf(svg)
  return `<img src="${uri(ink ? tint(svg, ink) : svg)}" width="${(w * k).toFixed(2)}" height="${(h * k).toFixed(2)}" alt="Kernel">`
}

// Neutral Dock stand-ins.
const standIn = (top, bottom, shape) =>
  uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient><linearGradient id="s" x1="0" y1="340" x2="0" y2="684" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#bdbdc2"/></linearGradient></defs><path d="${SQUIRCLE}" fill="url(#g)"/>${shape}</svg>`)
const refs = [
  { label: 'Finder', src: standIn('#ececef', '#bdbdc2', '<rect x="312" y="312" width="400" height="400" rx="60" fill="#8a8a90"/>') },
  { label: 'Terminal', src: standIn('#050505', '#050505', '<rect x="222" y="352" width="270" height="320" rx="14" fill="url(#s)"/><rect x="532" y="352" width="270" height="320" rx="14" fill="url(#s)"/><path d="' + SQUIRCLE + '" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="2"/>') },
  { label: 'Kernel', src: uri(tile1024), me: true },
  { label: 'Code', src: standIn('#3a8ee6', '#1d5fae', '<circle cx="512" cy="512" r="210" fill="#fff" fill-opacity=".92"/>') },
  { label: 'Warp', src: standIn('#2b3440', '#0d1016', '<path d="M512 292 L732 512 L512 732 L292 512 Z" fill="#dfe6ee"/>') },
]
const dock = (theme) => `
  <figure>
    <div class="wall ${theme}">
      <div class="dock">${refs.map((it) => `<div class="app${it.me ? ' me' : ''}"><span class="tip">${it.label}</span><img src="${it.src}" width="64" height="64" alt=""><i></i></div>`).join('')}</div>
    </div>
    <figcaption class="cap">${theme === 'dark' ? 'Dark' : 'Light'} wallpaper, 64 pt Dock</figcaption>
  </figure>`

// The 18 px check: each lockup drawn into a canvas at true 1x, at four
// subpixel offsets, then enlarged with hard pixels.
const OFFSETS = [0, 0.25, 0.5, 0.75]
const pixelRow = (svg, ink, bg) => {
  const [w, h] = viewOf(svg)
  return OFFSETS.map((o) => `<canvas class="wm18" width="58" height="22" data-src="${uri(tint(svg, ink))}" data-x="${4 + o}" data-w="${w}" data-h="${h}" data-bg="${bg}"></canvas>`).join('')
}
const realRow = (svg, ink) => OFFSETS.map((o) => `<div style="padding-left:${o}px;width:290px">${wordmark(svg, 18, ink)}</div>`).join('')
const fixCard = (theme, label, ink, bg, final) => `
    <div class="surface ${theme} fixcard">
      <div class="slabel">${label}</div>
      <div class="fix">
        <span class="cap">Round 2</span><div class="row">${pixelRow(round2, ink, bg)}</div>
        <span class="cap"></span><div class="row real">${realRow(round2, ink)}</div>
        <span class="cap">Final</span><div class="row">${pixelRow(final, ink, bg)}</div>
        <span class="cap"></span><div class="row real">${realRow(final)}</div>
      </div>
    </div>`

const sizesRow = (svg, ink) =>
  [64, 32, 18, 14].map((s) => `<figure><div class="wbox">${wordmark(svg, s, ink)}</div><span class="cap">${s}</span></figure>`).join('')

const markRow = (svg) => {
  const [w, h] = viewOf(svg)
  return [64, 32, 20, 16, 12, 10].map((s) => `<figure><img src="${uri(svg)}" width="${((w / h) * s).toFixed(2)}" height="${s}" alt=""><span class="cap">${s}</span></figure>`).join('')
}

// The DMG window: build/dmg-background.svg with the wordmark swapped for the
// lockup at the same 18 px size and baseline. Finder shows the art's top 408.
function dmgArt() {
  const svg = readFileSync(join(repo, 'build/dmg-background.svg'), 'utf8')
  const k = 18 / 2048
  const inner = lockupInk.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').replace(/<title>[^<]*<\/title>/, '')
  const swapped = svg.replace(
    /<!-- wordmark:[^\n]*\n[^\n]*\n[^\n]*\n/,
    `<!-- wordmark -->\n  <g transform="translate(36 ${(41.2 - 1490 * k).toFixed(2)}) scale(${k.toFixed(6)})" fill="${INK}">${inner}</g>\n`,
  )
  if (swapped === svg) throw new Error('DMG wordmark not found')
  return uri(swapped)
}
const folder = uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M12 30a8 8 0 0 1 8-8h28l8 8h52a8 8 0 0 1 8 8v62a8 8 0 0 1-8 8H20a8 8 0 0 1-8-8z" fill="#5aa6f0"/><path d="M12 44a8 8 0 0 1 8-8h88a8 8 0 0 1 8 8v56a8 8 0 0 1-8 8H20a8 8 0 0 1-8-8z" fill="#78baf6"/><path d="M64 56 L80 92 H72 L64 74 L56 92 H48 Z" fill="#3d86d4"/></svg>`)

const sheet = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kernel brand masters</title>
<style>
@font-face { font-family: Inter; src: url('../site/fonts/inter-var.woff2') format('woff2'); font-weight: 100 900; }
:root { --bg: #0c0c0d; --card: #141415; --line: #232325; --ink: #f7f7f8; --ink-2: #d6d6d7; --muted: #8e8e92; }
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); color: var(--ink-2); font: 13px/1.5 Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
img { display: block; }
.cap { color: var(--muted); font-size: 11px; }
.page { width: 1600px; padding: 56px 64px 64px; }
header { margin-bottom: 36px; }
h1 { color: var(--ink); font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
header p { color: var(--muted); margin-top: 6px; max-width: 980px; }
h2 { color: var(--ink); font-size: 13px; font-weight: 600; margin-bottom: 4px; }
section > .cap { margin-bottom: 20px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px 28px 28px; margin-bottom: 20px; }
.sizes { display: flex; align-items: flex-end; gap: 40px; }
.sizes figure { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.px { display: flex; gap: 40px; margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--line); }
.px figure { display: flex; flex-direction: column; gap: 8px; }
.px canvas { width: 160px; height: 160px; image-rendering: pixelated; border-radius: 4px; background: #1b1b1d; }
.px .group { display: flex; gap: 16px; }
.docks { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.docks figure .cap { margin-top: 8px; }
.wall { height: 200px; border-radius: 10px; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 10px; }
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
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.surface { border: 1px solid; border-radius: 10px; padding: 22px 28px 26px; }
.surface.light { background: #f3f3f4; border-color: #dedee2; }
.surface.dark { background: #09090a; border-color: #1f1f21; }
.surface .cap { color: #8e8e92; }
.fixcard + .fixcard { margin-top: 16px; }
.slabel { font-size: 11px; color: #8e8e92; margin-bottom: 16px; }
.fix { display: grid; grid-template-columns: 96px auto; row-gap: 14px; column-gap: 16px; align-items: center; }
.fix .row { display: flex; gap: 10px; }
.wm18 { width: 290px; height: 110px; image-rendering: pixelated; border-radius: 4px; }
.fix .row.real { gap: 10px; align-items: center; min-height: 24px; margin-bottom: 8px; }
.wsizes { display: flex; align-items: flex-end; gap: 36px; flex-wrap: wrap; }
.wsizes figure, .msizes figure { display: flex; flex-direction: column; gap: 10px; }
.wbox { display: flex; align-items: flex-end; min-height: 48px; }
.msizes { display: flex; align-items: flex-end; gap: 36px; }
.exports { display: grid; grid-template-columns: 380px 1fr; gap: 28px; align-items: start; }
.tabs { background: #dfe0e3; border-radius: 10px 10px 0 0; padding: 8px 8px 0; display: flex; gap: 2px; }
.tabs.dark { background: #1d1e21; }
.tab { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px; border-radius: 8px 8px 0 0; font-size: 12px; color: #4c4f56; width: 170px; }
.tabs.dark .tab { color: #b6b6b8; }
.tab.on { background: #fff; color: #18191b; }
.tabs.dark .tab.on { background: #2a2b2f; color: #f7f7f8; }
.tab img { width: 16px; height: 16px; }
.tabstack { display: flex; flex-direction: column; gap: 14px; }
.exrow { display: flex; gap: 24px; align-items: flex-end; margin-top: 18px; }
.exrow figure { display: flex; flex-direction: column; gap: 8px; }
.og { width: 600px; border-radius: 8px; border: 1px solid var(--line); }
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
    <h1>Kernel brand masters, Block K</h1>
    <p>Final masters for KERNEL-818. The icon K is unchanged from round 2. The wordmark K's channel narrows from 150 to 96 units, so "Kernel" reads as one word at 18 px. This sheet renders at 2x, so every size below is real pixels.</p>
  </header>

  <section>
    <h2>Wordmark at 18 px, the site nav size</h2>
    <p class="cap">Each lockup drawn at true 1x at four subpixel offsets (0, 0.25, 0.5 and 0.75 px), enlarged 5x, then at real size. Round 2 splits into "I&lt;ernel" wherever its 1.3 px channel lands on a whole pixel. The final channel is 0.84 px and never opens wider than the gap between the K and the e.</p>
    ${fixCard('light', 'Light, ink #18191b on #f3f3f4', INK, '#f3f3f4', lockupInk)}
    ${fixCard('dark', 'Dark, ink #f7f7f8 on #09090a', WHITE, '#09090a', lockupWhite)}
  </section>

  <section>
    <h2>Wordmark</h2>
    <p class="cap">wordmark-ink.svg and wordmark-white.svg: the wordmark K, then "ernel" in Inter 600 at -0.02em, as outlines. Smallest size 14 px.</p>
    <div class="pair">
      <div class="surface light"><div class="wsizes">${sizesRow(lockupInk)}</div></div>
      <div class="surface dark"><div class="wsizes">${sizesRow(lockupWhite)}</div></div>
    </div>
  </section>

  <section>
    <h2>Mark</h2>
    <p class="cap">mark-black.svg and mark-white.svg: the icon K alone, for the in-app Kernel mark and anywhere the name is already on screen. Smallest size 10 px tall.</p>
    <div class="pair">
      <div class="surface light"><div class="msizes">${markRow(read('mark-black.svg'))}</div></div>
      <div class="surface dark"><div class="msizes">${markRow(read('mark-white.svg'))}</div></div>
    </div>
  </section>

  <section>
    <h2>App icon</h2>
    <p class="cap">icon-tile-1024.svg makes 1024 down to 64. 32 and 16 use the pixel grid files, icon-tile-32.svg and icon-tile-16.svg.</p>
    <div class="sizes">
      <figure><img src="${uri(tile1024)}" width="512" height="512" alt=""><span class="cap">1024</span></figure>
      <figure><img src="${uri(tile1024)}" width="256" height="256" alt=""><span class="cap">512</span></figure>
      <figure><img src="${uri(tile1024)}" width="64" height="64" alt=""><span class="cap">128</span></figure>
      <figure><img src="${uri(tile1024)}" width="32" height="32" alt=""><span class="cap">64</span></figure>
      <figure><img src="${uri(tile32)}" width="16" height="16" alt=""><span class="cap">32</span></figure>
      <figure><img src="${uri(tile16)}" width="8" height="8" alt=""><span class="cap">16</span></figure>
    </div>
    <div class="px">
      <figure><div class="group"><canvas data-src="${uri(tile1024)}" width="32" height="32"></canvas><canvas data-src="${uri(tile32)}" width="32" height="32"></canvas></div><span class="cap">32 at 1x: scaled from 1024, then the pixel grid file</span></figure>
      <figure><div class="group"><canvas data-src="${uri(tile1024)}" width="16" height="16"></canvas><canvas data-src="${uri(tile16)}" width="16" height="16"></canvas></div><span class="cap">16 at 1x: scaled from 1024, then the pixel grid file</span></figure>
    </div>
  </section>

  <section>
    <h2>In the Dock</h2>
    <p class="cap">The other icons are neutral stand-ins.</p>
    <div class="docks">${dock('dark')}${dock('light')}</div>
  </section>

  <section>
    <h2>Site exports</h2>
    <p class="cap">design/site/logo/, regenerated from the masters. The favicon is the 32 px pixel file, which a Retina tab draws at 16 pt.</p>
    <div class="exports">
      <div>
        <div class="tabstack">
          <div class="tabs"><div class="tab on"><img src="${uri(readFileSync(join(logo, 'favicon.svg'), 'utf8'))}" alt="">Kernel</div><div class="tab">Changelog</div></div>
          <div class="tabs dark"><div class="tab on"><img src="${uri(readFileSync(join(logo, 'favicon.svg'), 'utf8'))}" alt="">Kernel</div><div class="tab">Changelog</div></div>
        </div>
        <div class="exrow">
          <figure><img src="${png(join(logo, 'apple-touch-icon.png'))}" width="90" height="90" style="border-radius:20px" alt=""><span class="cap">apple-touch-icon.png, 180, iOS mask</span></figure>
          <figure><img src="${png(join(logo, 'kernel-app-icon-512.png'))}" width="128" height="128" alt=""><span class="cap">kernel-app-icon-512.png</span></figure>
        </div>
        <div class="exrow">
          <figure><img src="${png(join(logo, 'favicon-32.png'))}" width="16" height="16" alt=""><span class="cap">favicon-32</span></figure>
          <figure><img src="${png(join(logo, 'favicon-16.png'))}" width="8" height="8" alt=""><span class="cap">favicon-16</span></figure>
        </div>
      </div>
      <figure><img class="og" src="${png(join(logo, 'og-image.png'))}" width="600" height="315" alt=""><figcaption class="cap" style="margin-top:8px">og-image.png, 1200 x 630: the new wordmark in the old one's place, the layout unchanged</figcaption></figure>
    </div>
  </section>

  <section>
    <h2>DMG installer</h2>
    <p class="cap">build/dmg-background.svg with the new wordmark at its real 18 px size and the new icon in the app slot, as a preview for the DMG PR. Right: the header enlarged 2x.</p>
    <div class="dmgrow">
      <div class="win">
        <div class="titlebar"><div class="lights"><i></i><i></i><i></i></div><span>Kernel 1.0.0</span></div>
        <div class="content">
          <img class="art" src="${dmgArt()}" width="660" height="440" alt="">
          <div class="slot" style="left:165px;top:236px"><img src="${uri(tile1024)}" width="128" height="128" alt=""><span>Kernel</span></div>
          <div class="slot" style="left:495px;top:236px"><img src="${folder}" width="128" height="128" alt=""><span>Applications</span></div>
        </div>
      </div>
      <div class="zoom"><img src="${dmgArt()}" alt=""></div>
    </div>
  </section>
</div>
<script>
// Rasterize at true 1x into a small canvas; CSS enlarges it with hard pixels.
window.__work = Promise.all([...document.querySelectorAll('canvas[data-src]')].map((c) => new Promise((done) => {
  const img = new Image()
  img.onload = () => {
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    if (c.dataset.bg) {
      g.fillStyle = c.dataset.bg
      g.fillRect(0, 0, c.width, c.height)
      const k = 18 / 2048
      g.drawImage(img, +c.dataset.x, 4, c.dataset.w * k, c.dataset.h * k)
    } else g.drawImage(img, 0, 0, c.width, c.height)
    done()
  }
  img.src = c.dataset.src
})))
</script>
</body></html>
`

writeFileSync(join(here, 'sheet.html'), sheet)
await render(null, join(here, 'sheet.png'), 1600, 900, { scale: 2, fullPage: true, file: join(here, 'sheet.html') })
const shared = join(repo, '.kernel/shared')
mkdirSync(shared, { recursive: true })
copyFileSync(join(here, 'sheet.png'), join(shared, 'kernel-brand-masters.png'))
await browser.close()
