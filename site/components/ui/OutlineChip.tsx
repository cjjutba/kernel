import Link from 'next/link'
import type { ReactNode } from 'react'
import { ExternalLink } from './ExternalLink'

type Props = {
  href: string
  className?: string
  'aria-label'?: string
  children: ReactNode
}

/** A link with a hairline border that brightens on hover. Links that leave the site open in a new tab. */
export function OutlineChip({ href, className = '', children, ...rest }: Props) {
  const classes = `border border-line-strong hover:border-edge-hover ${className}`
  return href.startsWith('/') ? (
    <Link href={href} className={classes} {...rest}>
      {children}
    </Link>
  ) : (
    <ExternalLink href={href} className={classes} {...rest}>
      {children}
    </ExternalLink>
  )
}
