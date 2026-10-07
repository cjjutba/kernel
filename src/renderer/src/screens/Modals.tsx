import { useMemo, useState } from 'react'
import { actions, go, useStore } from '../store'
import { Modal } from '../components/Shell'

export function SearchModal() {
  const rooms = useStore((s) => s.rooms)
  const workspaces = useStore((s) => s.workspaces.filter((w) => w.status !== 'archived'))
  const [q, setQ] = useState('')
  const items = useMemo(() => [
    { label: 'New workspace', run: () => actions.ui.openModal({ name: 'newWorkspace' }) },
    { label: 'Inbox', run: () => go({ name: 'inbox' }) },
    { label: 'History', run: () => go({ name: 'history' }) },
    { label: 'Add a room', run: () => go({ name: 'onboarding', step: 'checks' }) },
    ...rooms.map((r) => ({ label: `${r.name} floor`, run: () => go({ name: 'floor', roomId: r.id }) })),
    ...workspaces.map((w) => ({ label: `${w.name} workspace`, run: () => go({ name: 'workspace', workspaceId: w.id }) }))
  ].filter((i) => i.label.toLowerCase().includes(q.toLowerCase())), [q, rooms, workspaces])
  return (
    <Modal title="Search" onClose={() => actions.ui.closeModal()}>
      <div style={{ padding: '0 16px 8px' }}><input autoFocus className="input" style={{ width: '100%' }} placeholder="Type a command or search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && items[0]?.run()} /></div>
      <div className="col" style={{ maxHeight: 420, overflowY: 'auto', padding: '0 6px 8px' }}>{items.map((i) => <button key={i.label} className="menu-item" onClick={i.run}>{i.label}</button>)}</div>
    </Modal>
  )
}
