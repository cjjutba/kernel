import type { MetadataRoute } from 'next'
import { latestRelease } from '@/content/changelog'
import { SITE_URL } from '@/lib/site'

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = latestRelease.date
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: 'monthly', priority: 1 },
    { url: `${SITE_URL}/changelog`, lastModified, changeFrequency: 'monthly', priority: 0.8 }
  ]
}
