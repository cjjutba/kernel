/**
 * The dot loader's patterns as data (KERNEL-759). Dots are numbered row by row:
 *
 *   0 1 2
 *   3 4 5
 *   6 7 8
 *
 * A pattern splits the 0.8s loop into `n` equal steps. Every dot rests at full size and dips out once per loop (shrinks, stays gone, grows back), the dip starting at its `at` step (fractions allowed).
 * The center (dot 4) never shows or dips alone: its dip must overlap a neighbor's at every moment (test/spinnerGuard.test.ts). `still` is what reduced motion holds at full size, and it keeps a neighbor with the center.
 */
export type SpinnerPattern =
  | 'wave' | 'arrow-down' | 'ripple' | 'spiral' | 'checker' | 'twinkle' | 'snake'

export type Dot = { at: number }
export type PatternSpec = { n: number; dots: Dot[]; still: number[] }

/** Dots in a group light together, and the loop splits evenly across the groups. */
const groups = (g: number[][], still: number[]): PatternSpec => {
  const dots: Dot[] = Array.from({ length: 9 }, () => ({ at: 0 }))
  g.forEach((ids, step) => ids.forEach((id) => { dots[id] = { at: step } }))
  return { n: g.length, dots, still }
}

/** One dot at a time, in this order. */
const trace = (order: number[], still: number[]) => groups(order.map((d) => [d]), still)

const wave = [[0], [1, 3], [2, 4, 6], [5, 7], [8]]

/** Nine dots in uneven, fixed delays, so two or three are lit at once and it looks random but repeats exactly. */
const twinkle = (): PatternSpec => {
  const at = [1.6, 2.5, 0, 4, 0.8, 2.75, 0.35, 3.2, 1.9]
  return { n: 5, dots: at.map((a) => ({ at: a })), still: [2, 4, 6] }
}

export const dotPatterns: Record<SpinnerPattern, PatternSpec> = {
  wave: groups(wave, [2, 4, 6]),
  'arrow-down': groups([[1], [0, 4, 2], [3, 7, 5], [6, 8]], [0, 4, 2]),
  /** The center dips with the edges, then the corners, so it never leads on its own. The empty first step keeps the three-step spacing. */
  ripple: groups([[], [1, 3, 4, 5, 7], [0, 2, 6, 8]], [1, 3, 4, 5, 7]),
  spiral: trace([0, 1, 2, 5, 8, 7, 6, 3, 4], [0, 1, 2]),
  checker: groups([[0, 2, 4, 6, 8], [1, 3, 5, 7]], [0, 2, 4, 6, 8]),
  twinkle: twinkle(),
  snake: trace([0, 1, 2, 5, 4, 3, 6, 7, 8], [0, 1, 2]),
}

export const spinnerPatterns = Object.keys(dotPatterns) as SpinnerPattern[]
