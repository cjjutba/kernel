/**
 * The dot loader's patterns as data (KERNEL-759). Dots are numbered row by row:
 *
 *   0 1 2
 *   3 4 5
 *   6 7 8
 *
 * A pattern splits the 1s loop into `n` equal steps. Each dot lights once per loop, starting at its `at` step (fractions allowed), at `peak` of the full 0.9 opacity.
 * `shape` is the fade the dots use (the `dots-*` keyframes in tokens.css). `still` is what reduced motion holds.
 */
export type SpinnerPattern =
  | 'wave' | 'wave-back' | 'arrow-right' | 'arrow-down' | 'ripple-out' | 'ripple-in' | 'spiral'
  | 'rotate' | 'checker' | 'pulse' | 'scatter' | 'twinkle' | 'snake'

export type DotShape = 'half' | 'wave' | 'one' | 'tail' | 'blink' | 'beat'

/** A dot takes the pattern's `shape` unless it sets its own. */
export type Dot = { at: number; peak?: number; shape?: DotShape }
export type PatternSpec = { n: number; shape: DotShape; dots: Dot[]; still: number[] }

/** Dots in a group light together, and the loop splits evenly across the groups. */
const groups = (g: number[][], shape: DotShape, still: number[]): PatternSpec => {
  const dots: Dot[] = Array.from({ length: 9 }, () => ({ at: 0 }))
  g.forEach((ids, step) => ids.forEach((id) => { dots[id] = { at: step } }))
  return { n: g.length, shape, dots, still }
}

/** One dot at a time, in this order. */
const trace = (order: number[], shape: DotShape, still: number[]) => groups(order.map((d) => [d]), shape, still)

const wave = [[0], [1, 3], [2, 4, 6], [5, 7], [8]]

/** Corners turn clockwise at full strength, and the edge dot after each trails at half. */
const rotate = (): PatternSpec => {
  const dots: Dot[] = Array.from({ length: 9 }, () => ({ at: 0 }))
  ;[0, 2, 8, 6].forEach((corner, i) => { dots[corner] = { at: i } })
  ;[1, 5, 7, 3].forEach((edge, i) => { dots[edge] = { at: i + 0.5, peak: 0.55 } })
  dots[4] = { at: 4 }
  return { n: 5, shape: 'wave', dots, still: [0] }
}

/** The center beats twice, then the ring. */
const pulse = (): PatternSpec => {
  const dots: Dot[] = Array.from({ length: 9 }, () => ({ at: 2, shape: 'half' }))
  dots[4] = { at: 0, shape: 'beat' }
  return { n: 3, shape: 'wave', dots, still: [4] }
}

/** Nine dots in uneven, fixed delays, so two or three are lit at once and it looks random but repeats exactly. */
const twinkle = (): PatternSpec => {
  const at = [1.6, 2.5, 0, 4, 0.8, 2.75, 0.35, 3.2, 1.9]
  return { n: 5, shape: 'wave', dots: at.map((a) => ({ at: a })), still: [2, 4, 6] }
}

export const dotPatterns: Record<SpinnerPattern, PatternSpec> = {
  wave: groups(wave, 'wave', [2, 4, 6]),
  'wave-back': groups([...wave].reverse(), 'wave', [2, 4, 6]),
  'arrow-right': groups([[3], [0, 4, 6], [1, 5, 7], [2, 8]], 'wave', [0, 4, 6]),
  'arrow-down': groups([[1], [0, 4, 2], [3, 7, 5], [6, 8]], 'wave', [0, 4, 2]),
  'ripple-out': groups([[4], [1, 3, 5, 7], [0, 2, 6, 8]], 'wave', [4]),
  'ripple-in': groups([[0, 2, 6, 8], [1, 3, 5, 7], [4]], 'wave', [0, 2, 6, 8]),
  spiral: trace([0, 1, 2, 5, 8, 7, 6, 3, 4], 'one', [0, 1, 2]),
  rotate: rotate(),
  checker: groups([[0, 2, 4, 6, 8], [1, 3, 5, 7]], 'half', [0, 2, 4, 6, 8]),
  pulse: pulse(),
  scatter: trace([4, 0, 7, 2, 6, 1, 8, 3, 5], 'blink', [4, 0, 7]),
  twinkle: twinkle(),
  snake: trace([0, 1, 2, 5, 4, 3, 6, 7, 8], 'tail', [0, 1, 2]),
}

export const spinnerPatterns = Object.keys(dotPatterns) as SpinnerPattern[]
