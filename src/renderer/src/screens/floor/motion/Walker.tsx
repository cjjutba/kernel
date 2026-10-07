import type { AgentLook } from '@shared/types'
import { ART, pct } from '../../../floor/layout'
import { WAYPOINTS, type Waypoint } from './waypoints'

/** Someone up from their desk, standing at a waypoint. Strides while they still have steps to walk (Main.dc.html walkers). */
export function Walker({ at, moving, look }: { at: Waypoint; moving: boolean; look: AgentLook }) {
  const [x, y] = WAYPOINTS[at]
  return (
    <div aria-hidden="true" className="floor-walker" style={pct(x - 14, y - 60)}>
      <svg viewBox="-14 -60 28 64" width="100%" height="100%" style={{ display: 'block', overflow: 'visible' }}>
        <ellipse cx={0} cy={0} rx={9} ry={3.5} fill={ART.shade} fillOpacity={0.3} />
        <g className={moving ? 'floor-stride' : undefined}>
          <rect x={-5} y={-18} width={4} height={18} rx={1.5} fill={ART.legLeft} />
          <rect x={1} y={-18} width={4} height={18} rx={1.5} fill={ART.legRight} />
          <rect x={-11} y={-38} width={3.5} height={16} rx={1.7} fill={look.shirt} />
          <rect x={7.5} y={-38} width={3.5} height={16} rx={1.7} fill={look.shirt} />
          <rect x={-8} y={-40} width={16} height={23} rx={6} fill={look.shirt} />
          <circle cx={0} cy={-48} r={7.5} fill={look.skin} />
          <path d="M-7.6 -49 a7.6 7.6 0 0 1 15.2 0 Z" fill={look.hair} />
        </g>
      </svg>
    </div>
  )
}

/** Where a tag or a speech bubble sits over someone: above the walker when up, above the desk when seated (anchorOf in the canvas). */
export function anchor(at: Waypoint | 'seat', seat: [number, number]): [number, number] {
  if (at === 'seat') return [seat[0] + 2.1, seat[1] - 76]
  const [x, y] = WAYPOINTS[at]
  return [x, y - 62]
}
