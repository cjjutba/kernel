import { actions, useStore } from '../../store'
import { Icon } from '../../icons'

/** UpdateReady.png: the pill in the footer once an update has downloaded. The update itself is KERNEL-30; this is only its slot. */
export function UpdatePill() {
  const ready = useStore((s) => s.system.update?.status === 'ready')
  if (!ready) return null
  return (
    <button type="button" className="ft-pill" onClick={() => actions.ui.openModal({ name: 'whatsNew' })}>
      <Icon name="download" size={12} />Update ready
    </button>
  )
}
