import type { SharedAnchor, SharedFile } from '@shared/types'
import type { Rect } from './cover'

// The parts of comment mode that are plain arithmetic and text (KERNEL-311). CommentLayer draws them; keeping them here lets tests run them.

export interface Spot { x: number; y: number }
export type Size = { width: number; height: number }

/** The popover for a comment being written. `at` is where its pin sits, in the layer's pixels. */
export interface Draft { at: Spot; anchor: SharedAnchor; note: string }

/** Send needs words, a reachable agent and no send already going. */
export const canSend = (note: string, archived: boolean, busy: boolean) => !archived && !busy && note.trim().length > 0

/** The element's name in the hover label: its id when it has one, else the last step of its path without `:nth-of-type`, as `div.plan`. */
export function hoverLabel(element: { selector: string; tag: string }): string {
  const last = element.selector.split('>').pop()?.trim().replace(/:nth-of-type\(\d+\)/g, '') ?? ''
  return last || element.tag
}

/** The size of the picture sent with a comment on an image, and the least of it. */
export const CROP: Size = { width: 320, height: 200 }

/** Where the crop around a point of an image goes, in its natural pixels: `CROP` centred on the point and kept inside, or the whole image where it is smaller. */
export function imageCropRect(point: Spot, natural: Size): Rect {
  const width = Math.min(CROP.width, natural.width)
  const height = Math.min(CROP.height, natural.height)
  const x = Math.min(Math.max(Math.round(point.x - width / 2), 0), natural.width - width)
  const y = Math.min(Math.max(Math.round(point.y - height / 2), 0), natural.height - height)
  return { x, y, width, height }
}

/** What the page crop is taken around: the element under the point, or the point itself. */
export function pageCropRect(anchor: SharedAnchor, at: Spot): Rect {
  return anchor.element?.rect ?? { x: at.x, y: at.y, width: 1, height: 1 }
}

/** Where the popover goes: below and a little left of its pin, kept inside the layer, and above the pin when there is no project below. */
export function popoverPlace(pin: Spot, layer: Size, pop: Size, gap = 28, inset = 8): Spot {
  const left = Math.min(Math.max(pin.x - 64, inset), Math.max(layer.width - pop.width - inset, inset))
  const below = pin.y + gap
  const top = below + pop.height + inset <= layer.height ? below : Math.max(pin.y - gap - pop.height + 22, inset)
  return { x: left, y: top }
}

/**
 * Where an earlier pin goes now. The page may have moved the element it was left on, so the pin keeps its offset inside that element's box
 * and follows the box. Where the element can't be found, the pin goes back to the spot it was left at.
 */
export function pinSpot(anchor: SharedAnchor, now: Rect | null): Spot {
  const el = anchor.element
  if (!el || !now) return { x: anchor.x, y: anchor.y }
  const dx = Math.min(Math.max(anchor.x - el.rect.x, 0), now.width)
  const dy = Math.min(Math.max(anchor.y - el.rect.y, 0), now.height)
  return { x: now.x + dx, y: now.y + dy }
}

/** True when a point is inside the box. */
export const within = (r: Rect, p: Spot) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height

const clip = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max).trimEnd()

/** The same slug main gives a title (`slugify` in services/worktrees), for the name of the picture. */
function slug(text: string, max: number) {
  const s = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s.slice(0, max).replace(/-+$/, '') || 'workspace'
}

/** The name of the picture sent with a comment, as main names it. */
export const chipName = (title: string, version: number) => `${slug(title, 40)}-v${version}-comment.png`

/** What a comment says about its spot, as main writes it after "Where: " (`whereOf` in services/sharedComments). */
export function whereOf(file: Pick<SharedFile, 'kind' | 'versions'>, version: number, anchor: SharedAnchor): string {
  const at = `at ${Math.round(anchor.x)}, ${Math.round(anchor.y)}`
  if (file.kind === 'markdown') {
    const b = anchor.block
    return b ? `the block "${clip(b.text, 80)}" (block ${b.index}).` : 'the top of the file.'
  }
  if (file.kind === 'image') {
    const width = anchor.viewport?.width ?? file.versions.find((v) => v.n === version)?.width
    return width ? `a point, ${at} in a ${Math.round(width)} px wide image.` : `a point, ${at} in the image.`
  }
  const window = anchor.viewport ? ` in a ${Math.round(anchor.viewport.width)} px wide window` : ''
  const el = anchor.element
  if (!el) return `a point, ${at}${window}.`
  const text = el.text ? ` "${clip(el.text, 120)}"` : ''
  return `the <${el.tag}>${text} (${el.selector}), ${at}${window}.`
}

/** The first two lines of the message the agent gets: the file and version, then the spot. The note follows them, so it is not here. */
export function previewLines(file: Pick<SharedFile, 'title' | 'source' | 'kind' | 'versions'>, version: number, anchor: SharedAnchor): string[] {
  const latest = Math.max(...file.versions.map((v) => v.n))
  const since = latest > version ? ` You have shared v${latest} since.` : ''
  return [`Comment on "${file.title}" v${version} (${file.source}).${since}`, `Where: ${whereOf(file, version, anchor)}`]
}
