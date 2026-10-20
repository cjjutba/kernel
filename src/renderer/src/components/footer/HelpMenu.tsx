import { useEffect, useRef, useState } from 'react'
import { call, cleanError } from '../../api'
import { actions, go, useStore } from '../../store'
import { IconButton, Menu, MENU_SEPARATOR } from '../../ui'
import { reportProblem } from './reportProblem'

const DOCS = 'https://github.com/cjjutba/kernel/tree/main/docs'

/** The question mark in the sidebar footer. Its menu opens upward: Documentation, Keyboard shortcuts, Send feedback, then About Kernel with its version (KERNEL-1101). */
export function HelpMenu() {
  const open = useStore((s) => s.ui.menu === 'help')
  const anchor = useRef<HTMLDivElement>(null)
  const [version, setVersion] = useState('')
  useEffect(() => { if (open) void call('app.info', undefined).then((i) => setVersion(i.version)).catch(() => undefined) }, [open])
  const fail = (title: string) => (e: unknown) => actions.ui.toast({ title, sub: cleanError(e) })
  return (
    <div ref={anchor} className="sbf-helpbox">
      <IconButton className="sbf-btn" icon="question" label="Help" aria-haspopup="menu" aria-expanded={open} onClick={() => actions.ui.toggleMenu('help')} />
      {open && (
        <Menu
          label="Help" anchorRef={anchor} onClose={actions.ui.closeMenu} style={{ left: 0, bottom: 'calc(100% + 8px)', top: 'auto', width: 240 }}
          items={[
            { id: 'docs', label: 'Documentation', icon: 'book', onSelect: () => void call('system.openExternal', { url: DOCS }).catch(fail('Could not open the documentation')) },
            { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', onSelect: () => go({ name: 'settings', page: 'shortcuts' }) },
            { id: 'feedback', label: 'Send feedback', icon: 'chat', onSelect: () => void reportProblem().catch(fail('Could not open GitHub')) },
            MENU_SEPARATOR,
            { id: 'about', label: 'About Kernel', icon: 'info', note: version || undefined, onSelect: () => go({ name: 'settings', page: 'about' }) }
          ]}
        />
      )}
    </div>
  )
}
