import { isFixture } from '../../store'

const HIT_MS = 1600
const CONTROL = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [role="switch"], [role="radio"], [role="combobox"]'

let clear: ReturnType<typeof setTimeout> | undefined
let lit: HTMLElement | null = null

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)

/** The control a row is for: the checked option of a group, else the first control outside the row's text and Reset. */
export function controlOf(row: HTMLElement): HTMLElement | null {
  const all = [...row.querySelectorAll<HTMLElement>(CONTROL)].filter((el) => !el.closest('.set-text') && !el.classList.contains('set-reset') && !el.classList.contains('set-tag-x'))
  return all.find((el) => el.getAttribute('aria-checked') === 'true') ?? all[0] ?? null
}

/**
 * Scrolls a row into view, highlights it once in surface-3 and moves focus to its control (KERNEL-727). The fade is the CSS animation on
 * `data-hit`; under Reduce motion the CSS drops it and the highlight is shown for the same time, then clears. A fixture keeps the highlight, so a shot can show it. Returns false when the row isn't on the page yet.
 */
export function landOnRow(id: string): boolean {
  const row = rowOf(id)
  if (!row) return false
  clearTimeout(clear)
  lit?.removeAttribute('data-hit')
  row.removeAttribute('data-hit')
  void row.offsetWidth
  row.setAttribute('data-hit', isFixture() ? 'held' : '')
  lit = row
  row.scrollIntoView({ block: 'center' })
  const control = controlOf(row)
  if (control) control.focus({ preventScroll: true })
  else { row.tabIndex = -1; row.focus({ preventScroll: true }) }
  if (isFixture()) return true
  clear = setTimeout(() => { row.removeAttribute('data-hit'); if (lit === row) lit = null }, HIT_MS)
  return true
}

/** Lands on the row once it is in the page: now, or when the page has drawn it (a page waits for its settings). Returns a stop function. */
export function landWhenThere(id: string, within: HTMLElement | null): () => void {
  if (landOnRow(id)) return () => undefined
  const watch = new MutationObserver(() => { if (landOnRow(id)) watch.disconnect() })
  watch.observe(within ?? document.body, { childList: true, subtree: true })
  return () => watch.disconnect()
}
