// Where people can stand on the floor art (800x600). Points are wp() in design/canvas/project/Main.dc.html.

export const WAYPOINTS = {
  stand: [429.2, 302.0], back: [410.2, 259.0], wall: [295.8, 193.0], top: [482.9, 333.0], r1: [380.7, 392.0], noor: [353.0, 376.0],
  kai: [271.6, 329.0], r2: [295.8, 441.0], theo: [259.5, 420.0], ivy: [172.9, 370.0], door: [562.6, 507.0], lumi: [469.0, 481.0]
} as const satisfies Record<string, readonly [number, number]>

export type Waypoint = keyof typeof WAYPOINTS

/**
 * Which waypoints connect. Taken from the paths the canvas walks (stand, back, wall; stand, top, r1, noor; noor, kai;
 * kai, r1, r2, theo; theo, ivy; ivy, r2, top, stand), plus the open desk and the door for a new hire.
 */
export const EDGES: [Waypoint, Waypoint][] = [
  ['stand', 'back'], ['back', 'wall'], ['stand', 'top'], ['top', 'r1'], ['r1', 'noor'], ['noor', 'kai'], ['kai', 'r1'],
  ['r1', 'r2'], ['r2', 'theo'], ['theo', 'ivy'], ['ivy', 'r2'], ['r2', 'top'], ['top', 'lumi'], ['lumi', 'door']
]

/** Where someone stands next to each desk, in seat order (SEATS in floor/layout.ts): the lead desk first. */
export const DESK_SPOTS: Waypoint[] = ['stand', 'kai', 'noor', 'ivy', 'theo', 'lumi']

const dist = (a: Waypoint, b: Waypoint) => Math.hypot(WAYPOINTS[a][0] - WAYPOINTS[b][0], WAYPOINTS[a][1] - WAYPOINTS[b][1])

/** The shortest way from one waypoint to another along the edges, without the start. Empty when they are the same. */
export function path(from: Waypoint, to: Waypoint): Waypoint[] {
  if (from === to) return []
  const best = new Map<Waypoint, number>([[from, 0]])
  const prev = new Map<Waypoint, Waypoint>()
  const open = new Set<Waypoint>([from])
  while (open.size) {
    const here = [...open].reduce((a, b) => (best.get(a)! <= best.get(b)! ? a : b))
    open.delete(here)
    if (here === to) break
    for (const [a, b] of EDGES) {
      const next = a === here ? b : b === here ? a : null
      if (!next) continue
      const d = best.get(here)! + dist(here, next)
      if (d < (best.get(next) ?? Infinity)) { best.set(next, d); prev.set(next, here); open.add(next) }
    }
  }
  if (!prev.has(to)) return [to]
  const out: Waypoint[] = []
  for (let p: Waypoint | undefined = to; p && p !== from; p = prev.get(p)) out.unshift(p)
  return out
}
