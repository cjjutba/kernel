// The pointer in a clip. Headless Chrome draws none, so the recorder moves this one to each target before it clicks.
const NS = 'http://www.w3.org/2000/svg'
const el = document.createElement('div')
Object.assign(el.style, { position: 'fixed', left: '0', top: '0', width: '22px', height: '22px', zIndex: '2147483647', pointerEvents: 'none', opacity: '0', transition: 'opacity 200ms' })
const svg = document.createElementNS(NS, 'svg')
svg.setAttribute('viewBox', '0 0 22 22')
svg.setAttribute('width', '22')
svg.setAttribute('height', '22')
const path = document.createElementNS(NS, 'path')
path.setAttribute('d', 'M4 2.5v15.2l3.9-3.7 2.6 6 2.7-1.2-2.6-5.9h5.4Z')
path.setAttribute('fill', '#ffffff')
path.setAttribute('stroke', '#08090a')
path.setAttribute('stroke-width', '1.3')
path.setAttribute('stroke-linejoin', 'round')
svg.append(path)
el.append(svg)
const ring = document.createElement('div')
Object.assign(ring.style, { position: 'fixed', width: '28px', height: '28px', marginLeft: '-14px', marginTop: '-14px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.7)', zIndex: '2147483646', pointerEvents: 'none', opacity: '0' })
document.addEventListener('DOMContentLoaded', () => document.body.append(ring, el))
if (document.body) document.body.append(ring, el)

let x = 720
let y = 450
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const place = () => { el.style.transform = `translate(${x - 4}px, ${y - 2.5}px)` }

;(window as unknown as { __cursor: unknown }).__cursor = {
  show(at?: { x: number; y: number }) { if (at) { x = at.x; y = at.y }; place(); el.style.opacity = '1' },
  hide() { el.style.opacity = '0' },
  /** Glides to (tx, ty) over `ms`, and resolves when it gets there. */
  move(tx: number, ty: number, ms: number) {
    const fx = x, fy = y, start = performance.now()
    return new Promise<void>((done) => {
      const frame = (now: number) => {
        const t = Math.min(1, (now - start) / ms)
        x = fx + (tx - fx) * ease(t)
        y = fy + (ty - fy) * ease(t)
        place()
        if (t < 1) requestAnimationFrame(frame)
        else done()
      }
      requestAnimationFrame(frame)
    })
  },
  /** A ring that grows and fades where the click lands. */
  press() {
    Object.assign(ring.style, { left: `${x}px`, top: `${y}px`, opacity: '1', transform: 'scale(0.4)', transition: 'none' })
    void ring.offsetWidth
    Object.assign(ring.style, { opacity: '0', transform: 'scale(1.3)', transition: 'transform 450ms ease-out, opacity 450ms ease-out' })
  }
}
export {}

