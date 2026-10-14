/**
 * The tab to show after `closing` are closed while `active` is the open one (KERNEL-719), for every kind of tab.
 * `order` is the open tabs left to right, `recent` the tab ids with the one selected last first.
 *
 * - `active` is not among `closing`: it stays (a tab that isn't open, or Close other tabs, which keeps the one you are on).
 * - Otherwise the tab used most recently before it that is still open, like VS Code.
 * - With no such tab, the one to its left, or to its right when it was the first.
 * - Nothing is left: undefined.
 */
export function nextTab(order: string[], recent: string[] | undefined, closing: string[], active: string | undefined): string | undefined {
  if (!active || !closing.includes(active)) return active
  const left = order.filter((id) => !closing.includes(id))
  const open = new Set(left)
  const used = (recent ?? []).find((id) => open.has(id))
  if (used) return used
  const at = order.indexOf(active)
  if (at < 0) return left[0]
  const before = order.slice(0, at).filter((id) => open.has(id))
  return before[before.length - 1] ?? order.slice(at + 1).find((id) => open.has(id))
}
