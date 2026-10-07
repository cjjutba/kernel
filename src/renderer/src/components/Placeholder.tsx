import { Modal } from './Shell'
import { actions } from '../store'

// Stand-ins for screens no lane has built yet (KERNEL-8). Each one lives in the file its lane replaces,
// listed in the Component column of docs/SCREENS.md. Delete this file once nothing imports it.

export function PlaceholderPage({ title, issue }: { title: string; issue: string }) {
  return (
    <div className="panel" data-placeholder={issue}>
      <header className="header"><h1>{title}</h1></header>
    </div>
  )
}

export function PlaceholderModal({ title, issue }: { title: string; issue: string }) {
  return (
    <Modal title={title} onClose={actions.ui.closeModal}>
      <div data-placeholder={issue} />
    </Modal>
  )
}
