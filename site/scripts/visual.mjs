// Compares a full-page screenshot with a design render. Shared by scripts/compare.mjs and the e2e visual test.
import { readFileSync } from 'node:fs'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

/** How far the page height may drift from the render before spacing counts as broken. */
export const MAX_HEIGHT_DELTA = 24
/** Share of differing pixels allowed, for font rasterization. */
export const MAX_DIFF_RATIO = 0.02

function crop(png, width, height) {
  const out = new PNG({ width, height })
  PNG.bitblt(png, out, 0, 0, width, height, 0, 0)
  return out
}

function paint(png, rects, rgb = [8, 9, 10]) {
  for (const r of rects) {
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(png.height, Math.ceil(r.y + r.height)); y++) {
      for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(png.width, Math.ceil(r.x + r.width)); x++) {
        const i = (y * png.width + x) * 4
        ;[png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]] = [...rgb, 255]
      }
    }
  }
}

/**
 * @param {Buffer} shot full-page screenshot of the site
 * @param {string} renderPath design render PNG
 * @param {{x:number,y:number,width:number,height:number}[]} masks areas painted out on both sides
 */
export function compareToRender(shot, renderPath, masks = []) {
  const a = PNG.sync.read(shot)
  const b = PNG.sync.read(readFileSync(renderPath))
  const width = Math.min(a.width, b.width)
  const height = Math.min(a.height, b.height)
  const [ca, cb] = [crop(a, width, height), crop(b, width, height)]
  paint(ca, masks)
  paint(cb, masks)
  const diff = new PNG({ width, height })
  const pixels = pixelmatch(ca.data, cb.data, diff.data, width, height, { threshold: 0.1 })
  const side = new PNG({ width: width * 2 + 16, height })
  side.data.fill(255)
  PNG.bitblt(cb, side, 0, 0, width, height, 0, 0)
  PNG.bitblt(ca, side, 0, 0, width, height, width + 16, 0)
  return {
    heightDelta: a.height - b.height,
    ratio: pixels / (width * height),
    diffPng: PNG.sync.write(diff),
    sideBySidePng: PNG.sync.write(side)
  }
}
