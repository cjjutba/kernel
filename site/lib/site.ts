/** The site's public origin. Set NEXT_PUBLIC_SITE_URL in production. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'

export const SITE_DESCRIPTION =
  'Brief a lead, approve the plan, and watch your coding agents build in parallel, each in its own workspace. Free for Macs with Apple silicon.'

/** The canvas color, for the browser's chrome. Mirrors --color-canvas in globals.css. */
export const THEME_COLOR = '#08090a'

/** Per-page metadata. Next replaces nested objects instead of merging them, so each page sets the whole group. */
export function pageMetadata({ title, description, path }: { title: string; description: string; path: string }) {
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    openGraph: { type: 'website' as const, siteName: 'Kernel', title, description, url: path },
    twitter: { card: 'summary_large_image' as const, title, description }
  }
}
