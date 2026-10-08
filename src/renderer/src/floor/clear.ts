/** A tag or speech bubble over the office: `x` is its center and `y` its bottom edge, in pixels, with its measured size. */
export interface Box { id: string; x: number; y: number; w: number; h: number }

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && a.y > b.y - b.h && b.y > a.y - a.h

/**
 * How far to lift each box so none covers another. Boxes are placed front to back (the lowest on screen stays where it is);
 * each later box that would overlap one already placed stacks above it. `last` is placed after the rest, so it ends up on top
 * of any tag it would have covered, as the speech bubble does. Boxes that don't collide are left out of the result.
 */
export function clearOverlaps(boxes: Box[], last?: string): Record<string, number> {
  const order = [...boxes].sort((a, b) => Number(a.id === last) - Number(b.id === last) || b.y - a.y || a.x - b.x || (a.id < b.id ? -1 : 1))
  const placed: Box[] = []
  const lift: Record<string, number> = {}
  for (const box of order) {
    let y = box.y
    // Each pass moves above one more box, so this ends in at most `placed.length` passes.
    for (let pass = 0; pass <= placed.length; pass++) {
      const hit = placed.find((p) => overlaps({ ...box, y }, p))
      if (!hit) break
      y = hit.y - hit.h
    }
    if (y !== box.y) lift[box.id] = box.y - y
    placed.push({ ...box, y })
  }
  return lift
}
