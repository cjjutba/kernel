import { useState, type KeyboardEvent } from 'react'

export type ListKeyAction = { kind: 'move'; to: number } | { kind: 'open' }

interface KeyLike { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }

/** What a key does in a list of `len` rows with the cursor on row `at` (-1 for none): move to a row, open the current one, or nothing. The ends stop the cursor unless `wrap` is set. */
export function listKeyAction(e: KeyLike, at: number, len: number, wrap = false): ListKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || len === 0) return null
  const last = len - 1
  const step = (by: 1 | -1): ListKeyAction => {
    if (at < 0) return { kind: 'move', to: by === 1 || !wrap ? 0 : last }
    const to = at + by
    return { kind: 'move', to: to > last ? (wrap ? 0 : last) : to < 0 ? (wrap ? last : 0) : to }
  }
  switch (e.key) {
    case 'ArrowDown': case 'j': return step(1)
    case 'ArrowUp': case 'k': return step(-1)
    case 'Home': return { kind: 'move', to: 0 }
    case 'End': return { kind: 'move', to: last }
    case 'Enter': return at < 0 ? null : { kind: 'open' }
    default: return null
  }
}

export const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')

interface ListKeysOptions {
  ids: string[]
  rowId: (id: string) => string
  onOpen: (id: string) => void
  /** The row that is chosen, when the screen keeps a selection. Without it the list follows focus. */
  current?: string
  onCurrent?: (id: string) => void
  wrap?: boolean
  blocked?: () => boolean
}

/**
 * One keyboard model for every list (KERNEL-871): the arrows and j and k move, Home and End jump, Enter opens.
 * One row is in the tab order and a key moves focus to the next. Spread `rowProps(id)` on each row's focusable element
 * and `onKeyDown` on the element around the rows.
 */
export function useListKeys({ ids, rowId, onOpen, current, onCurrent, wrap, blocked }: ListKeysOptions) {
  const [focused, setFocused] = useState<string>()
  const pick = current ?? focused
  const active = pick !== undefined && ids.includes(pick) ? pick : ids[0]

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (isTyping(e.target) || blocked?.()) return
    const rowEl = (e.target as HTMLElement).closest('[data-list-row]')
    const at = rowEl ? ids.findIndex((id) => rowId(id) === rowEl.id) : -1
    if (at < 0) return
    const action = listKeyAction(e, at, ids.length, wrap)
    if (!action) return
    e.preventDefault()
    if (action.kind === 'open') return onOpen(ids[at])
    const id = ids[action.to]
    onCurrent?.(id)
    setFocused(id)
    const row = document.getElementById(rowId(id))
    row?.focus()
    row?.scrollIntoView({ block: 'nearest' })
  }

  const rowProps = (id: string) => ({
    id: rowId(id),
    tabIndex: id === active ? 0 : -1,
    'data-list-row': '',
    onFocus: () => setFocused(id),
  })

  return { onKeyDown, rowProps }
}
