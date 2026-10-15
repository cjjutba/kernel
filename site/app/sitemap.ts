import type { MetadataRoute } from 'next'
import { changelogPage, changelogPageHref, latestRelease } from '@/content/changelog'
import { DOC_SLUGS, docHref } from '@/lib/docs'
import { SITE_URL } from '@/lib/site'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = (await latestRelease()).date
  const pages = (await changelogPage(1))?.pages ?? 1
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: 'monthly', priority: 1 },
    { url: `${SITE_URL}/changelog`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    ...Array.from({ length: pages - 1 }, (_, i) => ({ url: `${SITE_URL}${changelogPageHref(i + 2)}`, lastModified, changeFrequency: 'monthly' as const, priority: 0.4 })),
    { url: `${SITE_URL}/pricing`, lastModified, changeFrequency: 'monthly', priority: 0.7 },
    ...DOC_SLUGS.map((slug) => ({ url: `${SITE_URL}${docHref(slug)}`, lastModified, changeFrequency: 'monthly' as const, priority: slug === 'introduction' ? 0.8 : 0.6 }))
  ]
}
