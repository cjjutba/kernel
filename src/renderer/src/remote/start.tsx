import { StrictMode, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useEffect } from 'react'
import { actions, resync, useStore } from '../store'
import { Gate } from './Gate'
import { Bridge, browserAppearance, sessionProbe, type LinkState } from './bridge'
import { forgetToken, leaveNotice, pairCode, storedToken, storeToken, takeNotice } from './pairing'
import './remote.css'

/*
 * How the page starts when there is no Electron preload (remote-web-client). A token in localStorage opens the bridge and starts the
 * app. A pairing link's code asks for a device name first, and without either the page says where the link is. A token the Mac
 * refuses clears itself and reloads into that last state, so a revoked device lands on the message and not on a broken app.
 */

let bridge: Bridge | undefined
const subscribe = (fn: () => void) => bridge?.watch(fn) ?? (() => undefined)
const link = (): LinkState => bridge?.link ?? 'connecting'

/** Over the app while the link to the Mac is down. Calls made meanwhile wait for it, and the app loads again once it is back. */
export function LinkNotice() {
  const state = useSyncExternalStore(subscribe, link)
  if (state === 'open' || state === 'connecting') return null
  return <div className="remote-bar" role="status">{state === 'reconnecting' ? 'Reconnecting to your Mac' : 'This device is not paired any more'}</div>
}

/** On a phone the sidebar covers the page, so picking a place closes it. */
export function PhoneSidebar() {
  const route = useStore((s) => s.ui.route)
  useEffect(() => { if (innerWidth <= 640) actions.ui.setSidebar(false) }, [route])
  return null
}

function open(token: string, run: () => void) {
  const url = new URL('/ws', location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  bridge = new Bridge({
    url: url.href,
    token,
    probe: sessionProbe(location.origin, token),
    onReconnect: () => { void resync().catch(() => undefined) }
  })
  bridge.watch(() => {
    if (bridge?.link !== 'unauthorized') return
    forgetToken()
    leaveNotice('This device was removed from Kernel on your Mac. Pair it again to carry on.')
    location.reload()
  })
  window.kernel = bridge
  // A phone that comes back to the front, or a network that returns, retries at once instead of waiting out the pause.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) bridge?.nudge() })
  window.addEventListener('online', () => bridge?.nudge())
  run()
}

/** `run` mounts the app. It is called once a bridge is open as `window.kernel`. */
export function startRemote(root: HTMLElement, run: () => void) {
  const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const a = browserAppearance()
  const d = document.documentElement.dataset
  d.remote = 'true'
  d.theme = theme; d.font = a.fontSize; d.density = a.density; d.pointer = String(a.pointerCursors); d.reduceMotion = String(a.reduceMotion)

  const code = pairCode()
  const token = storedToken()
  if (token && !code) return open(token, run)

  let gate: Root | undefined = createRoot(root)
  const paired = (t: string) => {
    storeToken(t)
    // The code is spent and must not stay in the address bar or the history.
    history.replaceState(null, '', location.pathname + location.search)
    gate?.unmount()
    gate = undefined
    open(t, run)
  }
  gate.render(<StrictMode><Gate code={code} notice={takeNotice()} onPaired={paired} /></StrictMode>)
}
