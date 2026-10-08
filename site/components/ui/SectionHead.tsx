import type { ReactNode } from 'react'
import { Eyebrow } from './Eyebrow'

type Props = {
  eyebrow: string
  title: ReactNode
  titleId: string
  lead?: ReactNode
  align?: 'center' | 'start'
  className?: string
}

export function SectionHead({ eyebrow, title, titleId, lead, align = 'center', className = '' }: Props) {
  const center = align === 'center'
  return (
    <div className={`${center ? 'mx-auto max-w-250 text-center' : ''} ${className}`}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 id={titleId} className="mt-4 text-h2 text-balance">
        {title}
      </h2>
      {lead ? <p className={`mt-4 text-lead text-muted ${center ? 'mx-auto max-w-140' : ''}`}>{lead}</p> : null}
    </div>
  )
}
