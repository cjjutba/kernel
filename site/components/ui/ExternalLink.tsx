import type { AnchorHTMLAttributes } from 'react'

/** A link that leaves the site, in a new tab. */
export function ExternalLink(props: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'target' | 'rel'> & { href: string }) {
  return <a target="_blank" rel="noopener" {...props} />
}
