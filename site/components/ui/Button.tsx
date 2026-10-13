import Link from 'next/link'
import type { ReactNode } from 'react'
import { ExternalLink } from './ExternalLink'

type Variant = keyof typeof variants
type Size = keyof typeof sizes

type Props = {
  href: string
  variant?: Variant
  size?: Size
  icon?: ReactNode
  /** Opens in a new tab, for links that leave the site. */
  external?: boolean
  className?: string
  children: ReactNode
}

const variants = {
  primary: 'bg-ink text-canvas hover:bg-white',
  secondary: 'border border-edge bg-tint-faint text-ink hover:border-edge-hover hover:bg-tint-strong hover:text-white'
}

const sizes = {
  md: 'h-8 rounded-md px-3 text-ui',
  lg: 'h-12 rounded-lg px-5 text-body'
}

/** The classes of a button, for a link that can't be a Button. */
export function buttonClasses(variant: Variant = 'primary', size: Size = 'md') {
  return `inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap transition-colors ${variants[variant]} ${sizes[size]}`
}

export function Button({ href, variant = 'primary', size = 'md', icon, external, className = '', children }: Props) {
  const classes = `${buttonClasses(variant, size)} ${className}`
  if (href.startsWith('/')) {
    return (
      <Link href={href} className={classes}>
        {icon}
        {children}
      </Link>
    )
  }
  const Anchor = external ? ExternalLink : 'a'
  return (
    <Anchor href={href} className={classes}>
      {icon}
      {children}
    </Anchor>
  )
}
