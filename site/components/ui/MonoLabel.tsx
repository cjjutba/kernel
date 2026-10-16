import type { ReactNode } from 'react'

const variants = {
  /** The line above a heading. */
  eyebrow: 'text-eyebrow font-medium text-muted',
  /** A count beside a heading. */
  count: 'text-tag font-medium text-faint',
  /** A number that orders a list. */
  index: 'text-tag text-faint'
}

/** A small mono label. */
export function MonoLabel({ variant = 'eyebrow', as: Tag = 'p', children }: { variant?: keyof typeof variants; as?: 'p' | 'span'; children: ReactNode }) {
  return <Tag className={`font-mono ${variants[variant]}`}>{children}</Tag>
}
