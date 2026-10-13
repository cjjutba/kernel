import type { ReactNode } from 'react'

/** The small mono label above a card's title, such as a step number. */
export function MonoLabel({ as: Tag = 'p', children }: { as?: 'p' | 'span'; children: ReactNode }) {
  return <Tag className="font-mono text-micro leading-normal font-medium text-faint">{children}</Tag>
}
