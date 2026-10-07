import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { boot, useStore } from './store'
import { DevUi } from './ui/DevUi'
import './tokens.css'
import './ui/ui.css'

const devHash = '#/dev/ui'

/**
 * The component gallery. In dev it lives at `#/dev/ui`. The screenshot harness has no dev server, so its fixtures
 * (DevUi, DevUiOverlays) force `ui.stage` instead. Stage is fixture-only, so a real run never shows it.
 */
function Gate() {
  const stage = useStore((s) => s.ui.stage)
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  if (stage === 'dev/ui' || stage === 'dev/ui-overlays') return <DevUi page={stage === 'dev/ui' ? 'components' : 'overlays'} />
  if (import.meta.env.DEV && hash === devHash) return <DevUi />
  return <App />
}

void boot()
createRoot(document.getElementById('root')!).render(<StrictMode><Gate /></StrictMode>)
