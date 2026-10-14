/** A rectangle in the page's CSS pixels, as `system.preview.place` takes it. */
export interface Rect { x: number; y: number; width: number; height: number }
/** The edges of an element's box, as `getBoundingClientRect` reports them. */
export interface Box { left: number; top: number; right: number; bottom: number }

/**
 * What Kernel draws over the page that the native view would hide: the scrim and every modal, menus, popovers, tooltips, toasts
 * and the dialogs and lists that carry no class of their own (the composer's @ and / list, ModelPicker).
 * `test/previewCover.test.ts` fails when `ui/overlays.tsx`, `ui/Tooltips.tsx` or `components/Toasts.tsx` stop using these names.
 */
export const COVER_SELECTOR = '.scrim, .modal, .menu, .popover, .tooltip, .toast, [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]'

/** The view's own stage holds the page and the crash notice. Nothing in it covers the page. */
const STAGE = '.sv-stage'

/** The part of an element `overlayBoxes` reads, so a test can stand in for the DOM. */
export interface Probe { closest(selector: string): unknown; getBoundingClientRect(): Box & { width: number; height: number } }
export interface Scope { querySelectorAll(selector: string): Iterable<Probe> }
type Style = { display: string; visibility: string; opacity: string }

/** The boxes of the overlays on screen: outside the stage, taking up room, and not hidden by display, visibility or opacity. */
export function overlayBoxes(scope: Scope = document, styleOf: (el: Probe) => Style = (el) => getComputedStyle(el as unknown as Element)): Box[] {
  const boxes: Box[] = []
  for (const el of scope.querySelectorAll(COVER_SELECTOR)) {
    if (el.closest(STAGE)) continue
    const b = el.getBoundingClientRect()
    if (b.width <= 0 || b.height <= 0) continue
    const s = styleOf(el)
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue
    boxes.push(b)
  }
  return boxes
}

/** Whether a box overlaps the rect by at least a pixel. Boxes that only touch don't. */
export const intersects = (rect: Rect, b: Box) => b.left < rect.x + rect.width && b.right > rect.x && b.top < rect.y + rect.height && b.bottom > rect.y

/** Whether something of Kernel's own would be drawn over the page at `rect`, so the native view must hide behind its still. */
export function isCovered(rect: Rect, boxes: Box[] = overlayBoxes()): boolean {
  return boxes.some((b) => intersects(rect, b))
}
