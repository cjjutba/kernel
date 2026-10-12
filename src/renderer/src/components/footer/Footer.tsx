import { actions, useStore } from '../../store'
import { Icon } from '../../ui'
import { githubPause } from './model'
import { AskRowanButton } from './QuickAsk'
import { UpdatePill } from './UpdatePill'
import './footer.css'

/**
 * The 32px strip under every main panel (KERNEL-588). Health shows on the left only while something is wrong: the hook server down
 * (D-082; Settings, Hooks has the port and status) or a GitHub rate limit holding PR reads off until it ends (KERNEL-401). On the right,
 * the update pill once an update is ready, then Ask Rowan. It sits in the same place whatever is hidden. Ask Rowan is off the floor,
 * where the brief box already talks to Rowan.
 */
export function Footer() {
  const down = useStore((s) => s.system.hooks?.listening === false)
  const github = useStore((s) => s.system.github)
  const onFloor = useStore((s) => s.ui.route.name === 'floor')
  const paused = githubPause(github, Date.now())
  return (
    <footer className="footer ft">
      {down && <button type="button" className="ft-hooks ft-down" onClick={() => actions.ui.openModal({ name: 'checkHooks' })}><Icon name="plug" size={13} />Hooks down<span className="ft-fix">Check hooks</span></button>}
      {/* Always mounted, so a screen reader hears the pause start. The item does nothing, so it is no button; Tab reaches its tooltip. */}
      <span role="status" className="ft-status">
        {paused && (
          <span className="ft-hooks ft-paused" tabIndex={0} data-tip={paused.why} aria-describedby="ft-github-why">
            <Icon name="pause" size={13} />{paused.label}<span className="ft-sub">{paused.sub}</span>
            <span id="ft-github-why" hidden>{paused.why}</span>
          </span>
        )}
      </span>
      <span className="grow" />
      <UpdatePill />
      {!onFloor && <AskRowanButton />}
    </footer>
  )
}
