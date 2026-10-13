import { useRef } from 'react'
import { cleanError } from '../../api'
import { actions, go, useStore } from '../../store'
import { IconButton, Menu, MENU_SEPARATOR } from '../../ui'
import { reportProblem } from './reportProblem'

/** The question mark at the footer's far right, always there. Its menu opens upward: What's new, Keyboard shortcuts, then Report a problem. Settings isn't here (KERNEL-674). */
export function HelpMenu() {
  const open = useStore((s) => s.ui.menu === 'help')
  const anchor = useRef<HTMLDivElement>(null)
  return (
    <div ref={anchor} className="ft-helpbox">
      <IconButton className="ft-help" icon="question" size={14} label="Help" aria-haspopup="menu" aria-expanded={open} onClick={() => actions.ui.toggleMenu('help')} />
      {open && (
        <Menu
          label="Help" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ right: 0, bottom: 'calc(100% + 6px)', top: 'auto', width: 220 }}
          items={[
            { id: 'new', label: "What's new", onSelect: () => actions.ui.openModal({ name: 'whatsNew' }) },
            { id: 'shortcuts', label: 'Keyboard shortcuts', onSelect: () => go({ name: 'settings', page: 'shortcuts' }) },
            MENU_SEPARATOR,
            { id: 'report', label: 'Report a problem', onSelect: () => void reportProblem().catch((e) => actions.ui.toast({ title: 'Could not open GitHub', sub: cleanError(e) })) }
          ]}
        />
      )}
    </div>
  )
}
