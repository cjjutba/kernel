import { type ReactNode } from 'react'
import { Icon } from '../icons'
import { actions, useStore } from '../store'

export { Sidebar } from './sidebar/Sidebar'

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
