import { actions, useStore } from '../../store'
import { Icon } from '../../ui'
import { AskRowanButton } from './QuickAsk'
import { UpdatePill } from './UpdatePill'
import './footer.css'

/**
 * The strip under every main panel: the update pill and Ask Rowan on the right. Hook health shows on the left only when the
 * hook server is down (D-082); Settings, Hooks has the port and status.
 */
export function Footer() {
  const down = useStore((s) => s.system.hooks?.listening === false)
  return (
    <footer className="footer ft">
      {down && <button type="button" className="ft-hooks ft-down" onClick={() => actions.ui.openModal({ name: 'checkHooks' })}><Icon name="plug" size={13} />Hooks down<span className="ft-fix">Check hooks</span></button>}
      <span className="grow" />
      <UpdatePill />
      <AskRowanButton />
    </footer>
  )
}
