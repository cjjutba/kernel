import type { ReactNode } from 'react'

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-eyebrow font-medium text-muted">{children}</p>
}
