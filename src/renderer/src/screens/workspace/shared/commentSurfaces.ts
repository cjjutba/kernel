import type { SharedAnchor, SharedComment } from '@shared/types'
import { call } from '../../../api'
import { hoverLabel, imageCropRect, pageCropRect, pinSpot, within, type Spot } from './comment'
import type { Rect } from './cover'

// What comment mode asks of the thing under it (KERNEL-311). A page answers through the preview host, an image through the box it is drawn
// in, Markdown through the blocks of its text. Every point and box here is in the layer's pixels, from its top-left corner.

export interface Picture { dataUrl: string; width: number; height: number }

export interface Surface {
  /** The box and name to outline under a point, or null where nothing is worth outlining. */
  hover(p: Spot): Promise<{ outline: Rect; label: string } | null>
  /** What a click at the point comments on, or null where the click is not on the file. `at` is where the pin goes. */
  pick(p: Spot): Promise<{ anchor: SharedAnchor; at: Spot } | null>
  /** Where each earlier comment's pin is now, null where it can't be shown. */
  spots(comments: SharedComment[]): Promise<(Spot | null)[]>
  /** The picture to send with the comment, or null to send none. */
  crop(anchor: SharedAnchor, at: Spot): Promise<Picture | null>
}

const quiet = () => null

/** A page in the native view. `view` names it to the preview host (a fixture run has no view, and the host answers by fixture). */
export function pageSurface(view: string): Surface {
  return {
    hover: async (p) => {
      const a = await call('system.preview.hit', { viewId: view, x: p.x, y: p.y }).catch(quiet)
      return a?.element ? { outline: a.element.rect, label: hoverLabel(a.element) } : null
    },
    pick: async (p) => {
      const a = await call('system.preview.hit', { viewId: view, x: p.x, y: p.y }).catch(quiet)
      return { anchor: a ?? { x: Math.round(p.x), y: Math.round(p.y) }, at: p }
    },
    spots: async (comments) => {
      const wanted = comments.map((c) => c.anchor.element?.selector)
      const rects = await call('system.preview.locate', { viewId: view, selectors: wanted.map((s) => s ?? '') }).catch(() => [] as (Rect | null)[])
      return comments.map((c, i) => pinSpot(c.anchor, wanted[i] ? rects[i] ?? null : null))
    },
    crop: (anchor, at) => call('system.preview.crop', { viewId: view, rect: pageCropRect(anchor, at) }).catch(quiet)
  }
}

/** The layer's top-left corner on screen, which every point here is measured from. */
type Origin = () => HTMLElement | null
const offset = (el: Element, layer: HTMLElement): Rect => {
  const b = el.getBoundingClientRect()
  const o = layer.getBoundingClientRect()
  return { x: b.left - o.left, y: b.top - o.top, width: b.width, height: b.height }
}

/** An image drawn at `img`. Anchors are in its natural pixels, and pins are drawn where the image is shown. */
export function imageSurface(layer: Origin, img: () => HTMLImageElement | null): Surface {
  const box = () => {
    const l = layer()
    const i = img()
    if (!l || !i || !i.naturalWidth || !i.naturalHeight) return null
    // The picture is inside the image's border.
    const o = offset(i, l)
    const r = { x: o.x + i.clientLeft, y: o.y + i.clientTop, width: i.clientWidth, height: i.clientHeight }
    return { l, i, r, w: i.naturalWidth, h: i.naturalHeight }
  }
  return {
    hover: async () => null,
    pick: async (p) => {
      const b = box()
      if (!b || !within(b.r, p)) return null
      const x = Math.round(((p.x - b.r.x) / b.r.width) * b.w)
      const y = Math.round(((p.y - b.r.y) / b.r.height) * b.h)
      return { anchor: { x, y, viewport: { width: b.w, height: b.h, scrollY: 0 } }, at: p }
    },
    spots: async (comments) => {
      const b = box()
      return comments.map((c) => (b ? { x: b.r.x + (c.anchor.x / b.w) * b.r.width, y: b.r.y + (c.anchor.y / b.h) * b.r.height } : null))
    },
    crop: async (anchor) => {
      const b = box()
      if (!b) return null
      const area = imageCropRect(anchor, { width: b.w, height: b.h })
      const canvas = document.createElement('canvas')
      canvas.width = area.width
      canvas.height = area.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(b.i, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height)
      return { dataUrl: canvas.toDataURL('image/png'), width: area.width, height: area.height }
    }
  }
}

/** Markdown drawn in `root`, whose children are its blocks. Blocks are numbered from 1, the way a person counts them. */
export function markdownSurface(layer: Origin, root: () => HTMLElement | null): Surface {
  const blocks = () => {
    const l = layer()
    const r = root()
    return l && r ? Array.from(r.children).map((el, i) => ({ el, n: i + 1, r: offset(el, l) })) : []
  }
  // The block a point is in, or the nearest one down the page when it is in the gap between two.
  const nearest = (p: Spot) => {
    let best: ReturnType<typeof blocks>[number] | undefined
    let gap = Infinity
    for (const b of blocks()) {
      const d = p.y < b.r.y ? b.r.y - p.y : p.y > b.r.y + b.r.height ? p.y - (b.r.y + b.r.height) : 0
      if (d < gap) { gap = d; best = b }
    }
    return best
  }
  return {
    hover: async (p) => {
      const b = nearest(p)
      return b ? { outline: b.r, label: `block ${b.n}` } : null
    },
    pick: async (p) => {
      const b = nearest(p)
      if (!b) return null
      const x = Math.round(Math.min(Math.max(p.x - b.r.x, 0), b.r.width))
      const y = Math.round(Math.min(Math.max(p.y - b.r.y, 0), b.r.height))
      return { anchor: { x, y, block: { index: b.n, text: (b.el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) } }, at: p }
    },
    spots: async (comments) => {
      const all = blocks()
      return comments.map((c) => {
        const b = all.find((x) => x.n === c.anchor.block?.index)
        return b ? { x: b.r.x + c.anchor.x, y: b.r.y + c.anchor.y } : null
      })
    },
    crop: async () => null
  }
}
