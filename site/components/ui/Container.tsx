import type { HTMLAttributes, ReactNode } from 'react'

type Props = Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'> & {
  as?: 'div' | 'section'
  /** `page` is the landing page width, `changelog` the narrower changelog column. */
  size?: 'page' | 'changelog'
  className?: string
  children: ReactNode
}

const widths = { page: 'max-w-page', changelog: 'max-w-changelog' }

/** The centered column with the page gutter. */
export function Container({ as: Tag = 'div', size = 'page', className, children, ...rest }: Props) {
  return (
    <Tag className={['mx-auto', widths[size], 'px-6', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </Tag>
  )
}

/** A landing page section: the page column, 160 px below the previous one. */
export function Section({ className, ...rest }: Omit<Props, 'as' | 'size'>) {
  return <Container as="section" className={['pt-40', className].filter(Boolean).join(' ')} {...rest} />
}
