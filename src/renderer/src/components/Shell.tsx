import { type ReactNode } from 'react'
import { IconButton } from '../ui'

export { Sidebar } from './sidebar/Sidebar'
export { Footer } from './footer/Footer'

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <section role="dialog" aria-modal="true" aria-label={title} className="modal" style={width ? { width } : undefined} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-head"><h2>{title}</h2><IconButton icon="close" label="Close" onClick={onClose} /></div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </section>
    </>
  )
}
