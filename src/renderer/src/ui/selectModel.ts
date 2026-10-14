// The parts of Select (KERNEL-680) that don't need the DOM: options in groups, which row the arrow keys and typing land on.

/** One choice. `description` is a second, muted line. A `disabled` one is shown but can't be picked or landed on. */
export interface SelectOption<T = unknown> { value: string; label: string; description?: string; disabled?: boolean; leading?: T }
/** A heading and the choices under it (the model picker: Claude Code, then Codex). A group with no label is set off by a rule instead. */
export interface SelectGroup<T = unknown> { label: string; options: SelectOption<T>[] }
export type SelectOptions<T = unknown> = (SelectOption<T> | SelectGroup<T>)[]

export const isGroup = <T>(o: SelectOption<T> | SelectGroup<T>): o is SelectGroup<T> => 'options' in o

/** Every choice in order, groups flattened. */
export function flattenOptions<T>(options: SelectOptions<T>): SelectOption<T>[] {
  return options.flatMap((o) => (isGroup(o) ? o.options : [o]))
}

/** The next row that can be landed on from `from`, one `step` at a time, wrapping round. -1 when none can. */
export function nextIndex(items: { disabled?: boolean }[], from: number, step: 1 | -1): number {
  const n = items.length
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n
    if (!items[i].disabled) return i
  }
  return -1
}

/** The first or last row that can be landed on (Home, End). -1 when none can. */
export function edgeIndex(items: { disabled?: boolean }[], edge: 'first' | 'last'): number {
  return edge === 'first' ? nextIndex(items, -1, 1) : nextIndex(items, items.length, -1)
}

/**
 * Typing jumps to a row whose label starts with what was typed, looking after `from` first and wrapping round, like a native select.
 * The same letter typed again moves on to the next row that starts with it. -1 when nothing matches.
 */
export function typeaheadIndex(items: { label: string; disabled?: boolean }[], typed: string, from: number): number {
  const q = typed.toLowerCase()
  if (!q) return -1
  const repeat = q.length > 1 && [...q].every((c) => c === q[0])
  const needle = repeat ? q[0] : q
  const n = items.length
  // A longer query keeps the current row when it still matches; a single letter always moves on.
  const start = needle.length > 1 ? 0 : 1
  for (let k = start; k <= n; k++) {
    const i = (((from + k) % n) + n) % n
    if (!items[i].disabled && items[i].label.toLowerCase().startsWith(needle)) return i
  }
  return -1
}
