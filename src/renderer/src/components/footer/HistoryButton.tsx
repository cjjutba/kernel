import { go, useStore } from '../../store'
import { IconButton } from '../../ui'

/** The clock just left of Help. It opens History for all projects, and shows pressed while History is open, whatever project it is filtered to (KERNEL-902). */
export function HistoryButton() {
  const open = useStore((s) => s.ui.route.name === 'history')
  return <IconButton className="ft-history" icon="history" size={14} label="History" aria-pressed={open} onClick={() => go({ name: 'history' })} />
}
