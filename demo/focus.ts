// Runs before the renderer.
//
// Every visit starts fresh: the renderer keeps drafts, tabs, folded rows and panel sizes in localStorage under `kernel.`,
// which would carry one visit's state into the next and into Start over.
try {
  for (const key of Object.keys(localStorage)) if (key.startsWith('kernel.')) localStorage.removeItem(key)
} catch {
  // Storage can be blocked. The demo still works, from whatever the browser kept.
}

// The demo lives in a frame on the landing page. A browser scrolls every ancestor to show a focused or scrolled-to
// element, the page around the frame included, so the transcript following its last line or the plan card showing
// itself would move the landing page under the visitor. Inside the demo, both only scroll the app's own panes.

const nativeFocus = HTMLElement.prototype.focus
HTMLElement.prototype.focus = function (options?: FocusOptions) {
  nativeFocus.call(this, { ...options, preventScroll: true })
}

type Pos = ScrollLogicalPosition
/** How far a scroller moves to put an item of `size` at `offset` (from the scroller's top) where `pos` asks. */
function distance(pos: Pos, offset: number, size: number, view: number): number {
  if (pos === 'start') return offset
  if (pos === 'end') return offset + size - view
  if (pos === 'center') return offset + size / 2 - view / 2
  // nearest: move only as far as it takes to bring the item fully into view.
  if (offset < 0) return offset
  if (offset + size > view) return Math.min(offset, offset + size - view)
  return 0
}

const scrolls = (overflow: string) => /auto|scroll|overlay/.test(overflow)

Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
  const o: ScrollIntoViewOptions = typeof arg === 'boolean' ? { block: arg ? 'start' : 'end' } : arg ?? {}
  const block = o.block ?? 'start'
  const inline = o.inline ?? 'nearest'
  const behavior = o.behavior ?? 'auto'
  // Each scroller inside the app, innermost first. The document itself and the page around the frame are never moved.
  for (let el = this.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el)
    const y = scrolls(style.overflowY) && el.scrollHeight > el.clientHeight
    const x = scrolls(style.overflowX) && el.scrollWidth > el.clientWidth
    if (!x && !y) continue
    const item = this.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    const top = y ? distance(block, item.top - box.top - el.clientTop, item.height, el.clientHeight) : 0
    const left = x ? distance(inline, item.left - box.left - el.clientLeft, item.width, el.clientWidth) : 0
    if (top || left) el.scrollBy({ top, left, behavior })
  }
}

export {}
