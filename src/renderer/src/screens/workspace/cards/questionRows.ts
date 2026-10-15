/** Where an arrow key moves the cursor among the `len` buttons of a question's choices, or -1 when the key is not one of them. The ends stop. */
export function rowStep(key: string, at: number, len: number): number {
  if (len === 0 || at < 0) return -1
  switch (key) {
    case 'ArrowDown': case 'ArrowRight': return Math.min(at + 1, len - 1)
    case 'ArrowUp': case 'ArrowLeft': return Math.max(at - 1, 0)
    case 'Home': return 0
    case 'End': return len - 1
    default: return -1
  }
}

/** The one choice in the tab order: the one the cursor is on, else the first picked one, else the first. */
export function activeRow(cursor: number | null, picked: number, len: number): number {
  const at = cursor ?? (picked >= 0 ? picked : 0)
  return Math.min(Math.max(at, 0), Math.max(len - 1, 0))
}
