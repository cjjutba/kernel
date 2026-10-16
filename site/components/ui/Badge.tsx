import type { ReactNode } from 'react'

const sizes = {
  md: 'h-6 text-tag',
  sm: 'h-5 text-badge'
}

/** A small solid label, such as New on the hero pill or Latest on a release. */
export function Badge({ size = 'md', children }: { size?: keyof typeof sizes; children: ReactNode }) {
  return (
    <span className={`inline-flex ${sizes[size]} items-center rounded-pill bg-ink px-2 font-semibold text-canvas`}>
      {children}
    </span>
  )
}
