import type { MetadataRoute } from 'next'
import { latestRelease } from '@/content/changelog'
import { DOC_SLUGS, docHref } from '@/lib/docs'
import { SITE_URL } from '@/lib/site'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = (await latestRelease()).date
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: 'monthly', priority: 1 },
    { url: `${SITE_URL}/changelog`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/pricing`, lastModified, changeFrequency: 'monthly', priority: 0.7 },
    ...DOC_SLUGS.map((slug) => ({ url: `${SITE_URL}${docHref(slug)}`, lastModified, changeFrequency: 'monthly' as const, priority: slug === 'introduction' ? 0.8 : 0.6 }))
  ]
}
