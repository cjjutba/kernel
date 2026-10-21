import type { ReactNode } from 'react'
import { CopyButton, Icon, Spinner, type IconName } from '../../ui'

/** A card of rows in the column: one hairline outline, rows divided by a hairline. */
export function Card({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return <div className={['ob-card', className].filter(Boolean).join(' ')} role="list" aria-label={label}>{children}</div>
}

/** What a row's state draws in front: a check, a cross, a dash for a skipped optional one, or the loader while it checks. */
export function StateMark({ state }: { state: 'ok' | 'fail' | 'skip' | 'checking' }) {
  if (state === 'checking') return <span className="ob-ico"><Spinner label={null} pattern="wave" /></span>
  const icon: IconName = state === 'ok' ? 'check' : state === 'fail' ? 'close' : 'minus'
  return <span className="ob-ico" data-state={state}><Icon name={icon} size={14} /></span>
}

/** A command to copy, in a code box. The copy button names what it copies. */
export function Command({ text }: { text: string }) {
  return (
    <div className="ob-cmd">
      <span className="ob-cmd-text"><span className="ob-cmd-prompt" aria-hidden="true">$</span>{text}</span>
      <CopyButton text={text} label="Copy command" failSub={text} />
    </div>
  )
}

/** A line of text where `code` parts in backticks show as code. */
export function Rich({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/).map((p, i) => (p.startsWith('`') ? <code key={i} className="ob-code">{p.slice(1, -1)}</code> : p))}</>
}
