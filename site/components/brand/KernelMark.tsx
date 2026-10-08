import type { ReactNode } from 'react'
import { MARK_PATH, MARK_VIEWBOX } from './markPath'

type Props = {
  className?: string
  /** When set, the mark is an image with this name. Otherwise it is hidden from screen readers. */
  title?: string
  /** Paint the mark with something other than currentColor, such as a gradient. */
  fill?: string
  children?: ReactNode
}

export function KernelMark({ className, title, fill = 'currentColor', children }: Props) {
  return (
    <svg
      className={className}
      viewBox={MARK_VIEWBOX}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      {title ? <title>{title}</title> : null}
      {children}
      <path d={MARK_PATH} fill={fill} />
    </svg>
  )
}
