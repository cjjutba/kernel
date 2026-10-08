import { actions, useStore } from '../../store'
import { Icon } from '../../ui'
import { AskRowanButton } from './QuickAsk'
import { UpdatePill } from './UpdatePill'
import './footer.css'

/**
 * The strip under every main panel: the update pill and Ask Rowan on the right. Hook health shows on the left only when the
 * hook server is down (D-082); Settings, Hooks has the port and status. Ask Rowan is hidden on the floor, where the brief box
 * already talks to Rowan.
 */
export function Footer() {
  const down = useStore((s) => s.system.hooks?.listening === false)
  const onFloor = useStore((s) => s.ui.route.name === 'floor')
  return (
    <footer className="footer ft">
      {down && <button type="button" className="ft-hooks ft-down" onClick={() => actions.ui.openModal({ name: 'checkHooks' })}><Icon name="plug" size={13} />Hooks down<span className="ft-fix">Check hooks</span></button>}
      <span className="grow" />
      <UpdatePill />
      {!onFloor && <AskRowanButton />}
    </footer>
  )
}
