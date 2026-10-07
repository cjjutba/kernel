import { useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import { actions, go, pending, useStore, type Route } from '../store'

const same = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b)

function NavItem({ route, icon, label, right, sub }: { route: Route; icon: string; label: string; right?: ReactNode; sub?: boolean }) {
  const current = useStore((s) => same(s.ui.route, route))
  return (
    <button className={`nav-item${sub ? ' nav-sub' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => go(route)}>
      <Icon name={icon} />
      <span className="grow ellipsis">{label}</span>
      {right}
    </button>
  )
}

export function Sidebar() {
  const rooms = useStore((s) => s.rooms)
  const workspaces = useStore((s) => s.workspaces)
  const inbox = useStore((s) => pending(s).length)
  const route = useStore((s) => s.ui.route)
  const [menu, setMenu] = useState<string | null>(null)
  const openRoom = 'roomId' in route ? route.roomId : route.name === 'workspace' ? workspaces.find((w) => w.id === route.workspaceId)?.roomId : rooms[0]?.id

  return (
    <nav aria-label="Sidebar" className="sidebar">
      <div className="drag" style={{ height: 42, flexShrink: 0 }} />
      <div className="row" style={{ height: 36, paddingLeft: 4 }}>
        <span style={{ width: 20, height: 20, borderRadius: 6, background: 'var(--ink)', color: 'var(--canvas)', fontSize: 9.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>CJ</span>
        <span className="grow" style={{ fontWeight: 500 }}>Kernel</span>
        <button className="icon-btn" aria-label="New workspace" style={{ border: '1px solid var(--line-2)', background: 'var(--surface)' }} onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: openRoom })}><Icon name="compose" /></button>
      </div>
      <div className="col" style={{ gap: 1, marginTop: 10 }}>
        <button className="nav-item" onClick={() => actions.ui.openModal({ name: 'search' })}><Icon name="search" /><span className="grow">Search</span><span className="muted" style={{ fontSize: 11.5 }}>⌘K</span></button>
        <NavItem route={{ name: 'home' }} icon="home" label="Home" />
        <NavItem route={{ name: 'inbox' }} icon="inbox" label="Inbox" right={inbox ? <span className="muted" style={{ fontSize: 12 }}>{inbox}</span> : null} />
        <NavItem route={{ name: 'history' }} icon="history" label="History" />
      </div>
      <div className="section-label hv">
        <span>Your rooms</span>
        <button className="icon-btn more" style={{ width: 24, height: 24 }} aria-label="Add a room" onClick={() => go({ name: 'onboarding', step: 'checks' })}><Icon name="plus" size={14} /></button>
      </div>
      <div className="col" style={{ gap: 1, overflowY: 'auto', minHeight: 0 }}>
        {rooms.map((r) => {
          const open = r.id === openRoom
          const live = workspaces.filter((w) => w.roomId === r.id && w.status !== 'archived' && w.name !== 'lead')
          return (
            <div key={r.id}>
              <div className="hv" style={{ position: 'relative' }}>
                <button className="nav-item" style={{ color: open ? 'var(--ink)' : undefined, paddingRight: 60 }} onClick={() => go({ name: 'floor', roomId: r.id })}>
                  <span style={{ width: 18, height: 18, borderRadius: 5, border: '1px solid var(--line-3)', background: open ? 'var(--surface-3)' : 'var(--surface)', fontSize: 10, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{r.name[0]?.toUpperCase()}</span>
                  <span className="grow ellipsis">{r.name}</span>
                </button>
                <div className="more row" style={{ position: 'absolute', right: 4, top: 3, gap: 2 }}>
                  <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label={`${r.name} options`} onClick={() => setMenu(menu === r.id ? null : r.id)}>···</button>
                  <button className="icon-btn" style={{ width: 24, height: 24 }} aria-label={`New workspace in ${r.name}`} onClick={() => actions.ui.openModal({ name: 'newWorkspace', roomId: r.id })}><Icon name="plus" size={14} /></button>
                </div>
                {menu === r.id && (
                  <div className="menu" role="menu" style={{ left: 60, top: 30 }} onMouseLeave={() => setMenu(null)}>
                    <button className="menu-item" onClick={() => { setMenu(null); actions.ui.openModal({ name: 'newWorkspace', roomId: r.id }) }}>New workspace</button>
                    <button className="menu-item" onClick={() => { setMenu(null); go({ name: 'team', roomId: r.id }) }}>Team</button>
                    <button className="menu-item" onClick={() => { setMenu(null); go({ name: 'board', roomId: r.id }) }}>Board</button>
                  </div>
                )}
              </div>
              {open && (
                <>
                  <NavItem sub route={{ name: 'floor', roomId: r.id }} icon="floor" label="Floor" />
                  <NavItem sub route={{ name: 'board', roomId: r.id }} icon="board" label="Board" />
                  {live.map((w) => <NavItem key={w.id} sub route={{ name: 'workspace', workspaceId: w.id }} icon="branch" label={w.name} right={w.prNumber ? <span className="mono muted" style={{ fontSize: 11 }}>#{w.prNumber}</span> : null} />)}
                </>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ flex: 1 }} />
      <div className="row" style={{ height: 40, flexShrink: 0, padding: '0 2px' }}>
        <span style={{ height: 24, padding: '0 9px', borderRadius: 999, border: '1px solid var(--line-2)', fontSize: 12, color: 'var(--ink-2)', display: 'inline-flex', alignItems: 'center' }}>Claude Max</span>
      </div>
    </nav>
  )
}

export function Footer() {
  const usage = useStore((s) => s.usage)
  const five = usage.find((u) => u.type === 'five_hour')
  return (
    <footer className="footer">
      <span className="row"><Icon name="plug" size={13} />Hooks live</span>
      <span style={{ flex: 1 }} />
      {five?.utilization !== undefined && <span>Session {Math.round(five.utilization * 100)}%</span>}
    </footer>
  )
}

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <section role="dialog" aria-modal="true" aria-label={title} className="modal" style={width ? { width } : undefined} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-head"><h2>{title}</h2><button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button></div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </section>
    </>
  )
}
