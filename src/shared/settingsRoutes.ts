import type { Route } from './types'

/**
 * Settings pages and project sections that were merged into others (KERNEL-680), to the page that holds them now. A route saved
 * before the merge, a link in an old message or a fixture keeps landing on the right page.
 */
const PAGES: Record<string, { page: string; section?: string }> = {
  account: { page: 'accounts' },
  providers: { page: 'accounts' },
  scripts: { page: 'git' }
}
const SECTIONS: Record<string, string> = { scripts: 'setup', files: 'setup', instructions: 'prs', reviews: 'prs' }

/** The route as it is today: an old Settings page or project section becomes the one that holds it. Other routes come back as they were. */
export function currentRoute<R extends Route>(route: R): R {
  if (route.name !== 'settings') return route
  const page: string = route.page
  const section: string | undefined = route.section
  const moved = PAGES[page]
  const to = section && SECTIONS[section]
  if (!moved && !to) return route
  return { ...route, ...(moved && { page: moved.page }), ...(to && { section: to }) } as R
}
