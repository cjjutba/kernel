import { actions, useStore } from '../../store'
import { Icon } from '../../ui'
import { AskRowanButton } from './QuickAsk'
import { UpdatePill } from './UpdatePill'
import './footer.css'

/** The strip under every main panel: hook server health on the left, the update pill and Ask Rowan on the right. */
export function Footer() {
  const hooks = useStore((s) => s.system.hooks)
  return (
    <footer className="footer ft">
      {hooks === null ? (
        <span className="ft-hooks"><Icon name="plug" size={13} />Checking hooks</span>
      ) : hooks.listening ? (
        <span className="ft-hooks" role="status"><Icon name="plug" size={13} />Hooks live<span className="mono ft-port">localhost:{hooks.port}</span></span>
      ) : (
        <button type="button" className="ft-hooks ft-down" onClick={() => actions.ui.openModal({ name: 'checkHooks' })}><Icon name="plug" size={13} />Hooks down<span className="ft-fix">Check hooks</span></button>
      )}
      <span className="grow" />
      <UpdatePill />
      <AskRowanButton />
    </footer>
  )
}
