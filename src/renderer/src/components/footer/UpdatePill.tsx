import { actions, useStore } from '../../store'

/** UpdateReady.png: the pill in the footer once an update has downloaded. The update itself is KERNEL-30; this is only its slot. */
export function UpdatePill() {
  const ready = useStore((s) => s.system.update?.status === 'ready')
  if (!ready) return null
  return (
    <button type="button" className="ft-pill" onClick={() => actions.ui.openModal({ name: 'whatsNew' })}>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" /></svg>Update ready
    </button>
  )
}
