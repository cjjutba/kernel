import { Button, Icon } from '../../ui'
import { go, useStore } from '../../store'
import './onboarding.css'

/** Welcome.png: the first screen on a fresh install. Get started leads into the checks. */
export function Welcome() {
  const version = useStore((s) => s.system.update?.current ?? '0.1')
  return (
    <div className="panel" style={{ background: 'transparent', border: 0 }}>
      <main className="ob-center">
        <span className="ob-mark" aria-hidden="true"><Icon name="floor" size={34} stroke={1.2} /></span>
        <h1 className="ob-title">Welcome to Kernel</h1>
        <p className="ob-lede">Give your Claude Code agents a desk. They do the work, you stay the director.</p>
        <Button variant="primary" className="ob-cta" autoFocus onClick={() => go({ name: 'onboarding', step: 'checks' })}>Get started</Button>
      </main>
      <footer className="ob-foot">
        <span>Kernel {version.replace(/^(\d+\.\d+).*/, '$1')}</span>
        <button type="button" className="ob-link" onClick={() => go({ name: 'home' })}>Skip setup</button>
      </footer>
    </div>
  )
}
