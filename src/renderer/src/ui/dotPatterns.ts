/**
 * The dot loader's patterns as data (KERNEL-759). Dots are numbered row by row:
 *
 *   0 1 2
 *   3 4 5
 *   6 7 8
 *
 * A pattern splits the 0.8s loop into `n` equal steps. Each dot swells from a pinpoint to full size and back once per loop, starting at its `at` step (fractions allowed), up to `peak` of full size.
 * `short` gives a swell with a rest, so a shape can be read (the arrows). `still` is what reduced motion holds at full size.
 */
export type SpinnerPattern =
  | 'wave' | 'wave-back' | 'arrow-right' | 'arrow-down' | 'ripple-out' | 'ripple-in' | 'spiral'
  | 'rotate' | 'checker' | 'pulse' | 'scatter' | 'twinkle' | 'snake'

export type Dot = { at: number; peak?: number }
export type PatternSpec = { n: number; short?: boolean; dots: Dot[]; still: number[] }

/** Dots in a group light together, and the loop splits evenly across the groups. */
const groups = (g: number[][], still: number[], short?: boolean): PatternSpec => {
  const dots: Dot[] = Array.from({ length: 9 }, () => ({ at: 0 }))
  g.forEach((ids, step) => ids.forEach((id) => { dots[id] = { at: step } }))
  return { n: g.length, short, dots, still }
}

/** One dot at a time, in this order. */
const trace = (order: number[], still: number[]) => groups(order.map((d) => [d]), still)

const wave = [[0], [1, 3], [2, 4, 6], [5, 7], [8]]

/** Corners turn clockwise at full strength, and the edge dot after each trails at half. */
const rotate = (): PatternSpec => {
  const dots: Dot[] = Array.from({ length: 9 }, () => ({ at: 0 }))
  ;[0, 2, 8, 6].forEach((corner, i) => { dots[corner] = { at: i } })
  ;[1, 5, 7, 3].forEach((edge, i) => { dots[edge] = { at: i + 0.5, peak: 0.55 } })
  dots[4] = { at: 4 }
  return { n: 5, dots, still: [0] }
}

/** The center swells, then the ring. */
const pulse = (): PatternSpec => groups([[4], [0, 1, 2, 3, 5, 6, 7, 8]], [4])

/** Nine dots in uneven, fixed delays, so two or three are lit at once and it looks random but repeats exactly. */
const twinkle = (): PatternSpec => {
  const at = [1.6, 2.5, 0, 4, 0.8, 2.75, 0.35, 3.2, 1.9]
  return { n: 5, dots: at.map((a) => ({ at: a })), still: [2, 4, 6] }
}

export const dotPatterns: Record<SpinnerPattern, PatternSpec> = {
  wave: groups(wave, [2, 4, 6]),
  'wave-back': groups([...wave].reverse(), [2, 4, 6]),
  'arrow-right': groups([[3], [0, 4, 6], [1, 5, 7], [2, 8]], [0, 4, 6], true),
  'arrow-down': groups([[1], [0, 4, 2], [3, 7, 5], [6, 8]], [0, 4, 2], true),
  'ripple-out': groups([[4], [1, 3, 5, 7], [0, 2, 6, 8]], [4]),
  'ripple-in': groups([[0, 2, 6, 8], [1, 3, 5, 7], [4]], [0, 2, 6, 8]),
  spiral: trace([0, 1, 2, 5, 8, 7, 6, 3, 4], [0, 1, 2]),
  rotate: rotate(),
  checker: groups([[0, 2, 4, 6, 8], [1, 3, 5, 7]], [0, 2, 4, 6, 8]),
  pulse: pulse(),
  scatter: trace([4, 0, 7, 2, 6, 1, 8, 3, 5], [4, 0, 7]),
  twinkle: twinkle(),
  snake: trace([0, 1, 2, 5, 4, 3, 6, 7, 8], [0, 1, 2]),
}

export const spinnerPatterns = Object.keys(dotPatterns) as SpinnerPattern[]
