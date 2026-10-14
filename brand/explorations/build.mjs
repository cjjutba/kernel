// Builds the icon tiles, the comparison sheet and the tile close-up from the
// hand-written marks in marks/, then renders both pages to PNG.
//   node brand/explorations/build.mjs [out dir for PNGs]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const outDir = resolve(process.argv[2] ?? join(repo, '.kernel/shared'))

const directions = [
  {
    id: '1-block-k',
    name: 'Block K',
    line: 'A stem and a solid chevron, split by one clean channel. The gap draws the K.',
  },
  {
    id: '2-core-team',
    name: 'Core and team',
    line: 'One round core with four agents locked around it. Reads as a team in motion.',
  },
  {
    id: '3-node-k',
    name: 'Node K',
    line: 'Today’s node K, rebuilt as one heavy shape. Keeps the identity, gains weight.',
  },
]

// The mark files use currentColor on a 120 unit grid. Return the inner shapes.
const inner = (id) =>
  readFileSync(join(here, 'marks', `${id}.svg`), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .trim()

const markSvg = (id, color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="${color}">${inner(id).replaceAll('currentColor', color)}</svg>`

// The current node K, for the before column.
const beforePath = readFileSync(join(repo, 'site/components/brand/markPath.ts'), 'utf8').match(/MARK_PATH =\s*'([^']+)'/)[1]
const beforeMark = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440.49 455.29"><path fill="${color}" d="${beforePath}"/></svg>`

// Apple style continuous corner rectangle (squircle), from the UIBezierPath
// constants. r is the nominal radius; each corner curve runs 1.52866483r.
function squircle(x, y, w, h, r) {
  const seq = [
    [1.52866483, 0],
    [1.08849323, 0], [0.86840689, 0], [0.63149399, 0.074911],
    [0.37282392, 0.16905899], [0.16905899, 0.37282392], [0.074911, 0.63149399],
    [0, 0.86840689], [0, 1.08849323], [0, 1.52866483],
  ]
  const f = (n) => +n.toFixed(2)
  const corner = (map, swap) => seq.map(([a, b]) => (swap ? map(b * r, a * r) : map(a * r, b * r)))
  const R = x + w, B = y + h
  const tr = corner((u, v) => [R - u, y + v], false)
  const br = corner((u, v) => [R - u, B - v], true)
  const bl = corner((u, v) => [x + u, B - v], false)
  const tl = corner((u, v) => [x + u, y + v], true)
  let d = ''
  for (const [i, pts] of [tr, br, bl, tl].entries()) {
    const [s, ...rest] = pts
    d += `${i === 0 ? 'M' : 'L'}${f(s[0])} ${f(s[1])}`
    for (let k = 0; k < rest.length; k += 3) d += `C${rest.slice(k, k + 3).map((p) => `${f(p[0])} ${f(p[1])}`).join(' ')}`
  }
  return d + 'Z'
}

// 1024 canvas, 824 tile centered, glyph 480 square (120 grid at 4x) on the
// optical center.
const TILE = squircle(100, 100, 824, 824, 160)
function tileSvg(id) {
  const p = id.replace(/\W/g, '')
  const glyph = `<g fill="url(#${p}-sheen)">${inner(id).replaceAll('currentColor', `url(#${p}-sheen)`)}</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="${p}-tile" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2c2c30"/>
      <stop offset="0.55" stop-color="#151517"/>
      <stop offset="1" stop-color="#0a0a0b"/>
    </linearGradient>
    <radialGradient id="${p}-light" cx="512" cy="100" r="640" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${p}-edge" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="0.25" stop-color="#fff" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.03"/>
    </linearGradient>
    <linearGradient id="${p}-sheen" x1="0" y1="0" x2="0" y2="120" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#d9d9de"/>
    </linearGradient>
    <clipPath id="${p}-clip"><path d="${TILE}"/></clipPath>
  </defs>
  <path d="${TILE}" fill="url(#${p}-tile)"/>
  <path d="${TILE}" fill="url(#${p}-light)"/>
  <path d="${TILE}" fill="none" stroke="url(#${p}-edge)" stroke-width="4" clip-path="url(#${p}-clip)"/>
  <g transform="translate(272 272) scale(4)">${glyph}</g>
</svg>
`
}

mkdirSync(join(here, 'tiles'), { recursive: true })
for (const d of directions) writeFileSync(join(here, 'tiles', `${d.id}-tile.svg`), tileSvg(d.id))

const uri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const beforeIcon = `data:image/png;base64,${readFileSync(join(repo, 'build/icon.png')).toString('base64')}`

// Neutral stand-ins for the reference apps. Not their logos.
const standIn = (top, bottom, shape) =>
  uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><path d="${TILE}" fill="url(#g)"/>${shape}</svg>`)
const refs = {
  finder: { label: 'Finder', src: standIn('#e9e9ec', '#b9b9be', '<rect x="312" y="312" width="400" height="400" rx="60" fill="#8a8a90"/>') },
  t3: { label: 'T3 Code', src: standIn('#1c1c1e', '#000', '<rect x="292" y="432" width="440" height="160" rx="24" fill="#e6e6e8"/>') },
  vscode: { label: 'VS Code', src: standIn('#3a8ee6', '#1d5fae', '<circle cx="512" cy="512" r="210" fill="#fff" fill-opacity=".92"/>') },
  warp: { label: 'Warp', src: standIn('#2b3440', '#0d1016', '<path d="M512 292 L732 512 L512 732 L292 512 Z" fill="#dfe6ee"/>') },
}

const entries = [
  {
    id: 'before',
    name: 'Before',
    line: 'The current icon. Thin links and dots, a flat tile, light at Dock size.',
    tile: beforeIcon,
    mark: (c) => uri(beforeMark(c)),
    markRatio: 440.49 / 455.29,
  },
  ...directions.map((d, i) => ({
    ...d,
    name: `${i + 1}. ${d.name}`,
    tile: uri(tileSvg(d.id)),
    mark: (c) => uri(markSvg(d.id, c)),
    markRatio: 1,
  })),
]

const css = `
@font-face { font-family: Inter; src: url('../../design/site/fonts/inter-var.woff2') format('woff2'); font-weight: 100 900; }
:root { --bg: #0c0c0d; --card: #141415; --line: #232325; --ink: #f7f7f8; --ink-2: #d6d6d7; --muted: #8e8e92; }
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); color: var(--ink-2); font: 13px/1.5 Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
h1 { color: var(--ink); font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
h2 { color: var(--ink); font-size: 13px; font-weight: 600; margin-bottom: 14px; }
.cap { color: var(--muted); font-size: 11px; }
img { display: block; }
`

const sizes = [
  [240, '1024 (shown at 240)'],
  [128, '128'],
  [32, '32'],
  [16, '16'],
]

function sheetHtml() {
  const sizeRows = entries
    .map(
      (e) => `
    <div class="row">
      <div class="who"><div class="name">${e.name}</div><div class="cap">${e.line}</div></div>
      ${sizes.map(([s]) => `<div class="cell"><img src="${e.tile}" width="${s}" height="${s}" alt=""></div>`).join('')}
      <div class="cell"><canvas data-src="${e.tile}" width="16" height="16" class="px"></canvas></div>
      <div class="cell bare"><img src="${e.mark('#f7f7f8')}" height="64" width="${Math.round(64 * e.markRatio)}" alt=""><img src="${e.mark('#f7f7f8')}" height="24" width="${Math.round(24 * e.markRatio)}" alt=""><img src="${e.mark('#f7f7f8')}" height="16" width="${Math.round(16 * e.markRatio)}" alt=""></div>
    </div>`,
    )
    .join('')

  const dock = (e) => {
    const items = [refs.finder, refs.t3, { label: 'Kernel', src: e.tile, me: true }, refs.vscode, refs.warp]
    return `
    <figure class="dockwrap">
      <div class="wall">
        <div class="dock">${items
          .map((it) => `<div class="app${it.me ? ' me' : ''}"><span class="tip">${it.label}</span><img src="${it.src}" width="64" height="64" alt=""><i></i></div>`)
          .join('')}</div>
      </div>
      <figcaption class="cap">${e.name}</figcaption>
    </figure>`
  }

  const wordmark = (e, ink, size) => {
    const h = Math.round(size * 1.05)
    return `<div class="wm" style="color:${ink};font-size:${size}px;gap:${Math.round(size * 0.36)}px"><img src="${e.mark(ink)}" height="${h}" width="${Math.round(h * e.markRatio)}" alt="">Kernel</div>`
  }
  const surface = (e, bg, ink, line) => `
    <div class="surface" style="background:${bg};border-color:${line}">
      ${wordmark(e, ink, 40)}
      <div class="small">
        ${wordmark(e, ink, 15)}
        <img src="${e.mark(ink)}" height="16" width="${Math.round(16 * e.markRatio)}" alt="">
        <img src="${e.tile}" width="32" height="32" alt="">
      </div>
    </div>`
  const brandRows = entries
    .map(
      (e) => `
    <div class="brow">
      <div class="who"><div class="name">${e.name}</div></div>
      ${surface(e, '#fafafa', '#0a0a0b', '#e4e4e7')}
      ${surface(e, '#09090a', '#f7f7f8', '#1f1f21')}
    </div>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kernel logo directions</title>
<style>${css}
.page { width: 1600px; padding: 56px 64px 64px; }
header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 40px; }
header p { color: var(--muted); margin-top: 6px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px 28px; margin-bottom: 20px; }
.row { display: grid; grid-template-columns: 300px 260px 160px 80px 80px 160px 1fr; align-items: center; border-top: 1px solid var(--line); padding: 18px 0; }
.row:first-of-type { border-top: 0; padding-top: 4px; }
.head { display: grid; grid-template-columns: 300px 260px 160px 80px 80px 160px 1fr; color: var(--muted); font-size: 11px; padding-bottom: 6px; }
.who { padding-right: 32px; }
.name { color: var(--ink); font-weight: 600; font-size: 14px; letter-spacing: -0.01em; margin-bottom: 4px; }
.cell { display: flex; align-items: center; }
.bare { gap: 28px; }
canvas.px { width: 64px; height: 64px; image-rendering: pixelated; }
.docks { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.dockwrap .cap { margin-top: 8px; }
.wall { height: 200px; border-radius: 10px; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 10px;
  background: radial-gradient(120% 90% at 20% 0%, #4a4f63 0%, #262a36 45%, #121318 100%); }
.dock { display: flex; gap: 8px; padding: 6px 8px 7px; border-radius: 22px; background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.22); backdrop-filter: blur(20px); }
.app { position: relative; display: flex; flex-direction: column; align-items: center; }
.app i { width: 4px; height: 4px; border-radius: 2px; margin-top: 3px; background: transparent; }
.app.me i { background: rgba(255,255,255,.85); }
.tip { display: none; }
.app.me .tip { display: block; position: absolute; top: -34px; white-space: nowrap; font-size: 12px; color: #f2f2f3; background: rgba(40,40,44,.85); border: 1px solid rgba(255,255,255,.14); padding: 2px 9px; border-radius: 6px; }
.brow { display: grid; grid-template-columns: 300px 1fr 1fr; gap: 16px; align-items: center; border-top: 1px solid var(--line); padding: 14px 0; }
.brow:first-of-type { border-top: 0; padding-top: 0; }
.surface { border: 1px solid; border-radius: 10px; height: 132px; padding: 0 32px; display: flex; align-items: center; justify-content: space-between; }
.wm { display: flex; align-items: center; font-weight: 600; letter-spacing: -0.02em; line-height: 1; }
.small { display: flex; align-items: center; gap: 22px; }
</style></head>
<body><div class="page">
  <header>
    <div><h1>Kernel logo directions</h1><p>Three directions for the mark and the macOS app icon, next to the current icon. Exploration only.</p></div>
    <div class="cap">Tile 824 on a 1024 canvas, glyph on a 120 unit grid at 4x</div>
  </header>
  <section>
    <h2>Sizes</h2>
    <div class="head"><span></span>${sizes.map(([, l]) => `<span>${l}</span>`).join('')}<span>16 at 1x, enlarged</span><span>Mark alone at 64, 24 and 16</span></div>
    ${sizeRows}
  </section>
  <section>
    <h2>In the Dock</h2>
    <div class="docks">${entries.map(dock).join('')}</div>
    <p class="cap" style="margin-top:12px">Finder, T3 Code, VS Code and Warp are neutral stand-ins, not their real icons.</p>
  </section>
  <section>
    <h2>Wordmark on light and dark</h2>
    ${brandRows}
  </section>
</div>
<script>
// Draw each icon into a true 16 x 16 canvas, stepping raster sources down by
// halves so the PNG before icon gets the same fair downscale as the SVGs.
const jobs = [...document.querySelectorAll('canvas[data-src]')].map((c) => new Promise((done) => {
  const img = new Image()
  img.onload = () => {
    let src = img, w = img.naturalWidth || 1024
    while (w / 2 >= 32) {
      const t = document.createElement('canvas'); t.width = t.height = w / 2
      const g = t.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, w / 2, w / 2)
      src = t; w /= 2
    }
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, 16, 16)
    done()
  }
  img.src = c.dataset.src
}))
Promise.all([...jobs, document.fonts.ready]).then(() => { window.__ready = true })
</script>
</body></html>
`
}

function closeupHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kernel tiles at 1024</title>
<style>${css}
.page { display: flex; gap: 48px; padding: 64px; width: max-content; }
figure .cap { margin-top: 12px; font-size: 16px; color: var(--ink-2); font-weight: 500; text-align: center; }
</style></head>
<body><div class="page">
${directions.map((d, i) => `<figure><img src="${uri(tileSvg(d.id))}" width="1024" height="1024" alt=""><figcaption class="cap">${i + 1}. ${d.name}</figcaption></figure>`).join('\n')}
</div><script>document.fonts.ready.then(() => { window.__ready = true })</script></body></html>
`
}

writeFileSync(join(here, 'sheet.html'), sheetHtml())
writeFileSync(join(here, 'closeup.html'), closeupHtml())

// Render both pages in headless Chromium.
const require = createRequire(join(repo, 'package.json'))
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ headless: true })
mkdirSync(outDir, { recursive: true })
for (const [page, png, scale] of [
  ['sheet.html', 'kernel-logo-directions.png', 2],
  ['closeup.html', 'kernel-logo-tiles-1024.png', 1],
]) {
  const ctx = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1600, height: 900 } })
  const p = await ctx.newPage()
  await p.goto(`file://${join(here, page)}`)
  await p.waitForFunction(() => window.__ready === true)
  await p.screenshot({ path: join(outDir, png), fullPage: true })
  await ctx.close()
  console.log('wrote', join(outDir, png))
}
await browser.close()
