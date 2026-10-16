import { actions, go } from '../../store'
import { Icon, type IconName } from '../../ui'
import './onboarding.css'

const CARDS: { icon: IconName; name: string; sub: string; open: () => void }[] = [
  { icon: 'branch', name: 'Connect a repo', sub: 'From GitHub', open: () => actions.ui.openModal({ name: 'connectRepo' }) },
  { icon: 'doc', name: 'Open a folder', sub: 'Already on your Mac', open: () => actions.ui.openModal({ name: 'openFolder' }) }
]

/** The last step of Welcome.png: pick how to make the first project. The modals belong to KERNEL-20. */
export function FirstProject() {
  return (
    <div className="panel ob-bare">
      <main className="ob-center">
        <h1 className="ob-h1 ob-h1-lg">Create your first project</h1>
        <p className="ob-sub ob-sub-lg">A project is one repo with its own team of agents.</p>
        <div className="ob-cards" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', width: 420 }}>
          {CARDS.map((c) => (
            <button key={c.name} type="button" className="ob-card" onClick={c.open}>
              <Icon name={c.icon} size={20} />
              <span className="col ob-card-text"><span className="ob-card-name">{c.name}</span><span className="ob-card-sub">{c.sub}</span></span>
            </button>
          ))}
        </div>
        <button type="button" className="ob-link ob-later" onClick={() => go({ name: 'inbox' })}>I'll do this later</button>
      </main>
    </div>
  )
}
