import Link from 'next/link'
import type { ReactNode } from 'react'

type Props = {
  href: string
  variant?: 'primary' | 'secondary'
  size?: 'md' | 'lg'
  icon?: ReactNode
  /** Opens in a new tab, for links that leave the site. */
  external?: boolean
  className?: string
  children: ReactNode
}

const variants = {
  primary: 'bg-ink text-canvas hover:bg-white',
  secondary: 'border border-edge bg-white/2 text-ink hover:border-edge-hover hover:bg-white/6 hover:text-white'
}

const sizes = {
  md: 'h-8 rounded-md px-3 text-ui',
  lg: 'h-12 rounded-lg px-5 text-body'
}

export function Button({ href, variant = 'primary', size = 'md', icon, external, className = '', children }: Props) {
  const classes = `inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap transition-colors ${variants[variant]} ${sizes[size]} ${className}`
  if (href.startsWith('/')) {
    return (
      <Link href={href} className={classes}>
        {icon}
        {children}
      </Link>
    )
  }
  return (
    <a href={href} className={classes} {...(external ? { target: '_blank', rel: 'noopener' } : {})}>
      {icon}
      {children}
    </a>
  )
}
