// The demo is the visitor's to explore. Nothing clicks by itself. One hint at a time points at the next real control,
// and it moves on when the story does: brief Kernel, switch to Plan, ask for the plan, approve it, open a workspace, merge.
// The agents' turns after an approval play out on their own, as they would in the app.
import { onStage, type Stage } from './story'

type ToSite = 'ready'
// The site serves the demo from its own origin, so messages only go there.
const tell = (type: ToSite) => { try { window.parent.postMessage({ source: 'kernel-demo', type }, window.location.origin) } catch { /* no parent */ } }

window.addEventListener('message', (e) => {
  const d = e.data as { source?: string; type?: string } | null
  if (e.origin !== window.location.origin || !d || d.source !== 'kernel-site') return
  if (d.type === 'restart') location.reload()
})

// ---------- Where each hint points

const visible = (el: Element | null | undefined): el is HTMLElement => !!el && (el as HTMLElement).offsetParent !== null
const composer = () => [...document.querySelectorAll('[role="textbox"][aria-label^="Message"]')].find(visible)
const buttonNamed = (label: RegExp) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => visible(b) && !b.disabled && label.test((b.textContent ?? '').replace(/\s+/g, ' ').trim()))
const sidebarRow = (label: string) => {
  const leaf = [...document.querySelectorAll('nav[aria-label="Sidebar"] *')].find((e) => e.children.length === 0 && (e.textContent ?? '').trim().startsWith(label))
  return visible(leaf) ? leaf : undefined
}

/**
 * `acted` says a click did what the hint asks, so it goes before the story moves on. A click on the anchor counts too,
 * unless `untilNextStep`: opening the mode menu and closing it again hasn't switched to Plan.
 */
type Hint = { text: string; side: 'top' | 'right'; anchor: () => Element | undefined; acted?: (target: Element) => boolean; untilNextStep?: true }
/** Opening a workspace: any row in the sidebar, or a plan task's Open workspace. */
const opensWorkspace = (t: Element) => !!t.closest('nav[aria-label="Sidebar"]') || /^Open workspace/.test((t.closest('button, a')?.textContent ?? '').trim())
const merges = (t: Element) => /^Merge/.test((t.closest('button')?.textContent ?? '').trim())
const HINTS: Record<Stage, Hint | undefined> = {
  quiet: undefined,
  done: undefined,
  brief: { text: 'Start here: brief Kernel on anything, then press Enter', side: 'top', anchor: composer },
  replied: { text: 'Press ⇧Tab, or pick Plan here', side: 'top', anchor: () => [...document.querySelectorAll('button[aria-label^="Permission mode"]')].find(visible), untilNextStep: true },
  planMode: { text: 'Now ask Kernel for the implementation plan', side: 'top', anchor: composer },
  planReady: { text: 'Read the plan, then approve it', side: 'top', anchor: () => buttonNamed(/^Approve/) },
  building: { text: 'Your team is building. Open a workspace to watch', side: 'right', anchor: () => sidebarRow('Save new plans'), acted: opensWorkspace },
  ready: { text: 'Code approved. Merge it when you are ready', side: 'top', anchor: () => buttonNamed(/^Merge( PR)?$/), acted: merges }
}

// ---------- The hint itself

const hint = document.createElement('div')
hint.setAttribute('role', 'status')
Object.assign(hint.style, {
  position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', opacity: '0',
  padding: '7px 11px', borderRadius: '8px', background: '#f7f8f8', color: '#08090a',
  font: "500 12.5px/1.2 'Geist Variable', 'Inter', system-ui, sans-serif", whiteSpace: 'nowrap', transition: 'opacity 300ms ease'
})
const label = document.createElement('span')
const tip = document.createElement('span')
Object.assign(tip.style, { position: 'absolute', width: '8px', height: '8px', background: '#f7f8f8' })
hint.append(label, tip)
document.body.append(hint)
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  hint.animate([{ translate: '0 0' }, { translate: '0 -3px' }, { translate: '0 0' }], { duration: 1800, iterations: Infinity, easing: 'ease-in-out' })
}

let current: Hint | undefined
/** The visitor did what this hint asked. It stays gone until the story reaches its next step. */
let acted = false
/** A menu, popover or dialog is open: the hint would sit on top of it. */
const overlayOpen = () => [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], dialog[open]')].some(visible)
function place() {
  const el = current?.anchor()
  if (!current || !el || acted || overlayOpen()) { hint.style.opacity = '0'; return }
  const r = el.getBoundingClientRect()
  if (current.side === 'top') {
    // Centered over its control, but kept inside the window: the tip still points at the control.
    const x = r.left + r.width / 2
    const half = hint.offsetWidth / 2
    const left = Math.min(Math.max(x, half + 8), window.innerWidth - half - 8)
    Object.assign(hint.style, { left: `${Math.round(left)}px`, top: `${Math.round(r.top - 12)}px`, transform: 'translate(-50%, -100%)' })
    Object.assign(tip.style, { left: `${Math.round(half + x - left)}px`, top: 'auto', bottom: '-4px', transform: 'translateX(-50%) rotate(45deg)' })
  } else {
    // A sidebar row's label ends mid-row, so the hint sits past the sidebar's edge, clear of the rows under it.
    const right = el.closest('nav')?.getBoundingClientRect().right ?? r.right
    Object.assign(hint.style, { left: `${Math.round(right + 14)}px`, top: `${Math.round(r.top + r.height / 2)}px`, transform: 'translate(0, -50%)' })
    Object.assign(tip.style, { left: '-4px', top: '50%', bottom: 'auto', transform: 'translateY(-50%) rotate(45deg)' })
  }
  hint.style.opacity = '1'
}

onStage((s) => {
  current = HINTS[s]
  acted = false
  if (current) label.textContent = current.text
  place()
})
window.addEventListener('pointerdown', (e) => {
  if (!e.isTrusted || !current || !(e.target instanceof Element)) return
  const anchor = current.anchor()
  if ((!current.untilNextStep && anchor?.contains(e.target)) || current.acted?.(e.target)) {
    acted = true
    place()
  }
}, { capture: true, passive: true })

// Layout settles over the first moments and moves as the visitor navigates, so the hint follows its control.
setInterval(place, 300)
window.addEventListener('resize', place)

tell('ready')
