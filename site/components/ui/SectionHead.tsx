import type { ReactNode } from 'react'
import { Eyebrow } from './Eyebrow'

type Props = {
  eyebrow: string
  title: ReactNode
  titleId: string
  lead?: ReactNode
  align?: 'center' | 'start'
  /** `page` is a page's own heading: an h1 in the changelog title size, with a narrower lead. */
  variant?: 'section' | 'page'
  className?: string
  /** Shown after the lead, such as a link. */
  children?: ReactNode
}

export function SectionHead({ eyebrow, title, titleId, lead, align = 'center', variant = 'section', className = '', children }: Props) {
  const center = align === 'center'
  const page = variant === 'page'
  const Heading = page ? 'h1' : 'h2'
  return (
    <div className={`${center ? 'mx-auto max-w-head text-center' : ''} ${className}`}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <Heading id={titleId} className={page ? 'mt-4 text-changelog-title' : 'mt-4 text-h2 text-balance'}>
        {title}
      </Heading>
      {lead ? (
        <p className={`mt-4 text-lead text-muted ${center ? 'mx-auto max-w-section-lead' : page ? 'max-w-section-lead' : ''}`}>{lead}</p>
      ) : null}
      {children}
    </div>
  )
}
