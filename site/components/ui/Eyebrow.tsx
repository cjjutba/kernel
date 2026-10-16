import type { ReactNode } from 'react'
import { MonoLabel } from './MonoLabel'

export function Eyebrow({ children }: { children: ReactNode }) {
  return <MonoLabel>{children}</MonoLabel>
}
