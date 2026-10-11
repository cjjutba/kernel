import type { Handlers } from '../kernel'

type Group = Partial<Handlers>
/** Every group's map as one type, so groups that cover every channel between them make a whole `Handlers`. */
type Joined<G extends Group[]> = G extends [infer H, ...infer R extends Group[]] ? H & Joined<R> : unknown

/**
 * Joins the features' handler maps into the one map `handlers()` returns (KERNEL-324). A spread would hand a channel two
 * features answer to whichever came last, so a channel handled twice throws instead, at launch and in every test that
 * builds a Kernel.
 */
export function channels<G extends Group[]>(...groups: G): Joined<G> {
  const out: Record<string, unknown> = {}
  for (const group of groups) {
    for (const [channel, handler] of Object.entries(group)) {
      if (channel in out) throw new Error(`${channel} is handled twice`)
      out[channel] = handler
    }
  }
  return out as Joined<G>
}
