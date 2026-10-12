import { actions, useStore } from '../../store'
import { Icon } from '../../ui'
import { githubPause } from './model'
import './footer.css'

/**
 * What the footer used to warn about, now a row just above the sidebar's bottom row (KERNEL-527): hook health only when the hook
 * server is down (D-082; Settings, Hooks has the port and status), and a GitHub rate limit holding PR reads off until it ends
 * (KERNEL-401). With the sidebar hidden, the chat's banners say the same. Ask Rowan and the update pill sit in the bottom row itself.
 */
export function SidebarAlerts() {
  const down = useStore((s) => s.system.hooks?.listening === false)
  const github = useStore((s) => s.system.github)
  const paused = githubPause(github, Date.now())
  return (
    <div className="sb-alerts">
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
    </div>
  )
}
